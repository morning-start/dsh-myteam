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

function fakeContext(spawned: Map<string, FakeTool>) {
  const tools = new Map<string, FakeTool>()
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
      get: () => undefined,
      async create(options: { sessionId: string; setup?: (agentCtx: unknown) => void }) {
        options.setup?.({
          tools: {
            register(definition: unknown) {
              const tool = definition as FakeTool
              spawned.set(tool.name, tool)
              return () => spawned.delete(tool.name)
            },
          },
        })
        return { agent: { session: { id: options.sessionId } } }
      },
    },
  }
  return { ctx: ctx as never, tools, cleanups }
}

test('聘人时宿主现场创建成员会话并在其作用域内注册三个成员工具', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-spawn-'))
  const spawned = new Map<string, FakeTool>()
  const { ctx, tools, cleanups } = fakeContext(spawned)
  const captainExec = { agent: { id: 'ses_captain' } }

  try {
    applyCaptainHost(ctx, { projectRoot: dir })
    const created = (await tools.get('myteam_create_team')!.execute(
      { name: '甲队', goal: '测试聘人' },
      captainExec,
    )) as { ok: boolean; data: { roles: { id: string }[] } }
    assert.equal(created.ok, true, JSON.stringify(created))

    const member = (await tools.get('myteam_appoint_member')!.execute(
      { roleId: created.data.roles[0]!.id },
      captainExec,
    )) as { ok: boolean; data: { memberId: string; sessionId: string | null; bound: boolean } }
    assert.equal(member.ok, true, JSON.stringify(member))
    assert.equal(member.data.bound, true, '成员会话应已创建并绑定')
    assert.match(member.data.sessionId!, /^mt-member-/)

    // 成员工具只注册了三个，且能真的提交进度（说明身份解析到新成员）。
    assert.deepEqual([...spawned.keys()].sort(), ['myteam_evidence', 'myteam_progress', 'myteam_submit_review'])
    const progress = (await spawned.get('myteam_progress')!.execute(
      { taskId: 'task_x', attemptId: 'att_x', note: 'hi', percent: 50 },
      { agent: { id: member.data.sessionId! } },
    )) as { ok: boolean; error?: { code: string } }
    assert.equal(progress.ok, false, '任务不存在时应报错，而不是成功')
    assert.equal(progress.error!.code, 'NOT_FOUND')
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})