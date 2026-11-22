/**
 * v2 版本常量：所有持久化与协议格式的单一定义点。
 *
 * 为什么单独成文件：schema 版本既写进事件信封，也写进 manifest 与批次帧。
 * 分散定义时，改一处忘一处的结果是「日志说 v2、manifest 说 v1」，恢复逻辑
 * 会按错误版本解释权威数据。这里只放常量与版本兼容判定，不放业务规则。
 */

/** 事件与批次帧格式版本。改变信封必填字段或帧结构时必须递增。 */
export const SCHEMA_VERSION = 2

/** 项目目录布局版本（manifest.json 的 layoutVersion）。 */
export const LAYOUT_VERSION = 2

/** 面板/工具协议版本；客户端与服务端各自声明，不匹配时明确拒绝。 */
export const PROTOCOL_VERSION = 2

/** 配置合并算法版本，写入每个 Effective Config Snapshot。 */
export const MERGE_ALGORITHM_VERSION = 'merge@2'

/** 安全上限版本，写入每个 Effective Config Snapshot。 */
export const SAFETY_LIMITS_VERSION = 'limits@2'

/** 项目内权威目录名，相对项目根。 */
export const WORKSPACE_DIR = '.dsh-myteam'

/** 项目权威事件日志，相对项目根。 */
export const EVENTS_FILE = `${WORKSPACE_DIR}/events/project.jsonl`

/** 项目 manifest，相对项目根。 */
export const MANIFEST_FILE = `${WORKSPACE_DIR}/manifest.json`

/** 项目写者协调文件，相对项目根。 */
export const WRITER_LOCK_FILE = `${WORKSPACE_DIR}/state/writer.lock`

/** 项目派生投影目录，相对项目根。 */
export const PROJECTIONS_DIR = `${WORKSPACE_DIR}/state/projections`

/** 全局定义库目录名，相对 `$DSH_HOME/myteam`。 */
export const GLOBAL_LIBRARY_DIR = 'myteam'

/** 全局写操作审计，相对 `$DSH_HOME`。 */
export const GLOBAL_AUDIT_FILE = 'myteam/audit/global-operations.jsonl'

/**
 * 版本兼容判定。
 *
 * v2 只接受与自己相同的 schema 主版本：读到一个更高或更低版本的文件时，
 * 不能「尽力解释」——那会把未知字段静默丢掉，再写回去就是数据损失。
 * 调用方据此拒绝打开项目并给出明确错误。
 */
export function isSupportedSchemaVersion(value: unknown): value is number {
  return value === SCHEMA_VERSION
}

/** 协议兼容：当前只支持同版本，不回退解释旧协议。 */
export function isSupportedProtocolVersion(value: unknown): value is number {
  return value === PROTOCOL_VERSION
}
