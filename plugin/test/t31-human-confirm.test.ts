import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectHosts } from '../src/infrastructure/dsh/project-hosts.ts'
import { bootstrapProject } from '../src/application/bootstrap.ts'
import { createTeamCommand } from '../src/application/commands.ts'
import { registerHumanCommands } from '../src/composition/human-command.ts'

const HUMAN = { kind: 'human' as const, userId: 'tester', via: 'host' as const }

test('人类动作：预览后可直接 --yes 确认，不必手抄 targetHash；重复确认被拒', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-cmd-'))
  const hosts = new ProjectHosts()
  const handlers = new Map<string, (invocation: unknown) => Promise<{ kind: string; text: string }>>()
  const disposers = registerHumanCommands({
    commands: {
      register: (definition: never) => {
        const def = definition as unknown as { name: string; handler: (invocation: unknown) => Promise<{ kind: string; text: string }> }
        handlers.set(def.name, def.handler)
        return () => handlers.delete(def.name)
      },
    },
    agents: { get: (id: string) => ({ id }) },
    workingDirectory: { ensure: async () => dir },
  } as never)

  try {
    const runtime = await hosts.open(dir)
    bootstrapProject(runtime, dir)
    const created = createTeamCommand(runtime, { actor: HUMAN, name: '解散队', goal: '', captainSessionId: 'ses_h' })
    const teamId = (created.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } })
      .team.id
    const invoke = (rawInput: string) => handlers.get('myteam-disband')!({ agent: { id: 'ses_h' }, rawInput })

    const preview = await invoke(teamId)
    assert.equal(preview.kind, 'success')
    assert.match(preview.text, /这是预览，未写入/)
    assert.match(preview.text, /--yes/)

    const confirmed = await invoke(`${teamId} --yes`)
    assert.equal(confirmed.kind, 'success', confirmed.text)
    assert.match(confirmed.text, /已执行/)

    // 预览已消费：再来一次必须要求重新预览。
    const again = await invoke(`${teamId} --yes`)
    assert.equal(again.kind, 'error')
    assert.match(again.text, /没有可用的预览/)
  } finally {
    for (const dispose of disposers) dispose()
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})