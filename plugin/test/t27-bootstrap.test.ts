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

function fakeContext(): { ctx: never; tools: Map<string, FakeTool>; cleanups: (() => void)[] } {
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
  }
  return { ctx: ctx as never, tools, cleanups }
}

test('引导建队：空项目里当前会话可自建团队并立刻建任务，重复建队被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-bootstrap-'))
  const { ctx, tools, cleanups } = fakeContext()
  const exec = { agent: { id: 'ses_captain_new' } }

  try {
    applyCaptainHost(ctx, { projectRoot: dir })

    // 建队前：建任务必须失败（还没有团队）。
    const before = (await tools.get('myteam_create_task')!.execute(
      { title: '不该成功', acceptance: ['x'] },
      exec,
    )) as { ok: boolean; error?: { code: string } }
    assert.equal(before.ok, false)
    assert.equal(before.error!.code, 'FORBIDDEN')

    const created = (await tools.get('myteam_create_team')!.execute(
      { name: '甲队', goal: '把登录模块拆出来' },
      exec,
    )) as { ok: boolean; data?: { teamId: string }; error?: { code: string } }
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.match(created.data!.teamId, /^team_/)

    // 建队后：同一个会话就是队长，可以建任务。
    const task = (await tools.get('myteam_create_task')!.execute(
      { title: '拆登录模块', acceptance: ['接口不变'] },
      exec,
    )) as { ok: boolean; data?: { taskId: string }; error?: { code: string } }
    assert.equal(task.ok, true, JSON.stringify(task))
    assert.match(task.data!.taskId, /^task_/)

    // 同一会话不能重复建队。
    const again = (await tools.get('myteam_create_team')!.execute({ name: '乙队', goal: '重复' }, exec)) as {
      ok: boolean
      error?: { code: string }
    }
    assert.equal(again.ok, false)
    assert.equal(again.error!.code, 'CONFLICT')
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})