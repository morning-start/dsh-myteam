/**
 * T135（CHG-174）：全仓**唯一写盘原语** `atomic-write.ts` 的不变量。
 *
 * 为什么要有这个测试：CHG-174 把原来的「写临时文件 + rename」两步写升级成八步写序
 * （父目录存在性 → 拒符号链接 → 捕获原权限 → 同目录唯一临时文件 → 写入 → fsync(file)
 * → chmod → rename → fsync(dir)）。原实现少掉的四样东西，**每一样都是真实故障面**：
 *   ① 没有 `fsync(file)`：`rename` 只改目录项，页缓存没落盘时掉电会得到「文件名在、内容是
 *      空洞」的文件 —— 长度对、内容全 `\0`，比丢文件更难查；
 *   ② 没有 `fsync(dir)`：`rename` 产生的目录项本身也会丢，掉电后新旧名字都不在；
 *   ③ 临时文件名固定成 `${path}.tmp`：两个写者并发时互相覆盖，`rename` 出来的是两份内容
 *      交织的**半截 JSON** —— 这是「并发写坏文件」，不是「最后写入者胜」；
 *   ④ 不拒符号链接：`ln -s ~/.ssh/id_rsa team.json` 之后一次「原子写」就把它替换成普通文件，
 *      等于**写穿到任意路径**。
 *
 * ①② 依赖掉电，单测观测不到，所以本文件只锁**可观测的那几条**：
 *   - 权限：新建文件 0644、覆盖时**继承原权限**（临时文件是 0600，不继承会把 0644 的配置
 *     静默改成仅所有者可读）；
 *   - 拒符号链接：抛 `MT_FS_SYMLINK_REFUSED` 且**链接目标一个字节都不变**（这是「写穿没发生」
 *     的唯一证据，只断言抛错是不够的）；
 *   - 失败语义：任何一步失败都清理临时文件、目标文件保持原样 —— 「整份替换」的全部价值就是
 *     **不存在写坏一半的中间态**，重跑一次即可；
 *   - 临时文件唯一性：串行/并发连写都不留 `*.tmp` 残留。
 *
 * 剩下几条是纯便利函数（`fingerprint` / `snapshot` / `restore` / `removeIfExists` / `ensureDir`）
 * 的契约：它们没有并发面，但错一次就让上层「我读完以后别人动过没有」的判定失效。
 *
 * 跨平台口径：`chmod` 在 Windows 上只映射「只读位」，`stat` 拿到的是 0666 / 0444 而不是
 * 0644 / 0600，因此权限断言按 `process.platform` 取期望值（详见 `NEW_FILE_MODE`）；
 * 符号链接需要权限，拿不到就 `t.skip`（跳过 ≠ 通过，报告里会体现）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTextSync,
  ensureDir,
  fingerprint,
  FsError,
  fsyncDir,
  removeIfExists,
  restore,
  snapshot,
  writeTextAtomicRaw,
} from '../src/core/fs/atomic-write.ts'

/**
 * 新建文件的期望权限。
 *
 * Windows 上 `chmod` 只有「只读位」一位的意思（Node 文档），`stat` 会返回 0666（可写）或
 * 0444（只读），拿不到 0644。硬断言 0644 会在这里必红，而红的原因与被测代码无关 ——
 * 所以按平台取期望值，同时在 POSIX 上保留 0644 的强断言。
 */
const NEW_FILE_MODE = process.platform === 'win32' ? 0o666 : 0o644

/** 每个用例自己的临时目录（不共用，避免用例之间通过磁盘串味）。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'myteam-fs-'))
}

/** 删临时目录。`maxRetries` 兜 Windows 上文件句柄释放的延迟。 */
function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
}

/** 目录里残留的临时文件（本模块临时文件名固定以 `.tmp` 结尾）。 */
function tmpFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'))
}

/** 权限位（`stat.mode` 去掉文件类型位）。 */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

/* ── 1. 新建文件：内容 + 权限 ─────────────────────────────────── */

test('t135-1: writeTextAtomicRaw 写新文件：内容一字不差、权限 0644（不是临时文件的 0600）', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'team.json')
    writeTextAtomicRaw(path, '{"id":"t1"}\n')

    assert.equal(readFileSync(path, 'utf8'), '{"id":"t1"}\n', '整份替换必须一字不差地落盘')
    assert.ok(statSync(path).isFile(), '目标必须是普通文件（不是残留的临时文件被改名成别的形状）')
    assert.equal(
      modeOf(path),
      NEW_FILE_MODE,
      '新建文件必须是 0644：临时文件建出来是 0600，漏掉 chmod 会让 0644 的配置退化成仅所有者可读',
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 2. 覆盖写：继承原权限 ───────────────────────────────────── */

test('t135-2: 覆盖已有文件时继承原权限（0600 不会被抬成 0644）', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'secret.json')
    writeTextAtomicRaw(path, 'old')
    chmodSync(path, 0o600)
    const before = modeOf(path)

    writeTextAtomicRaw(path, 'new')

    assert.equal(readFileSync(path, 'utf8'), 'new', '内容必须是新的')
    assert.equal(
      modeOf(path),
      before,
      '覆盖写必须继承原权限：临时文件是 0600，若这里变成 0644 就说明权限被静默放宽了',
    )
    if (process.platform !== 'win32') {
      assert.equal(modeOf(path), 0o600, 'POSIX 上 0600 必须原样保留（group/other 不能重新可读）')
    }
  } finally {
    cleanup(dir)
  }
})

/* ── 3. 父目录不存在：刻意报错，不自动建目录 ───────────────────── */

test('t135-3: 父目录不存在 → MT_FS_WRITE_FAILED，消息含「父目录」，且不偷偷建目录', () => {
  const dir = tempDir()
  try {
    const parent = join(dir, 'missing-dir')
    const path = join(parent, 'team.json')

    assert.throws(
      () => writeTextAtomicRaw(path, 'x'),
      (error: unknown) => {
        assert.ok(error instanceof FsError, '必须抛 FsError（调用方按 MT_* 码分支，不能靠匹配中文）')
        assert.equal((error as FsError).code, 'MT_FS_WRITE_FAILED', '父目录不存在归一到 MT_FS_WRITE_FAILED')
        assert.match(
          (error as Error).message,
          /父目录/,
          '消息必须点名「父目录」不存在：只说 failed 等于让人猜是路径写错还是磁盘满',
        )
        return true
      },
    )
    assert.equal(
      existsSync(parent),
      false,
      '刻意不自动建目录：自动建会把「路径写错了」变成「在错的地方建出一个新目录」',
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 4. ensureParent：显式要求时才建目录 ─────────────────────── */

test('t135-4: 传 { ensureParent: true } 时自动建父目录并写成功', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'teams', 't1', 'team.json')
    writeTextAtomicRaw(path, 'ok', { ensureParent: true })

    assert.equal(readFileSync(path, 'utf8'), 'ok', 'ensureParent 必须真的把目录建出来再写')
    assert.ok(statSync(join(dir, 'teams', 't1')).isDirectory(), '中间层级也要建（mkdir -p 语义）')
  } finally {
    cleanup(dir)
  }
})

/* ── 5. 拒符号链接：不能「写穿」 ─────────────────────────────── */

test('t135-5: 目标是符号链接 → MT_FS_SYMLINK_REFUSED，且链接目标一个字节都不变', (t) => {
  const dir = tempDir()
  try {
    const real = join(dir, 'real.json')
    const link = join(dir, 'link.json')
    writeFileSync(real, 'ORIGINAL')
    try {
      symlinkSync(real, link)
    } catch {
      t.skip('需要符号链接权限（Windows 需开发者模式或管理员）')
      return
    }

    assert.throws(
      () => writeTextAtomicRaw(link, 'PWNED'),
      (error: unknown) => {
        assert.ok(error instanceof FsError, '必须抛 FsError')
        assert.equal(
          (error as FsError).code,
          'MT_FS_SYMLINK_REFUSED',
          '符号链接必须走独立的码：合并进 MT_FS_WRITE_FAILED 会让调用方以为重试就能过',
        )
        return true
      },
    )

    // 这几条才是「拒符号链接」的全部意义：写穿没有发生
    assert.equal(
      readFileSync(real, 'utf8'),
      'ORIGINAL',
      '链接目标必须原封不动 —— 被改写就等于写穿了任意路径（~/.ssh/id_rsa 这类文件）',
    )
    assert.ok(
      lstatSync(link).isSymbolicLink(),
      '链接本身也必须还是链接：rename 成功过一次就会把它换成普通文件，链接语义已丢',
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 6. 失败路径：不留临时文件（父路径是文件）─────────────────── */

test('t135-6: 父路径是文件 → MT_FS_WRITE_FAILED，目录里不残留 *.tmp', () => {
  const dir = tempDir()
  try {
    const notDir = join(dir, 'not-a-dir')
    writeFileSync(notDir, 'x')

    assert.throws(
      () => writeTextAtomicRaw(join(notDir, 'team.json'), 'x'),
      (error: unknown) => {
        assert.ok(error instanceof FsError, '必须抛 FsError')
        assert.equal((error as FsError).code, 'MT_FS_WRITE_FAILED')
        assert.match((error as Error).message, /不是目录/, '消息要说清「父路径不是目录」，否则用户会去查权限')
        return true
      },
    )
    assert.deepEqual(
      tmpFiles(dir),
      [],
      '失败路径必须清理临时文件：残留 *.tmp 会在下次 rename 时被当成有效数据，也会让目录越写越脏',
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 7. 失败路径：临时文件已建好后才失败（rename 到目录）───────── */

test('t135-7: 目标是已存在的目录 → rename 失败后清理临时文件、目标保持原样', () => {
  const dir = tempDir()
  try {
    const target = join(dir, 'team.json')
    mkdirSync(target)
    writeFileSync(join(target, 'inner.txt'), 'keep')

    assert.throws(
      () => writeTextAtomicRaw(target, 'x'),
      (error: unknown) => {
        assert.ok(error instanceof FsError, '必须抛 FsError')
        assert.equal(
          (error as FsError).code,
          'MT_FS_WRITE_FAILED',
          'rename 到目录失败必须归一成 MT_FS_WRITE_FAILED（调用方只认这一个码，不能漏出 EISDIR）',
        )
        return true
      },
    )

    assert.ok(statSync(target).isDirectory(), '失败后目标必须保持原样：不存在「写坏一半」的中间态')
    assert.equal(readFileSync(join(target, 'inner.txt'), 'utf8'), 'keep', '目标里的内容一个字都不能少')
    assert.deepEqual(
      tmpFiles(dir),
      [],
      '临时文件在 rename 之后才失败，必须由 catch 分支删掉 —— 这是最容易漏的清理路径',
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 8. 连写 20 次：临时文件不累积、最终内容正确 ──────────────── */

test('t135-8: 同一路径串行写 20 次：不留 *.tmp 残留，最终内容等于最后一次', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'team.json')
    for (let index = 0; index < 20; index += 1) {
      writeTextAtomicRaw(path, `v${index}`)
    }

    assert.equal(readFileSync(path, 'utf8'), 'v19', '整份替换：最终内容只能是最后一次写入')
    assert.deepEqual(tmpFiles(dir), [], '每次写完都必须清理自己的临时文件（20 次写 = 20 个潜在残留）')
    assert.deepEqual(
      readdirSync(dir),
      ['team.json'],
      '目录里只能有目标文件本身 —— 出现别的名字说明临时文件命名/清理有泄漏',
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 9. 追加写：只增不改 ─────────────────────────────────────── */

test('t135-9: appendTextSync 追加不覆盖（两次追加 = 两行），且能建新文件', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'events.jsonl')
    appendTextSync(path, '{"i":1}\n')
    appendTextSync(path, '{"i":2}\n')

    assert.equal(
      readFileSync(path, 'utf8'),
      '{"i":1}\n{"i":2}\n',
      'JSONL 账本只增不改：整份重写会把并发写者的行冲掉，也让 10 万行账本每追加一行都 O(n)',
    )

    const nested = join(dir, 'a', 'b', 'events.jsonl')
    appendTextSync(nested, 'x\n', { ensureParent: true })
    assert.equal(readFileSync(nested, 'utf8'), 'x\n', 'ensureParent 对追加同样生效')

    assert.throws(
      () => appendTextSync(join(dir, 'nope', 'events.jsonl'), 'x\n'),
      (error: unknown) => {
        assert.ok(error instanceof FsError, '追加失败也必须归一成 FsError（不能漏出 ENOENT）')
        assert.equal((error as FsError).code, 'MT_FS_WRITE_FAILED')
        return true
      },
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 10. fingerprint：内容哈希 ───────────────────────────────── */

test('t135-10: fingerprint 是内容哈希：不存在 → ""、同内容相同、不同内容不同', () => {
  const dir = tempDir()
  try {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    const ghost = join(dir, 'ghost.txt')

    assert.equal(fingerprint(ghost), '', '不存在必须返回空串（调用方按 "" 判「没有上一份」）')

    writeTextAtomicRaw(a, 'same')
    writeTextAtomicRaw(b, 'same')
    assert.match(fingerprint(a), /^[0-9a-f]{64}$/, '必须是 sha256 十六进制（不是 mtime/size 之类）')
    assert.equal(
      fingerprint(a),
      fingerprint(b),
      '内容相同必须同哈希：否则「我读完以后别人动过没有」会假阳性，白白回滚',
    )

    writeTextAtomicRaw(a, 'different')
    assert.notEqual(fingerprint(a), fingerprint(b), '内容不同必须不同哈希（漏判 = 静默覆盖别人的改动）')

    assert.equal(fingerprint(dir), 'unreadable', '读不出来（EISDIR 等）必须返回 "unreadable" 而不是空串')
  } finally {
    cleanup(dir)
  }
})

/* ── 11. snapshot / restore：按字节还原 ──────────────────────── */

test('t135-11: snapshot 不存在 → {before:null,had:false}；restore 按快照还原或删文件', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'team.json')
    const fresh = join(dir, 'fresh.json')

    assert.deepEqual(
      snapshot(path),
      { before: null, had: false },
      '不存在必须给出 had:false —— 这是「回滚时该删掉这个文件」的唯一依据',
    )

    // 故意带 CRLF 与尾随空格：还原必须是字节级，不能被规范化
    const original = '原内容\n第二行\r\n尾随空格 '
    writeTextAtomicRaw(path, original)
    const saved = snapshot(path)
    assert.deepEqual(saved, { before: original, had: true }, '快照必须拿到写前的完整原文')

    writeTextAtomicRaw(path, '改坏了')
    restore(path, saved.before, saved.had)
    assert.equal(
      readFileSync(path, 'utf8'),
      original,
      '回滚必须按字节还原：CRLF 被改成 LF、尾随空格被 trim 都会让 diff 变脏',
    )

    writeTextAtomicRaw(fresh, 'x')
    restore(fresh, null, false)
    assert.equal(existsSync(fresh), false, 'had:false 的快照表示原本不存在 ⇒ 还原就是删掉它')
  } finally {
    cleanup(dir)
  }
})

/* ── 12. removeIfExists：不存在不算错 ────────────────────────── */

test('t135-12: removeIfExists 对不存在的路径不抛，存在则真删', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'ghost.json')
    removeIfExists(path)
    removeIfExists(path) // 幂等：收尾路径可能被调两次（rollback + discard）

    const real = join(dir, 'real.json')
    writeTextAtomicRaw(real, 'x')
    removeIfExists(real)
    assert.equal(existsSync(real), false, '存在则必须真删')
  } finally {
    cleanup(dir)
  }
})

/* ── 13. ensureDir：幂等 + 递归 + 路径是文件时报错 ────────────── */

test('t135-13: ensureDir 幂等（连调两次不抛）、递归建、路径是文件时抛 MT_FS_WRITE_FAILED', () => {
  const dir = tempDir()
  try {
    const nested = join(dir, 'a', 'b', 'c')
    ensureDir(nested)
    ensureDir(nested) // 幂等：调用点可能重复走同一条路径
    assert.ok(statSync(nested).isDirectory(), '递归建目录必须成功（mkdir -p 语义）')

    const file = join(dir, 'file.txt')
    writeFileSync(file, 'x')
    assert.throws(
      () => ensureDir(file),
      (error: unknown) => {
        assert.ok(error instanceof FsError, '必须抛 FsError 而不是裸 EEXIST')
        assert.equal((error as FsError).code, 'MT_FS_WRITE_FAILED')
        assert.match((error as Error).message, /建目录/, '消息必须点名是「建目录」失败，否则排查会跑偏')
        return true
      },
    )
  } finally {
    cleanup(dir)
  }
})

/* ── 14. FsError 形状 + fsyncDir 刻意吞错 ────────────────────── */

test('t135-14: FsError 带 name/code/instanceof；fsyncDir 对目录失败一律吞掉', () => {
  const dir = tempDir()
  try {
    const error = new FsError('MT_FS_SYMLINK_REFUSED', 'x')
    assert.ok(error instanceof Error, 'FsError 必须是 Error（否则堆栈与 catch 语义都会丢）')
    assert.equal(error.name, 'FsError', 'name 必须是 FsError（日志里要能一眼认出来源）')
    assert.equal(error.code, 'MT_FS_SYMLINK_REFUSED', 'code 必须原样带上 MT_* 码')

    // 存在的目录：POSIX 上 fsync 成功，Windows 上必然报错但被吞 —— 两种都不能抛
    fsyncDir(dir)
    // 不存在的目录：open('r') 抛 ENOENT，同样必须被吞（这是已知取舍，真报出来 Windows 上 100% 写盘失败）
    fsyncDir(join(dir, 'ghost-dir'))
  } finally {
    cleanup(dir)
  }
})

/* ── 15. 整份替换语义 ──────────────────────────────────────── */

test('t135-15: 整份替换：新内容更短时不残留旧尾巴，空内容得到 0 字节文件', () => {
  const dir = tempDir()
  try {
    const path = join(dir, 'team.json')
    writeTextAtomicRaw(path, 'X'.repeat(4096))
    writeTextAtomicRaw(path, 'short')
    assert.equal(
      readFileSync(path, 'utf8'),
      'short',
      '必须是整份替换：残留旧尾巴会让 JSON 解析出两个对象，比报错更难查',
    )

    writeTextAtomicRaw(path, '')
    assert.equal(statSync(path).size, 0, '空内容必须得到 0 字节文件（不是「不写」）')
  } finally {
    cleanup(dir)
  }
})
