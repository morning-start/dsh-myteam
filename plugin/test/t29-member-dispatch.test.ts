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

test('认领任务后把任务派发给成员会话（subagents.sendMessage）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-dispatch-'))
  const tools = new Map<string, FakeTool>()
  const sent: { target: string; text: string }[] = []
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
        return { id }
      },
      async create(options: { sessionId: string; setup?: (agentCtx: unknown) => void }) {
        options.setup?.({ tools: { register: () => () => {} } })
        return { agent: { session: { id: options.sessionId } } }
      },
    },
    subagents: {
      async sendMessage(_sender: unknown, target: string, content: { type: string; text: string }[]) {
        sent.push({ target, text: content.map((part) => part.text).join('') })
        return 'msg_1'
      },
    },
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
    assert.equal(claimed.data!.dispatched, true, '应通过 subagents 通道派出')

    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.target, (member.data as { sessionId: string }).sessionId)
    assert.ok(sent[0]!.text.includes('拆登录模块'), sent[0]!.text)
    assert.ok(sent[0]!.text.includes('接口不变'), sent[0]!.text)
    assert.ok(sent[0]!.text.includes('myteam_submit_review'), sent[0]!.text)
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})