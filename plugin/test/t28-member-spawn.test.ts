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

test('聘人优先用 subagents.startActivation 建真正的子代理（成员 preset + 队长 cwd）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-activation-'))
  const tools = new Map<string, FakeTool>()
  const activations: Record<string, unknown>[] = []
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
      get: (id: string) => ({ id }),
      async create() {
        throw new Error('不应回落到 agents.create')
      },
    },
    subagents: {
      async sendMessage() {
        return 'msg_1'
      },
      async startActivation(spec: Record<string, unknown>) {
        activations.push(spec)
        return { childId: 'mt-child-1' }
      },
    },
  }

  const captainExec = { agent: { id: 'ses_captain' } }
  try {
    applyCaptainHost(ctx as never, { projectRoot: dir })
    const created = (await tools.get('myteam_create_team')!.execute(
      { name: '甲队', goal: '激活测试' },
      captainExec,
    )) as { ok: boolean; data: { roles: { id: string }[] } }
    assert.equal(created.ok, true, JSON.stringify(created))

    const member = (await tools.get('myteam_appoint_member')!.execute(
      { roleId: created.data.roles[0]!.id },
      captainExec,
    )) as { ok: boolean; data: { sessionId: string | null; bound: boolean } }
    assert.equal(member.ok, true, JSON.stringify(member))
    assert.equal(member.data.bound, true)
    assert.equal(member.data.sessionId, 'mt-child-1')

    assert.equal(activations.length, 1)
    const spec = activations[0]!
    assert.equal(spec.provider, 'spawn')
    assert.equal(spec.agentPreset, 'myteam-member')
    assert.equal(spec.cwd, dir)
    assert.equal((spec.parent as { id: string }).id, 'ses_captain')
    assert.ok(Array.isArray(spec.prompt) && spec.prompt.length > 0)
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})