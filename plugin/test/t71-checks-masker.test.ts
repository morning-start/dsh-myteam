/**
 * CHG-217 回归：装配层规则引擎的 **masker** 与「消息必须带 id」规则必须真有辨别力。
 *
 * 为什么这条要单独存在：`tools/checks/rules.js` 是从 `@morning-start/dsh-plugin-creator`
 * 复制进来的（vendored），而本轮**改了它一处**（见该文件里 `CHG-217 · 上游缺陷修复`）。
 * 下次有人照抄上游新版覆盖这个文件，那处修复会**静默消失**——于是
 * `session-message-identity` 又在含模板串的文件上假绿，`host.ts` 那类
 * 「写的时候不报错、用户下次打开会话整段打不开」的缺陷再次逃过门禁。
 *
 * 这个测试就是那道闸：它**不**断言实现细节，只断言两条行为——
 *   ① 模板串**之后**的代码仍然可见（masker 不失衡）；
 *   ② 「没有 id 的消息字面量」会被规则判红、「带 id」的判绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { maskSource, runRules } from '../../tools/checks/rules.js'

/** 规则引擎里「消息必须带 id」那一条。 */
const SESSION_MESSAGE_RULES = [
  { id: 'session:messages', type: 'session-message-identity', root: 'src' },
]

/**
 * 在临时目录里造一个最小包，跑指定规则。
 *
 * @param source `src/bad.ts` 的内容
 * @returns 规则结果
 */
async function runOnFixture(source: string): Promise<{ status: string; message: string }> {
  const root = mkdtempSync(join(tmpdir(), 'myteam-masker-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'bad.ts'), source, 'utf8')
    const result = await runRules(root, SESSION_MESSAGE_RULES, {}, {})
    const check = result.checks[0]
    return { status: check?.status ?? 'missing', message: check?.message ?? '' }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('masker：模板串之后的行仍是代码（模板栈必须归零）', () => {
  const source = [
    'const label = `myteam-${input.roleId}`',
    "targetAgent.followup({ role: 'user', content })",
  ].join('\n')

  const masked = maskSource(source)
  const secondLine = masked.split('\n')[1] ?? ''

  // 上游缺陷的表现是整行被抹成空白：role 的字母看不见，规则于是把这一行
  // 当成字符串/注释跳过。这里断言它**看得见**。
  assert.ok(
    secondLine.includes('role'),
    `模板串之后的代码被抹掉了（masker 失衡）：${JSON.stringify(secondLine)}`,
  )
  assert.ok(secondLine.includes('followup'), `调用本身也必须可见：${JSON.stringify(secondLine)}`)
})

test('session:messages 有辨别力：裸字面量判红、带 id 判绿', async () => {
  const bare = await runOnFixture(
    [
      'declare const targetAgent: { followup(message: unknown): void }',
      'declare const content: unknown[]',
      '// 前面故意放一个模板串：这正是真实 host.ts 让它逃过检查的形状',
      'const label = `myteam-${1}`',
      "targetAgent.followup({ role: 'user', content })",
    ].join('\n'),
  )
  assert.equal(bare.status, 'fail', `裸字面量应判红，实际：${bare.status} / ${bare.message}`)

  const identified = await runOnFixture(
    [
      'declare const targetAgent: { followup(message: unknown): void }',
      'declare const content: unknown[]',
      'declare const randomUUID: () => string',
      'const label = `myteam-${1}`',
      "targetAgent.followup({ id: randomUUID(), role: 'user', content })",
    ].join('\n'),
  )
  assert.equal(
    identified.status,
    'pass',
    `带 id 的消息应判绿，实际：${identified.status} / ${identified.message}`,
  )
})