/**
 * T143 · CHG-193（T160 · M3-7 收口）：**面板「任务」tab 接上项目看板派生索引的消费方**
 *
 * 背景（上一轮留的债）：`core/index/project-board-index.ts`（CHG-188）已建好、五条不变量被
 * `t140` 钉死，`getBoard({})` 也已把索引挂到返回值的 `project` 字段——但**没有任何消费方**：
 * 面板「任务」tab 仍走 `getProject().tasks`（每团队各拉一次、自己拼）。
 *
 * 本轮补的两件事：
 *  ① 面板任务 tab（列表 / 看板 / 流程 / 依赖图**四视图**）统一吃 `getBoard({}).project`；
 *     索引未加载 / 不可用 / 为空 → **降级** `getProject().tasks`（绝不白屏）。
 *  ② 打开任务带**复合键** `{ teamId, taskId }`：跨团队聚合后 `task-N` 会撞（每个团队都从
 *     task-1 编号），只传 taskId 会打开另一个团队的同名任务、写操作也会落错账本。
 *
 * 四条回归锁（`t143-1`~`t143-4`）：
 *  - `t143-1` 两个团队各 2 个任务 → 面板任务 tab 渲染 **4 条**（跨团队聚合）；
 *  - `t143-2` 两个团队都有 `task-1` → 两条**不互相覆盖**（复合键唯一）；
 *  - `t143-3` 索引不可用（`getBoard` 抛错 / 返回无 `project` / 空索引）→ **降级 getProject**，不白屏；
 *  - `t143-4` 打开跨团队任务时，写操作打到**任务所属团队**的 service（spy 断言 teamId）。
 *
 * 夹具纪律（与 `t140` 同）：临时项目根（`mkdtempSync(tmpdir())`）+ **真实入口**
 * （`MyTeamHost.executeLeadTool`）建团队与任务，不碰仓库自己的 `.dsh-myteam/`，也不手写账本行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { MyTeamRemote } from '../src/remote/service.ts'
import type { ProjectBoardIndex } from '../src/core/index/project-board-index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'client', 'client.js')

/* ── mock loader（与 t88/t102 同款）：不依赖浏览器/宿主，只取纯组件与纯函数 ── */
const j = (type: unknown, props: any, ...children: unknown[]) => ({
  type,
  props: props ?? {},
  children: (props?.children !== undefined ? [props.children, ...children] : children).flat(),
})
const js = (type: unknown, props: any, ...children: unknown[]) => j(type, props, ...children)
const reactShim = {
  useState: (init: any) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (init: any) => ({ current: init }),
  useCallback: (fn: any) => fn,
  useMemo: (fn: any) => fn(),
  useSyncExternalStore: (_sub: any, get: any) => get(),
}

function loadClient() {
  const modules = new Map<string, unknown>([
    ['react/jsx-runtime', { jsx: j, jsxs: js }],
    ['react', reactShim],
  ])
  let module: any
  const loader = {
    load: (def: any) => {
      module = def.factory((name: string) => {
        if (!modules.has(name)) throw new Error(`module not mocked: ${name}`)
        return modules.get(name)
      })
      return def
    },
  }
  const documentObj = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, set textContent(_v: string) {}, remove() {} }),
    head: { appendChild: () => {} },
    body: { toggleAttribute: () => {}, style: { setProperty: () => {} } },
    documentElement: { dataset: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const source = readFileSync(clientPath, 'utf8')
  new Function('window', 'document', source)({ __ModuleLoader__: loader }, documentObj)
  return { module, source }
}

const { module, source } = loadClient()
const { resolveProjectTasks, taskOpenTarget, makeApi } = module.__testBoard
const { BoardView } = module.__testG6
const { TaskCard } = module.__test

/** 渲染树里 `type === TaskCard` 的节点数（= 看板真的画出了几张卡） */
function countCards(tree: any, target: unknown = TaskCard): number {
  if (!tree || typeof tree !== 'object') return 0
  if (typeof tree.type === 'function') {
    if (tree.type === target) return 1
    return countCards(tree.type(tree.props ?? {}), target)
  }
  let total = 0
  for (const child of tree.children ?? []) total += countCards(child, target)
  return total
}

/* ── 真实项目夹具：两个团队 × 2 个任务（每个团队的账本都从 task-1 编号）── */
const TASKS_PER_TEAM = 2
const TEAMS = ['team-a', 'team-b']
const TOTAL_TASKS = TASKS_PER_TEAM * TEAMS.length

function makeRuntime(root: string) {
  return {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
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

function setup(root: string) {
  const rt = makeRuntime(root)
  const host = new MyTeamHost(rt)
  host.initialize()
  const remote = new MyTeamRemote(rt, host)
  return { host, remote }
}

function seedTwoTeams(host: MyTeamHost, remote: MyTeamRemote): void {
  for (const teamId of TEAMS) {
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
      host.executeLeadTool('myteam_create_task', { teamId, task: taskOf(`${teamId} 任务 ${index + 1}`) }, {})
    }
  }
}

function withProject(run: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-board-consumer-'))
    try {
      await run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/**
 * 面板 `getProject()` 的团队摘要（本测试只关心会话绑定这一面）。
 * 真实 GUI 里 `online/sessionId` 来自存活队长会话，**索引刻意不存**（换机器就废），
 * 所以由 `resolveProjectTasks` 按 `ownerTeamId` 从名册补回去。
 */
const liveTeams = () => [
  { teamId: 'team-a', name: 'Team team-a', state: 'active', online: true, sessionId: 'sess-a', members: [] },
  { teamId: 'team-b', name: 'Team team-b', state: 'active', online: true, sessionId: 'sess-b', members: [] },
]

const T = (key: string) => key

/** 面板任务 tab 的四视图输入（= Panel 里 `allProjectTasks` 的那一行） */
async function panelTasks(remote: MyTeamRemote) {
  const board = (await remote.getBoard({})) as unknown as { project?: ProjectBoardIndex }
  const index = board?.project
  assert.ok(index, 'getBoard({}) 必须带出 project（派生索引）')
  return resolveProjectTasks(index, liveTeams(), [])
}

/* ── t143-1 ── */
test(
  't143-1: 面板任务 tab 吃索引 —— 两个团队各 2 个任务，渲染出 4 条（跨团队聚合）',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)

    const tasks = await panelTasks(remote)
    assert.equal(tasks.length, TOTAL_TASKS, '两个团队 × 2 个任务 = 4 条（跨团队聚合成一张看板）')
    assert.deepEqual(
      [...new Set(tasks.map((task) => task.ownerTeamId))].sort(),
      ['team-a', 'team-b'],
      '两条团队的任务都在同一张看板上（不是只看当前选中团队）',
    )

    // 真的渲染：看板卡数 = 聚合出来的任务数（不是只算了个数组）
    const tree = BoardView({ t: T, tasks, memberName: (id: string) => id, teamName: () => 'Team' })
    assert.equal(countCards(tree), TOTAL_TASKS, '看板必须画出 4 张卡（每团队 2 张）')

    // 任务 tab 的计数也必须是聚合后的条数（此前读的是 getProject().tasks 的长度）
    assert.ok(
      source.includes("t('project.tabs.tasks')}（${projectTasks.length}）"),
      '任务 tab 的计数必须来自索引派生结果（projectTasks.length）',
    )
  }),
)

/* ── t143-2 ── */
test(
  't143-2: 两个团队都有 task-1 —— 两条不互相覆盖（复合键 teamId/taskId 唯一）',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)

    const tasks = await panelTasks(remote)
    const firsts = tasks.filter((task) => task.id === 'task-1')
    assert.equal(firsts.length, 2, '两个团队各有一条 task-1，必须都在（不许被 Map 按 id 覆盖掉一条）')
    assert.deepEqual(
      firsts.map((task) => task.key).sort(),
      ['team-a/task-1', 'team-b/task-1'],
      '复合键 = teamId/taskId',
    )
    assert.equal(new Set(tasks.map((task) => task.key)).size, TOTAL_TASKS, '复合键必须唯一')
    assert.notEqual(firsts[0].title, firsts[1].title, '两条 task-1 是不同的任务（标题不同），不是同一条被读了两遍')

    // 打开目标也按团队分开（同一个 task-1 落到不同团队 → 不同详情）
    const targets = firsts.map((task) => taskOpenTarget(task))
    assert.deepEqual(targets.map((target) => target?.teamId).sort(), ['team-a', 'team-b'])
    assert.equal(new Set(targets.map((target) => `${target?.teamId}/${target?.taskId}`)).size, 2, '打开目标也必须复合键唯一')

    const tree = BoardView({ t: T, tasks, memberName: (id: string) => id, teamName: () => 'Team' })
    assert.equal(countCards(tree), TOTAL_TASKS, '看板画 4 张卡（两条 task-1 各占一张）')
  }),
)

/* ── t143-3 ── */
test(
  't143-3: 索引不可用（抛错 / 无 project / 空索引）→ 降级 getProject，不白屏',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)

    /* 降级用的实时折叠：getProject().tasks（同一份账本的另一个读法） */
    const fallback = ((await remote.getBoard({})) as { project: ProjectBoardIndex }).project.tasks
    assert.equal(fallback.length, TOTAL_TASKS, '兜底数据源本身要有 4 条（否则测不出降级）')
    const teams = liveTeams()

    /* ① 未加载（首屏还没回来） */
    assert.equal(resolveProjectTasks(undefined, teams, fallback).length, TOTAL_TASKS, '索引未加载 → 回落 getProject')
    /* ② 不可用（getBoard 抛错 / 返回无 project → 面板存 null） */
    assert.equal(resolveProjectTasks(null, teams, fallback).length, TOTAL_TASKS, '索引不可用 → 回落 getProject')
    assert.equal(resolveProjectTasks({ status: 'ok' }, teams, fallback).length, TOTAL_TASKS, '没有 tasks 数组的对象 = 不可用')
    /* ③ 空索引（tasks 是空数组）→ 同样回落（「读不到」不许被渲染成「没有任务」） */
    assert.equal(resolveProjectTasks({ tasks: [] }, teams, fallback).length, TOTAL_TASKS, '空索引 → 回落 getProject')

    /* 不看源码也不白屏：降级后看板照常画出 4 张卡 */
    const degraded = resolveProjectTasks(null, teams, fallback)
    assert.equal(countCards(BoardView({ t: T, tasks: degraded, memberName: (id: string) => id, teamName: () => 'Team' })), TOTAL_TASKS)

    /* 面板侧的降级路径：两条 catch/兜底分支都在（抛错 → setBoardIndex(null)；无 project → null） */
    assert.ok(
      source.includes('.catch(() => { if (alive) setBoardIndex(null) })'),
      'getBoard 抛错必须降级为 null（渲染侧回落 getProject），不许把面板卡在加载中',
    )
    assert.ok(
      source.includes('setBoardIndex(index && Array.isArray(index.tasks) ? index : null)'),
      '没有 project 字段 / tasks 不是数组 → 存 null（降级），不存坏索引',
    )
    assert.ok(
      source.includes('const allProjectTasks = projectTasks'),
      '任务 tab 的四视图必须统一吃归一后的数据源',
    )
  }),
)

/* ── t143-4 ── */
test(
  't143-4: 打开跨团队任务 —— 写操作打到**任务所属团队**的 service（spy 断言 teamId）',
  withProject(async (root) => {
    const { host, remote } = setup(root)
    seedTwoTeams(host, remote)

    const tasks = await panelTasks(remote)
    /* 取 team-b 的 task-1：跨团队聚合下它是第二条同名任务，最容易落错团队 */
    const foreign = tasks.find((task) => task.ownerTeamId === 'team-b' && task.id === 'task-1')
    assert.ok(foreign, 'team-b 的 task-1 必须在聚合结果里')

    const target = taskOpenTarget(foreign)
    assert.deepEqual(target, { teamId: 'team-b', taskId: 'task-1', online: true, sessionId: 'sess-b' }, '打开目标 = 任务所属团队的复合键 + 该团队的会话')

    /* 客户端：写路径的 service 由 target.sessionId 绑定 → 网关 agentId 必须是 team-b 的会话 */
    const rpcCalls: Array<{ endpoint: string; args: any }> = []
    const connection = {
      rpc: {
        call: async (_channel: string, endpoint: string, payload: any) => {
          rpcCalls.push({ endpoint, args: payload?.args })
          return { ok: true, value: { status: 'ok' } }
        },
      },
    }
    const detail = await remote.getTaskDetail({ teamId: target!.teamId, taskId: target!.taskId }) as any
    await makeApi(connection, target!.sessionId).updateTask({
      teamId: target!.teamId,
      taskId: target!.taskId,
      patch: { title: '跨团队编辑' },
      expectedRevision: detail?.detail?.revision,
    })
    const write = rpcCalls.find((call) => call.endpoint === 'myteam/updateTask')
    assert.ok(write, '写操作必须发出（updateTask）')
    assert.equal(write!.args.agentId, 'sess-b', '写操作绑定的是**任务所属团队**的会话（不是当前选中/默认团队）')
    assert.equal(write!.args.query.teamId, 'team-b', '载荷里的 teamId 也是任务所属团队')
    assert.equal(write!.args.query.expectedRevision, detail?.detail?.revision, 'expectedRevision 来自**该团队**的任务详情快照')

    /* 服务端：单写者管线按 teamId 取 service —— 必须只碰 team-b */
    const serviceCalls: string[] = []
    const originalService = host.service.bind(host)
    ;(host as unknown as { service: (teamId: string) => unknown }).service = (teamId: string) => {
      serviceCalls.push(String(teamId))
      return originalService(teamId)
    }
    await remote.updateTask({ teamId: 'team-b', taskId: 'task-1', patch: { title: '跨团队编辑' }, expectedRevision: detail?.detail?.revision })
    assert.ok(serviceCalls.length > 0, '写路径必须真的取过 service（不是空跑）')
    assert.ok(serviceCalls.every((teamId) => teamId === 'team-b'), `服务端只按任务所属团队取 service，实际：${serviceCalls.join(',')}`)
    assert.ok(!serviceCalls.includes('team-a'), '不许碰到同名的 team-a 任务账本')
  }),
)
