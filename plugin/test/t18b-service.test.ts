import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamService, bootstrapTeam } from '../src/core/service.ts'
import { copyToProject } from '../src/core/roles/role-store.ts'
import { adoptDraft, knowledgeDirOf, readKnowledgeEntry } from '../src/core/knowledge/knowledge.ts'

function setup() {
  const ws = mkdtempSync(join(tmpdir(), 'myteam-t18b-'))
  const rolePaths = { projectRolesDir: join(ws, 'roles') }
  copyToProject(rolePaths, 'captain', 'builtin')
  copyToProject(rolePaths, 'implementer', 'builtin')
  const service = new TeamService({ workspaceRoot: ws, teamId: 't1', rolePaths })
  bootstrapTeam(service)
  service.commit({ actor: 'lead', type: 'team.created', payload: { teamId: 't1', name: 'n', goal: 'g', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }] } })
  service.commit({ actor: 'lead', type: 'plan.approved', payload: { teamId: 't1', planId: 'p1' } })
  service.commit({ actor: 'lead', type: 'task.created', payload: { teamId: 't1', taskId: 'k1', task: { title: 't', description: 'd', acceptanceCriteria: ['ac'], deliverableSpec: { path: 'docs/x.md' }, deps: [], requiredRole: 'implementer', priority: 'P2', gateChain: ['review'] } } })
  service.commit({ actor: 'lead', type: 'member.spawned', payload: { teamId: 't1', memberId: 'm1', roleId: 'implementer', sessionId: 's1', status: 'ok', instanceName: 'impl-1' } })
  service.commit({ actor: 'm1', type: 'task.claimed', payload: { teamId: 't1', taskId: 'k1', memberId: 'm1', attemptId: 'a1' } })
  return { ws, service }
}

test('T18 service: knowledge.proposed without evidence rejected; with evidence accepted (FR-17.4)', () => {
  const { service } = setup()
  const noEv = service.commit({
    actor: 'm1', type: 'knowledge.proposed',
    payload: { teamId: 't1', draftId: 'd1', draft: { id: 'd1', title: 't', body: 'b', evidence: '' } },
  })
  assert.equal(noEv.ok, false)
  assert.equal((noEv as { code: string }).code, 'MT_KB_EVIDENCE_REQUIRED')
  const ok = service.commit({
    actor: 'm1', type: 'knowledge.proposed',
    payload: { teamId: 't1', draftId: 'd1', draft: { id: 'd1', title: '用户域模型', body: '正文', evidence: 'task-k1', tags: ['db'] } },
  })
  assert.equal(ok.ok, true)
})

test('T18 service: adopt without prior proposal rejected; full curation flow lands entry on disk (scene 31)', () => {
  const { ws, service } = setup()
  // 未提案直接采纳 → 拒绝
  const adoptNoProposal = service.commit({ actor: 'lead', type: 'knowledge.adopted', payload: { teamId: 't1', draftId: 'd1' } })
  assert.equal(adoptNoProposal.ok, false)
  // 提案 → 采纳 → 落库（host 侧 adoptDraft + writeKnowledgeEntry）
  service.commit({
    actor: 'm1', type: 'knowledge.proposed',
    payload: { teamId: 't1', draftId: 'd1', draft: { id: 'dsl-guide', title: 'DSL 指南', body: '正文', evidence: 'task-k1', tags: ['tool'] } },
  })
  const adopt = service.commit({ actor: 'lead', type: 'knowledge.adopted', payload: { teamId: 't1', draftId: 'd1' } })
  assert.equal(adopt.ok, true)
  // host 侧落库（队长采纳动作的实际写入）
  const draft = { id: 'dsl-guide', title: 'DSL 指南', tags: ['tool'], body: '正文', evidence: 'task-k1' }
  const entry = adoptDraft(draft, 'm1', new Set(), '2026-10-25')
  knowledgeModule.writeKnowledgeEntry(knowledgeDirOf(ws), entry)
  const read = readKnowledgeEntry(knowledgeDirOf(ws), 'dsl-guide')
  assert.ok(read)
  assert.equal(read!.contributor, 'm1')
  assert.deepEqual(read!.evidence, ['task-k1'])
  assert.equal(read!.proofCount, 1)
  assert.ok(existsSync(join(knowledgeDirOf(ws), 'index.json')))
})

import * as knowledgeModule from '../src/core/knowledge/knowledge.ts'
