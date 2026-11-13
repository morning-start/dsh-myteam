/**
 * T140 · 项目级看板派生索引（CHG-188 / FR-33 · M3-6）
 *
 * 三条不变量（少一条索引就变成第二真源）：
 *  ① **可重建**：删掉索引文件后再读，结果必须与原来逐字段相等（派生数据不是真源）；
 *  ② **逐字段相等**：索引内容 = 实时折叠（`foldBoardLive`）的内容，一个字段都不许漂；
 *  ③ **坏索引降级**：坏 JSON / `schema` 版本不符 / 账本比索引新 → 回落实时折叠，
 *     **绝不返回空看板**（空看板会被 UI 说成「这个项目没有任务」= 谎报）。
 *
 * 夹具纪律：临时项目根（`mkdtempSync(tmpdir())`）里用**真实入口**
 * （`MyTeamHost.executeLeadTool`）建团队与任务，不碰仓库自己的 `.dsh-myteam/`，
 * 也不手写账本行（手写会绕开 payload 校验，测出来的索引和真机不是一份东西）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import {
  BOARD_INDEX_SCHEMA,
  boardIndexPath,
  buildProjectBoardIndex,
  foldBoardLive,
  readProjectBoardIndex,
  type ProjectBoardIndex,
} from '../src/core/index/project-board-index.ts'

const TASKS_PER_TEAM = 3
const TEAM_COUNT = 2
const TOTAL_TASKS = TASKS_PER_TEAM * TEAM_COUNT

function makeRuntime(root: string) {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
}

function setup(root: string) {
  const rt = makeRuntime(root)
  const host = new MyTeamHost(rt)
  host.initialize()
  const remote = new MyTeamRemote(rt, host)
  return { host, remote }
}

const taskOf = (title: string) => ({
  title,
  description: 'd',
  acceptanceCriteria: ['AC1'],
  deliverableSpec: { path: 'docs/x.md', producer: 'implementer', reviewer: 'reviewer', archiver: 'captain' },
  deps: [],
  requiredRole: 'implementer',
  taskType: 'default',
  estimate: 'S',
})

/** 建两个团队、各 3 个任务（全项目 6 个任务）——走真实入口，不写假账本 */
function seedTwoTeams(host: MyTeamHost, remote: MyTeamRemote): void {
  for (const teamId of ['team-a', 'team-b']) {
    host.executeLeadTool(
      'myteam_submit_plan',
      {
        teamId,
        teamName: `Team ${teamId}`,
        goal: `goal of ${teamId}`,
        roster: [{ roleId: 'captain' }, { roleId: 'implementer' }],
        tasks: [],
      },
      {},
    )
    void remote.planAction({ teamId, action: 'approve' })
    for (let index = 0; index < TASKS_PER_TEAM; index += 1) {
      host.executeLeadTool('myteam_create_task', { teamId, task: taskOf(`${teamId} 任务 ${index}`) }, {})
    }
  }
}

function withProject(run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-board-'))
    try {
      await run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/** 比较用的去时间戳副本（`builtAt` 每次构建都不同，不参与内容比对） */
function contentOf(index: ProjectBoardIndex): Omit<ProjectBoardIndex, 'builtAt'> {
  const { builtAt: _ignored, ...content } = index
  return content
}

test(
  't140-1: 索引内容与实时折叠逐字段相等',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)

    const live = foldBoardLive(root)
    const built = await buildProjectBoardIndex(root)
    const read = await readProjectBoardIndex(root)

    // 读的是盘上那份（builtAt 不变），不是每次重新折叠出来的
    assert.equal(read.builtAt, built.builtAt, '第二次读必须读盘：builtAt 变了说明又在实时折叠')
    // 逐字段相等（除 builtAt 外的全部顶层字段）
    assert.deepEqual(contentOf(read), contentOf(live), '索引内容必须与实时折叠逐字段相等')
    assert.equal(read.tasks.length, TOTAL_TASKS, '两个团队 × 3 个任务必须全部进索引')
    assert.deepEqual(
      read.teams.map((team) => team.teamId),
      ['team-a', 'team-b'],
      '团队摘要按 teamId 升序（删掉重算才逐字段相等）',
    )
    assert.equal(read.counts.tasks, TOTAL_TASKS, '汇总口径 = 全项目任务数')
    assert.equal(read.counts.teams, TEAM_COUNT)
    // 复合键：跨团队同名 task-N 不许互相覆盖（账本按团队分号，task-N 会撞）
    const keys = new Set(read.tasks.map((task) => task.key))
    assert.equal(keys.size, TOTAL_TASKS, '复合键必须唯一（teamId/taskId）')
    assert.ok(read.tasks.every((task) => task.key === `${task.ownerTeamId}/${task.id}`), 'key = teamId/taskId')
    // 索引要能换机器复用：绝对路径一个都不许进
    assert.ok(!JSON.stringify(read).includes(root), '索引里不得出现项目绝对路径（换机器就废）')
    assert.equal(read.schema, BOARD_INDEX_SCHEMA)
  }),
)

test(
  't140-2: 删掉索引文件后能全量重建（派生数据不是真源）',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)

    const first = await buildProjectBoardIndex(root)
    assert.ok(existsSync(boardIndexPath(root)), '构建后索引必须落盘')
    rmSync(boardIndexPath(root))

    const rebuilt = await readProjectBoardIndex(root)
    assert.equal(rebuilt.tasks.length, TOTAL_TASKS, '删掉索引后必须能全量重建')
    assert.deepEqual(contentOf(rebuilt), contentOf(first), '删掉重算的结果必须与原来逐字段相等')
    assert.ok(existsSync(boardIndexPath(root)), '缺失时读必须顺手把索引写回去（自愈）')
  }),
)

test(
  't140-3: 索引损坏（坏 JSON）→ 降级实时折叠，不返回空看板',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)
    await buildProjectBoardIndex(root)

    writeFileSync(boardIndexPath(root), '{ 坏掉了')

    const board = await readProjectBoardIndex(root)
    assert.equal(board.tasks.length, TOTAL_TASKS, '坏索引必须降级折叠，不能返回空看板')
    assert.equal(board.counts.tasks, TOTAL_TASKS, '汇总也不能是 0（0 会让 UI 说「没有任务」）')
    assert.equal(board.schema, BOARD_INDEX_SCHEMA, '降级结果仍是当前 schema 的形状')
  }),
)

test(
  't140-4: schema 版本不符 → 降级重算（旧结构不许当索引读）',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)
    const built = await buildProjectBoardIndex(root)

    writeFileSync(boardIndexPath(root), `${JSON.stringify({ ...built, schema: 999 })}\n`)

    const board = await readProjectBoardIndex(root)
    assert.equal(board.schema, BOARD_INDEX_SCHEMA, '版本不符必须丢弃重算，不能把 999 那个结构当索引')
    assert.equal(board.tasks.length, TOTAL_TASKS, '重算必须拿到全部任务')
  }),
)

test(
  't140-5: 账本比索引新（建索引后又落了一条任务）→ 重算拿到新任务',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)
    const built = await buildProjectBoardIndex(root)
    assert.equal(built.tasks.length, TOTAL_TASKS)

    // 索引建好之后再落一条任务（真实入口 → 账本 mtime 前进）
    host.executeLeadTool('myteam_create_task', { teamId: 'team-a', task: taskOf('后来新增的任务') }, {})
    // 把索引 mtime 压到过去：跨文件系统时间精度的差异不影响「索引比账本旧」这条判定
    const past = new Date(Date.now() - 60_000)
    utimesSync(boardIndexPath(root), past, past)

    const board = await readProjectBoardIndex(root)
    assert.equal(board.tasks.length, TOTAL_TASKS + 1, '账本比索引新时必须重算，不能返回旧索引')
    assert.ok(
      board.tasks.some((task) => task.title === '后来新增的任务'),
      '重算结果必须包含索引构建之后新增的任务',
    )
  }),
)
