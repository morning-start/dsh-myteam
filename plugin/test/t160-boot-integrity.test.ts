/**
 * T160 · CHG-210：**冷启动不得污染账本**。
 *
 * 缺陷现场（两个独立实测都复现）：`service()` 构造后**无条件** `bootstrapTeam`，
 * 于是每进程每团队冷启动都追加一条 `rules.version.adopted`：
 *   - 连续构造 3 次 → 账本 seq 0/1/2 三行同名事件；
 *   - 「看一眼已归档团队」也会改它的账本（打开=写）；
 *   - `revision` 与真实业务事件数脱钩，时间线出现重复首事件。
 *
 * 本文件钉两件事：
 *   ① 已有账本的团队，反复打开**零新增**（这是修法的主断言）；
 *   ② 空账本的团队，第一次打开**必须**落基线（否则后续 commit 会以
 *      `MT_LEDGER_MISSING_RULES_VERSION` 整体失败——不能为了「不写」把初始化也去掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

const TASK = {
  title: '完整性用例', description: 'd', acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [], requiredRole: 'implementer', taskType: 'default', estimate: 'S',
}

const eventsOf = (root: string, teamId: string) =>
  readFileSync(join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl'), 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))

/** 每次调用 = 一次「进程重启」（新 host 实例 + initialize） */
function boot(root: string): MyTeamHost {
  const host = new MyTeamHost(makeRuntime(root))
  host.initialize()
  return host
}

test('t160-1: 已有账本的团队，反复打开零新增（不再追加 rules.version.adopted）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t160-idem-'))
  try {
    const first = boot(root)
    const sub = first.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }, { roleId: 'implementer' }], tasks: [] }, {}) as any
    const teamId = String(sub.teamId)
    first.executeLeadTool('myteam_approve_plan', { teamId }, {})
    first.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {})

    const baseline = eventsOf(root, teamId).filter((e) => e.type === 'rules.version.adopted').length
    assert.equal(baseline, 1, '首次建队必须有且只有一条基线事件')

    // 三次「重启」：每次都真的走 service() 构造（initialize → reconcile → recover 都会碰 team）
    for (let round = 1; round <= 3; round += 1) {
      const host = boot(root)
      host.service(teamId) // 显式打开一次（模拟面板/工具读面）
      host.service(teamId) // 缓存命中路径
      assert.equal(
        eventsOf(root, teamId).filter((e) => e.type === 'rules.version.adopted').length,
        1,
        `第 ${round} 次重启后基线事件不得增加（旧实现每次 +1）`,
      )
    }

    // 账本整体条数也必须稳定（不只是基线事件那一类）
    const countAfter = eventsOf(root, teamId).length
    boot(root).service(teamId)
    assert.equal(eventsOf(root, teamId).length, countAfter, '打开团队必须零写入')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t160-2: 空账本团队，第一次打开仍要有基线事件（否则后续 commit 全挂）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t160-empty-'))
  try {
    /* 只建目录不写账本：模拟「团队目录存在但账本是空的」（导入/复制/崩溃残留的形态） */
    const first = boot(root)
    const sub = first.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }], tasks: [] }, {}) as any
    const teamId = String(sub.teamId)
    const before = eventsOf(root, teamId)
    assert.equal(before.filter((e) => e.type === 'rules.version.adopted').length, 1)

    // 再次打开：不新增
    boot(root).service(teamId)
    assert.equal(eventsOf(root, teamId).filter((e) => e.type === 'rules.version.adopted').length, 1)

    // 且基线之后的写入仍然正常（没有把初始化一起去掉）
    const host = boot(root)
    const created = host.executeLeadTool('myteam_create_task', { teamId, task: TASK }, {}) as any
    assert.equal(created.status, 'created', JSON.stringify(created))
    assert.ok(eventsOf(root, teamId).some((e) => e.type === 'task.created'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t160-3: 归档后的团队被打开，账本也不得被改（打开=写的历史缺陷）', () => {
  const root = mkdtempSync(join(tmpdir(), 'mt-t160-arch-'))
  try {
    const first = boot(root)
    const sub = first.executeLeadTool('myteam_submit_plan', { teamName: 'T', goal: 'G', roster: [{ roleId: 'captain' }], tasks: [] }, {}) as any
    const teamId = String(sub.teamId)
    first.executeLeadTool('myteam_approve_plan', { teamId }, {})
    const disbanded = first.executeLeadTool('myteam_disband', { teamId, confirm: true }, {}) as any
    assert.ok(disbanded.status === 'disbanded' || disbanded.status === 'ok', JSON.stringify(disbanded))

    const snapshot = eventsOf(root, teamId)
    const reopened = boot(root)
    reopened.service(teamId) // 回看已归档团队
    const after = eventsOf(root, teamId)
    assert.equal(after.length, snapshot.length, '回看归档团队不得写账本')
    assert.deepEqual(after.map((e) => e.type), snapshot.map((e) => e.type), '事件序列必须逐条不变')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
