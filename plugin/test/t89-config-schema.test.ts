/**
 * T89 · CHG-116：**配置 Schema 定稿的三方同步门禁**。
 *
 * 定稿交付物有三份（docs/18 §0）：
 *  ①`plugin/schema/team-config.schema.json`（机器可读）
 *  ②`plugin/src/core/config/team-config.ts` 的 `DEFAULT_CONFIG` / `PATCH_CEILINGS`（代码真相）
 *  ③`docs/contracts/18-配置Schema定稿.md`（字段语义）
 *
 * 只要它们任一漂移，本用例就红——这是「定稿」和「写了一半的文档」的区别。
 *
 * 断言：
 *  ① schema 是 draft-07 对象，顶层 `additionalProperties: false`；
 *  ② `DEFAULT_CONFIG` 的每个字段都在 schema 里登记，且 schema 的 `default` 与代码逐项相等；
 *  ③ schema 里有 `default` 的字段必须在 `DEFAULT_CONFIG` 里存在（反向）；
 *  ④ 用最小校验器验 `DEFAULT_CONFIG` 合法、坏样例被拒、段落缺失合法（部分覆盖）；
 *  ⑤ `PATCH_CEILINGS` 与 schema 的 `maximum` 一致（更严格者胜的硬顶）；
 *  ⑥ 角色 / 模板定义的必填字段与 docs/18 一致；
 *  ⑦ docs/18 提到每个字段名（文档漂移即红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, PATCH_CEILINGS } from '../src/core/config/team-config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, '..', 'schema', 'team-config.schema.json')
const docPath = join(here, '..', '..', 'docs', 'contracts', '18-配置Schema定稿.md')

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
const doc = readFileSync(docPath, 'utf8')

/** 最小 JSON Schema 校验器（draft-07 子集：类型 / 枚举 / 数值区间 / 字符串 / 数组 / 对象 / 本地 $ref） */
function validate(node, value, path, root) {
  if (!node || typeof node !== 'object') return []
  if (node.$ref) {
    const segs = node.$ref.replace(/^#\//, '').split('/')
    let target = root
    for (const seg of segs) target = target?.[seg]
    return validate(target, value, path, root)
  }
  const errors = []
  if (node.type) {
    const ok = node.type === 'object'
      ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : node.type === 'array'
        ? Array.isArray(value)
        : node.type === 'integer'
          ? Number.isInteger(value)
          : node.type === 'boolean'
            ? typeof value === 'boolean'
            : node.type === 'string'
              ? typeof value === 'string'
              : true
    if (!ok) return [`${path}: 期望 ${node.type}，实际 ${Array.isArray(value) ? 'array' : typeof value}`]
  }
  if (node.enum && !node.enum.includes(value)) errors.push(`${path}: 不在枚举 ${JSON.stringify(node.enum)}`)
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${path}: 小于 minimum ${node.minimum}`)
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${path}: 大于 maximum ${node.maximum}`)
  }
  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${path}: 短于 minLength ${node.minLength}`)
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${path}: 不匹配 ${node.pattern}`)
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${path}: 少于 minItems ${node.minItems}`)
    if (node.uniqueItems) {
      const seen = new Set()
      for (const item of value) {
        const key = JSON.stringify(item)
        if (seen.has(key)) errors.push(`${path}: 重复项 ${key}`)
        seen.add(key)
      }
    }
    if (node.items) value.forEach((item, index) => errors.push(...validate(node.items, item, `${path}[${index}]`, root)))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of node.required ?? []) if (!(key in value)) errors.push(`${path}: 缺必填 ${key}`)
    const props = node.properties ?? {}
    for (const [key, sub] of Object.entries(props)) if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`, root))
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in props)) errors.push(`${path}: 未知键 ${key}`)
    } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      for (const [key, sub] of Object.entries(value)) {
        if (!(key in props)) errors.push(...validate(node.additionalProperties, sub, `${path}.${key}`, root))
      }
    }
  }
  return errors
}

test('t89-1: schema 是 draft-07 顶层对象，未知顶层键拒绝', () => {
  assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#')
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(validate(schema, { nope: true }, '$', schema), ['$: 未知键 nope'])
})

test('t89-2: DEFAULT_CONFIG ↔ schema 逐字段双向同步，default 值相等', () => {
  const props = schema.properties ?? {}
  for (const key of Object.keys(DEFAULT_CONFIG)) assert.ok(key in props, `DEFAULT_CONFIG.${key} 未在 schema 登记`)

  const walk = (node, value, path) => {
    if (Array.isArray(value)) {
      assert.deepEqual(node.default, value, `${path} 的 schema default 与代码不一致`)
      return
    }
    if (value !== null && typeof value === 'object') {
      const sectionProps = node.properties
      if (!sectionProps) {
        /* 形如 columnMapping / taskTypes：自由键对象，只有 default 可比 */
        assert.deepEqual(node.default, value, `${path} 的 schema default 与代码不一致`)
        return
      }
      for (const [key, sub] of Object.entries(value)) {
        assert.ok(key in sectionProps, `${path}.${key} 未在 schema 登记`)
        walk(sectionProps[key], sub, `${path}.${key}`)
      }
      for (const [key, sub] of Object.entries(sectionProps)) {
        if (sub && typeof sub === 'object' && 'default' in sub) {
          assert.ok(key in value, `${path}.${key} 在 schema 有 default 但 DEFAULT_CONFIG 没有`)
        }
      }
      return
    }
    assert.deepEqual(node.default, value, `${path} 的 schema default 与代码不一致`)
  }
  walk(schema, DEFAULT_CONFIG, '$')
})

test('t89-3: 最小校验器 —— DEFAULT_CONFIG 合法、坏样例被拒、段落缺失合法', () => {
  assert.deepEqual(validate(schema, DEFAULT_CONFIG, '$', schema), [], '默认配置必须合法')
  /* 部分覆盖合法（FR-9.1：段落缺失由默认补） */
  assert.deepEqual(validate(schema, { board: { columns: ['a', 'b'] } }, '$', schema), [])
  assert.deepEqual(validate(schema, {}, '$', schema), [])
  const bad = [
    [{ board: { columns: 'nope' } }, '期望 array'],
    [{ board: { columns: [] } }, '少于 minItems 1'],
    [{ board: { columnMapping: { running: 'nope' } } }, '期望 array'],
    [{ board: { dragRules: 'anything' } }, '不在枚举'],
    [{ pipeline: { swimlaneBy: 'bogus' } }, '不在枚举'],
    [{ views: { tabs: ['board', 'bogus'] } }, '不在枚举'],
    [{ views: { tabs: ['board', 'board'] } }, '重复项'],
    [{ limits: { maxMembers: 7 } }, '大于 maximum 6'],
    [{ limits: { memberMaxDepth: 3 } }, '大于 maximum 2'],
    [{ limits: { maxChildren: 6 } }, '大于 maximum 5'],
    [{ gates: { enabled: 'yes' } }, '期望 boolean'],
    [{ taskTypes: { dev: { gateChain: ['bogus'] } } }, '不在枚举'],
    [{ clarify: { maxRounds: -1 } }, '小于 minimum 0'],
  ]
  for (const [sample, needle] of bad) {
    const errors = validate(schema, sample, '$', schema)
    assert.ok(errors.some((message) => message.includes(needle)), `样例 ${JSON.stringify(sample)} 应被拒（${needle}），实际 ${JSON.stringify(errors)}`)
  }
})

test('t89-4: PATCH_CEILINGS 与 schema 的硬上限一致（更严格者胜的硬顶）', () => {
  const limits = schema.properties.limits.properties
  assert.equal(limits.maxMembers.maximum, PATCH_CEILINGS['limits.maxMembers'])
  assert.equal(limits.memberMaxDepth.maximum, PATCH_CEILINGS['limits.memberMaxDepth'])
  assert.equal(limits.maxChildren.maximum, PATCH_CEILINGS['limits.maxChildren'])
  assert.equal(PATCH_CEILINGS['limits.maxMembers'], 6)
  // CHG-187（FR-32 支柱一）：默认允许一层子成员，硬上限 2 层
  assert.equal(PATCH_CEILINGS['limits.memberMaxDepth'], 2)
  assert.equal(PATCH_CEILINGS['limits.maxChildren'], 5)
})

test('t89-5: 角色 / 模板定义的必填字段与文档一致', () => {
  const role = schema.definitions.roleDefinition
  assert.deepEqual(role.required, ['id', 'name', 'description', 'systemPrompt', 'version'])
  assert.equal(role.properties.toolPolicy.description.includes('收窄'), true, 'C5：allow 只能收窄')
  assert.equal(role.properties.interestWords.description.includes('软信号'), true, '兴趣词不是权限')
  const preset = schema.definitions.presetDefinition
  assert.deepEqual(preset.required, ['id', 'name', 'members'])
  assert.ok(preset.properties.board, '模板可声明看板段')
  assert.ok(preset.properties.charter, '模板可声明团队章程（FR-18）')
  assert.ok(preset.properties.namespace, '插件贡献分组名（CHG-91）')
  /* 模板不得声明运行期策略段（docs/18 §5 规则 5） */
  for (const forbidden of ['limits', 'views', 'clarify', 'memory', 'audit']) {
    assert.ok(!(forbidden in preset.properties), `模板不得声明 ${forbidden}`)
  }
})

test('t89-6: docs/18 提到每个配置字段 / 角色字段 / 模板字段（文档漂移即红）', () => {
  const mentions = (name) => doc.includes('`' + name + '`')
  for (const key of Object.keys(DEFAULT_CONFIG)) assert.ok(mentions(key), `docs/18 缺顶层字段 ${key}`)
  const sectionFields = {
    board: ['columns', 'columnMapping', 'cardFields', 'dragRules'],
    pipeline: ['swimlaneBy', 'stages', 'layout'],
    dag: ['showModel', 'collapseGroups', 'direction'],
    views: ['default', 'tabs'],
    limits: ['maxMembers', 'memberMaxDepth', 'maxChildren', 'maxTasks'],
    gates: ['enabled', 'commandTimeoutMs'],
    clarify: ['maxRounds'],
    memory: ['evidenceRequired'],
    audit: ['writeScopes'],
  }
  for (const [section, fields] of Object.entries(sectionFields)) {
    for (const field of fields) assert.ok(mentions(field), `docs/18 缺 ${section}.${field}`)
  }
  for (const roleField of Object.keys(schema.definitions.roleDefinition.properties)) {
    assert.ok(mentions(roleField), `docs/18 缺角色字段 ${roleField}`)
  }
  for (const presetField of Object.keys(schema.definitions.presetDefinition.properties)) {
    assert.ok(mentions(presetField), `docs/18 缺模板字段 ${presetField}`)
  }
  /* 关键裁决与待实现契约必须在文档里写明 */
  for (const phrase of ['不引入顶层 `version` 字段', 'saveTeamConfig', 'PATCH_CEILINGS', 't89-config-schema']) {
    assert.ok(doc.includes(phrase), `docs/18 缺关键内容：${phrase}`)
  }
})
