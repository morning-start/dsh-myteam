import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { createTeamCommand, initializeProject } from '../src/application/commands.ts'
import type { EventEnvelope } from '../src/contracts/events.ts'

const HUMAN = { kind: 'human' as const, userId: 'tester', via: 'host' as const }

function fakes() {
  const events: EventEnvelope[] = []
  let counter = 0
  return {
    events,
    eventStore: {
      readCommitted: () => ({ events }),
      append: (incoming: EventEnvelope[]) => {
        events.push(...incoming)
      },
    },
    writerLock: {
      acquire: () => ({ owner: 'test', pid: 1, fencing: 1 } as never),
      renew: (token: unknown) => token,
      assert: () => undefined,
      release: () => undefined,
    },
    clock: { now: () => new Date().toISOString() },
    ids: (kind: string) => `${kind}_${++counter}`,
  }
}

test('外部写入后 refresh 才能看到新团队（陈旧投影会误判身份）', async () => {
  const fake = fakes()
  const options = {
    projectId: 'prj_test',
    eventStore: fake.eventStore as never,
    writerLock: fake.writerLock as never,
    clock: fake.clock as never,
    ids: fake.ids as never,
  }

  const writer = ProjectRuntime.open(options)
  const reader = ProjectRuntime.open(options)
  try {
    initializeProject(writer, { actor: HUMAN, name: '刷新验证' })
    reader.refresh()
    assert.equal(reader.state.teams.size, 0)

    createTeamCommand(writer, { actor: HUMAN, name: '外部队', goal: '', captainSessionId: 'ses_x' })
    assert.equal(reader.state.teams.size, 0, '未 refresh 前应仍是陈旧投影')

    reader.refresh()
    assert.equal(reader.state.teams.size, 1)
    assert.equal([...reader.state.teams.values()][0]!.name, '外部队')
  } finally {
    writer.close()
    reader.close()
  }
})