/**
 * T133 · CHG-163（docs/10 KI-9 / PRD FR-17.4 沉淀时机①）：**知识库 onboarding 采集钩子**。
 *
 * 为什么必须有：FR-17.4 的沉淀时机是两半——
 *   ② 「任务验收后提案」由成员 `myteam_update_task` 的 `knowledgeDraft` 走，早已通；
 *   ① 「onboarding 采集（规划轮队长起草初始条目 → 用户确认）」**从来没接**：
 *      队长侧没有任何工具能发 `knowledge.proposed`，这条路物理上不存在（KI-9 原文）。
 * 本测试守的是「钩子真的接上了，且接得不越权」：
 *
 *  ① **三表一致**：新工具同时出现在 `leadToolDefs()` / `TOOL_TIERS` / `describeContract()`
 *    —— 任何一处漏登记，档位门禁或输出契约就会静默失效（t107 / t121 的同源口径）；
 *  ② **端到端**：提案 → 采纳 → `config/knowledge/` 真落盘（只提案不写库，采纳才写）；
 *  ③ **证据纪律（E8）**：无证据 → 拒绝且**账本零写入**（不消耗 seq）；
 *  ④ **关系声明**：`relation:'refine'` 的目标必须存在（提案时就炸，不拖到采纳才炸）；
 *  ⑤ **提示不唠叨**：首次成团才提示；已有提案/已有条目 → 不再提示；
 *  ⑥ **非阻塞**：`knowledgeHint` 只加字段，`submit_plan` 原有返回逐条不变。
 *
 * 运行：`cd plugin && node --test test/t133-onboarding-knowledge.test.ts`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { leadToolDefs, memberToolDefs } from '../src/tools/defs.ts'
import { TOOL_TIERS } from '../src/core/tools/tool-tiers.ts'
import { describeContract, outputForTool } from '../src/core/tools/output-contract.ts'

const TOOL = 'myteam_propose_knowledge'

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  }
}

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  return host
}

/** 建一个 draft 团队（submit_plan 成功 = 成团；不 approve，避免成员/门禁噪声） */
function stagedTeam(root: string, teamName = 'T') {
  const host = setup(root)
  const staged = host.executeLeadTool(
    'myteam_submit_plan',
    { teamName, goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] },
    {},
  ) as any
  return { host, teamId: String(staged.teamId), staged }
}

function ledgerOf(root: string, teamId: string): any[] {
  const p = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

const kbDirOf = (root: string) => join(root, '.dsh-myteam', 'config', 'knowledge')

/* ── ① 三表一致：defs / 档位 / 输出契约 ─────────────────────────── */

test('t133-1: 新工具三表一致 —— leadToolDefs() / TOOL_TIERS / describeContract() 都有条目', () => {
  const lead = leadToolDefs().map((d) => d.name)
  assert.ok(lead.includes(TOOL), `${TOOL} 未注册进 leadToolDefs()`)
  // 两层作用域零重名（CHG-86 P0-4 的口径：同名跨层注册时解析顺序决定谁生效）
  assert.deepEqual(
    lead.filter((name) => memberToolDefs().some((d) => d.name === name)),
    [],
  )
  // 数量断言写死（不许放宽成 >=）：加/删工具必须同步改这里与 t121 / t7b
  assert.equal(lead.length, 54, 'Lead 工具数必须是 54')
  assert.equal(lead.length + memberToolDefs().length, 63, '工具总数必须是 63')

  // 档位：C（仅队长）—— 写面走团队账本，成员不能替团队立「团队级理解」
  assert.equal(TOOL_TIERS[TOOL], 'C', `${TOOL} 必须是 C 档（仅队长）`)

  // 输出契约：就地声明的字段必须真实存在于返回里（draftId 是采纳入口的凭据）
  const entry = describeContract().find((e) => e.name === TOOL)
  assert.ok(entry, `${TOOL} 不在 describeContract() 的契约清单里`)
  assert.equal(entry.tier, 'C')
  assert.ok(entry.declaredFields.includes('draftId'), `契约缺 draftId：${entry.declaredFields.join(',')}`)
  const props = outputForTool(TOOL).schema['properties'] as Record<string, unknown>
  for (const key of ['draftId', 'relation', 'evidence', 'note', 'status']) {
    assert.ok(key in props, `${TOOL} 的结果契约缺 ${key}`)
  }

  // 参数契约：evidence 是**数组**且形状 {kind, ref}（照 KnowledgeDraft 的真实形状，不另造一套）
  const def = leadToolDefs().find((d) => d.name === TOOL)!
  const params = def.parameters['properties'] as Record<string, any>
  assert.equal(params['evidence']?.['type'], 'array')
  assert.deepEqual(params['evidence']?.['items']?.['required'], ['kind', 'ref'])
  assert.deepEqual(params['relation']?.['enum'], ['new', 'refine', 'contradict'])
  assert.deepEqual(def.parameters['required'], ['title', 'body'])
})

/* ── ② 端到端：提案 → 采纳 → 落盘 ─────────────────────────────── */

test('t133-2: 提案落 knowledge.proposed（payload 形状同成员侧），draftId 能被 adopt 采纳并真落盘', () => {
  const root = mkdtempSync(join(tmpdir(), 't133b-'))
  try {
    const { host, teamId } = stagedTeam(root, 'T')
    const proposed = host.executeLeadTool(TOOL, {
      teamId,
      title: 'orders soft delete',
      body: 'orders 表的删除是软删（deleted_at），不是物理删除——查历史订单必须带 `deleted_at IS NOT NULL`。',
      tags: ['db', 'orders'],
      evidence: [{ kind: 'file', ref: 'docs/schema.md#L12-L20' }, { kind: 'task', ref: 'task-1' }],
    }) as any

    assert.equal(proposed.status, 'proposed', JSON.stringify(proposed))
    assert.equal(proposed.relation, 'new')
    assert.equal(proposed.draftId, 'orders-soft-delete', 'draftId 由标题派生（可预期、可判重）')
    assert.deepEqual(proposed.evidence, ['file:docs/schema.md#L12-L20', 'task:task-1'])
    // 只提案不写库：此刻知识库里必须什么都没有
    assert.equal(existsSync(join(kbDirOf(root), `${proposed.draftId}.md`)), false, '提案阶段绝不写库（策展制）')

    // 账本：knowledge.proposed，payload 形状 = {teamId, draftId, draft, proposedBy}
    const proposedEvent = ledgerOf(root, teamId).find((e) => e.type === 'knowledge.proposed')
    assert.ok(proposedEvent, 'knowledge.proposed 已落账本')
    assert.equal(proposedEvent.payload.draftId, proposed.draftId)
    assert.equal(proposedEvent.payload.teamId, teamId)
    assert.equal(proposedEvent.payload.proposedBy, 'lead')
    assert.equal(proposedEvent.payload.draft.evidence, 'file:docs/schema.md#L12-L20', '条目证据取第一条指针')
    assert.deepEqual(proposedEvent.payload.draft.tags, ['db', 'orders'])
    assert.equal(proposedEvent.payload.draft.relation, 'new')

    // 采纳（策展门）→ 真落盘
    const adopted = host.executeLeadTool('myteam_adopt_knowledge', { teamId, draftId: proposed.draftId, decision: 'adopted' }, {}) as any
    assert.equal(adopted.status, 'adopted', JSON.stringify(adopted))
    const file = join(kbDirOf(root), `${proposed.draftId}.md`)
    assert.equal(existsSync(file), true, '采纳后 config/knowledge/ 必须有条目文件')
    const text = readFileSync(file, 'utf8')
    assert.match(text, /evidence: file:docs\/schema\.md#L12-L20/, '证据指针落库（E8）')
    assert.match(text, /contributor: lead/, '归因落库（E9）')
    // index.json 同步重建（索引层是注入面，不重建等于新条目不可发现）
    const index = JSON.parse(readFileSync(join(kbDirOf(root), 'index.json'), 'utf8'))
    assert.ok(index.some((item: any) => item.id === proposed.draftId), 'index.json 必须收录新条目')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── ③ 证据纪律：无证据 → 拒绝 + 账本零写入 ────────────────────── */

test('t133-3: 无证据 → MT_KB_EVIDENCE_REQUIRED 且账本零写入（不消耗 seq）', () => {
  const root = mkdtempSync(join(tmpdir(), 't133c-'))
  try {
    const { host, teamId } = stagedTeam(root, 'T')
    const before = ledgerOf(root, teamId).length
    const lastSeq = ledgerOf(root, teamId).at(-1)?.seq

    for (const evidence of [undefined, [], [{ kind: 'file', ref: '   ' }]]) {
      const r = host.executeLeadTool(TOOL, { teamId, title: '无证据条目', body: '正文', ...(evidence ? { evidence } : {}) }, {}) as any
      assert.equal(r.status, 'error', `evidence=${JSON.stringify(evidence)} 必须被拒`)
      assert.equal(r.code, 'MT_KB_EVIDENCE_REQUIRED')
      assert.match(String(r.message), /证据|evidence/)
    }

    // 零写入：条数不变、seq 没被消耗（先校验后落账——「先写再校验」会在账本留空证提案）
    assert.equal(ledgerOf(root, teamId).length, before, '拒绝路径不得写账本')
    assert.equal(ledgerOf(root, teamId).at(-1)?.seq, lastSeq, '拒绝路径不得消耗 seq')

    // 中文标题派生不出合法 id → 哈希兜底（同一标题确定性同 id）
    const ok = host.executeLeadTool(TOOL, { teamId, title: '中文标题也能提案', body: '正文', evidence: [{ kind: 'seq', ref: '1' }] }, {}) as any
    assert.equal(ok.status, 'proposed', JSON.stringify(ok))
    assert.match(ok.draftId, /^kb-[0-9a-f]{8}$/, `中文标题应走哈希兜底：${ok.draftId}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── ④ 关系声明：refine 必须给存在目标 ─────────────────────────── */

test('t133-4: relation=refine —— 缺 targetId → MT_KB_TARGET_REQUIRED；targetId 不存在 → MT_KB_NOT_FOUND', () => {
  const root = mkdtempSync(join(tmpdir(), 't133d-'))
  try {
    const { host, teamId } = stagedTeam(root, 'T')
    const missingTarget = host.executeLeadTool(TOOL, {
      teamId,
      title: '精炼既有条目',
      body: '补充证据',
      relation: 'refine',
      evidence: [{ kind: 'task', ref: 'task-1' }],
    }) as any
    assert.equal(missingTarget.status, 'error')
    assert.equal(missingTarget.code, 'MT_KB_TARGET_REQUIRED', 'refine 必须给 targetId（knowledge.ts 既有错误码）')

    const unknownTarget = host.executeLeadTool(TOOL, {
      teamId,
      title: '精炼既有条目',
      body: '补充证据',
      relation: 'refine',
      targetId: 'kb-does-not-exist',
      evidence: [{ kind: 'task', ref: 'task-1' }],
    }) as any
    assert.equal(unknownTarget.status, 'error')
    assert.equal(unknownTarget.code, 'MT_KB_NOT_FOUND', '目标条目不存在 → 提案时就拒，不拖到采纳')
    assert.match(String(unknownTarget.message), /kb-does-not-exist/)

    // 目标存在 → 放行（refine 提案可以正常落账）
    const created = host.executeLeadTool(TOOL, {
      teamId,
      title: 'orders soft delete',
      body: 'v1',
      evidence: [{ kind: 'file', ref: 'docs/schema.md' }],
    }) as any
    host.executeLeadTool('myteam_adopt_knowledge', { teamId, draftId: created.draftId, decision: 'adopted' }, {})
    const refine = host.executeLeadTool(TOOL, {
      teamId,
      title: '补充：软删也要看 restore_at',
      body: 'v2',
      relation: 'refine',
      targetId: created.draftId,
      evidence: [{ kind: 'task', ref: 'task-2' }],
    }) as any
    assert.equal(refine.status, 'proposed', JSON.stringify(refine))
    assert.equal(refine.relation, 'refine')
    assert.equal(refine.targetId, created.draftId)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── ⑤ 采集提示：首次成团才提示 ────────────────────────────────── */

test('t133-5: 首次成团 → submit_plan 带 knowledgeHint，文案含 propose_knowledge 与 adopt_knowledge', () => {
  const root = mkdtempSync(join(tmpdir(), 't133e-'))
  try {
    const { staged } = stagedTeam(root, 'T')
    assert.equal(staged.status, 'staged')
    const hint = String(staged.knowledgeHint ?? '')
    assert.ok(hint.length > 0, '首次成团必须给 onboarding 采集提示')
    // 文案要说清三件事：采集什么 / 怎么采集 / 谁定夺
    assert.match(hint, /myteam_propose_knowledge/, '必须点名提案工具')
    assert.match(hint, /myteam_adopt_knowledge/, '必须点名采纳工具（只提案不入库）')
    assert.match(hint, /证据/, '必须强调证据纪律（E8）')
    assert.match(hint, /编造/, '必须明确「不要凭印象编造条目」')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t133-6: 本团队已有 knowledge.proposed 事件 → 不再提示（避免每次提计划都唠叨）', () => {
  const root = mkdtempSync(join(tmpdir(), 't133f-'))
  try {
    const { host, teamId } = stagedTeam(root, 'T')
    // 提案一次（账本里就有 knowledge.proposed 了；哪怕后来被驳回，也不该再催）
    const proposed = host.executeLeadTool(TOOL, {
      teamId,
      title: 'orders soft delete',
      body: '正文',
      evidence: [{ kind: 'file', ref: 'docs/schema.md' }],
    }) as any
    assert.equal(proposed.status, 'proposed')
    // 同一团队再提一次计划（draft 态可重复提交）
    const again = host.executeLeadTool(
      'myteam_submit_plan',
      { teamId, teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] },
      {},
    ) as any
    assert.equal(again.status, 'staged')
    assert.equal(again.knowledgeHint, undefined, '已有提案 → 不再提示')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t133-7: 知识库已有条目 → 不再提示（采集过了）', () => {
  const root = mkdtempSync(join(tmpdir(), 't133g-'))
  try {
    // 预先落一条知识（模拟别的团队已沉淀：知识库是工作区共享的，不是每团队一份）
    const kbDir = kbDirOf(root)
    mkdirSync(kbDir, { recursive: true })
    writeFileSync(
      join(kbDir, 'seed-entry.md'),
      ['---', 'id: seed-entry', 'title: 既有条目', 'tags: [seed]', 'audience: []', 'evidence: file:docs/x.md', 'contributor: lead', 'updated: 2026-11-08', 'core: false', '---', '正文', ''].join('\n'),
      'utf8',
    )
    const { staged } = stagedTeam(root, 'T')
    assert.equal(staged.status, 'staged')
    assert.equal(staged.knowledgeHint, undefined, '知识库非空 → 不再提示')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ── ⑥ 非阻塞：原有返回字段逐条不变 ────────────────────────────── */

test('t133-8: knowledgeHint 只加字段 —— submit_plan 原有返回（status/teamId/roster/note）逐条不变', () => {
  const root = mkdtempSync(join(tmpdir(), 't133h-'))
  try {
    const roster = [{ roleId: 'captain' }, { roleId: 'implementer' }]
    const { staged } = stagedTeam(root, 'T')
    const { knowledgeHint, ...rest } = staged as Record<string, unknown>

    assert.equal(typeof knowledgeHint, 'string')
    // 除提示外**只有**既有四个字段（提示不是新契约面，不能顺手塞别的）
    assert.deepEqual(Object.keys(rest).sort(), ['note', 'roster', 'status', 'teamId'])
    assert.equal(rest['status'], 'staged')
    assert.equal(rest['teamId'], 't')
    assert.deepEqual(rest['roster'], roster)
    assert.match(String(rest['note']), /草稿已暂存/, '原有 note 文案必须原样保留')
    assert.match(String(rest['note']), /Approve & Run/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
