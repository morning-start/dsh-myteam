/**
 * 从代码生成工具面契约：`docs/contracts/tool-surface.md`。
 *
 *   node tools/gen-tool-contract.mjs          # 写入
 *   node tools/gen-tool-contract.mjs --check  # 只校验
 *
 * 工具名、说明与必填参数都从 `tool-specs.ts` 读；错误码从 `contracts/errors.ts` 读。
 * 手写文档会漂移，这里生成后由 `--check` 守住。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { leadToolSpecs, memberToolSpecs } from '../plugin/src/application/tool-specs.ts'
import { ERROR_CODES } from '../plugin/src/contracts/errors.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = join(ROOT, 'docs', 'contracts', 'tool-surface.md')

function rows(specs) {
  return specs
    .map((spec) => {
      const required = spec.parameters?.required ?? []
      return `| \`${spec.name}\` | ${spec.description} | ${required.length === 0 ? '—' : required.map((key) => `\`${key}\``).join('、')} |`
    })
    .join('\n')
}

const lead = leadToolSpecs()
const member = memberToolSpecs()
const codes = Object.keys(ERROR_CODES).sort()

const content = `# 工具面契约

> 由 \`tools/gen-tool-contract.mjs\` 从 \`plugin/src/application/tool-specs.ts\` 与
> \`plugin/src/contracts/errors.ts\` 生成。不要手改。

## 身份与权限

- 工具参数里的 \`teamId\` / \`memberId\` **不可信**；调用者身份只来自会话绑定
  （\`application/actor-resolution.ts\`），解析不到即 \`FORBIDDEN\`。
- 队长 preset 只注册队长工具，成员 preset 只注册成员工具；两侧不共享注册表。

## 队长工具（${lead.length}）

| 工具 | 说明 | 必填参数 |
|---|---|---|
${rows(lead)}

## 成员工具（${member.length}）

| 工具 | 说明 | 必填参数 |
|---|---|---|
${rows(member)}

## 返回形状

成功：\`{ "ok": true, "data": { ... } }\`
失败：\`{ "ok": false, "error": { "code": "FORBIDDEN", "message": "...", "retryable": false } }\`

业务错误**不抛给宿主**：模型需要看到 \`code\` 才能改变行为。

## 错误码

${codes.map((code) => `- \`${code}\``).join('\n')}
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
    console.error('工具契约文档与代码不一致，请运行 node tools/gen-tool-contract.mjs')
    process.exit(1)
  }
  console.log('TOOL_CONTRACT_OK')
  process.exit(0)
}

writeFileSync(TARGET, content)
console.log(`已生成 ${TARGET}`)