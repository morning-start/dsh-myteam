/**
 * 从代码生成面板契约文档：`docs/contracts/panel-rpc.md`。
 *
 * 为什么生成而不是手写：方法名、协议版本和说明都在 `panel-contract.ts` 里，
 * 手写文档迟早与代码漂移。生成文件顶部带「不要手改」标记。
 *
 *   node tools/gen-panel-contract.mjs           # 写入
 *   node tools/gen-panel-contract.mjs --check   # 只校验（CI 用）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { PANEL_METHODS, PANEL_METHOD_DOCS } from '../plugin/src/application/panel-contract.ts'
import { PANEL_WRITE_DOCS, PANEL_WRITE_KINDS, PANEL_WRITE_METHODS } from '../plugin/src/application/panel-writes.ts'
import { PROTOCOL_VERSION } from '../plugin/src/contracts/versions.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = join(ROOT, 'docs', 'contracts', 'panel-rpc.md')

const content = `# 面板 RPC 契约

> 由 \`tools/gen-panel-contract.mjs\` 从 \`plugin/src/application/panel-contract.ts\` 生成。
> 不要手改；改契约请改代码后重新生成。

- 协议版本：\`${PROTOCOL_VERSION}\`
- 请求：\`{ protocolVersion?: number, method: string, params?: object }\`
- 响应：\`{ ok: true, data: object }\` 或 \`{ ok: false, error: { code, message, retryable, details? } }\`

协议版本显式不匹配时返回 \`UNSUPPORTED_PROTOCOL_VERSION\`；未知方法返回 \`INVALID_COMMAND\`。
面板只读方法不写项目。写操作不走这个命名空间，而是单独一条通道：
\`POST /__myteam/write/<method>\`，必须带 \`sessionId\`，按确认方式分两类——
\`token\` 先预览影响面换一次性令牌、再凭令牌执行；\`direct\` 直接带 \`confirm: true\` 执行
（由域内状态校验兜底）。

## 方法

| 方法 | 说明 |
|---|---|
${PANEL_METHODS.map((method) => `| \`${method}\` | ${PANEL_METHOD_DOCS[method]} |`).join('\n')}

## 写方法

| 方法 | 确认方式 | 说明 |
|---|---|---|
${PANEL_WRITE_METHODS.map((method) => `| \`${method}\` | \`${PANEL_WRITE_KINDS[method]}\` | ${PANEL_WRITE_DOCS[method]} |`).join('\n')}

## 参数

| 方法 | 必填参数 |
|---|---|
| \`task\` | \`taskId\` |
| \`team\` | \`teamId\` |
| \`migration\` | 无（读取请求里的工作区根） |
| 其余 | 无 |

## 稳定标识

方法名是协议的一部分，发布后只增不改。新增能力只能追加方法，不能改变已有方法的
参数语义或返回结构。
`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(TARGET, 'utf8')
  } catch {
    console.error(`缺少生成产物：${TARGET}`)
    process.exit(1)
  }
  if (current !== content) {
    console.error('面板契约文档与代码不一致，请运行 node tools/gen-panel-contract.mjs')
    process.exit(1)
  }
  console.log('PANEL_CONTRACT_OK')
  process.exit(0)
}

writeFileSync(TARGET, content)
console.log(`已生成 ${TARGET}`)