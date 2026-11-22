import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectHosts } from '../src/infrastructure/dsh/project-hosts.ts'
import { bootstrapProject } from '../src/application/bootstrap.ts'
import { createTeamCommand } from '../src/application/commands.ts'
import { previewTeamDisband } from '../src/application/human-actions.ts'
import { actOnHumanCard } from '../src/composition/human-cards.ts'

const HUMAN = { kind: 'human' as const, userId: 'tester', via: 'host' as const }

test('动作卡片：targetHash 一致才执行解散；不一致拒绝；cancel 不写业务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-card-'))
  const hosts = new ProjectHosts()
  try {
    const runtime = await hosts.open(dir)
    bootstrapProject(runtime, dir)
    const created = createTeamCommand(runtime, { actor: HUMAN, name: '卡片队', goal: '', captainSessionId: 'ses_card' })
    const teamId = (created.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } })
      .team.id
    const preview = previewTeamDisband(runtime, { teamId })

    const stale = await actOnHumanCard(
      { open: async () => runtime },
      {
        callId: 'call-1',
        action: 'myteam.human',
        sessionId: 'ses_card',
        details: { action: 'disband', teamId, toSessionId: '', summary: preview.summary, targetHash: 'stale-hash' },
      },
      'confirm',
    )
    assert.equal(stale.status, 'refused')
    assert.match((stale as { reason: string }).reason, /状态已变化/)

    const cancel = await actOnHumanCard(
      { open: async () => runtime },
      {
        callId: 'call-2',
        action: 'myteam.human',
        sessionId: 'ses_card',
        details: { action: 'disband', teamId, toSessionId: '', summary: preview.summary, targetHash: preview.targetHash },
      },
      'cancel',
    )
    assert.equal(cancel.status, 'settled')
    assert.equal((cancel as { decision: { phase: string } }).decision.phase, 'cancelled')

    const confirmed = await actOnHumanCard(
      { open: async () => runtime },
      {
        callId: 'call-3',
        action: 'myteam.human',
        sessionId: 'ses_card',
        details: { action: 'disband', teamId, toSessionId: '', summary: preview.summary, targetHash: preview.targetHash },
      },
      'confirm',
    )
    assert.equal(confirmed.status, 'settled', JSON.stringify(confirmed))
    assert.equal(runtime.state.teams.get(teamId)!.status, 'disbanded')

    const unknown = await actOnHumanCard(
      { open: async () => runtime },
      {
        callId: 'call-4',
        action: 'myteam.human',
        sessionId: 'ses_card',
        details: { action: 'disband', teamId, toSessionId: '', summary: '', targetHash: preview.targetHash },
      },
      'explode',
    )
    assert.equal(unknown.status, 'refused')
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})