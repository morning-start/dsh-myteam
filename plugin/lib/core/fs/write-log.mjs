/**
 * 记账本 + 收尾闸门（CHG-175，移植自 `dsh-task-ledger` 的 `store/dirty.go` + `shell/runner.go`）。
 *
 * ── 解决什么问题 ─────────────────────────────────────────────────────────────
 * 一个「多文件写」的操作（建团队要写目录、`team.json`、`team-index.json`、账本首事件）
 * 中途失败时，前面已写的文件会留在磁盘上，而内存里的状态没有推进 —— 于是**磁盘与状态
 * 不一致**。下一个读的人看到半个团队，下一个写的人接着在半个团队上写。
 *
 * 本模块给这个场景两条**唯一**的收尾路径，并划一条**不可逆边界**：
 *
 *   - `rollbackPresync()`：按「写前快照」**逆序**还原被覆盖的内容（逆序是因为同一文件
 *     可能被多次写，要回到**最早**那份）。
 *   - `discardCreated()`：删掉本次**新建**的文件。
 *   - `commitStarted`：一旦置位，**任何失败都不再回滚**。因为此刻数据已落盘，
 *     回滚等于吃掉刚写的成果 —— 那是比不一致更大的损失。
 *
 * ── 为什么不做 journal ───────────────────────────────────────────────────────
 * journal 解决的是「进程写一半被杀，下次启动要能重放或回滚」。本项目的崩溃恢复责任
 * 交给**固定写序 + 重跑幂等**；引 journal 会引入第二个真源，而它自己也需要原子性与
 * GC，收益为负。`snapshot` / `restore` 只兜**进程内**失败，不落日志文件、不扫残留、
 * 不做启动恢复。
 *
 * ── 依赖方向 ─────────────────────────────────────────────────────────────────
 * `write-log.ts` → `atomic-write.ts`（单向）。原语在 `atomic-write.ts`，
 * 记账与收尾在这里。**反过来不成立** —— 原语不该知道有记账本这回事。
 *
 * ── 使用方式 ─────────────────────────────────────────────────────────────────
 * ```ts
 * runWithRollback('createTeam', (log) => {
 *   snapshotFor(log, teamJsonPath)     // 写前留档：要回滚的文件必须先 snapshot
 *   writeTextAtomic(teamJsonPath, text)
 *   writeTextAtomic(indexPath, indexText)
 *   log.markCommitStarted()            // 走到「不可逆」那一步再置位
 *   appendEvent(ledgerPath, event)
 * })
 * ```
 */
import {
  appendTextSync as appendRaw,
  FsError,
  restore,
  snapshot,
  writeTextAtomicRaw,
                              
} from './atomic-write.mjs'

/** 取最新时刷过的文件 + 刷之前的原文（回滚要回到**命令开始时**，所以按路径覆盖不追加）。 */
                                
              
                       
              
 

/**
 * 一轮逻辑操作的写记录。
 *
 * **提交集合只看它**，不看业务函数说它改了哪些 —— 后者是「业务以为改了」，
 * 前者是「磁盘上真的变了」。
 */
export class WriteLog {
                   changedList           = []
                   createdList           = []
          presyncList                  = []
          started = false

  /** 本次改动（`track: true` 的写）的文件路径，去重保序。 */
  get changed()                    {
    return this.changedList
  }

  /** 本次**新建**（写之前不存在）的文件路径，去重保序。 */
  get created()                    {
    return this.createdList
  }

  /** 提交是否已经开始。**一旦为真，任何失败都不再回滚。** */
  get commitStarted()          {
    return this.started
  }

  /**
   * 置位「提交已开始」。
   *
   * 调用时机：**数据已经不可逆地落盘**（账本 fsync 完成 / 归档文件写完）。
   * 置位之后再失败，收尾只报告、不回滚 —— 回滚会把已提交的内容从工作树里抹掉，
   * 那才是真丢数据。
   */
  markCommitStarted()       {
    this.started = true
  }

  /** 记一次写。`track=false`（复原 / 外壳刷盘）不进改动集合。 */
  record(path        , track         , created         )       {
    if (created && !this.createdList.includes(path)) this.createdList.push(path)
    if (track && !this.changedList.includes(path)) this.changedList.push(path)
  }

  /**
   * 记「这个文件被取最新刷过」+ 刷之前的原文。
   *
   * **首次留档生效**：同一路径重复登记保留**最早**那份 `before`，因为回滚要回到「一轮操作
   * 开始时」的那个字节状态；若保留最后一次，回滚只会退回到「第一次写之后」，等于把本轮
   * 自己的改动当成基线。`had` 同理（首见即定：本来在 / 本来不在）。
   */
  recordPresync(path        , before               , had         )       {
    if (this.presyncList.some((record) => record.path === path)) return
    this.presyncList.push({ path, before, had })
  }

  /** 取最新刷过的记录（只读快照）。 */
  get presync()                           {
    return this.presyncList
  }

  /**
   * 最终要「提交」的文件集合：本次改动 ∪ 取最新刷过的（去重保序）。
   *
   * `Presync` 必须进集合：取最新把远端内容刷进了工作树，这些「不是我写的」改动也要
   * 随本次一起落定，否则文件停在「已改未提交」的中间态。
   */
  commitSet()           {
    const out           = []
    for (const path of [...this.changedList, ...this.presyncList.map((record) => record.path)]) {
      if (!out.includes(path)) out.push(path)
    }
    return out
  }

  /** 这一轮有没有写过东西（**判「要不要提交」只认它**）。 */
  hasWrites()          {
    return this.changedList.length > 0 || this.presyncList.length > 0
  }

  /**
   * 失败收尾 ①：按快照**逆序**还原被覆盖的内容。
   *
   * @returns 实际尝试还原的路径（供日志/断言）
   */
  rollbackPresync()           {
    const records = this.presyncList
    this.presyncList = []
    const done           = []
    for (let index = records.length - 1; index >= 0; index -= 1) {
      restore(records[index].path, records[index].before, records[index].had)
      done.push(records[index].path)
    }
    return done
  }

  /**
   * 失败收尾 ②：删掉本次新建的文件。
   *
   * @returns 实际尝试删除的路径
   */
  discardCreated()           {
    const created = [...this.createdList]
    this.createdList.length = 0
    for (const path of created) {
      try {
        restore(path, null, false)
      } catch {
        // 删不掉也不能让收尾本身炸：真正的失败已经由调用方抛出
      }
    }
    return created
  }

  /** 成功路径收尾：全部清零。 */
  clear()       {
    this.changedList.length = 0
    this.createdList.length = 0
    this.presyncList = []
  }
}

/**
 * 当前生效的记账本。`null` = 没有包在 `runWithRollback` 里（单文件写不需要）。
 *
 * 为什么是模块级而不是参数透传：写盘原语的调用点有几十处，让每一处都接一个 `log`
 * 参数会把「记账」这件事散回每个业务函数 —— 正是要避免的。
 */
let activeLog                  = null

/** 当前生效的记账本（没有则 `null`）。 */
export function currentWriteLog()                  {
  return activeLog
}

/**
 * 绑定记账本。
 *
 * **重复绑定直接抛错**：嵌套两层会让提交集合分裂成两个（内层的改动外层看不到），
 * 而分裂的表现是「回滚看起来成功了，但文件还在」—— 比不记账更难查。
 */
export function bindWriteLog(log          )             {
  if (activeLog !== null) {
    throw new FsError(
      'MT_FS_LOG_MISUSE',
      '记账本重复绑定：已有另一轮 WriteLog 生效。' +
        '写盘原语的记账入口只有一个，嵌套绑定会让提交集合分裂（回滚看似成功但文件还在）。',
    )
  }
  activeLog = log
  return () => {
    activeLog = null
  }
}

/**
 * 记账版的原子写：`writeTextAtomicRaw` + 记进当前账本。
 *
 * 这是**业务代码应该用的那个**（原语本身只在 `atomic-write.ts` 里给测试与收尾用）。
 */
export function writeTextAtomic(path        , text        , options                         = {})       {
  const log = activeLog
  const existed = log === null ? false : pathExists(path)
  writeTextAtomicRaw(path, text, options)
  if (log !== null) log.record(path, true, !existed)
}

/** 记账版的追加写（JSONL 账本专用）。 */
export function appendText(path        , text        , options                         = {})       {
  const log = activeLog
  const existed = log === null ? false : pathExists(path)
  appendRaw(path, text, options)
  if (log !== null) log.record(path, true, !existed)
}

/** 写前留档：把一个文件登记进账本的 `presync`（回滚的唯一依据）。 */
export function snapshotFor(log          , path        )       {
  const { before, had } = snapshot(path)
  log.recordPresync(path, before, had)
}

/**
 * 收尾闸门：包住一轮多文件写，失败时按两条路径收尾。
 *
 * 收尾规则（与 `dsh-task-ledger` 的 `shell.Run` 同构）：
 *   - `commitStarted === false` ⇒ `rollbackPresync()` + `discardCreated()`
 *   - `commitStarted === true`  ⇒ **什么都不做**（数据已落盘，回滚等于吃掉成果）
 *   - 成功 ⇒ `log.clear()`
 *
 * 回滚本身失败（磁盘满 / 权限）时抛 `MT_FS_ROLLBACK_INCOMPLETE` 并**同时带上原始错误**，
 * 不谎称「已回滚」——这正是本项目「不假装成功」的纪律。
 *
 * @param label 错误消息里的操作名（如 `createTeam`）
 * @param fn 业务体；参数是本次的记账本，需要写前留档时调 `snapshotFor(log, path)`
 */
export function runWithRollback   (label        , fn                      )    {
  const log = new WriteLog()
  const unbind = bindWriteLog(log)
  try {
    const value = fn(log)
    log.clear()
    return value
  } catch (error) {
    if (!log.commitStarted) {
      try {
        log.rollbackPresync()
        log.discardCreated()
      } catch (rollbackError) {
        throw new FsError(
          'MT_FS_ROLLBACK_INCOMPLETE',
          `${label} 失败且回滚未完成。\n` +
            `  原始错误：${describe(error)}\n` +
            `  回滚错误：${describe(rollbackError)}\n` +
            '  处理：磁盘可能已满或不可写；先手动核对本次涉及的台账文件，再重跑。',
        )
      }
    }
    throw error
  } finally {
    unbind()
  }
}

function describe(error         )         {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function pathExists(path        )          {
  try {
    return snapshot(path).had
  } catch {
    // 读不出来按「已存在」处理：宁可少删一个文件，也不要把别人的文件当成新建的删掉
    return true
  }
}

export { FsError }


//# sourceURL=./src/core/fs/write-log.ts