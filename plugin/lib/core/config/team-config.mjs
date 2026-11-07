/**
 * T11（FR-9.1/R12/R4b）：team.config.json 加载 + 三层合并（纯函数 + 单测〔J1〕）。
 *
 * 合并纪律（K5）：
 *   - 数组整条替换，禁止深合并；
 *   - patch 硬上限（host 层）与 config 冲突取更严格者；
 *   - 非法配置（如列映射不覆盖终态）→ 回退默认 + 告警（返回 warnings）。
 * 层级：内置默认 < 项目 team.config.json < 团队模板（CHG-55：建团时按模板落
 * `.team-workplace/state/teams/<teamId>/team.config.json`，团队级更具体、优先级最高）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

                             
          
                     
                                           
                        
                              
   
                                                                                                              
                                                                              
                                            
                                                                          
                                                       
                                                    
                                
                                       
     
                                   
                                                        
                                        
     
                                 
 

export const DEFAULT_CONFIG             = {
  board: {
    columns: ['backlog', 'ready', 'running', 'gates', 'done'],
    columnMapping: {
      running: ['in_progress', 're-scoping'],
      gates: ['gate:review', 'gate:verify', 'gate:archive'],
      done: ['done'],
      backlog: ['failed', 'blocked', 'cancelled'], // 终态兜底桶：面板显示在 backlog 列头下的"需人工"分区
    },
    cardFields: ['assignee', 'deps', 'gateState', 'tokens'],
    dragRules: 'state-machine',
  },
  pipeline: { swimlaneBy: 'stage', stages: ['plan', 'dev', 'gates', 'integrate'], layout: 'serpentine' },
  dag: { showModel: true, collapseGroups: true, direction: 'LR' },
  views: { default: 'board', tabs: ['board', 'swimlane', 'dag', 'roster'] },
  limits: { maxMembers: 6, memberMaxDepth: 0, maxTasks: 20 },
  gates: { enabled: true, commandTimeoutMs: 120000 },
  taskTypes: {
    default: { gateChain: ['review', 'archive'] },
    dev: { gateChain: ['review', 'verify', 'archive'] },
  },
  clarify: { maxRounds: 3 },
  // 记忆审计（CHG-19，FR-6.2/ADR-009）：true = 无证据指针的记忆条目被审计落账本
  memory: { evidenceRequired: true },
  // scope 完成审计（CHG-87，FR-5.4）：默开——越界只留痕不阻断交付
  audit: { writeScopes: true },
}

/** patch 层硬上限（升级存活；config 不得超过，冲突取更严格者） */
export const PATCH_CEILINGS = {
  'limits.maxMembers': 6,
  'limits.memberMaxDepth': 0,
}         

                              
                    
                    
                                              
                   
                                        
                                              
 

const isPlainObject = (v         )                               =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 数组整条替换的对象浅合并（仅一层 config 深度，键集以 overrides 为准） */
export function mergeConfig(base            , overrides         , warnings          )             {
  if (!isPlainObject(overrides)) return base
  const out = structuredClone(base)                                      
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in base)) {
      warnings.push(`unknown config key "${key}" ignored`)
      continue
    }
    if (isPlainObject(value) && isPlainObject((base                                      )[key])) {
      // 对象段落：按子键合并——子键值为对象则递归浅并，子键值为数组/标量则整条替换（K5）
      const baseSection = (base                                      )[key]                           
      const mergedSection                          = { ...baseSection }
      for (const [subKey, subValue] of Object.entries(value                           )) {
        if (isPlainObject(subValue) && isPlainObject(baseSection[subKey])) {
          mergedSection[subKey] = { ...(baseSection[subKey]                           ), ...(subValue                           ) }
        } else {
          mergedSection[subKey] = subValue
        }
      }
      out[key] = mergedSection
    } else {
      // 数组/标量：整条替换（K5）
      out[key] = value
    }
  }
  return out                         
}

/** 终态覆盖校验（FR-9.1 非法配置判定）：columnMapping 的归并结果必须覆盖全部终态 */
export function validateCoverage(config            )           {
  const warnings           = []
  const terminalStates = ['done', 'failed', 'blocked', 'cancelled']
  const mapped = new Set        (config.board.columns)
  for (const states of Object.values(config.board.columnMapping)) {
    for (const s of states) mapped.add(s)
  }
  for (const t of terminalStates) {
    if (!mapped.has(t)) warnings.push(`terminal state "${t}" not covered by columns/columnMapping; fallback engaged`)
  }
  return warnings
}

/** 更严格者胜（C5 同源思想）：maxMembers/memberMaxDepth 不得超过 patch 硬上限 */
export function applyCeilings(config            , warnings          )             {
  const out = structuredClone(config)
  if (out.limits.maxMembers > PATCH_CEILINGS['limits.maxMembers']) {
    warnings.push(`limits.maxMembers ${out.limits.maxMembers} exceeds patch ceiling ${PATCH_CEILINGS['limits.maxMembers']}; clamped`)
    out.limits.maxMembers = PATCH_CEILINGS['limits.maxMembers']
  }
  if (out.limits.memberMaxDepth > PATCH_CEILINGS['limits.memberMaxDepth']) {
    warnings.push(`limits.memberMaxDepth ${out.limits.memberMaxDepth} exceeds patch ceiling ${PATCH_CEILINGS['limits.memberMaxDepth']}; clamped`)
    out.limits.memberMaxDepth = PATCH_CEILINGS['limits.memberMaxDepth']
  }
  return out
}

/** 结构快检（拒绝式但只拒"类型明显错误"）：段落缺失合法（merge 补默认）；
 * 已知段落若存在但类型错误 → 非法（防 garbage JSON 拖垮面板）。 */
export function isStructurallyValidConfig(value         )          {
  if (!isPlainObject(value)) return false
  const sections                                          = {
    board: (v) => isPlainObject(v) && (v.columns === undefined || (Array.isArray(v.columns) && v.columns.every((c) => typeof c === 'string'))),
    pipeline: isPlainObject,
    dag: isPlainObject,
    views: isPlainObject,
    limits: isPlainObject,
    gates: isPlainObject,
    taskTypes: isPlainObject,
    clarify: isPlainObject,
    memory: isPlainObject,
    audit: isPlainObject,
  }
  for (const [section, check] of Object.entries(sections)) {
    if (section in value && !check(value[section])) return false
  }
  return true
}

/**
 * 顶层入口（CHG-55/56）：内置默认 ← 项目 config → 团队级 config。
 * 逐层应用：非法/不覆盖终态的层被忽略并告警，已生效的浅层保留（拒绝式但不误伤）。
 * 最后统一做硬上限钳制。
 */
export function loadEffectiveConfig(projectConfigRaw         , teamConfigRaw          )              {
  const warnings           = []
  const applied = { project: false, team: false }
  let config = DEFAULT_CONFIG
  let fellBack = false
  const applyLayer = (raw         , layer                              , label        )       => {
    if (raw === undefined || raw === null) return
    if (!isStructurallyValidConfig(raw)) {
      warnings.push(`${label} structurally invalid; layer ignored`)
      fellBack = true
      return
    }
    const candidate = mergeConfig(config, raw, warnings)
    const coverage = validateCoverage(candidate)
    if (coverage.length > 0) {
      warnings.push(...coverage.map((w) => `${label}: ${w}`))
      fellBack = true
      return
    }
    config = candidate
    applied[layer] = true
  }
  applyLayer(projectConfigRaw, 'project', 'project team.config.json')
  applyLayer(teamConfigRaw, 'team', 'team team.config.json')
  const clamped = applyCeilings(config, warnings)
  return { config: clamped, warnings, fellBack, applied }
}

/** 项目级配置落点（CHG-56）：随仓库共享，团队级配置在它之上叠加 */
export function projectConfigPath(workspaceRoot        )         {
  return join(workspaceRoot, '.team-workplace', 'config', 'team.config.json')
}

/** 读项目级配置（缺失/坏 JSON 返回 undefined） */
export function readProjectConfigRaw(workspaceRoot        )          {
  return readJsonIfExists(projectConfigPath(workspaceRoot))
}

function readJsonIfExists(path        )          {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 团队级配置落点（CHG-55）：与账本同目录，随团队生命周期走 */
export function teamConfigPath(workspaceRoot        , teamId        )         {
  return join(workspaceRoot, '.team-workplace', 'state', 'teams', teamId, 'team.config.json')
}

/** 读团队级配置（缺失/坏 JSON 返回 undefined；坏 JSON 不抛错，由上层回退默认） */
export function readTeamConfigRaw(workspaceRoot        , teamId        )          {
  return readJsonIfExists(teamConfigPath(workspaceRoot, teamId))
}

/** 原子写团队级配置（tmp + rename；父目录自动创建） */
export function writeTeamConfigRaw(workspaceRoot        , teamId        , value         )         {
  const path = teamConfigPath(workspaceRoot, teamId)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return path
}

/** 团队模板 → 生效配置覆盖（CHG-55）：只取模板显式声明的段落，未声明段走插件默认 */
export function configOverrideFromPreset(preset   
                                                                          
                                                                        
                                                          
                                                     
 )                                      {
  const overrides                          = {}
  if (preset.board && (preset.board.columns || preset.board.columnMapping)) {
    overrides.board = {
      ...(preset.board.columns ? { columns: preset.board.columns } : {}),
      ...(preset.board.columnMapping ? { columnMapping: preset.board.columnMapping } : {}),
    }
  }
  if (preset.pipeline) overrides.pipeline = preset.pipeline
  if (preset.gates) overrides.gates = preset.gates
  if (preset.taskTypes) overrides.taskTypes = preset.taskTypes
  return Object.keys(overrides).length > 0 ? overrides : undefined
}



//# sourceURL=./src/core/config/team-config.ts