/**
 * T136（CHG-175）：记账本 + **收尾闸门** `write-log.ts` 的不变量。
 *
 * 为什么要有这个测试：一个「多文件写」的操作（建团队要写目录、`team.json`、`team-index.json`、
 * 账本首事件）中途失败时，前面已写的文件会留在磁盘上，而内存里的状态没有推进 —— 于是
 * **磁盘与状态不一致**：下一个读的人看到半个团队，下一个写的人接着在半个团队上写。
 * 本模块给这个场景两条**唯一**的收尾路径和一条**不可逆边界**：
 *   ① `rollbackPresync()`：按写前快照**逆序**还原被覆盖的内容（逆序 = 同一文件被多次写时
 *      要回到**最早**那份，否则回滚完仍是中间态）；
 *   ② `discardCreated()`：只删本次**新建**的文件（已存在的文件哪怕被改过也不归它删 ——
 *      删掉别人的文件比不一致更糟）；
 *   ③ `commitStarted`：一旦置位，**任何失败都不再回滚**。因为此刻数据已落盘，回滚等于吃掉
 *      刚写的成果，那是比不一致更大的损失。
 *
 * 另外锁三件最容易写错、也最难从现象反推的事：
 *   - 模块级 `activeLog` 的生命周期：`runWithRollback` 成功、失败、抛错**三条路径都必须解绑**。
 *     漏解绑的表现是「回滚看起来成功了，但文件还在」—— 下一个请求拿到的是别人的账本；
 *   - 嵌套绑定必须**当场拒绝**（`MT_FS_LOG_MISUSE`）：提交集合一旦分裂成两个，内层的改动
 *     外层看不到，同一个现象、更难查；
 *   - 记账只看「磁盘上真的变了」（写前 `pathExists` 判定），不看业务函数说它改了哪些 ——
 *     前者是事实，后者是「业务以为」。
 *
 * 跨平台口径：本文件全部走 `fs` + 临时目录，不涉及权限位与符号链接，Windows/POSIX 同结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTextAtomicRaw } from '../src/core/fs/atomic-write.ts'
import {
  appendText,
  bindWriteLog,
  currentWriteLog,
  FsError,
  runWithRollback,
  snapshotFor,
  writeTextAtomic,
  WriteLog,
} from '../src/core/fs/write-log.ts'

/** 每个用例自己的临时目录（`activeLog` 是模块级状态，磁盘也不能串味）。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'myteam-fs-'))
}

/** 删临时目录。`maxRetries` 兜 Windows 上文件句柄释放的延迟。 */
function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
}

/* ── 1. 没有账本时：写盘行为不变 ─────────────────────────────── */

test('t136-1: 未绑定记账本时 writeTextAtomic 照常写盘，currentWriteLog() 为 null', () => {
  const dir = tempDir()
  try {
    assert.equal(
      currentWriteLog(),
      null,
      '没有 runWithRollback 时 activeLog 必须是 null：单文件写不需要记账，也不该被上一轮的账本粘住',
    )

    const path = join(dir, 'team.json')
    writeTextAtomic(path, 'plain')
    assert.equal(
      readFileSync(path, 'utf8'),
      'plain',
      '无账本时 writeTextAtomic 的写盘行为必须与 writeTextAtomicRaw 完全一致（记账是附加，不是前提）',
    )
    assert.equal(currentWriteLog(), null, '写盘本身不能凭空绑出一个账本')
  } finally {
    cleanup(dir)
  }
})

/* ── 2. 绑定 / 解绑 / 重复绑定拒绝 ───────────────────────────── */

test('t136-2: bindWriteLog 返回的 unbind 能解绑；重复绑定抛 MT_FS_LOG_MISUSE', () => {
  const log = new WriteLog()
  const unbind = bindWriteLog(log)
  try {
    assert.equal(currentWriteLog(), log, '绑定后 currentWriteLog 必须就是这一本')

    assert.throws(
      () => bindWriteLog(new WriteLog()),
      (error: unknown) => {
        assert.ok(error instanceof FsError, '必须抛 FsError（调用方按 MT_* 码分支）')
        assert.equal(
          (error as FsError).code,
          'MT_FS_LOG_MISUSE',
          '嵌套绑定必须直接拒绝：提交集合分裂的表现是「回滚看似成功但文件还在」，比不记账更难查',
        )
        assert.match((error as Error).message, /重复绑定/, '消息必须点名「重复绑定」，否则读的人会以为是磁盘问题')
        return true
      },
    )
    assert.equal(currentWriteLog(), log, '拒绝之后原来那本必须仍然生效（拒绝不能顺手把它清掉）')
  } finally {
    unbind()
  }

  assert.equal(currentWriteLog(), null, 'unbind 之后必须解绑，否则后面所有写盘都会记进一个已经结束的账本')

  // 解绑后可以再开一轮：证明 unbind 不是一次性的
  const again = bindWriteLog(new WriteLog())
  again()
  assert.equal(currentWriteLog(), null)
})

/* ── 3. record：去重保序 + created 只在新建时进 ───────────────── */

test('t136-3: record 去重保序；created 只接受「写之前不存在」的路径', () => {
  const log = new WriteLog()
  log.record('/a', true, false)
  log.record('/b', true, true)
  log.record('/a', true, true) // 同一个路径第二次写（第一次已建出来）
  log.record('/c', false, false) // 复原 / 外壳刷盘：track=false 不进 changed

  assert.deepEqual(
    [...log.changed],
    ['/a', '/b'],
    'changed 必须去重保序：重复路径会让提交命令对同一个文件跑两次，顺序则决定日志可读性',
  )
  assert.deepEqual([...log.created], ['/b', '/a'], 'created 也必须去重保序（同一个新文件写两次只算一个）')
  assert.equal(log.hasWrites(), true, '有 changed 就说明这一轮写过东西')
})

/* ── 4. recordPresync：首次留档生效 ──────────────────────────── */

test('t136-4: recordPresync 首次留档生效（同一文件记两次保留最早那份 before）', () => {
  const log = new WriteLog()
  log.recordPresync('/a', 'first', true)
  log.recordPresync('/a', 'second', true)

  assert.equal(
    log.presync.length,
    1,
    '同一路径只能有一条 presync：重复登记要么追加要么覆盖，两种都会破坏「回到命令开始时」的语义',
  )
  assert.deepEqual(
    log.presync[0],
    { path: '/a', before: 'first', had: true },
    '留**最早**那份 before：保留最后一次等于把本轮自己的改动当成回滚基线，回滚只能退到「第一次写之后」',
  )

  log.recordPresync('/b', null, false)
  assert.deepEqual(
    log.presync.map((record) => record.path),
    ['/a', '/b'],
    '不同路径按记录顺序排列（回滚时再倒过来遍历）',
  )
})

/* ── 5. commitSet：changed ∪ presync ─────────────────────────── */

test('t136-5: commitSet() = changed ∪ presync，去重保序（changed 在前）', () => {
  const log = new WriteLog()
  log.record('/a', true, false)
  log.record('/b', true, true)
  log.recordPresync('/b', 'b0', true) // 与 changed 重叠
  log.recordPresync('/c', null, false)

  assert.deepEqual(
    log.commitSet(),
    ['/a', '/b', '/c'],
    'presync 必须进提交集合（取最新把远端内容刷进了工作树，这些「不是我写的」改动也要随本次落定），且不能重复',
  )

  log.recordPresync('/d', 'd0', true)
  assert.deepEqual(log.commitSet(), ['/a', '/b', '/c', '/d'], '后记的 presync 追加在尾部')

  // 每次返回独立数组：调用方 sort 一下不能把账本内部顺序改掉
  const first = log.commitSet()
  first.reverse()
  assert.deepEqual(log.commitSet(), ['/a', '/b', '/c', '/d'], 'commitSet 必须是独立快照，不能被调用方就地改坏')
})

/* ── 6. hasWrites：只有 presync 也算写过 ─────────────────────── */

test('t136-6: hasWrites() 空账本为 false；只有 presync 也是 true', () => {
  const log = new WriteLog()
  assert.equal(log.hasWrites(), false, '空账本不能触发提交（空提交会把「什么都没干」当成一次真改动）')

  log.recordPresync('/a', 'before', true)
  assert.equal(
    log.hasWrites(),
    true,
    '只有 presync 也必须算「写过」：取最新已经改了工作树，不提交就停在「已改未提交」的中间态',
  )
})

/* ── 7. rollbackPresync：逆序还原 ────────────────────────────── */

test('t136-7: rollbackPresync 逆序还原（返回数组是倒序，文件回到写前内容）', () => {
  const dir = tempDir()
  try {
    const paths = ['a.json', 'b.json', 'c.json'].map((name) => join(dir, name))
    for (const [index, path] of paths.entries()) {
      writeTextAtomicRaw(path, `orig-${index}`)
    }

    const log = new WriteLog()
    for (const [index, path] of paths.entries()) {
      log.recordPresync(path, `orig-${index}`, true)
      writeTextAtomicRaw(path, `dirty-${index}`)
    }

    const done = log.rollbackPresync()

    assert.deepEqual(
      done,
      [paths[2], paths[1], paths[0]],
      '必须逆序还原：同一文件被多次写时要回到最早那份，正序回滚会把它写成中间态',
    )
    for (const [index, path] of paths.entries()) {
      assert.equal(readFileSync(path, 'utf8'), `orig-${index}`, `第 ${index} 个文件必须回到写前内容`)
    }
    assert.deepEqual([...log.presync], [], '回滚后 presync 必须清空（否则重复收尾会把回滚当成新改动再提交一次）')
  } finally {
    cleanup(dir)
  }
})

/* ── 8. discardCreated：只删本次新建 ─────────────────────────── */

test('t136-8: discardCreated 只删本次新建的文件，已存在的（被改过的）一个不删', () => {
  const dir = tempDir()
  try {
    const existing = join(dir, 'team.json')
    const created = join(dir, 'index.json')
    writeTextAtomicRaw(existing, 'ORIGINAL')

    const log = new WriteLog()
    log.record(existing, true, false) // 已存在
    log.record(created, true, true) // 本次新建
    writeTextAtomicRaw(existing, 'MODIFIED')
    writeTextAtomicRaw(created, '{}')

    const done = log.discardCreated()

    assert.deepEqual(done, [created], '只该删本次新建的那一个（返回值供日志/断言）')
    assert.equal(existsSync(created), false, '本次新建的文件必须删掉，否则下次运行会在残留文件上接着写')
    assert.equal(
      readFileSync(existing, 'utf8'),
      'MODIFIED',
      '已存在的文件不归 discardCreated 管：它由 rollbackPresync 按快照还原，删掉等于丢别人的数据',
    )
    assert.deepEqual([...log.created], [], '删完必须清空 created，避免重复收尾')
  } finally {
    cleanup(dir)
  }
})

/* ── 9. runWithRollback 成功路径 ─────────────────────────────── */

test('t136-9: runWithRollback 成功路径：写盘生效、返回值透传、log 被 clear、没有残留绑定', () => {
  const dir = tempDir()
  try {
    const existing = join(dir, 'team.json')
    const fresh = join(dir, 'index.json')
    writeTextAtomicRaw(existing, 'ORIGINAL')
    let captured: WriteLog | undefined

    const value = runWithRollback('createTeam', (log) => {
      captured = log
      snapshotFor(log, existing)
      writeTextAtomic(existing, 'v2')
      writeTextAtomic(fresh, '{}')
      assert.equal(log.hasWrites(), true, '体内写过东西必须可见（否则提交集合是空的）')
      return 42
    })

    assert.equal(value, 42, 'runWithRollback 必须透传业务体返回值（不然调用方拿不到结果）')
    assert.equal(readFileSync(existing, 'utf8'), 'v2', '成功路径不能回滚：写入必须留着')
    assert.equal(readFileSync(fresh, 'utf8'), '{}', '新建文件同样要留（回滚只发生在失败路径）')
    assert.ok(captured !== undefined, '业务体必须拿到本次账本')
    assert.deepEqual([...captured.changed], [], '成功收尾必须 clear 账本（否则这条命令会一直带着「我要提交」的脏状态）')
    assert.deepEqual([...captured.created], [], 'created 同样要清')
    assert.deepEqual([...captured.presync], [], 'presync 同样要清')
    assert.equal(captured.hasWrites(), false, 'clear 之后 hasWrites 必须是 false')
    assert.equal(currentWriteLog(), null, '成功路径也必须解绑')
  } finally {
    cleanup(dir)
  }
})

/* ── 10. runWithRollback 失败路径（未提交）────────────────────── */

test('t136-10: 失败（未 markCommitStarted）→ 还原被覆盖文件、删除新建文件、原始错误原样抛出', () => {
  const dir = tempDir()
  try {
    const overwritten = join(dir, 'team.json')
    const created = join(dir, 'index.json')
    writeTextAtomicRaw(overwritten, 'ORIGINAL')
    const boom = new Error('账本 fsync 失败')

    assert.throws(
      () =>
        runWithRollback('createTeam', (log) => {
          snapshotFor(log, overwritten)
          writeTextAtomic(overwritten, 'HALF-WRITTEN')
          writeTextAtomic(created, '{}')
          throw boom
        }),
      (error: unknown) => {
        assert.equal(
          error,
          boom,
          '原始错误必须原样抛出：包一层 FsError 会让调用方按码分支的判定失效，也丢掉原始堆栈',
        )
        return true
      },
    )

    assert.equal(
      readFileSync(overwritten, 'utf8'),
      'ORIGINAL',
      '被覆盖的文件必须回到写前内容 —— 否则磁盘上留着半个团队，下一个读的人会当真',
    )
    assert.equal(
      existsSync(created),
      false,
      '本次新建的文件必须删掉 —— 残留文件会让下一次运行在半个团队上接着写',
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 11. commitStarted 之后不回滚 ────────────────────────────── */

test('t136-11: markCommitStarted() 之后失败 → 不回滚（文件保持失败前的写入结果）', () => {
  const dir = tempDir()
  try {
    const overwritten = join(dir, 'team.json')
    const created = join(dir, 'index.json')
    writeTextAtomicRaw(overwritten, 'ORIGINAL')
    const boom = new Error('归档文件写失败')

    assert.throws(
      () =>
        runWithRollback('archiveTeam', (log) => {
          snapshotFor(log, overwritten)
          writeTextAtomic(overwritten, 'COMMITTED')
          writeTextAtomic(created, '{}')
          log.markCommitStarted() // 数据已落盘：越过不可逆边界
          throw boom
        }),
      (error: unknown) => error === boom,
    )

    assert.equal(
      readFileSync(overwritten, 'utf8'),
      'COMMITTED',
      '置位后回滚等于吃掉刚写的成果 —— 那比不一致更大的损失，所以必须原样留着',
    )
    assert.equal(readFileSync(created, 'utf8'), '{}', '新建文件同样不能删：它已经是提交的一部分')
    assert.equal(currentWriteLog(), null, '不回滚也要解绑')
  } finally {
    cleanup(dir)
  }
})

/* ── 12. 嵌套 runWithRollback 拒绝 ───────────────────────────── */

test('t136-12: 嵌套 runWithRollback → 内层抛 MT_FS_LOG_MISUSE，外层仍按失败收尾', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'team.json')
    writeTextAtomicRaw(path, 'ORIGINAL')

    assert.throws(
      () =>
        runWithRollback('outer', (log) => {
          snapshotFor(log, path)
          writeTextAtomic(path, 'DIRTY')
          runWithRollback('inner', () => {
            // 永远不该执行到：内层绑定在进 try 之前就炸
          })
        }),
      (error: unknown) => {
        assert.ok(error instanceof FsError, '必须抛 FsError')
        assert.equal(
          (error as FsError).code,
          'MT_FS_LOG_MISUSE',
          '嵌套必须当场拒绝：内层的改动外层看不到，回滚会「看起来成功」但文件还在',
        )
        return true
      },
    )

    assert.equal(
      readFileSync(path, 'utf8'),
      'ORIGINAL',
      '外层仍然要按失败收尾（内层没写任何东西，但外层已经写了）',
    )
    assert.equal(currentWriteLog(), null, '内层抛错也不能把外层的绑定留下（finally 必须在两条路径上都跑到）')
  } finally {
    cleanup(dir)
  }
})

/* ── 13. snapshotFor：写前留档 ───────────────────────────────── */

test('t136-13: snapshotFor 把文件登记进 presync（已存在 had:true / 不存在 had:false），不污染 changed', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'team.json')
    const ghost = join(dir, 'ghost.json')
    writeTextAtomicRaw(path, 'BEFORE')

    const log = new WriteLog()
    assert.equal(log.presync.length, 0, '新账本必须是空的')

    snapshotFor(log, path)
    snapshotFor(log, ghost)

    assert.equal(log.presync.length, 2, '每留档一个文件 presync 长度 +1（回滚的唯一依据）')
    assert.deepEqual(log.presync[0], { path, before: 'BEFORE', had: true }, '已存在：记下完整原文')
    assert.deepEqual(log.presync[1], { path: ghost, before: null, had: false }, '不存在：记下 had:false，回滚时据此删除')
    assert.deepEqual([...log.changed], [], '留档本身不写盘，不能进「本次改动」（否则空操作也会被提交）')
    assert.equal(log.hasWrites(), true, '但 presync 也算写过：取最新的内容已经进了工作树')
  } finally {
    cleanup(dir)
  }
})

/* ── 14. 收尾后 activeLog 恢复 null（含抛错路径）─────────────── */

test('t136-14: 收尾后 currentWriteLog() 恢复为 null（即使业务体抛错），可以再开新一轮', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'team.json')
    const boom = new Error('业务体炸了')

    assert.throws(
      () =>
        runWithRollback('explode', () => {
          throw boom
        }),
      (error: unknown) => error === boom,
    )
    assert.equal(
      currentWriteLog(),
      null,
      '抛错路径也必须解绑：否则下一个请求拿到别人的账本，表现为「回滚看似成功但文件还在」',
    )

    // 再开一轮：证明没有残留状态（上一轮的 changed/created 不会漏进来）
    runWithRollback('again', (log) => {
      assert.deepEqual([...log.changed], [], '新一轮必须是空账本')
      assert.deepEqual([...log.created], [], 'created 也要是空的')
      assert.equal(log.commitStarted, false, 'commitStarted 每轮从 false 开始（否则一次提交后所有失败都不回滚）')
      writeTextAtomic(path, 'ok')
    })
    assert.equal(readFileSync(path, 'utf8'), 'ok', '解绑后重新绑定必须能正常写入')
    assert.equal(currentWriteLog(), null)
  } finally {
    cleanup(dir)
  }
})

/* ── 15. 记账由真实写盘驱动（writeTextAtomic / appendText）─────── */

test('t136-15: writeTextAtomic / appendText 由真实写盘驱动记账（新建进 created，已存在只进 changed）', () => {
  const dir = tempDir()
  try {
    const existing = join(dir, 'team.json')
    const fresh = join(dir, 'index.json')
    const ledger = join(dir, 'events.jsonl')
    writeTextAtomicRaw(existing, 'v0') // 账本之外先建好：写之前就存在

    runWithRollback('createTeam', (log) => {
      writeTextAtomic(existing, 'v1') // 覆盖
      writeTextAtomic(fresh, '{}') // 新建
      appendText(ledger, '{"i":1}\n') // 新建（追加）

      assert.deepEqual(
        [...log.changed],
        [existing, fresh, ledger],
        'changed 必须按真实写盘顺序（提交顺序影响日志可读性）',
      )
      assert.deepEqual(
        [...log.created],
        [fresh, ledger],
        'created 只装写之前不存在的文件：已存在的 team.json 不能被当成新建（否则回滚会删掉别人的文件）',
      )
    })

    assert.equal(readFileSync(existing, 'utf8'), 'v1', '覆盖写必须生效')
    assert.equal(readFileSync(fresh, 'utf8'), '{}', '新建写必须生效')
    assert.equal(readFileSync(ledger, 'utf8'), '{"i":1}\n', '追加写必须生效（记账不能把它变成整份替换）')
  } finally {
    cleanup(dir)
  }
})

/* ── 16. clear()：全部清零 ──────────────────────────────────── */

test('t136-16: clear() 把 changed / created / presync 全部清零，hasWrites 归 false', () => {
  const log = new WriteLog()
  log.record('/a', true, true)
  log.recordPresync('/b', 'b0', true)
  assert.equal(log.hasWrites(), true)

  log.clear()

  assert.deepEqual([...log.changed], [], 'changed 必须清空')
  assert.deepEqual([...log.created], [], 'created 必须清空')
  assert.deepEqual([...log.presync], [], 'presync 必须清空（残留会在下一轮收尾时被当成要回滚的东西）')
  assert.equal(log.hasWrites(), false, 'clear 之后「要不要提交」必须是 false，否则空提交会被当成真改动')
  assert.deepEqual(log.commitSet(), [], '提交集合也要是空的')
})
