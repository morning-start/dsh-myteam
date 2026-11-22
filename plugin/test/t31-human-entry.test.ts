import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectHosts } from '../src/infrastructure/dsh/project-hosts.ts'
import { createTeamCommand } from '../src/application/commands.ts'
import { runHumanAction } from '../../tools/myteam-human.mjs'

test('人类入口：预览 → 确认解散团队，预览不写入、执行后团队已解散', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-human-'))
  const hosts = new ProjectHosts()
  const actor = { kind: 'human', userId: 'tester', via: 'host' }
  try {
    const runtime = await hosts.open(dir)
    const created = createTeamCommand(runtime, {
      actor,
      name: '待解散队',
      goal: '验证人类入口',
      captainSessionId: 'ses_human_test',
    })
    const teamId = (created.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } })
      .team.id
    await hosts.closeAll()

    const preview = await runHumanAction({ command: 'preview', root: dir, action: 'disband', team: teamId })
    assert.equal(preview.kind, 'preview')
    assert.equal(preview.preview.action, 'team.disband')
    assert.match(preview.preview.targetHash, /^sha256:/)
    assert.match(preview.preview.impactHash, /^sha256:/)

    const applied = await runHumanAction({
      command: 'apply',
      root: dir,
      action: 'disband',
      team: teamId,
      by: 'tester',
      yes: true,
    })
    assert.equal(applied.kind, 'applied', JSON.stringify(applied))
    assert.ok(applied.events.includes('team.disbanded'), JSON.stringify(applied.events))

    // 再次执行应被拒（团队已解散）。
    let failure: unknown = null
    try {
      await runHumanAction({ command: 'apply', root: dir, action: 'disband', team: teamId, by: 'tester', yes: true })
    } catch (error) {
      failure = error
    }
    assert.ok(failure !== null, '已解散团队不应还能再次解散')
    assert.match(String((failure as { message?: string }).message ?? failure), /已解散/)
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})