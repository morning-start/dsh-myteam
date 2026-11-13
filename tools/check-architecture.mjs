/**
 * 架构约束门禁（CHG-176）：把「分层」与「写盘出口」这两条口头纪律做成**可机械检查**的 CI 门禁。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * 这两条边界以前只写在文档和 code review 里，靠人记：
 *   - `core/**` 是对外零副作用的领域层，`host.ts` / `remote/**` 是上层装配。一次「顺手 import
 *     一下」就能让 core 反向依赖 remote —— TypeScript **完全不报错**，但依赖图已经成环
 *     （`remote/views.ts` 本来就 import `core/**`），装载顺序变成运气问题。
 *   - 直接 `writeFileSync` 也能跑通，但它少了 fsync 屏障、临时文件名唯一、拒符号链接，
 *     掉电/并发/符号链接三种故障只在**最不该出事**的时候暴露（见 `core/fs/atomic-write.ts`
 *     头注释的四条）。写盘原语必须只有一个出口，否则「哪次写没走原子写」永远查不清。
 *
 * ── 规则码（稳定 id，不要改——改了 issue / 文档里的引用就断）────────────────────
 *   A1 分层      `core/**` 不得 import `host.ts` / `panel.ts` / `remote/**`
 *   A2 写盘出口  文件内容原语只允许出现在 `core/fs/atomic-write.ts`
 *   A3 子进程    `core/**` 不得出现 `child_process`
 *   A4 记账本    只有 `core/fs/write-log.ts` 可以 `new WriteLog(` / 持有 `activeLog`
 *   A5 打印边界  `core/**` 不得 `console.log` / `process.stdout.write`（warn/error 允许）
 *   A6 行数棘轮  `host.ts` 行数只减不增（上限见 {@link A6_LIMIT}）
 *
 * A1–A5 是**行级**规则（一行一条违规，带 line 号）；A6 是**文件级**（判整份文件的行数，
 * 没有「第几行」可言），所以它在扫描后统一算，不塞进 RULES。
 *
 * ── 冻结清单（FROZEN_A2）──────────────────────────────────────────────────────
 * CHG-174 的写盘迁移是分批做的，A2 在迁完之前**必然有存量违规**。门禁的价值是「拦住新增」，
 * 不是「第一天全绿」，所以存量按**文件**冻结：清单内的文件不计入 violations（摘要里单独报
 * `frozen: N`），清单外的任何新违规立刻红。清单一律只减不增 —— 已经迁完的文件还挂在清单里
 * 会报 `A2-STALE-FROZEN`，逼着删条目（否则清单会烂成一张没人看的白名单）。
 *
 * 注意：Lead 会在迁移完成后把 FROZEN_A2 刷成**剩余项（可能为空）**。空清单是目标态。
 *
 * ── 三个已知取舍（都点名代价）──────────────────────────────────────────────────
 *   ① 只剥「行首是注释」的行（`//`、`*`、`/*`）。行内注释、模板串里的原语名不剥 ——
 *      真剥要么引 TS 解析器（本仓零依赖纪律），要么写半个词法器（比不剥更糟）。
 *      代价：`const s = "from '../host.ts'"` 这种字符串会误报。可接受，因为它一眼看得出。
 *   ② 按**文件**冻结而不是按行号：行号会随迁移漂移，按行冻结等于每天改清单。
 *   ③ 不判断 import 的符号是否真被用到。`import { writeFileSync }` 就是准备写盘 ——
 *      这比等到调用点更早拦住，也和「文件级冻结」同一粒度。
 *
 * 运行：node tools/check-architecture.mjs
 *   退出码：ARCH_VIOLATIONS 为 0 时 0，否则 1（可直接当 CI 门禁）
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = fileURLToPath(new URL('../plugin/', import.meta.url))

/** 唯一豁免 A2 的文件（原语本体）；A4 的唯一持有者（记账本） */
const ATOMIC_WRITE = 'core/fs/atomic-write.ts'
const WRITE_LOG = 'core/fs/write-log.ts'

/**
 * A2 存量清单：相对 `plugin/src` 的 posix 路径，**排序去重**。
 *
 * 由 `node tools/check-architecture.mjs` 实测得出。CHG-174 迁移期间这里是 5 条
 * （`core/members/member-card.ts`、`core/members/memory.ts`、`core/presets/preset-store.ts`、
 * `core/roles/session-defaults.ts`、`core/workspace/layout.ts`）；迁移完成后由 Lead 刷成
 * **剩余项，可能为空** —— 现在就是空的，这是目标态。
 *
 * 不要为了「让门禁绿」往这里加条目：那等于把门禁关掉。加条目的唯一理由是有一次
 * 明确分期的迁移还没做完，且条目会随迁移一起被删。
 */
export const FROZEN_A2 = []

/**
 * A6 入口层行数棘轮：`host.ts` 只减不增（拆薄是持续动作，不是一次性运动）。
 *
 * 为什么单独成**文件级**检查而不在 RULES 里：RULES 每条都是「一行一条违规」，A6 判的是
 * 整份文件的行数（没有第几行可言），混进去只会让 line 号失去意义。所以它在扫描后统一算。
 *
 * 上限写在 A6_LIMIT 里，**每次拆完手动下调**；CI 上只要涨就红。
 *
 * 行数口径 = `code.split('\n').length`，与 `tools/arch-report.mjs` 的 `loc` 完全一致，
 * 也就是计划 §4 写的「`host.ts` 6,210 行」。**不要**用
 * `(Get-Content src/host.ts | Measure-Object -Line).Lines`：本仓源码是 UTF-8 无 BOM +
 * 大量中文注释，Windows 下 `Get-Content` 会按错误编码解码而少报约 900 行（实测报 5,319，
 * 真实 6,209 行 / 6,210 个 split 元素）——拿它当基线，棘轮会凭空多出 900 行余量。
 *
 * 基线演进：CHG-186 动手前 6,210 → 契约下沉（`MyTeamConfig` / `KnowledgeView` 搬到
 * `core/host/contract.ts`）后 **6,163** → T155b 搬走成员族（`src/host/members.ts`）后
 * **6,160** → 再搬走任务族（`src/host/tasks.ts`）后 **5,961** → T155c 搬走计划族
 * （`src/host/plan.ts`）后 **5,715** → 再搬走角色族（`src/host/roles.ts`）后 **5,710** →
 * 再搬走团队族（`src/host/teams.ts`）后 **5,682** → 再搬走知识族
 * （`src/host/knowledge.ts`）后 **5,536** → 再搬走查询族（`src/host/query.ts`）后
 * **5,563**。棘轮直接钉在**拆完的实测值**上（不留余量：入口层再加一行注释都该红）。
 *
 * ⚠️ 查询族是**唯一会让入口层变高**的一族（+27）：它的 15 个 case 本来就只有两行
 * （`case` + 一行转发），没有内联逻辑可减。搬它换来的是**形状统一**——`executeLeadTool`
 * 的 switch 现在纯是「工具名 → 适配层」路由表。所以这一族的 +27 是口径成本，不是回潮；
 * 下一刀该切的是**行为边界**（`spawnMember` / `reviewTask` / `batchTaskOp` /
 * `scopeAuditFor` 下沉 `core/**`），不是继续按端点切。
 *
 * ── CHG-189（T159a）──────────────────────────────────────────────────────────
 * 第一刀已落：spawn 生命周期 5 个私有方法（`spawnMember` / `settleSpawnActive` /
 * `settleSpawnFailure` / `probeProvisionedSession` / `pendingMessagesFor`）**逐字**搬进
 * `core/members/spawn-lifecycle.ts` → 5,563 → **5,311**（-252 行，入口占比 35.5% → 34.2%）。
 * 逐字核验 281/281 逻辑行一致；下一刀照同样口径切 `reviewTask` / `batchTaskOp` /
 * `scopeAuditFor`（剩下的私有方法体）。
 *
 * ── CHG-190（T159b）──────────────────────────────────────────────────────────
 * 第二刀已落：门禁执行 12 个私有方法（`taskWithGateChain` / `reviewTask` /
 * `expectedRevisionOf` / `scopeAuditFor` / `runVerifyGate` / `captureArtifactBaseline` /
 * `artifactFreshnessFor` / `artifactTextOf` / `completionReplyOf` / `deliveryJudgementFor` /
 * `evaluateArchiveGate` / `autoEvaluateGateChain`）**逐字**搬进
 * `core/gates/gate-execution.ts` → 5,311 → **4,815**（-496 行，入口占比 34.2% → **31.9%**）。
 * 逐字核验 **443/443 逻辑行一致**；`GateExecutionDeps` 17 个成员。
 *
 * ── CHG-191（T159c）──────────────────────────────────────────────────────────
 * 第三刀（收口）已落：批量编排 3 个私有方法（`batchTaskOp` / `createTasksBatch` /
 * `materializeSplitProposal`）**逐字**搬进 `core/tasks/batch-orchestration.ts` →
 * 4,815 → **4,405**（-410 行，入口占比 31.9% → **30.1%**）。
 * 逐字核验 **417/417 逻辑行一致**；`BatchOrchestrationDeps` 7 个成员。
 * `resolveProposal` **没有**搬（提案裁决入口：参数校验 + 按 type 分发 + 驳回留痕，与
 * 「物化」的载荷形状无关），留在入口层原位。
 *
 * 下一刀切剩下的私有方法体：`afterCommit` / `dispatchSweep` / `refreshTeamIndex`
 * （装配与唤醒逻辑）。⚠️ **入口层再降要靠装配逻辑下沉，不是端点**——`executeLeadTool`
 * 的 switch 已经是纯「工具名 → 适配层」路由表，再按端点切只是把转发行搬来搬去。
 */
export const A6_LIMIT = { 'host.ts': 4405 }

/** 递归列出 dir 下扩展名为 ext 的文件（确定性排序；Dirent 直接给答案，不 try/catch 猜目录） */
function walk(dir, ext) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out.sort((a, b) => a.localeCompare(b))
}

const posix = (p) => p.split(sep).join('/')

/**
 * 这一行是不是纯注释。见头注释取舍 ①：只认行首，宁可漏剥也不写半个词法器。
 * （不剥注释的话，`host.ts` 里那句「host 不再直接 writeFileSync」的说明就会被当成违规。）
 */
function isCommentLine(line) {
  const text = line.trimStart()
  return text.startsWith('//') || text.startsWith('/*') || text.startsWith('*')
}

/** 一行里的模块说明符：静态 from / 副作用 import / 动态 import() / export … from 全覆盖 */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"]+)\1/g

/** 相对说明符 → 相对 `src` 的 posix 路径（`core/x.ts` + `../host.ts` → `host.ts`）；裸包名返回 undefined */
function resolveSpecifier(fileRel, specifier) {
  if (!specifier.startsWith('.')) return undefined
  return posix(join(dirname(fileRel), specifier))
}

/** 从 from 文件指向 to 文件时该写的相对说明符（修法提示要能直接粘） */
function specifierFrom(fromRel, toRel) {
  const spec = posix(relative(dirname(fromRel), toRel))
  return spec.startsWith('.') ? spec : `./${spec}`
}

const isCore = (rel) => rel.startsWith('core/')

/** 规则表：每条一个稳定 id + 一行「为什么违规」+ 一行「怎么改」 */
const RULES = [
  {
    id: 'A1',
    check(line, rel) {
      if (!isCore(rel)) return undefined
      for (const match of line.matchAll(IMPORT_SPECIFIER)) {
        const target = resolveSpecifier(rel, match[2])
        if (target === undefined) continue
        const upperLayer = target === 'host.ts' || target === 'panel.ts' || target.startsWith('remote/')
        if (!upperLayer) continue
        return {
          message:
            `core 层反向 import 上层模块 ${target}：core 必须能被 remote 之外的任何层独立装载，` +
            `而 ${target} 本身就依赖 core/**，反向 import 直接把依赖图变成环`,
          fix:
            `不要 import ${target}：把要用的纯函数下沉到 core/**（视图构建器放 core/index/views.ts，` +
            `由 ${target} re-export，调用点不用动），core 只允许依赖 core`,
        }
      }
      return undefined
    },
  },
  {
    id: 'A2',
    // 原语本体豁免：它**就是**那个出口。除它以外谁都不许碰（含 write-log.ts —— 那里只做记账转发）
    check(line, rel) {
      if (rel === ATOMIC_WRITE) return undefined
      const hit = /\b(writeFileSync|writeSync|appendFileSync|truncateSync|fsyncSync|openSync)\b/.exec(line)
      if (hit === null) return undefined
      return {
        message:
          `直接调用 ${hit[1]}：文件内容必须走 ${WRITE_LOG} 的 writeTextAtomic` +
          '（整份替换 + fsync 屏障 + 唯一临时名 + 拒符号链接）',
        fix: `import { writeTextAtomic } from '${specifierFrom(rel, WRITE_LOG)}'`,
      }
    },
  },
  {
    id: 'A3',
    check(line, rel) {
      if (!isCore(rel) || !/\bchild_process\b/.test(line)) return undefined
      return {
        message:
          'core 层出现 child_process：子进程会绕开记账本与 MT_* 错误码，' +
          '并让「纯领域层」依赖宿主可执行文件（可测性直接归零）',
        fix: '把子进程调用上移到 host.ts / remote/**，core 只接受注入进来的纯函数',
      }
    },
  },
  {
    id: 'A4',
    check(line, rel) {
      if (rel === WRITE_LOG) return undefined
      if (/\bnew WriteLog\s*\(/.test(line)) {
        return {
          message:
            `只有 ${WRITE_LOG} 可以 new WriteLog：两个记账本并存会让提交集合分裂` +
            '（回滚看似成功但文件还在），比不记账更难查',
          fix: `用 ${WRITE_LOG} 的 runWithRollback(label, (log) => …) 包住这一轮写`,
        }
      }
      if (/\bactiveLog\b/.test(line)) {
        return {
          message:
            'activeLog 是 write-log.ts 的私有状态：外部读写会让「当前生效的记账本」出现第二个真源',
          fix: '改调 currentWriteLog() / bindWriteLog()，不要直接碰 activeLog',
        }
      }
      return undefined
    },
  },
  {
    id: 'A5',
    check(line, rel) {
      if (!isCore(rel)) return undefined
      const hit = /\bconsole\.log\s*\(|\bprocess\.stdout\.write\s*\(/.exec(line)
      if (hit === null) return undefined
      return {
        message:
          `${hit[0].replace(/\s*\($/, '')} 在 core 层直接打印：输出绕过宿主日志通道` +
          '（面板 / CLI 都收不到），且把「无副作用的纯层」变成有副作用',
        fix: 'core 只返回数据，由 host.ts / remote/** 决定打印；真需要告警用 console.warn / console.error（本规则允许）',
      }
    },
  },
]

/**
 * 跑一遍全部规则。**纯函数**（除读盘外无副作用、不改全局），供单测直接构造样例树。
 *
 * @param {object} [options]
 * @param {string} [options.rootDir] 插件根目录（含 `src/`）；默认本仓 `plugin/`
 * @param {string} [options.srcDir] 要扫的源码目录；默认 `join(rootDir, 'src')`
 * @param {string[]} [options.frozen] A2 存量清单；默认 {@link FROZEN_A2}
 * @param {Record<string, number>} [options.a6Limit] A6 行数棘轮；默认 {@link A6_LIMIT}
 * @returns {{
 *   total: number,
 *   violations: Array<{ rule: string, file: string, line: number, message: string, fix: string }>,
 *   frozen: number,
 *   frozenFiles: string[],
 *   a6: Array<{ file: string, lines: number, limit: number }>,
 * }}
 */
export function runArchitectureCheck(options = {}) {
  const { rootDir = PLUGIN_ROOT, srcDir = join(rootDir, 'src'), frozen = FROZEN_A2, a6Limit = A6_LIMIT } = options
  const files = walk(srcDir, '.ts')
  const frozenSet = new Set(frozen)
  /** 本次**确实还在违规**的冻结条目：只有它算「仍在迁移」，没命中的要报 STALE */
  const frozenHit = new Set()
  const violations = []

  for (const file of files) {
    const rel = posix(relative(srcDir, file))
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return
      for (const rule of RULES) {
        const finding = rule.check(line, rel)
        if (finding === undefined) continue
        // 冻结只作用于 A2：其它规则没有存量，任何新违规都必须当场红
        if (rule.id === 'A2' && frozenSet.has(rel)) {
          frozenHit.add(rel)
          continue
        }
        violations.push({ rule: rule.id, file: rel, line: index + 1, ...finding })
      }
    })
  }

  // 清单只减不增：迁完（或文件已删）还挂在清单里就报一条 —— 否则冻结清单会退化成永久白名单
  for (const path of [...frozenSet].sort((a, b) => a.localeCompare(b))) {
    if (frozenHit.has(path)) continue
    violations.push({
      rule: 'A2-STALE-FROZEN',
      file: path,
      line: 0,
      message:
        '冻结清单里的条目已经不再违规（文件已迁完或已删除），但仍挂在 FROZEN_A2 里：' +
        '清单只减不增，请删掉这一条',
      fix: `从 tools/check-architecture.mjs 的 FROZEN_A2 里删掉 '${path}'`,
    })
  }

  // A6 入口层行数棘轮：文件级（没有「第几行」的概念，line 记 0，与 A2-STALE-FROZEN 同形）。
  // 文件不在扫描结果里就跳过——临时树（t137 的样例）与「端点族已搬空后改名」都不该凭空报错。
  const a6 = []
  for (const rel of Object.keys(a6Limit).sort((a, b) => a.localeCompare(b))) {
    const full = join(srcDir, ...rel.split('/'))
    if (!existsSync(full)) continue
    const lines = readFileSync(full, 'utf8').split('\n').length
    a6.push({ file: rel, lines, limit: a6Limit[rel] })
    if (lines > a6Limit[rel]) {
      violations.push({
        rule: 'A6',
        file: rel,
        line: 0,
        message:
          `入口层 ${rel} 已 ${lines} 行，超出棘轮上限 ${a6Limit[rel]} 行：入口层只减不增，` +
          '新代码请落到 src/host/<族>.ts（端点族适配器），不要继续堆进 host.ts',
        fix:
          `把该族端点实现搬到 src/host/<族>.ts 转发；拆完把 tools/check-architecture.mjs 的 ` +
          `A6_LIMIT['${rel}'] 下调到新的实测行数（${lines}）`,
      })
    }
  }

  const frozenFiles = [...frozenHit].sort((a, b) => a.localeCompare(b))
  return { total: files.length, violations, frozen: frozenFiles.length, frozenFiles, a6 }
}

/**
 * 把结果排成行（**不打印**，由调用方决定输出到哪）：摘要 → 逐条违规 → 冻结进度。
 *
 * 存量条目没有「行」的概念（`A2-STALE-FROZEN` 说的是清单本身），打 `:0` 只会让人
 * 以为第 0 行有问题，所以只打文件路径。
 */
export function formatArchitectureReport(result) {
  const lines = [`total src files: ${result.total}`, `ARCH_VIOLATIONS: ${result.violations.length}`]
  for (const violation of result.violations) {
    const location = violation.line > 0 ? `${violation.file}:${violation.line}` : violation.file
    lines.push(` - ${location} ${violation.rule} ${violation.message}（修法：${violation.fix}）`)
  }
  lines.push(`frozen (A2 存量，迁移中): ${result.frozen}`)
  // A6：入口层行数棘轮（文件级；临时树里没有入口层文件时为空 → 不打印）
  for (const entry of result.a6 ?? []) {
    lines.push(`A6 入口层行数棘轮: ${entry.file} ${entry.lines} 行 / 上限 ${entry.limit}`)
  }
  return lines
}

/** 直接 `node tools/check-architecture.mjs` 才执行；被单测 import 时只取纯函数 */
function invokedDirectly() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const result = runArchitectureCheck()
  for (const line of formatArchitectureReport(result)) console.log(line)
  process.exitCode = result.violations.length > 0 ? 1 : 0
}
