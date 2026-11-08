/**
 * T96 · CHG-124（docs/19 §M6）：`myteam_get_task_graph` —— 任务依赖图谱只读查询（A 档）。
 *
 * 为什么必须有：依赖是**写**（`create_task.deps` / `edit_task` / `rescope_task`），但模型
 * 此前只能拿 `deps` 手算拓扑——判断不了「哪些能并行」「有没有环」。
 *
 * 断言：
 *  ① 工具已注册；空团队返回空图（`hasCycle:false`）；
 *  ② 纯函数分层：链式 A→B→C 三层；并行（A、B 同层，C 依赖两者）两层；
 *  ③ 环检测：A↔B 有环 → `hasCycle:true`、`cycles` 覆盖环上节点；
 *  ④ 容错：自依赖与孤儿依赖跳过（不让读视图崩）；
 *  ⑤ 只读：调用前后账本行数一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'
import { buildTaskGraph } from '../src/core/scheduler/task-graph.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t96-'))
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  return { host, root }
}

test('t96-1: 工具已注册 + 空团队返回空图', () => {
  assert.ok(defsSource.includes("name: 'myteam_get_task_graph'"), 'defs 必须有 myteam_get_task_graph')
  const { host, root } = setup()
  try {
    const graph: any = host.executeLeadTool('myteam_get_task_graph', {}, {})
    assert.equal(graph.status, 'ok', JSON.stringify(graph))
    assert.deepEqual(graph.nodes, [])
    assert.deepEqual(graph.edges, [])
    assert.deepEqual(graph.layers, [])
    assert.deepEqual(graph.order, [])
    assert.deepEqual(graph.cycles, [])
    assert.equal(graph.hasCycle, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('t96-2: 链式 A→B→C —— 三层 + 两条边 + 无环', () => {
  const graph = buildTaskGraph([
    { id: 'a', title: 'A', deps: [] },
    { id: 'b', title: 'B', deps: ['a'] },
    { id: 'c', title: 'C', deps: ['b'] },
  ])
  assert.equal(graph.nodes.length, 3)
  assert.equal(graph.edges.length, 2, '链式只有两条边')
  assert.deepEqual(graph.layers, [['a'], ['b'], ['c']], '链式三层，每层可并行')
  assert.deepEqual(graph.order, ['a', 'b', 'c'], '拓扑序')
  assert.equal(graph.hasCycle, false)
  assert.deepEqual(graph.cycles, [])
  /* 边方向：from=前置 → to=后继 */
  assert.deepEqual(graph.edges, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])
})

test('t96-3: 并行 —— A、B 同层，C 依赖两者；环检测', () => {
  const dag = buildTaskGraph([
    { id: 'a', title: 'A', deps: [] },
    { id: 'b', title: 'B', deps: [] },
    { id: 'c', title: 'C', deps: ['a', 'b'] },
  ])
  assert.deepEqual(dag.layers, [['a', 'b'], ['c']], 'A、B 同层可并行，C 在下一层')
  assert.equal(dag.edges.length, 2)
  assert.equal(dag.hasCycle, false)

  const cyclic = buildTaskGraph([
    { id: 'a', title: 'A', deps: ['b'] },
    { id: 'b', title: 'B', deps: ['a'] },
  ])
  assert.equal(cyclic.hasCycle, true, 'A↔B 必须报环')
  assert.deepEqual(cyclic.cycles, ['a', 'b'])
  assert.deepEqual(cyclic.layers, [], '有环时无无环节点')
})

test('t96-4: 容错 —— 自依赖与孤儿依赖跳过', () => {
  const graph = buildTaskGraph([
    { id: 'a', title: 'A', deps: ['a', 'missing'] },
    { id: 'b', title: 'B', deps: ['a'] },
  ])
  assert.deepEqual(graph.edges, [{ from: 'a', to: 'b' }], '自依赖与孤儿依赖都被跳过')
  assert.equal(graph.hasCycle, false)
  assert.deepEqual(graph.layers, [['a'], ['b']])
})

test('t96-5: 只读 —— 不写账本', async () => {
  const { host, root } = setup()
  try {
    const staged: any = await host.executeLeadTool('myteam_submit_plan', { teamName: 'T96', goal: 'G', tasks: [] }, {})
    const teamId = String(staged.teamId)
    const ledger = join(root, '.dsh-myteam', 'tasks', teamId, 'ledger.jsonl')
    const before = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
    host.executeLeadTool('myteam_get_task_graph', { teamId }, {})
    host.executeLeadTool('myteam_get_task_graph', { teamId }, {})
    const after = existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length : 0
    assert.equal(after, before, '只读工具不得写账本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
