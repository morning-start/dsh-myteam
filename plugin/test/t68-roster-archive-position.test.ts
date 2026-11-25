/**
 * t68：名册树里归档成员的位置 —— 从数据源到挂树逻辑的端到端验证。
 *
 * 为什么要有：`docs/features/界面依赖与搭建顺序.md` 一直把「归档成员进树之后位置对不对」
 * 列为**没验过**。t39 那条用的是渲染夹具（手写 members 数组），验的是「给了这样的数据，
 * 树画得对」；这里验的是**真实数据源会不会给出那样的数据**。
 *
 * 锁三件事：
 *   1. 领域层禁止「有未归档子成员时归档父成员」（CONFLICT）—— 所以树里不会出现
 *      「归档父成员 + 在岗子成员」这种需要特殊处理的组合；
 *   2. 合法顺序（从叶子往上归档）之后，`teamView` 仍返回全部成员，含归档的；
 *   3. 按 RosterTree 的挂树逻辑复算，归档成员的深度与父子关系都保持原样，不被挪到根层。
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
import {
  appointMemberCommand,
  archiveMemberCommand,
  createProjectRole,
  createTeamCommand,
  initializeProject,
} from '../src/application/commands.ts'
import { teamView } from '../src/application/queries.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
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

/** 复刻 client.js 里 RosterTree 的挂树逻辑，返回每名成员的深度与孤儿标记。 */
function layout(members: { id: string; parentMemberId: string | null }[]): Map<string, { depth: number; orphan: boolean }> {
  const ids = new Set(members.map((member) => member.id))
  const children = new Map<string, typeof members>()
  const roots: typeof members = []
  for (const member of members) {
    if (member.parentMemberId === null || !ids.has(member.parentMemberId)) {
      roots.push(member)
    } else {
      const list = children.get(member.parentMemberId) ?? []
      list.push(member)
      children.set(member.parentMemberId, list)
    }
  }
  const out = new Map<string, { depth: number; orphan: boolean }>()
  const walk = (member: (typeof members)[number], depth: number): void => {
    out.set(member.id, {
      depth,
      orphan: member.parentMemberId !== null && !ids.has(member.parentMemberId),
    })
    for (const child of children.get(member.id) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 0)
  return out
}

function withTeam(body: (runtime: ProjectRuntime, teamId: string, roleId: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t68-'))
  try {
    const runtime = openRuntime(dir)
    try {
      initializeProject(runtime, { actor: HUMAN, name: '归档位置' })
      createProjectRole(runtime, {
        actor: HUMAN,
        profile: { name: '实现者', purpose: '实现', instructions: '按 AC 做', specialties: [] },
        capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
      })
      const roleId = [...runtime.state.roles.keys()][0]!
      createTeamCommand(runtime, { actor: HUMAN, name: '甲队', goal: '目标', captainSessionId: 'ses_cap' })
      const teamId = [...runtime.state.teams.keys()][0]!
      body(runtime, teamId, roleId)
    } finally {
      runtime.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('有未归档子成员时，归档父成员被拒（CONFLICT）', () => {
  withTeam((runtime, teamId, roleId) => {
    appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, parentMemberId: null })
    const parentId = [...runtime.state.members.keys()][0]!
    appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, parentMemberId: parentId })

    assert.throws(
      () => archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId: parentId }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'CONFLICT',
      '父成员下面还有在岗子成员时不能归档 —— 否则树里会出现「归档父 + 在岗子」',
    )
  })
})

test('从叶子往上归档后：teamView 仍返回全部成员，归档成员层级与父子关系不变', () => {
  withTeam((runtime, teamId, roleId) => {
    appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, parentMemberId: null })
    const rootId = [...runtime.state.members.keys()][0]!
    appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, parentMemberId: rootId })
    const childId = [...runtime.state.members.keys()].find((id) => id !== rootId)!
    appointMemberCommand(runtime, { actor: HUMAN, teamId, roleId, parentMemberId: childId })
    const grandId = [...runtime.state.members.keys()].find((id) => id !== rootId && id !== childId)!

    // 合法顺序：叶子先归档
    archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId: grandId })
    archiveMemberCommand(runtime, { actor: HUMAN, teamId, memberId: childId })

    const view = teamView(runtime.state, teamId)
    assert.equal(view.members.length, 3, '归档成员必须仍在 teamView 里（名册保留记录）')

    const archived = view.members.filter((member) => member.status === 'archived')
    assert.equal(archived.length, 2, '两名成员已归档')

    const placed = layout(view.members)
    assert.equal(placed.get(rootId)!.depth, 0, '根成员在 d0')
    assert.equal(placed.get(childId)!.depth, 1, '归档的子成员仍在 d1，不被挪到根层')
    assert.equal(placed.get(grandId)!.depth, 2, '归档的孙成员仍在 d2')
    for (const [, info] of placed) {
      assert.equal(info.orphan, false, '合法归档顺序下不该出现孤儿')
    }
  })
})
