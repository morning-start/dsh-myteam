/**
 * 配置视图载荷（CHG-62）：`getConfig` 与离线看板共用同一份纯数据构造，
 * 避免「在线设置页」与「离线设置页」两套字段漂移。
 *
 * 只做投影：输入 = 已合并生效配置 + 告警 + 来源层，输出 = 客户端可直接渲染的载荷。
 */
import type { TeamConfig } from './team-config.ts'

export type ConfigLayer = 'default' | 'project' | 'team'

/**
 * CHG-170（R41-③）：随配置视图下发的**宿主运行时事实**（可选）。
 *
 * 为什么不是 TeamConfig 的字段：`builtinToolsHide` 是 host 级行为（initialize 时执行一次），
 * 不属于任何合并层；离线/旧宿主拿不到时**整个键缺席**，客户端显示「—」不编 0
 * （与覆盖率徽标的「未知不编 0」同一纪律）。
 */
export interface ConfigPayloadRuntime {
  builtinToolsHide?: { enabled: boolean; restricted: boolean; configured: string[]; effective: string[] }
}

export interface ConfigPayload {
  status: 'ok'
  source: ConfigLayer
  chain: Array<{ layer: ConfigLayer; active: boolean }>
  config: {
    board: TeamConfig['board']
    pipeline: TeamConfig['pipeline']
    views: TeamConfig['views']
    limits: TeamConfig['limits']
    gates: TeamConfig['gates']
    taskTypes: TeamConfig['taskTypes']
    clarify: TeamConfig['clarify']
    memory: TeamConfig['memory']
    /** CHG-173（FR-1.3）：DAG 来源（唯一的顶层标量字段，随 config 载荷下发） */
    taskPlanning: TeamConfig['taskPlanning']
  }
  runtime?: ConfigPayloadRuntime
  warnings: string[]
}

export function buildConfigPayload(config: TeamConfig, warnings: string[], source: ConfigLayer = 'default', runtime?: ConfigPayloadRuntime): ConfigPayload {
  return {
    status: 'ok',
    source,
    // 合并链：内置默认 < 项目 team.config.json（CHG-56）< 团队模板落盘（CHG-55）
    chain: [
      { layer: 'default', active: source === 'default' },
      { layer: 'project', active: source === 'project' },
      { layer: 'team', active: source === 'team' },
    ],
    config: {
      board: config.board,
      pipeline: config.pipeline,
      views: config.views,
      limits: config.limits,
      gates: config.gates,
      taskTypes: config.taskTypes,
      clarify: config.clarify,
      memory: config.memory,
      taskPlanning: config.taskPlanning,
    },
    ...(runtime ? { runtime } : {}),
    warnings,
  }
}
