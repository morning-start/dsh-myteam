/**
 * T127（A1 / A2 / A7）：**降级要诚实**——幽灵工具引用 + 能力隔离静默跳过。
 *
 * 这一组用例守的是同一条纪律：**允许降级，不允许把降级描述成没发生**。
 *  1. A1：`buildHandoffPrompt` 里引用的每个 `myteam_*` 都必须是真工具——模型会照着
 *     提示词调工具，编一个不存在的名字（旧文案的 `myteam_get_board`）等于让它必然拿到
 *     unknown tool；`session-handoff.ts` 全文同理（注释里的幽灵名会误导下一个维护者）。
 *  2. A2：`MT_ARCHIVE_FAILED` 的复查指引必须指向**真实存在**的落点与工具，不能编
 *     「应该存在」的名字（旧文案的 `myteam_list_archives` 全仓无定义）。
 *  3. A7：宿主缺 `tools.restrict` / `skills.registerProvider` 时，`applyCapabilityGuard`
 *     必须在 `warnings` 里说出来（旧实现整块静默跳过，调用方以为隔离生效了）；
 *     喂给模型的「能力边界」section 文本必须**条件化**——只有隔离真生效才允许出现
 *     「已硬隔离」这类断言。
 *  4. 全仓扫描（防回归，不是打地鼠）：`plugin/src` 下所有 `.ts` + `cordis.patch.yml` +
 *     `locale/*.json` 里出现的**每一个** `myteam_*` 名字都必须是真工具（或极短的
 *     非工具标识符白名单）——幽灵引用不会只犯一次。
 *
 * 断言口径：工具名集合从 `defs.ts` 源码里现读（不硬编码名单），源码里新增/改名工具时
 * 这里自动跟着走，只会在出现**解析不到**的名字时失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { buildHandoffPrompt } from '../src/core/host/session-handoff.ts'
import {
  applyCapabilityGuard,
  buildCapabilityBoundaryText,
  type CapabilityGuardResult,
} from '../src/core/members/capability-guard.ts'

const here = import.meta.dirname

/**
 * 非工具标识符白名单（**必须极短、逐条注明为什么不是幽灵**）。
 *
 * 判据：它是不是模型/调用方会当作**工具名**去调的东西？不是，才允许进白名单。
 * 别为了让测试过而往里塞真幽灵——那等于给幽灵引用发通行证。
 */
const NON_TOOL_IDENTIFIERS: ReadonlyMap<string, string> = new Map([
  // 模板变量名（宿主校验 `[a-z][a-z0-9_]*`），不是工具：`core/host/team-charter.ts` L51
  // 的 `TEAM_CHARTER_VARIABLE`，用于把 `.dsh-myteam/structure.md` 注入提示词。
  ['myteam_team_charter', '注入变量名（team-charter.ts 的 TEAM_CHARTER_VARIABLE），不是工具'],
])

/** 递归列出目录下所有 `.ts` 文件（测试只扫源码，不扫构建产物/依赖） */
function walkTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkTs(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** 从 defs.ts 源码里现读「真实存在的 Lead 工具名」集合（避免硬编码名单漂移） */
function realToolNames(): Set<string> {
  const source = readFileSync(join(here, '..', 'src', 'tools', 'defs.ts'), 'utf8')
  const names = new Set<string>()
  for (const match of source.matchAll(/name:\s*'([^']+)'/g)) {
    const name = match[1]
    if (name.startsWith('myteam_')) names.add(name)
  }
  return names
}

/** 从任意文本里抽出所有 `myteam_*` 名字（工具名形态：小写 + 下划线） */
function myteamNamesIn(text: string): string[] {
  return [...new Set(text.match(/myteam_[a-z_]+/g) ?? [])]
}

/* ══════════════════════════════════════════════════════════════════
 * A1：移交提示词里的工具名必须全部可解析
 * ══════════════════════════════════════════════════════════════════ */

test('t127-1: buildHandoffPrompt 引用的每个 myteam_* 都是 defs.ts 里的真工具', () => {
  const real = realToolNames()
  assert.ok(real.size > 0, 'defs.ts 里必须能解析出工具名（解析失败说明正则/路径坏了）')

  const prompt = buildHandoffPrompt('【团队上下文摘要】占位摘要')
  const referenced = myteamNamesIn(prompt)
  assert.ok(referenced.length > 0, '提示词必须引用具体的工具名，而不是只说「读板」')
  for (const name of referenced) {
    assert.ok(real.has(name), `幽灵工具引用：${name} 在 defs.ts 里没有定义（提示词会让模型必然拿到 unknown tool）`)
  }
  // 旧文案的幽灵名：必须彻底消失
  assert.ok(!prompt.includes('myteam_get_board'), 'myteam_get_board 全仓无定义，不能出现在提示词里')
  // 看现状的真实路径仍要在（否则模型不知道去哪读）
  // CHG-200：接手的是**队长**会话——任务读面是队长专属的 myteam_read_task / myteam_read_board；
  // 旧文案写的 myteam_get_task / myteam_list_tasks 只注册在成员作用域（同一类幽灵引用）。
  assert.match(prompt, /myteam_list_teams/, '看团队目录用 myteam_list_teams')
  assert.match(prompt, /myteam_read_task/, '看单个任务用 myteam_read_task（队长读面）')
})

test('t127-2: session-handoff.ts 源文件全文的 myteam_* 名字同样全部可解析', () => {
  const real = realToolNames()
  const source = readFileSync(join(here, '..', 'src', 'core', 'host', 'session-handoff.ts'), 'utf8')
  const referenced = myteamNamesIn(source)
  assert.ok(referenced.length > 0, '源文件里应当能扫到工具名（扫不到说明断言失效）')
  for (const name of referenced) {
    assert.ok(real.has(name), `session-handoff.ts 里出现幽灵工具名：${name}（注释里的也算——会误导维护者）`)
  }
})

/* ══════════════════════════════════════════════════════════════════
 * A2：MT_ARCHIVE_FAILED 的复查指引必须指向真实落点
 * ══════════════════════════════════════════════════════════════════ */

test('t127-3: MT_ARCHIVE_FAILED 文案不再引用幽灵工具，且给出真实归档落点', () => {
  const real = realToolNames()
  /* CHG-186（T155c）：`myteam_disband`（MT_ARCHIVE_FAILED 分支）已随团队族搬到
   * `src/host/teams.ts`。**扫描面不缩**：入口层 + 团队族两处一起拼，幽灵名在任何一处
   * 出现都仍然失败（断言本身一个都没改）。 */
  const source = ['host.ts', join('host', 'teams.ts')]
    .map((path) => readFileSync(join(here, '..', 'src', path), 'utf8'))
    .join('\n')

  assert.ok(!source.includes('myteam_list_archives'), 'myteam_list_archives 全仓无定义，任何位置（含注释）都不该出现')

  // 取 MT_ARCHIVE_FAILED 分支附近的文案（错误码后紧跟 message）
  const lines = source.split('\n')
  const index = lines.findIndex((line) => line.includes('MT_ARCHIVE_FAILED'))
  assert.ok(index >= 0, '找不到 MT_ARCHIVE_FAILED 分支')
  const block = lines.slice(index, index + 12).join('\n')

  // ① 引用的工具名必须真实存在
  const referenced = myteamNamesIn(block)
  assert.ok(referenced.length > 0, '复查指引必须给出可执行的工具（不能只说「失败了」）')
  for (const name of referenced) {
    assert.ok(real.has(name), `MT_ARCHIVE_FAILED 文案引用了不存在的工具：${name}`)
  }
  // ② 真实落点：归档目录（`<STORE_DIR>/history/archive/<teamId>/`）
  assert.match(block, /history\/archive\//, '必须给出归档目录相对路径，用户才能自己去看文件')
  assert.match(block, /MANIFEST\.json/, '必须说清完整性判据（MANIFEST.json 缺失 = 未归档）')
  // ③ 账本仍是权威：复核入口是审计事件流
  assert.match(block, /myteam_get_audit/, '账本侧复核入口是 myteam_get_audit')
})

/* ══════════════════════════════════════════════════════════════════
 * A7：能力隔离降级必须留 warning（不许静默跳过）
 * ══════════════════════════════════════════════════════════════════ */

test('t127-4: 宿主 tools 服务无 restrict() 时，MCP allowlist 降级必须写 warning', async () => {
  // ① 宿主没有 tools 服务（get 返回空对象）——旧实现整块静默跳过
  const noTools = { get: (name: string) => (name === 'tools' ? {} : undefined) }
  const result = await applyCapabilityGuard(noTools, { id: 'agent-a' }, { skills: [], mcpAllowlist: ['filesystem'] }, { workspaceRoot: '/ws' })
  assert.ok(result.warnings.length > 0, '缺 restrict API 时不能静默：必须留下 warning')
  assert.ok(
    result.warnings.some((warning) => /mcp/i.test(warning)),
    `warning 必须说清是哪一项 allowlist 没生效，实际：${JSON.stringify(result.warnings)}`,
  )
  assert.ok(
    result.warnings.some((warning) => /restrict/i.test(warning)),
    'warning 必须点名缺的宿主 API（restrict），否则维护者无从修起',
  )
  assert.deepEqual(result.mcpDenied, [], '没有宿主 API 时不可能真的 deny 掉工具')
})

test('t127-5: 宿主 skills 服务无 registerProvider() 时，技能 allowlist 降级必须写 warning', async () => {
  const noSkills = {
    get: (name: string) =>
      name === 'tools' ? { schemas: () => [], restrict: () => {} } : name === 'skills' ? { list: async () => [] } : undefined,
  }
  const result = await applyCapabilityGuard(noSkills, { id: 'agent-b' }, { skills: ['ui-design'], mcpAllowlist: [] }, { workspaceRoot: '/ws' })
  assert.ok(result.warnings.length > 0, '缺 registerProvider API 时不能静默：必须留下 warning')
  assert.ok(
    result.warnings.some((warning) => /skill/i.test(warning)),
    `warning 必须说清是技能 allowlist 没生效，实际：${JSON.stringify(result.warnings)}`,
  )
  assert.ok(
    result.warnings.some((warning) => /registerProvider/i.test(warning)),
    'warning 必须点名缺的宿主 API（registerProvider）',
  )
  assert.deepEqual(result.skillsShadowed, [], '没有宿主 API 时不可能真的把技能遮蔽掉')
})

/* ══════════════════════════════════════════════════════════════════
 * A7：喂给模型的 section 文本必须条件化（隔离真生效才允许说「已硬隔离」）
 * ══════════════════════════════════════════════════════════════════ */

test('t127-6: 能力边界 section 文本——降级时不说「已硬隔离」，生效时才允许断言', () => {
  const caps = { skills: ['ui-design'], mcpAllowlist: ['filesystem'] }

  // ① 隔离真的生效（没有 warning）：允许说硬话
  const enforced: CapabilityGuardResult = { skillsShadowed: ['create-role'], mcpDenied: ['mcp__github__x'], warnings: [] }
  const enforcedText = buildCapabilityBoundaryText(caps, enforced)
  assert.match(enforcedText, /已硬隔离/, '隔离生效时应当明确告诉模型边界是硬的')
  assert.match(enforcedText, /ui-design/, 'allowlist 原样列出（技能）')
  assert.match(enforcedText, /filesystem/, 'allowlist 原样列出（MCP）')

  // ② 降级（有 warning）：不许断言「已硬隔离」，必须点名未生效项
  const degraded: CapabilityGuardResult = {
    skillsShadowed: [],
    mcpDenied: [],
    warnings: ['mcp allowlist not enforced: host tools service has no restrict() API (allowlist: filesystem)'],
  }
  const degradedText = buildCapabilityBoundaryText(caps, degraded)
  assert.ok(!degradedText.includes('已硬隔离'), '宿主缺 API 时隔离没生效，模型提示词不能宣称「已硬隔离」（说硬话 = 假装成功）')
  assert.match(degradedText, /未生效/, '必须明确写出「部分隔离未生效」')
  assert.match(degradedText, /no restrict\(\) API/, '未生效原因要带出来（缺哪个宿主 API）')
  assert.match(degradedText, /ui-design/, '降级时 allowlist 仍要原样列出')
})

/* ══════════════════════════════════════════════════════════════════
 * 全仓扫描：幽灵工具名不会只犯一次（本项真正的价值）
 * ══════════════════════════════════════════════════════════════════ */

test('t127-7: 全仓扫描——src/**/*.ts + cordis.patch.yml + locale/*.json 里没有幽灵工具名', () => {
  const real = realToolNames()
  assert.ok(real.size >= 60, `defs.ts 必须能解析出全部真实工具名（Lead 53 + 成员 9），实际 ${real.size} 个`)

  const pluginRoot = join(here, '..')
  const files: string[] = [
    ...walkTs(join(pluginRoot, 'src')),
    join(pluginRoot, 'cordis.patch.yml'),
    ...readdirSync(join(pluginRoot, 'locale')).map((name) => join(pluginRoot, 'locale', name)),
    /* CHG-158：客户端也要扫——`tool.call.toolview` 按 **wire 工具名** 精确匹配 key，
     * 写错的 key 不会报错，只会让那张卡**永远不渲染**（`myteam_plan_tasks` 就是这么躺了
     * 好几个版本的）。浏览器产物同样会「照着名字调」，和 src 一视同仁。 */
    join(pluginRoot, 'client', 'client.js'),
  ]
  // 门禁非空校验：文件清单塌了（路径写错/目录改名）时不能「零命中 = 通过」
  assert.ok(files.length > 50, `扫描清单过短（${files.length} 个文件）——路径可能写错了，门禁会变成摆设`)
  assert.ok(existsSync(join(pluginRoot, 'cordis.patch.yml')), 'cordis.patch.yml 必须存在（preset 声明在这里）')

  /* 名字形态与工具名同构（小写 + 下划线）；`\b` 两端保证不会把长名字切一半。
   * 抽到「解析不到」的名字就失败——失败信息带 `file:line`，维护者能直接跳过去改。 */
  const ghostPattern = /\bmyteam_[a-z][a-z0-9_]*\b/g
  const ghosts: string[] = []
  let inspected = 0
  for (const file of files) {
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const match of line.matchAll(ghostPattern)) {
        inspected += 1
        const name = match[0]
        if (real.has(name)) continue
        if (NON_TOOL_IDENTIFIERS.has(name)) continue
        const where = `${relative(pluginRoot, file).split(sep).join('/')}:${index + 1}`
        ghosts.push(`${where}  ${name}`)
      }
    })
  }
  // 门禁非空校验：一条都没匹配到 = 正则/读取坏了，不是「仓库干净」
  assert.ok(inspected > 200, `只匹配到 ${inspected} 处 myteam_* 名字——扫描门禁失效（正则或读取坏了）`)

  assert.deepEqual(
    ghosts,
    [],
    [
      '出现解析不到的工具名（模型/子 Agent 会照着调，然后拿到 unknown tool）：',
      ...ghosts,
      '',
      '修法：改成 `plugin/src/tools/defs.ts` 里的真实工具名；确实是变量/配置键的，',
      '加进 NON_TOOL_IDENTIFIERS 并逐条注明理由（白名单必须极短）。',
    ].join('\n'),
  )

  /* 白名单本身也要受约束：每条都必须真在仓库里出现过，否则就是过期条目（会悄悄放宽门禁） */
  for (const [name, reason] of NON_TOOL_IDENTIFIERS) {
    const appears = files.some((file) => existsSync(file) && readFileSync(file, 'utf8').includes(name))
    assert.ok(appears, `白名单条目 ${name} 已不存在于仓库（理由：${reason}）——请删除，别让门禁悄悄放宽`)
  }
})
