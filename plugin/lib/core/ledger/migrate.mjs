/**
 * CHG-187b（FR-32 支柱一）：账本**一次性迁移**——`member.spawned` 的派生树三字段
 * （`parentMemberId` / `depth` / `rootMemberId`）从「读时猜默认」升级为「显式迁移」。
 *
 * ── 为什么要迁移，而不是继续在 fold 里兜底 ────────────────────────────────────
 * CHG-187 为了兼容把三字段做成**可选**，缺省语义放在 `fold.ts`（`?? null` / `?? 0` /
 * `?? event.memberId`）。这等于**两份真相**：事件载荷说「可能没有」，折叠层说「没有就是
 * 队长直接召唤的一级成员」。两份真相一旦漂移（比如以后加「子成员可跨团队」），重放结果
 * 取决于哪一边先被改，而账本是唯一权威〔I2〕——**权威的东西不能靠读的时候补**。
 * 现在按用户口径「不必向后兼容，保证能力最重要」：三字段进 `PAYLOAD_REQUIRED`（写入端
 * 必须显式带），历史账本在**打开时一次性迁移**，fold 只读、不再有第二套默认值。
 *
 * ── 为什么版本号不在账本里 ───────────────────────────────────────────────────
 * 账本行格式是 `{seq, ts, actor, type, payload}`，**没有 meta 行**；再放一个
 * `ledger.schema` 旁文件就是第三个真源（旁文件说 2、内容里还缺字段，两边谁对？）。
 * 所以版本由**内容形状**判定：存在缺三字段的 `member.spawned` ⇔ schema 1；一条都没有
 * ⇔ 已是 {@link LEDGER_SCHEMA}。这个判定天然幂等——迁移跑完第二次就无活可干。
 *
 * ── 写盘纪律 ────────────────────────────────────────────────────────────────
 * **先读全量 → 只在内存里补字段 → 一次性原子重写**（`core/fs/atomic-write.ts` 的
 * `writeTextAtomic`：同目录唯一临时名 → fsync(file) → rename → fsync(dir)）。
 * 绝不边读边写：那样写到一半失败会得到**半本账**（比不迁移更糟）。
 * 失败语义由原语保证——任何一步失败都清理临时文件、目标文件保持**原样**；本模块把它
 * 翻译成 `MT_SCHEMA_MIGRATION_FAILED`（**失败大声**，不静默降级成「当作已迁移」）。
 *
 * ── 只动该动的行 ────────────────────────────────────────────────────────────
 * 非 `member.spawned` 行、以及三字段已经齐全的行**原样保留**（逐字节），所以：
 *   - 迁移不重排/不重编码其它事件；
 *   - 崩溃残行（不可解析）不归迁移管，留给 `openLedger` 的截断路径（它才懂 seq 语义）；
 *   - 已经迁移过的文件再跑一次是 **no-op**（连 mtime 都不动）。
 */
import { readFileSync } from 'node:fs'
import { MTError } from '../errors.mjs'
import { writeTextAtomic } from '../fs/write-log.mjs'

/**
 * 当前账本 schema 版本。
 *
 * - **1** = 派生树三字段可选（CHG-187 的向后兼容态；`fold` 靠缺省补一级成员）；
 * - **2** = 三字段必填（CHG-187b）：新账本由写入端显式带，历史账本由
 *   {@link migrateLedgerIfNeeded} 一次性补齐。
 *
 * 唯一来源在这里（`ledger.ts` 只 re-export）——放 `ledger.ts` 会和 `ledger → migrate`
 * 的依赖方向成环（`migrate.ts` 需要 `writeTextAtomic`，而 `openLedger` 需要迁移）。
 */
export const LEDGER_SCHEMA = 2

/**
 * 写盘口（测试注入点，形状与 `writeTextAtomic(path, text)` 一致）。
 *
 * 为什么留这个参数：`t139-13` 要验证「**写盘失败后原账本一个字节都没变**」。
 * 真实磁盘故障（磁盘满 / 只读）在 CI 上不可移植（POSIX 的 rename 能覆盖只读文件，
 * Windows 不能），所以失败用注入制造；而「零改动」是**真实文件**的字节快照断言，
 * 不是桩的返回值断言——这条性质来自 `writeTextAtomic` 的整份替换语义（唯一写口）。
 */
                                                              

/** 一次迁移的结论（`text` 是迁移后的完整账本内容，供调用方**复用**，不必再读一遍） */
                                        
                                                        
                   
                                              
                   
                                                               
              
                                              
            
                                                          
               
 

function messageOf(error         )         {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把账本迁移到当前 schema（幂等：跑第二次是 no-op，不重写）。
 *
 * @param ledgerPath 账本文件（`.../tasks/<teamId>/ledger.jsonl`）
 * @param write 写盘口；默认走 `writeTextAtomic`（**唯一**允许的写盘出口，A2 门禁）
 * @throws MTError `MT_SCHEMA_MIGRATION_FAILED` —— 读失败（除 ENOENT）或写失败；
 *        写失败时原账本**保持原样**（不存在半本账）。
 */
export function migrateLedgerIfNeeded(ledgerPath        , write              = writeTextAtomic)                        {
  let raw        
  try {
    raw = readFileSync(ledgerPath, 'utf8')
  } catch (error) {
    if ((error                         ).code === 'ENOENT') {
      // 还没有账本 = 没有历史可迁（新账本由写入端直接按 schema 2 写）
      return { migrated: false, rewritten: 0, from: LEDGER_SCHEMA, to: LEDGER_SCHEMA }
    }
    throw new MTError(
      'MT_SCHEMA_MIGRATION_FAILED',
      `迁移账本 ${ledgerPath} 失败：读不出来（${messageOf(error)}）。` +
        '  原账本未被修改；先确认路径可读、编码是 UTF-8，再重跑。',
    )
  }

  const lines = raw.split('\n')
  let rewritten = 0
  const migrated = lines.map((line) => {
    if (line.trim().length === 0) return line
    let event         
    try {
      event = JSON.parse(line)
    } catch {
      // 崩溃残行：迁移不认领（openLedger 的截断路径才懂 seq 语义），原样留下
      return line
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) return line
    const record = event                                         
    if (record.type !== 'member.spawned') return line
    const payload = record.payload
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return line
    const fields = payload                           
    // `rootMemberId` 的默认值只能是**事件自己的 memberId**（根成员的树根是它自己）；
    // 连 memberId 都不是字符串的事件已经非法，不在这里造一个假值（否则第二次跑还会「缺」）
    const memberId = typeof fields.memberId === 'string' ? fields.memberId : undefined
    const needsParent = fields.parentMemberId === undefined
    const needsDepth = fields.depth === undefined
    const needsRoot = fields.rootMemberId === undefined && memberId !== undefined
    if (!needsParent && !needsDepth && !needsRoot) return line
    // 默认语义与 CHG-187 的 fold 缺省**逐字相同**：「队长直接召唤的一级成员」
    if (needsParent) fields.parentMemberId = null
    if (needsDepth) fields.depth = 0
    if (needsRoot) fields.rootMemberId = memberId
    rewritten += 1
    return JSON.stringify(event)
  })

  if (rewritten === 0) {
    // 已是最新 schema：**不写盘**（幂等的可观测面 = 文件字节与 mtime 都不动）
    return { migrated: false, rewritten: 0, from: LEDGER_SCHEMA, to: LEDGER_SCHEMA, text: raw }
  }

  const text = migrated.join('\n')
  try {
    write(ledgerPath, text)
  } catch (error) {
    throw new MTError(
      'MT_SCHEMA_MIGRATION_FAILED',
      `迁移账本 ${ledgerPath} 失败：${rewritten} 条 member.spawned 需要补派生树三字段，但写盘失败（${messageOf(error)}）。\n` +
        '  原账本未被修改（整份替换：失败时目标文件保持原样，不存在写坏一半）。\n' +
        '  处理：确认该路径可写、磁盘没满，然后重跑一次（迁移是幂等的）。',
    )
  }
  return { migrated: true, rewritten, from: 1, to: LEDGER_SCHEMA, text }
}


//# sourceURL=./src/core/ledger/migrate.ts