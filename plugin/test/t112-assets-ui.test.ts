/**
 * T112 · CHG-140（docs/19 §7 UI 缺口）：**团队资产面板**（技能清单 / 导出 / 复制 / 发布）。
 *
 * 断言：
 *  ① 四个操作按钮（`data-testid` 可定位）+ `runAsset` 处理器；
 *  ② **两段确认透传**：`confirm-required` 不吞成成功（走提示分支）；
 *  ③ **隔离提示上屏**：`assets.isolation`（只写 myteam 目录，不污染其它预设）；
 *  ④ 文案 zh/en 成对（新增 9 个键不得只加一边）；
 *  ⑤ 客户端 api 四个方法齐全（面板才能调）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const clientSource = readFileSync(join(import.meta.dirname, '..', 'client', 'client.js'), 'utf8')

test('t112-1: 四个操作按钮 + runAsset 处理器', () => {
  for (const id of ['assets-skills', 'assets-export', 'assets-copy', 'assets-publish']) {
    assert.ok(clientSource.includes(`'data-testid': '${id}'`), `缺按钮 ${id}`)
  }
  /* CHG-202x（P1-2）：处理器多了一个「这次带不带 confirm」的选项参数 */
  assert.ok(clientSource.includes('const runAsset = async (op, opts = {}) =>'), '缺 runAsset 处理器')
  assert.ok(clientSource.includes("if (op === 'skills') result = await api.listSkills("), '技能分支')
  assert.ok(clientSource.includes("result = await api.exportTeam("), '导出分支')
  assert.ok(clientSource.includes("result = await api.copyTeam("), '复制分支')
  assert.ok(clientSource.includes("result = await api.publishTeam("), '发布分支')
})

test('t112-2: 两段确认透传（confirm-required 不吞成成功）', () => {
  assert.ok(clientSource.includes("if (result?.status === 'confirm-required')"), '必须识别 confirm-required')
  assert.ok(clientSource.includes("t('assets.confirmPublish')"), '必须给二次确认提示')
  /* 失败不吞：非 ok 走错误分支 */
  assert.ok(clientSource.includes("if (result?.status !== 'ok')"), '非 ok 必须走错误分支')
  /* CHG-202x（P1-2）：**不得写死 confirm:true**——否则服务端 confirm-required 分支永远不可达，
   * 不可逆的全局写一次点击就落地。确认必须由第二次点击（runAsset 的 opts.confirm）提供。 */
  assert.ok(!clientSource.includes('api.publishTeam({ teamId: team.teamId, confirm: true })'), '发布不得写死 confirm:true（两段确认会被绕过）')
  assert.ok(clientSource.includes("api.publishTeam({ teamId: team.teamId, ...(opts.confirm === true ? { confirm: true } : {}) })"), '发布必须按本次点击决定是否带 confirm')
  assert.ok(clientSource.includes("runAsset('publish', { confirm: assets.pending === 'publish' })"), '发布按钮必须回传 pending 状态')
})

test('t112-3: 隔离提示上屏 + api 四方法齐全', () => {
  assert.ok(clientSource.includes("t('assets.isolation')"), '隔离提示必须上屏')
  assert.ok(clientSource.includes('$DSH_HOME/myteam/**'), '隔离提示必须写明落点')
  for (const method of ['listSkills', 'exportTeam', 'copyTeam', 'publishTeam']) {
    assert.ok(clientSource.includes(`${method}: (query) => call('${method}', query)`), `api 缺 ${method}`)
  }
})

test('t112-4: 新增文案 zh/en 成对', () => {
  for (const key of ['assets.title', 'assets.desc', 'assets.skills', 'assets.export', 'assets.copy', 'assets.publish', 'assets.noSkills', 'assets.done', 'assets.confirmPublish', 'assets.isolation']) {
    const hits = clientSource.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 必须 zh/en 各一条（实际 ${hits}）`)
  }
})
