/**
 * t49：面板写「建团队 / 召唤成员」（L0-G1、G2）。
 *
 * 这两个动作的域命令早就有了（队长工具也在用），只是面板写通道没登记 —— 设计稿的
 * 「从蓝图建团队」「召唤成员」两屏因此没地方发请求。这里锁住面板路径：
 * 缺 confirm 拒绝、正常落地成事件、未知蓝图/团队报 NOT_FOUND、成员固化角色快照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ensureProjectManifest } from '../src/infrastructure/fs/project-manifest.ts'
import { createProjectRole, initializeProject } from '../src/application/commands.ts'
import { applyDirectPanelWrite } from '../src/application/panel-writes.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../src/contracts/versions.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'confirmation' }
const NOW = '2026-01-01T00:00:00.000Z'

function openRuntime(dir: string): ProjectRuntime {
  const manifest = ensureProjectManifest(dir, { projectId: newId('project'), createdAt: NOW })
  return ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(dir, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(dir, WRITER_LOCK_FILE)),
    clock: { now: () => NOW },
    ids: newId,
  })
}

function seed(runtime: ProjectRuntime): { roleId: string } {
  initializeProject(runtime, { actor: HUMAN, name: '建队项目' })
  const role = createProjectRole(runtime, {
    actor: HUMAN,
    profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
    capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
  })
  return { roleId: (role.events[0]!.payload as { role: { id: string } }).role.id }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MyTeamError, `应抛 MyTeamError，实际 ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`应抛 ${code}`)
}

test('面板写 teamCreate：缺 confirm 拒绝；正常建队并绑队长会话', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-team-create-'))
  try {
    const runtime = openRuntime(dir)
    try {
      seed(runtime)
      const params = { name: '甲队', goal: '把闭环跑通', captainSessionId: 'ses_captain_1' }
      expectCode(() => applyDirectPanelWrite(runtime, 'teamCreate', { confirm: false, params }), 'INVALID_PAYLOAD')
      assert.equal(runtime.state.teams.size, 0, '被拒绝的写不能建出团队')

      const applied = applyDirectPanelWrite(runtime, 'teamCreate', { confirm: true, params })
      const committed = applied.committed as { teamId: string; name: string; captainSessionId: string }
      assert.equal(committed.name, '甲队')
      assert.equal(committed.captainSessionId, 'ses_captain_1')

      const team = runtime.state.teams.get(committed.teamId)!
      assert.equal(team.status, 'active')
      // 队长绑定不是 Team 实体字段，而在单独的 captain assignment 投影里。
      const assignment = runtime.state.captains.get(committed.teamId)!
      assert.equal(assignment.sessionId, 'ses_captain_1', '队长会话要按参数绑定')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板写 teamCreate：蓝图不存在 → NOT_FOUND，且不留下团队', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-team-create-'))
  try {
    const runtime = openRuntime(dir)
    try {
      seed(runtime)
      expectCode(
        () =>
          applyDirectPanelWrite(runtime, 'teamCreate', {
            confirm: true,
            params: { name: '乙队', goal: 'g', captainSessionId: 'ses_b', blueprintId: 'blueprint_missing' },
          }),
        'NOT_FOUND',
      )
      assert.equal(runtime.state.teams.size, 0)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板写 memberAppoint：缺 confirm 拒绝；正常聘任且固化角色快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-member-appoint-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { roleId } = seed(runtime)
      const team = applyDirectPanelWrite(runtime, 'teamCreate', {
        confirm: true,
        params: { name: '甲队', goal: 'g', captainSessionId: 'ses_a' },
      })
      const teamId = (team.committed as { teamId: string }).teamId

      const params = { teamId, roleId }
      expectCode(() => applyDirectPanelWrite(runtime, 'memberAppoint', { confirm: false, params }), 'INVALID_PAYLOAD')
      assert.equal(runtime.state.members.size, 0, '被拒绝的写不能聘任出成员')

      const applied = applyDirectPanelWrite(runtime, 'memberAppoint', { confirm: true, params })
      const committed = applied.committed as { memberId: string; status: string }
      // 不给会话时成员停在 appointed（会话绑定后才 active），这是域里的既定语义。
      assert.equal(committed.status, 'appointed')

      const member = runtime.state.members.get(committed.memberId)!
      assert.equal(member.teamId, teamId)
      assert.equal(member.roleId, roleId)
      assert.equal(member.roleSnapshot.id, roleId, '聘任时要把角色固化成快照')
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板写 memberAppoint：团队不存在 → NOT_FOUND；角色不存在 → NOT_FOUND', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-member-appoint-'))
  try {
    const runtime = openRuntime(dir)
    try {
      const { roleId } = seed(runtime)
      expectCode(
        () => applyDirectPanelWrite(runtime, 'memberAppoint', { confirm: true, params: { teamId: 'team_missing', roleId } }),
        'NOT_FOUND',
      )
      const team = applyDirectPanelWrite(runtime, 'teamCreate', {
        confirm: true,
        params: { name: '丙队', goal: 'g', captainSessionId: 'ses_c' },
      })
      const teamId = (team.committed as { teamId: string }).teamId
      expectCode(
        () => applyDirectPanelWrite(runtime, 'memberAppoint', { confirm: true, params: { teamId, roleId: 'role_missing' } }),
        'NOT_FOUND',
      )
      assert.equal(runtime.state.members.size, 0)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})