/**
 * T176 成员工具入口（CHG-212 / ADR-010 P3）。
 *
 * 这条链路是「成员 = 子代理」的关键：工具由 preset 注册，执行时靠
 * `exec.agent → parentSession → serviceFor` 找回**同一个** myteam 服务。
 * 这里用假 ctx 把四条失败路径与一条成功路径都钉住——真机上解析不到时会静默失败，
 * 而静默正是这个项目最不能接受的东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, resolveMemberHost, runMemberTool, memberSessionIdOf } from '../src/member.ts'
import { memberToolDefs } from '../src/tools/defs.ts'

function fakeCtx(options: { parent?: unknown; service?: unknown } = {}) {
  const registered: Record<string, unknown>[] = []
  const ctx = {
    tools: { register: (def: Record<string, unknown>) => { registered.push(def) } },
    agents: { get: (id: string) => (id === 'cap-1' ? options.parent : undefined) },
    agentPresets: { serviceFor: () => options.service },
  }
  return { ctx, registered }
}

test('t176a: 注册 13 个成员工具，名字与 defs 一致且都带输出契约', () => {
  const { ctx, registered } = fakeCtx()
  apply(ctx)
  assert.equal(registered.length, memberToolDefs().length)
  assert.deepEqual(registered.map((r) => r['name']), memberToolDefs().map((d) => d.name))
  for (const def of registered) {
    assert.ok(def['output'], `${String(def['name'])} 缺 output 契约`)
    assert.equal(typeof def['execute'], 'function')
  }
})

test('t176b: 没有调用方 Agent → MT_UNAVAILABLE（不猜身份）', () => {
  const { ctx } = fakeCtx()
  const result = runMemberTool(ctx, 'myteam_recall', {}, undefined) as Record<string, unknown>
  assert.equal(result.code, 'MT_UNAVAILABLE')
  assert.match(String(result.message), /exec\.agent/)
})

test('t176c: 没有 parentSession → 说明「不是子代理方式起来的」', () => {
  const { ctx } = fakeCtx()
  const resolved = resolveMemberHost(ctx, { agent: { id: 'solo-1', session: { header: {} } } })
  assert.equal(resolved.error?.['code'], 'MT_UNAVAILABLE')
  assert.match(String(resolved.error?.['message']), /parentSession/)
})

test('t176d: 队长会话不在线 → 报「先恢复队长」，不返回空结果', () => {
  const { ctx } = fakeCtx()
  const resolved = resolveMemberHost(ctx, { agent: { id: 'mt-1', session: { header: { parentSession: 'gone' } } } })
  assert.equal(resolved.error?.['code'], 'MT_UNAVAILABLE')
  assert.match(String(resolved.error?.['message']), /不在线/)
})

test('t176e: 队长在线但没挂 myteam preset → 报 preset 问题', () => {
  const { ctx } = fakeCtx({ parent: { id: 'cap-1' }, service: undefined })
  const resolved = resolveMemberHost(ctx, { agent: { id: 'mt-1', session: { header: { parentSession: 'cap-1' } } } })
  assert.equal(resolved.error?.['code'], 'MT_UNAVAILABLE')
  assert.match(String(resolved.error?.['message']), /myteam-preset-captain/)
})

test('t176f: 解析成功 → 转发到 executeMemberToolBySession（成员会话 id 原样传）', () => {
  const calls: unknown[] = []
  const host = { executeMemberToolBySession: (sessionId: string, name: string, args: Record<string, unknown>) => { calls.push([sessionId, name, args]); return { status: 'ok' } } }
  const { ctx } = fakeCtx({ parent: { id: 'cap-1' }, service: host })
  const result = runMemberTool(ctx, 'myteam_remember', { title: 'x' }, { agent: { id: 'mt-t1-dev-1', session: { header: { parentSession: 'cap-1' } } } })
  assert.deepEqual(result, { status: 'ok' })
  assert.deepEqual(calls, [['mt-t1-dev-1', 'myteam_remember', { title: 'x' }]])
})

test('t176g: 会话 id 兼容 agent.id 与 agent.session.id 两种形状', () => {
  assert.equal(memberSessionIdOf({ id: 'a' }), 'a')
  assert.equal(memberSessionIdOf({ session: { id: 'b' } }), 'b')
  assert.equal(memberSessionIdOf({}), undefined)
})
test('t176h: C5 懒收窄——首次提示词组装时按角色策略 restrict，一次后不再重复', () => {
  const restricted: unknown[] = []
  const sections: Array<{ name: string; text: (scope: { agent?: unknown }) => string }> = []
  let section: { text: (scope: { agent?: unknown }) => string } | undefined
  const host = { executeMemberToolBySession: () => ({ status: 'ok' }), memberPolicyBySession: () => ({ status: 'ok', mode: 'deny', deny: ['pwsh'] }) }
  const ctx = {
    tools: { register: () => {}, restrict: (mask: unknown) => { restricted.push(mask) } },
    agents: { get: () => ({ id: 'cap-1' }) },
    agentPresets: { serviceFor: () => host },
    systemPrompt: { section: (s: { name: string; text: (scope: { agent?: unknown }) => string }) => { sections.push(s); section = s } },
  }
  apply(ctx as never)
  const agent = { id: 'mt-t1-dev-1', session: { header: { parentSession: 'cap-1' } } }
  const policy = sections.find((s) => s.name === 'myteam:member-policy')!
  assert.equal(policy.text({ agent }), '')
  assert.deepEqual(restricted, [{ deny: ['pwsh'] }])
  policy.text({ agent }) // 第二次：已应用，不再 restrict
  assert.equal(restricted.length, 1)
})

test('t176i: 服务方法必须带接收者调用（`this` 一丢，MyTeamRemote 的 this.host 当场炸）', () => {
  /* CHG-213 实机缺陷：旧实现 `const run = host.memberToolBySession; run(...)` 把方法取出再调，
   * `this` 变 undefined → `Cannot read properties of undefined (reading 'host')`，
   * 成员的**所有** myteam 工具一起失效（活体验收里成员逐条试过，全部同一句错误）。 */
  const service = {
    host: { run: (sessionId: string, name: string) => ({ status: 'ok', sessionId, name }) },
    memberToolBySession(sessionId: string, name: string) {
      // 复刻 MyTeamRemote 的方法体：读 this.host
      return this.host.run(sessionId, name)
    },
  }
  const { ctx } = fakeCtx({ parent: { id: 'cap-1' }, service })
  const result = runMemberTool(ctx, 'myteam_recall', {}, { agent: { id: 'mt-t1-dev-1', session: { header: { parentSession: 'cap-1' } } } }) as Record<string, unknown>
  assert.equal(result['status'], 'ok', JSON.stringify(result))
  assert.equal(result['sessionId'], 'mt-t1-dev-1')
  assert.equal(result['name'], 'myteam_recall')
})
