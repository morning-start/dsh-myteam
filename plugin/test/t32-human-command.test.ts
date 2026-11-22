import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectHosts } from '../src/infrastructure/dsh/project-hosts.ts'
import { createTeamCommand } from '../src/application/commands.ts'
import { registerHumanCommands } from '../src/composition/human-command.ts'

test('人类命令：先预览后 --yes 执行，模型无法绕过（命令只在 UI 提交路径存在）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-cmd-'))
  const hosts = new ProjectHosts()
  const actor = { kind: 'human', userId: 'tester', via: 'host' }
  const registered = new Map()

  try {
    const runtime = await hosts.open(dir)
    const created = createTeamCommand(runtime, {
      actor,
      name: '命令队',
      goal: '验证命令入口',
      captainSessionId: 'ses_cmd_test',
    })
    const teamId = (created.events.find((event) => event.type === 'team.created')!.payload as { team: { id: string } })
      .team.id
    await hosts.closeAll()

    const disposers = registerHumanCommands({
      commands: {
        register(definition) {
          registered.set(definition.name, definition)
          return () => registered.delete(definition.name)
        },
      },
      agents: { get: (id) => (id === 'ses_cmd_test' ? { id } : undefined) },
      workingDirectory: { ensure: async () => dir },
    })
    assert.deepEqual([...registered.keys()].sort(), ['myteam-disband', 'myteam-takeover'])

    const invoke = async (name, rawInput) =>
      registered.get(name).handler({ agent: { id: 'ses_cmd_test' }, rawInput })

    const preview = await invoke('myteam-disband', teamId)
    assert.equal(preview.kind, 'success')
    assert.match(preview.text, /这是预览，未写入/)
    assert.match(preview.text, /targetHash/)

    const applied = await invoke('myteam-disband', `${teamId} 测试解散 --yes`)
    assert.equal(applied.kind, 'success', applied.text)
    assert.match(applied.text, /已执行：team.disband/)

    // 已解散后再执行应报错，而不是静默成功。
    const again = await invoke('myteam-disband', `${teamId} --yes`)
    assert.equal(again.kind, 'error')

    for (const dispose of disposers) dispose()
  } finally {
    await hosts.closeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})