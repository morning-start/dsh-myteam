import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leadToolDefs, memberToolDefs, toolRegistryPlan, toolOutput, EVIDENCE_PARAM } from '../src/tools/defs.ts'
import { TEAM_MEMBER_TOOLS } from '../src/core/members/member-setup.ts'

test('T7 tool defs: 35 lead tools + 9 member tools, names match contract (docs/04 §1 + CHG-17/19/53/57/69/73/76/86/87/91)', () => {
  const plan = toolRegistryPlan()
  assert.equal(plan.lead.length, 35)
  assert.equal(plan.member.length, 9)
  assert.deepEqual(plan.member, [...TEAM_MEMBER_TOOLS])
  // CHG-86（P0-4）：两个作用域不能有同名工具——旧实现队长侧与成员侧都叫
  // myteam_update_task，同名跨层注册时解析顺序决定谁生效（成员可能绕过 attemptId 校验）。
  // 队长侧现名 myteam_edit_task；成员侧保持 myteam_update_task（申报进度语义）。
  assert.deepEqual(plan.lead.filter((name) => plan.member.includes(name)), [])
  // 契约对齐：docs/04 §1.1 的 22 个名字（+adopt_knowledge CHG-19；+create_role/update_role CHG-53；
  // +list/save/copy/delete_preset +reset_team_config CHG-57；+participate/assign/set_project_role CHG-69；
  // +rescope_task/cancel_task/batch_task_op/delete_role CHG-73；+create_tasks CHG-76；+review_task CHG-86）
  for (const expected of [
    'myteam_submit_plan', 'myteam_approve_plan', 'myteam_revise_plan', 'myteam_discard_plan',
    'myteam_create_task', 'myteam_edit_task', 'myteam_update_team', 'myteam_reassign_task', 'myteam_revoke_attempt',
    'myteam_participate_task', 'myteam_assign_task',
    'myteam_spawn_member', 'myteam_release_member', 'myteam_message', 'myteam_interrupt',
    'myteam_disband', 'myteam_resolve_proposal', 'myteam_adopt_knowledge',
    'myteam_create_role', 'myteam_update_role', 'myteam_set_project_role',
    'myteam_list_presets', 'myteam_save_preset', 'myteam_copy_preset', 'myteam_delete_preset',
    'myteam_reset_team_config',
    'myteam_rescope_task', 'myteam_cancel_task', 'myteam_batch_task_op', 'myteam_delete_role',
    'myteam_create_tasks', 'myteam_review_task',
    // CHG-87（FR-16.1 单角色调用 / FR-15.1 入口②）
    'myteam_apply_roles',
    // CHG-91（插件团队贡献契约 v1）：插件贡献只读视图 + 显式重载
    'myteam_list_contributions', 'myteam_reload_contributions',
  ]) {
    assert.ok(plan.lead.includes(expected), `missing lead tool ${expected}`)
  }
})

test('T7 tool defs: every tool has name/description/valid parameters object', () => {
  for (const t of [...leadToolDefs(), ...memberToolDefs()]) {
    assert.equal(typeof t.name, 'string')
    assert.ok(t.description.length > 10, `${t.name} description too short`)
    assert.equal(t.parameters.type, 'object')
    assert.ok(typeof t.parameters.properties === 'object')
  }
})

test('T7 tool output contract: schema object-rooted + status required; render returns content-block array (host tools.register 校验器 + createSuccessResult 返回值校验)', () => {
  const out = toolOutput()
  // schema 子集关键字（assertSupportedJsonSchema）+ object 根
  assert.equal(out.schema.type, 'object')
  const props = out.schema.properties as Record<string, { type?: string }>
  assert.equal(props['status']!.type, 'string')
  assert.deepEqual(out.schema.required, ['status'])
  // render(args, value) → 内容块数组（isContentBlockShape：plain object + string type）
  const blocks = out.render({}, { status: 'ok', extra: 1 })
  assert.ok(Array.isArray(blocks) && blocks.length > 0)
  for (const b of blocks) {
    assert.equal(typeof b.type, 'string')
    assert.ok(typeof (b as Record<string, unknown>)['text'] === 'string')
  }
  // 全部真实返回路径都是 { status: string, ... }：抽一个 error/timeout 形状也过 schema（人工核对 executeLeadTool/executeMemberTool 全分支）
  const blocks2 = out.render({}, { status: 'error', code: 'X', message: 'm' })
  assert.equal(blocks2[0]!.type, 'text')
})

test('T7 tool defs: member update_task requires attemptId + status; evidence schema enforces kind', () => {
  const update = memberToolDefs().find((t) => t.name === 'myteam_update_task')!
  // spec 风格：属性级 required: true（宿主编译器收集，T0 实证 L603）
  const updateProps = update.parameters.properties as Record<string, { required?: boolean }>
  assert.equal(updateProps['attemptId']!.required, true)
  assert.equal(updateProps['status']!.required, true)
  const escalate = memberToolDefs().find((t) => t.name === 'myteam_escalate_task')!
  assert.equal((escalate.parameters.properties as Record<string, { required?: boolean }>)['evidence']!.required, true)
  assert.deepEqual(EVIDENCE_PARAM.required, ['kind'])
  // escalate evidence 子属性必填（attempted/blockedAt）
  const evSpec = escalate.parameters.properties as Record<string, { properties?: Record<string, { required?: boolean }> }>
  assert.equal(evSpec['evidence']!.properties!['attempted']!.required, true)
  assert.equal(evSpec['evidence']!.properties!['blockedAt']!.required, true)
  // wait_for_change 无需 taskId（可全队等待）
  const wait = memberToolDefs().find((t) => t.name === 'myteam_wait_for_change')!
  assert.ok(!(wait.parameters.properties as Record<string, { required?: boolean }>)['taskId']!.required)
})

test('T7 tool defs: domain-neutral wording (FR-10.3) — no dev-only vocabulary in descriptions', () => {
  for (const t of [...leadToolDefs(), ...memberToolDefs()]) {
    assert.ok(!/代码评审|跑测试|编译通过/.test(t.description), `${t.name} hardcodes dev domain`)
  }
})

test('T7 compileParameters: compiled parameters are subset-clean — no property-level boolean required survives (含 items 下钻)', async () => {
  // 宿主 assertSupportedJsonSchema 子集：布尔 required 不是合法关键字；编译器必须把
  // 属性级 required:true 全部收进 required 数组——包括嵌套在 items 里的（此前只下钻
  // properties，EVIDENCE_PARAM.commands.items / rosterItem / taskInputSpec 会残留）。
  const walk = (node: unknown, path: string, bad: string[]): void => {
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`, bad)); return }
    if (typeof node !== 'object' || node === null) return
    const rec = node as Record<string, unknown>
    if ('required' in rec && typeof rec['required'] !== 'object') bad.push(`${path}.required(${JSON.stringify(rec['required'])})`)
    for (const [k, v] of Object.entries(rec)) walk(v, `${path}.${k}`, bad)
  }
  // 直接 import host 会拉起全部依赖；编译语义由 host.ts 导出（纯函数）。
  // 为避免测试加载 host 全量，这里内联同语义审计：对 defs 原始 spec 走一遍与
  // host.compileParameters 相同的断言目标——先确认 defs 里确实有 items 内嵌
  // required:true（保证本测试测到点子上），再要求 host 导出的编译产物干净。
  const evidence = EVIDENCE_PARAM as unknown as Record<string, unknown>
  const commands = (evidence['properties'] as Record<string, Record<string, unknown>>)['commands']!
  const cmdSpec = (commands['items'] as Record<string, unknown>) as Record<string, unknown>
  const cmdProps = cmdSpec['properties'] as Record<string, { required?: boolean }>
  assert.equal(cmdProps['cmd']!.required, true, '前置：defs 里必须存在 items 内属性级 required（否则本审计没有靶子）')

  // host.ts 已被其他测试（t21）加载过，import 安全；compileParameters 是纯函数导出
  const { compileParameters } = await import('../src/host.ts')
  const bad: string[] = []
  for (const t of [...leadToolDefs(), ...memberToolDefs()]) {
    walk(compileParameters(t).parameters, t.name, bad)
  }
  assert.deepEqual(bad, [], `残留布尔 required: ${bad.join(', ')}`)
})
