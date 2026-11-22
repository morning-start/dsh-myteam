import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectHosts } from '../src/infrastructure/dsh/project-hosts.ts'
import { bootstrapProject } from '../src/application/bootstrap.ts'
import { createTeamCommand } from '../src/application/commands.ts'
import { apply as applyCaptainHost } from '../src/composition/host.ts'

const HUMAN = { kind: 'human' as const, userId: 'tester', via: 'host' as const }

interface FakeTool {
  name: string
  execute: (args: unknown, exec: { agent: { id: string } }) => Promise<unknown>
}

test('预览工具：解散预览返回 targetHash 且不写任何事件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-preview-'))
  const hosts = new ProjectHosts()
  const tools = new Map<string, FakeTool>()
  try {
    const runtime = await hosts.open(dir)
    bootstrapProject(runtime, dir)
    const created = createTeamCommand(runtime, { actor: HUMAN, name: '预览队', goal: '', captainSessionId: 'ses_p' })
    const teamId = (created.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } })
      .team.id

    const ctx = {
      tools: {
        register(definition: unknown) {
          const tool = definition as FakeTool
          tools.set(tool.name, tool)
          return () => tools.delete(tool.name)
        },
      },
      effect(execute: () => () => void) {
        execute()
      },
    }
    applyCaptainHost(ctx as never, { projectRoot: dir })

    const seqBefore = runtime.state.seq
    const result = (await tools.get('myteam_preview_disband')!.execute({ teamId }, { agent: { id: 'ses_p' } })) as {
      ok: boolean
      data?: { action: string; targetHash: string; summary: string }
    }
    assert.equal(result.ok, true)
    assert.equal(result.data!.action, 'team.disband')
    assert.equal(typeof result.data!.targetHash, 'string')
    assert.ok(result.data!.targetHash.length > 0)
    assert.equal(runtime.state.seq, seqBefore, '预览不得写事件')

    const takeover = (await tools.get('myteam_preview_takeover')!.execute(
      { teamId, toSessionId: 'ses_q' },
      { agent: { id: 'ses_p' } },
    )) as { ok: boolean; data?: { action: string; targetHash: string } }
    assert.equal(takeover.ok, true)
    assert.equal(takeover.data!.action, 'captain.takeover')
    assert.equal(runtime.state.seq, seqBefore)
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})