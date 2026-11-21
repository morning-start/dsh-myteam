/**
 * T121 · P1-6（docs/21 §6）：**工具输出契约（`jsonOutput` 双声明）**。
 *
 * 为什么必须有：此前 68 个工具的 `output.schema` 只有 `{ status: string }` ——
 * 一个字段的「契约」等于没有契约：宿主校验器（`validateJsonSchemaValue`）过不去任何东西，
 * 面板和模型都不知道能拿到什么。本测试守的是「声明是真的」：
 *
 *  ① **覆盖度**：68 个工具**一个不少**地走 `jsonOutput`（与 `TOOL_TIERS` 双向锁死，
 *    与 `defs.ts` 的 68 个名字一致，无重复）；
 *  ② **合法性**：每个 schema 都是 `type:'object'` + `properties.status` + `required` 含 status；
 *  ③ **不丢字段**：`render` 输出是可 `JSON.parse` 的**紧凑** JSON（不 pretty-print、不筛选）；
 *  ④ **合并语义**：就地补的字段进得来、`status` 的必填减不掉；
 *  ⑤ **运行时校验不抛**：合法通过；缺 status / 非字符串 / 空串 / 非法状态 / 非对象
 *    一律 `{ok:false, code:'MT_TOOL_CONTRACT'}`（抛错会被宿主编译成 MT_INTERNAL，丢原因）；
 *  ⑥ **词表漂移**：`RESULT_STATUSES` 覆盖 `src/**` 里出现的每一个 `status: '<字面量>'`
 *    —— 新增状态忘了登记会变红（否则 `assertToolResult` 会误拒真实返回）。
 *
 * 运行：`cd plugin && node --test test/t121-tool-output-contract.test.ts`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  assertToolResult,
  describeContract,
  jsonOutput,
  outputForTool,
  RESULT_STATUSES,
  TOOL_CONTRACT_CODE,
  TOOL_OUTPUT_FIELDS,
  TOOL_RESULT_SCHEMA,
} from '../src/core/tools/output-contract.ts'
import { leadToolDefs, memberToolDefs, toolOutput } from '../src/tools/defs.ts'
import { TOOL_TIERS } from '../src/core/tools/tool-tiers.ts'

/* CHG-202x（P0-1）：+myteam_delete_task = 69 */
const TOOL_COUNT = 70

/** 69 个真实工具名（defs 侧）——契约清单必须与它一一对应 */
const defNames = [...leadToolDefs(), ...memberToolDefs()].map((def) => def.name).sort()

/* ── ① 覆盖度：68 个一个不能少，且与单一事实源双向锁死 ─────────────── */

test('t121-1: 69 个工具全部有契约 —— 与 TOOL_TIERS / defs 双向锁死，无重复', () => {
  const entries = describeContract()
  const names = entries.map((entry) => entry.name)

  assert.equal(names.length, TOOL_COUNT, `契约数量必须是 ${TOOL_COUNT}`)
  assert.equal(new Set(names).size, names.length, '契约清单里有重复工具名')
  assert.deepEqual([...names].sort(), [...Object.keys(TOOL_TIERS)].sort(), '契约清单 ≠ 档位表（工具有哪些的单一事实源）')
  assert.deepEqual([...names].sort(), defNames, '契约清单 ≠ defs 里真实注册的 69 个工具名')
  // 每个条目都带档位（面板按档位决定「谁能看到这条契约」）
  for (const entry of entries) assert.ok(['A', 'C', 'CM', 'H'].includes(entry.tier), `${entry.name} 档位非法：${entry.tier}`)
})

/* ── ② 合法性：每个 schema 都是完整的 object 结果契约 ─────────────── */

test('t121-2: 每个 schema 合法 —— type:object + properties.status:string + required 含 status', () => {
  for (const { name, schema } of describeContract()) {
    assert.equal(schema['type'], 'object', `${name} 的 schema 根类型必须是 object`)
    const props = schema['properties'] as Record<string, Record<string, unknown>>
    assert.ok(props && typeof props === 'object', `${name} 缺 properties`)
    assert.equal(props['status']?.['type'], 'string', `${name} 的 status 必须是 string`)
    const required = schema['required'] as string[]
    assert.ok(Array.isArray(required), `${name} 的 required 必须是数组`)
    assert.ok(required.includes('status'), `${name} 的 required 必须含 status`)
    // 开放声明：既有返回里的 field / currentRevision / attemptId 等按路径才出现的字段不能被 schema 判死
    assert.notEqual(schema['additionalProperties'], false, `${name} 不能写 additionalProperties:false（会拒掉既有返回）`)
    // 统一契约的四个槽都在（成功与失败共用同一个 schema）
    for (const key of ['code', 'message', 'data']) assert.ok(key in props, `${name} 缺统一契约字段 ${key}`)
  }
})

/* ── ③ render：紧凑 JSON，可 parse，不丢字段 ─────────────────────── */

test('t121-3: render 输出可 JSON.parse 且不丢字段（紧凑：不 pretty-print、不筛选）', () => {
  const value = { status: 'ok', code: 'MT_X', message: 'm', field: 'teamId', data: { a: 1, b: [2, 3] }, attemptId: 'at-1' }
  for (const { name } of describeContract()) {
    const blocks = outputForTool(name).render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length === 1, `${name} 的 render 必须返回单个内容块`)
    assert.equal(blocks[0]!['type'], 'text', `${name} 的 render 内容块类型必须是 text`)
    const text = blocks[0]!['text']
    assert.equal(typeof text, 'string', `${name} 的 render 必须给字符串`)
    // 紧凑：省 token（人类可读性由面板做，契约不负责）
    assert.ok(!String(text).includes('\n'), `${name} 的 render 不该 pretty-print（多余换行 = 白烧 token）`)
    // 不丢字段：反序列化必须与输入深等（否则「能拿到什么」的声明就是假的）
    assert.deepEqual(JSON.parse(String(text)), value, `${name} 的 render 丢了字段`)
  }
})

/* ── ④ 合并语义：就地字段进得来，status 减不掉 ───────────────────── */

test('t121-4: jsonOutput 合并 —— 就地字段并集、required 并集去重、status 不可被移除', () => {
  const merged = jsonOutput({ properties: { task: { type: 'object' }, status: { type: 'string', description: '覆盖' } }, required: ['task'] })
  const props = merged.schema['properties'] as Record<string, Record<string, unknown>>
  assert.equal(props['task']!['type'], 'object', '就地字段必须并入')
  assert.equal(props['code']?.['type'], 'string', '统一契约字段不能被就地声明挤掉')
  assert.equal(props['status']!['description'], '覆盖', '同名字段以就地声明为准')
  assert.deepEqual(merged.schema['required'], ['status', 'task'], 'required 必须是并集且 status 在前（去重）')
  // 无参 = 统一契约本身
  assert.deepEqual(jsonOutput().schema['required'], ['status'])
  assert.equal(jsonOutput().schema['type'], 'object')

  // 就地补的字段必须是真实存在的工具名（防拼错：拼错的条目永远不会被命中）
  for (const name of Object.keys(TOOL_OUTPUT_FIELDS)) {
    assert.ok(defNames.includes(name), `TOOL_OUTPUT_FIELDS 里有不存在的工具：${name}`)
    const declared = Object.keys((TOOL_OUTPUT_FIELDS[name]!['properties'] ?? {}) as Record<string, unknown>)
    assert.ok(declared.length > 0, `${name} 登记了却没有字段（空条目 = 噪声）`)
  }
})

/* ── ⑤ 运行时校验：合法通过，失败不抛 ──────────────────────────── */

test('t121-5: assertToolResult 合法通过 —— ok / error / 领域状态 + 可选字段', () => {
  assert.deepEqual(assertToolResult('myteam_get_task', { status: 'ok' }), { ok: true })
  assert.deepEqual(assertToolResult('myteam_get_task', { status: 'ok', task: { id: 't1' } }), { ok: true })
  assert.deepEqual(assertToolResult('myteam_create_task', { status: 'error', code: 'MT_VALIDATION', message: 'bad', field: 'teamId' }), { ok: true })
  // 领域状态（真实返回里 staged / claimed / confirm-required 都是正常路径）
  for (const status of ['staged', 'claimed', 'approved', 'confirm-required', 'timeout']) {
    assert.deepEqual(assertToolResult('myteam_claim_task', { status }), { ok: true }, `${status} 应被接受`)
  }
})

test('t121-6: assertToolResult 失败 —— 缺 status / 非字符串 / 空串 / 非法状态 / 非对象，一律 MT_TOOL_CONTRACT 且不抛', () => {
  const cases: Array<[string, unknown]> = [
    ['缺 status', {}],
    ['status=null', { status: null }],
    ['status 数字', { status: 42 }],
    ['status 空串', { status: '' }],
    ['status 拼错', { status: 'BOGUS' }],
    ['status 大小写错', { status: 'OK' }],
    ['根不是对象', 'ok'],
    ['根是数组', [{ status: 'ok' }]],
    ['根是 null', null],
    ['code 非字符串', { status: 'error', code: 500 }],
  ]
  for (const [label, result] of cases) {
    let check: ReturnType<typeof assertToolResult>
    assert.doesNotThrow(() => { check = assertToolResult('myteam_get_task', result) }, `${label} 不该抛`)
    assert.equal(check!.ok, false, `${label} 应判失败`)
    assert.equal((check as { code?: string }).code, TOOL_CONTRACT_CODE, `${label} 的错误码`)
    assert.equal(TOOL_CONTRACT_CODE, 'MT_TOOL_CONTRACT')
    // 失败必须点名工具 + 指出具体值（否则排障要回读源码）
    const message = String((check as { message?: string }).message)
    assert.ok(message.includes('myteam_get_task'), `${label} 的 message 必须点名工具：${message}`)
  }
})

/* ── ⑥ 词表漂移门禁 ──────────────────────────────────────────── */

test('t121-7: RESULT_STATUSES 覆盖 src 里每一个 status 字面量（新增状态忘登记会变红）', () => {
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }
  const vocabulary = new Set(RESULT_STATUSES)
  const missing = new Set<string>()
  for (const file of walk(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bstatus:\s*'([^']+)'/g)) {
      const status = match[1]!
      if (!vocabulary.has(status)) missing.add(`${status}（${relative(root, file).split('\\').join('/')}）`)
    }
  }
  assert.deepEqual([...missing].sort(), [], `这些 status 字面量不在 RESULT_STATUSES 里（assertToolResult 会误拒真实返回）：\n${[...missing].join('\n')}`)
  // 词表本身：无重复、非空、两个基础状态一定在
  assert.equal(new Set(RESULT_STATUSES).size, RESULT_STATUSES.length, 'RESULT_STATUSES 有重复项')
  for (const base of ['ok', 'error']) assert.ok(vocabulary.has(base), `词表缺基础状态 ${base}`)
})

/* ── ⑦ host 兼容：别名与统一契约等价 ──────────────────────────── */

test('t121-8: defs.toolOutput 是 jsonOutput 的别名（host.ts 零改动吃到新契约）', () => {
  assert.equal(toolOutput, jsonOutput, 'toolOutput 必须就是 jsonOutput（不是第二份实现）')
  const out = toolOutput()
  assert.equal(out.schema['type'], 'object')
  assert.deepEqual(out.schema['required'], ['status'])
  // 统一契约常量与 jsonOutput() 同构（改一处不能出现两份真相）
  assert.equal(TOOL_RESULT_SCHEMA['type'], 'object')
  assert.deepEqual(Object.keys((TOOL_RESULT_SCHEMA['properties'] ?? {}) as Record<string, unknown>).sort(), ['code', 'data', 'field', 'message', 'status'])
})
