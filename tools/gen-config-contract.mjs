/**
 * 从代码生成配置字段契约：`docs/contracts/config-schema.md`。
 *
 *   node tools/gen-config-contract.mjs          # 写入
 *   node tools/gen-config-contract.mjs --check  # 只校验
 *
 * 字段与默认值从 `domain/config/merge.ts` 的 `DEFAULT_TEAM_CONFIG` 读取。
 * 手写 schema 迟早与默认值不一致，这里生成后由 `--check` 守住。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { DEFAULT_TEAM_CONFIG } from '../plugin/src/domain/config/merge.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TARGET = join(ROOT, 'docs', 'contracts', 'config-schema.md')

function walk(value, path, lines) {
  for (const [key, child] of Object.entries(value)) {
    const full = path === '' ? key : `${path}.${key}`
    if (typeof child === 'object' && child !== null) {
      lines.push(`| \`${full}\` | 分组 | — |`)
      walk(child, full, lines)
    } else {
      lines.push(`| \`${full}\` | \`${typeof child}\` | \`${JSON.stringify(child)}\` |`)
    }
  }
}

const lines = []
walk(DEFAULT_TEAM_CONFIG, '', lines)

const content = `# 配置字段契约

> 由 \`tools/gen-config-contract.mjs\` 从 \`plugin/src/domain/config/merge.ts\` 生成。不要手改。

## 分层与优先级

\`\`\`
内置默认 (DEFAULT_TEAM_CONFIG)
  → 项目默认 (projectDefaults)
  → 蓝图默认 (blueprintDefaults，可无)
  → 团队覆盖 (teamOverrides)
  = 生效配置 (EffectiveConfigSnapshot)
\`\`\`

规则：

- 覆盖是**深合并**：只写要改的叶子键；
- **未知键与类型错误都拒绝**（拼写错与面板传错类型不能被静默吞掉）；
- 生效配置带 \`configRevision\`；团队覆盖更新时只 rebase 冲突字段，不整份重置；
- 迁移来的团队没有可信覆盖，\`legacy.unknownConfigRevision\` 标记这一点。

## 字段与默认值

| 键 | 类型 | 默认值 |
|---|---|---|
${lines.join('\n')}

## 校验边界

- 数值字段必须是有限正数（\`commandTimeoutMs\` 允许单位为毫秒的整数）；
- 布尔字段只接受 \`true\`/\`false\`；
- 成员权限收窄由 \`domain/permissions/narrowing.ts\` 负责，不在配置里表达。
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
    console.error('配置契约文档与代码不一致，请运行 node tools/gen-config-contract.mjs')
    process.exit(1)
  }
  console.log('CONFIG_CONTRACT_OK')
  process.exit(0)
}

writeFileSync(TARGET, content)
console.log(`已生成 ${TARGET}`)