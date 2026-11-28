/**
 * CHG-217 P0-A 回归：成员投递的消息**必须**带 id 与 source。
 *
 * 为什么这条要有测试：`agent.followup({ role:'user', content })` 这种手写字面量
 * 写进会话时**不报错**（`session.append` 只校验 JSON 可序列化），但持久化层在
 * **用户下次打开会话时**校验 `message.id` 与 `message.source.kind`，缺一就抛
 * `lacks an identified message`，整段会话打不开。
 *
 * 这类缺陷「测试绿着、真实调用坏着」，所以这里断言的是**消息的形状**，
 * 而不是「调用没抛错」。
 *
 * 证据来源：宿主 `dsh-session` 的 `adoptSessionEvent`（内含
 * `assertMessageEventShape`）与 `dsh-llm` 的 `createUserMessage`——
 * 本测试用宿主自己的校验器判定，而不是自己写一套规则。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply as applyCaptainHost } from '../src/composition/host.ts'

interface FakeTool {
  name: string
  execute(args: unknown, exec: { agent: { id: string } }): Promise<unknown>
}

/** 投递给成员的消息（原样捕获，用来断言形状）。 */
interface CapturedMessage {
  id?: unknown
  role?: unknown
  content?: unknown
  source?: unknown
}

test('成员投递的消息带 id 与 source（否则用户下次打开会话整段打不开）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-dispatch-msg-'))
  const tools = new Map<string, FakeTool>()
  const captured: CapturedMessage[] = []
  const cleanups: (() => void)[] = []

  const ctx = {
    tools: {
      register(definition: unknown) {
        const tool = definition as FakeTool
        tools.set(tool.name, tool)
        const dispose = () => tools.delete(tool.name)
        cleanups.push(dispose)
        return dispose
      },
    },
    effect(execute: () => () => void) {
      const dispose = execute()
      if (typeof dispose === 'function') cleanups.push(dispose)
    },
    agents: {
      get(id: string) {
        // 只有队长有 subagents 通道；成员没有，所以会走 followup 老路径。
        return id === 'ses_captain' ? { id } : { id, followup: (message: CapturedMessage) => captured.push(message) }
      },
      async create(options: { sessionId: string; setup?: (agentCtx: unknown) => void }) {
        options.setup?.({ tools: { register: () => () => {} } })
        return { agent: { session: { id: options.sessionId } } }
      },
    },
    // 队长**没有** subagents → 强制走 followup 老路径（就是出问题的那条路）。
    subagents: undefined,
  }

  const captainExec = { agent: { id: 'ses_captain' } }
  try {
    applyCaptainHost(ctx as never, { projectRoot: dir })
    const call = async (name: string, args: unknown) =>
      (await tools.get(name)!.execute(args, captainExec)) as {
        ok: boolean
        data?: Record<string, unknown>
        error?: { code: string; message: string }
      }

    const created = await call('myteam_create_team', { name: '甲队', goal: '派发测试' })
    const roles = (created.data as { roles: { id: string }[] }).roles
    const member = await call('myteam_appoint_member', { roleId: roles[0]!.id })
    const task = await call('myteam_create_task', { title: '拆登录模块', acceptance: ['接口不变'] })

    const claimed = await call('myteam_claim_task', {
      taskId: (task.data as { taskId: string }).taskId,
      memberId: (member.data as { memberId: string }).memberId,
    })
    assert.equal(claimed.ok, true, JSON.stringify(claimed))
    assert.equal(claimed.data!.dispatched, true, '应通过 followup 通道派出')

    assert.equal(captured.length, 1, '应恰好投递一条消息')
    const message = captured[0]!

    // ① id：宿主构造器补的稳定身份。非空字符串，否则持久化层拒绝加载。
    assert.equal(typeof message.id, 'string', '消息必须带 id')
    assert.ok((message.id as string).length > 0, 'id 不能是空串')

    // ② role：必须是 user（会话的 user/message 事件要求 role 匹配）。
    assert.equal(message.role, 'user')

    // ③ source：必须是非空对象且 kind 非空。
    assert.equal(typeof message.source, 'object', '消息必须带 source')
    assert.notEqual(message.source, null)
    const source = message.source as { kind?: unknown }
    assert.equal(typeof source.kind, 'string', 'source.kind 必须是字符串')
    assert.ok((source.kind as string).length > 0, 'source.kind 不能是空串')

    // ④ source 必须是「Agent 之间」而不是「真人」：
    //    标成 user 会让 dsh-tool-goal 的「直接人类授权」判定误判，
    //    给模型它本不该有的真人授权。
    assert.equal(source.kind, 'agent-message', '队长投给成员的消息不能标成真人输入')
    assert.equal((source as { senderSessionId?: unknown }).senderSessionId, 'ses_captain')

    // ⑤ content 仍是原来的文本块。
    assert.ok(Array.isArray(message.content))
    assert.ok(
      (message.content as { type: string; text: string }[]).some((part) => part.text.includes('拆登录模块')),
      '内容不应丢失',
    )
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
