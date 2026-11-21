/**
 * T165 · CHG-210 批 5.1：**优先级真的决定谁先被领**。
 *
 * 缺陷现场：`claimOrder`（P0→P3，同级按 `waitingSince ?? createdAt` FIFO）早已实现、
 * 有单测、文档也承诺「优先级最高 + 同级 FIFO 防饿死」——但**生产零调用**：
 * `claimableTasks` 直接返回 `Object.values(proj.tasks)`，也就是账本插入序。
 * 后果：P3 只要建得早就能一直压着 P0；低优先级也不会因为等久了而升值。
 *
 * 本文件钉三件事：
 *   ① P0 后建也排在 P3 前（优先级生效）；
 *   ② 同优先级按建单先后（FIFO）；
 *   ③ 排序只改顺序——**不改变进出集合**（角色不匹配 / 依赖未完成的仍然领不到）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

function makeRuntime(root: string): HostRuntime {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

const task = (title: string, priority: 'P0' | 'P1' | 'P2' | 'P3', requiredRole = 'implementer') => ({
  title, description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: `docs/${title}.md`, producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole, taskType: 'default', estimate: 'S', priority,
})

function setup(root: string) {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  const sub = host.executeLeadTool('myteam_submit_plan', {
    teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }, { roleId: 'reviewer' }], tasks: [],
  }, {}) as any
  const teamId = String(sub.teamId)
  host.executeLeadTool('myteam_approve_plan', { teamId }, {})
  return { host, teamId }
}

test('t165-1: P0 后建也排在 P3 前（优先级真的生效）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t165-prio-'))
  try {
    const { host, teamId } = setup(root)
    const p3 = host.executeLeadTool('myteam_create_task', { teamId, task: task('low', 'P3') }, {}) as any
    const p0 = host.executeLeadTool('myteam_create_task', { teamId, task: task('urgent', 'P0') }, {}) as any
    const order = host.service(teamId).claimableTasks('implementer').map((t) => t.id)
    assert.deepEqual(order.slice(0, 2), [p0.taskId, p3.taskId], 'P0 必须排在 P3 前面（旧实现是建单序，P3 反在前）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t165-2: 同优先级按建单先后（FIFO）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t165-fifo-'))
  try {
    const { host, teamId } = setup(root)
    const first = host.executeLeadTool('myteam_create_task', { teamId, task: task('a', 'P2') }, {}) as any
    const second = host.executeLeadTool('myteam_create_task', { teamId, task: task('b', 'P2') }, {}) as any
    const order = host.service(teamId).claimableTasks('implementer').map((t) => t.id)
    assert.deepEqual(order.slice(0, 2), [first.taskId, second.taskId], '同级先建先领')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t165-3: 排序不改进出集合——角色不匹配仍然领不到', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t165-set-'))
  try {
    const { host, teamId } = setup(root)
    host.executeLeadTool('myteam_create_task', { teamId, task: task('impl-p0', 'P0', 'implementer') }, {})
    const review = host.executeLeadTool('myteam_create_task', { teamId, task: task('rev-p3', 'P3', 'reviewer') }, {}) as any
    const implOrder = host.service(teamId).claimableTasks('implementer').map((t) => t.id)
    assert.equal(implOrder.length, 1, 'implementer 只看到自己角色的任务')
    assert.ok(!implOrder.includes(review.taskId), '别的角色的任务不得因为排序被带进来')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})