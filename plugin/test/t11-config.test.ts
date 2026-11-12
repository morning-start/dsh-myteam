import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CONFIG,
  mergeConfig,
  validateCoverage,
  applyCeilings,
  isStructurallyValidConfig,
  loadEffectiveConfig,
  PATCH_CEILINGS,
} from '../src/core/config/team-config.ts'

test('T11: array values replace wholesale (K5), scalars override, unknown keys warned (FR-9.1)', () => {
  const warnings: string[] = []
  const merged = mergeConfig(DEFAULT_CONFIG, {
    board: { columns: ['a', 'b'] },
    views: { default: 'dag' },
    bogusKey: 1,
  }, warnings)
  // 数组整条替换，不是拼接
  assert.deepEqual(merged.board.columns, ['a', 'b'])
  // 未覆盖的兄弟键保留默认
  assert.deepEqual(merged.board.cardFields, DEFAULT_CONFIG.board.cardFields)
  assert.equal(merged.views.default, 'dag')
  assert.equal(merged.views.tabs.length, DEFAULT_CONFIG.views.tabs.length)
  assert.ok(warnings.some((w) => w.includes('bogusKey')))
  assert.equal(warnings.filter((w) => w.includes('bogusKey')).length, 1, 'unknown key warned exactly once')
})

test('T11: terminal-state coverage check (scene 9 fallback)', () => {
  // 缺终态列 → 告警
  const bad = structuredClone(DEFAULT_CONFIG)
  bad.board = { ...bad.board, columns: ['backlog', 'ready'], columnMapping: {} }
  const warnings = validateCoverage(bad)
  assert.ok(warnings.some((w) => w.includes('"done" not covered')))
  // 默认配置完整覆盖
  assert.equal(validateCoverage(DEFAULT_CONFIG).length, 0)
})

test('T11: ceilings clamp stricter-than-patch config (scene 25)', () => {
  const warnings: string[] = []
  const over = applyCeilings(
    { ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, maxMembers: 12 } },
    warnings,
  )
  assert.equal(over.limits.maxMembers, PATCH_CEILINGS['limits.maxMembers'])
  assert.ok(warnings.some((w) => w.includes('maxMembers')))
  const ok = applyCeilings({ ...DEFAULT_CONFIG, limits: { ...DEFAULT_CONFIG.limits, maxMembers: 3 } }, [])
  assert.equal(ok.limits.maxMembers, 3)
})

test('T11: structurally invalid config falls back wholly (scene 9)', () => {
  // 已知段落类型错误 → 非法
  assert.equal(isStructurallyValidConfig({ board: 'nonsense' }), false)
  assert.equal(isStructurallyValidConfig('nonsense'), false)
  assert.equal(isStructurallyValidConfig(DEFAULT_CONFIG), true)
  // 部分覆盖（缺段落）合法——merge 补默认
  assert.equal(isStructurallyValidConfig({ board: { columnMapping: { running: ['in_progress'] } } }), true)
  // 已知段落类型错误 → 整体回退
  const result = loadEffectiveConfig({ board: 'nonsense' })
  assert.equal(result.fellBack, true)
  assert.deepEqual(result.config, DEFAULT_CONFIG)
  assert.ok(result.warnings.length > 0)
  // 未知顶层键 → 告警但不回退（前向兼容）
  const result2 = loadEffectiveConfig({ garbage: true })
  assert.equal(result2.fellBack, false)
  assert.ok(result2.warnings.some((w) => w.includes('garbage')))
})

test('T11: valid override survives coverage check; clarify round picks up CHG-16 ruling', () => {
  const result = loadEffectiveConfig({ clarify: { maxRounds: 5 } })
  assert.equal(result.fellBack, false)
  assert.equal(result.config.clarify.maxRounds, 5)
  assert.deepEqual(result.config.board.columns, DEFAULT_CONFIG.board.columns)
  // coverage 合法：默认列含终态归并
  const result2 = loadEffectiveConfig({
    board: { columnMapping: { running: ['in_progress'], gates: ['gate:review'] } },
  })
  assert.equal(result2.fellBack, false)
})

test('T11b: taskPlanning 顶层标量（CHG-173 / FR-1.3）——合并整条替换 + 枚举校验 + 默认值', () => {
  // 默认值 = captain
  assert.equal(DEFAULT_CONFIG.taskPlanning, 'captain')
  // 合并走「整条替换」（标量不走段落合并）
  const merged = mergeConfig(DEFAULT_CONFIG, { taskPlanning: 'template' }, [])
  assert.equal(merged.taskPlanning, 'template')
  const merged2 = mergeConfig(merged, {}, [])
  assert.equal(merged2.taskPlanning, 'template', '未覆盖时保留前层')
  // 结构校验：合法枚举通过、非法值拒绝（整层回退）
  assert.equal(isStructurallyValidConfig({ taskPlanning: 'template' }), true)
  assert.equal(isStructurallyValidConfig({ taskPlanning: 'auto' }), false)
  const bad = loadEffectiveConfig({ taskPlanning: 'auto' })
  assert.equal(bad.fellBack, true, '非法枚举 → 该层整层忽略')
  assert.equal(bad.config.taskPlanning, 'captain')
  // 生效路径：项目层设 template → effectiveConfig.taskPlanning = template
  const good = loadEffectiveConfig({ taskPlanning: 'template' })
  assert.equal(good.fellBack, false)
  assert.equal(good.config.taskPlanning, 'template')
})
