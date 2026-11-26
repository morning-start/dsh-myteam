#!/usr/bin/env node
/**
 * 类型门禁：`tsc --noEmit`。
 *
 * 为什么必须单独一道：构建用的是 `node:module stripTypeScriptTypes` —— 它**只擦类型、
 * 从不校验**。于是「访问不存在的属性」「调用端口没承诺过的方法」这类错误在构建期
 * 完全静默，只有运行到那一行才炸。2026-11-26 第一次真跑 tsc 抓出 123 个错误，其中
 * 两个是真实运行时缺陷：
 *   - `panel-writes.ts` 的 `globalUnpublish` 分支用了未定义的 `input` → 面板「全局下架」必崩；
 *   - `tool-specs.ts` 读 `context.actor`，而 `ToolRuntimeContext` 里没有这个字段、
 *     `composition/host.ts` 也没传 → `myteam_propose_handoff` / `myteam_propose_plan` 必崩。
 * 两个都是「测试绿着、真实调用坏着」，正是这道门禁存在的理由。
 *
 * 依赖：`typescript` 与 `@types/node` 装在 `plugin/node_modules`（**不入库**，也不进
 * `package.json` 的 dependencies —— 本包保持零运行时依赖）。没装时本脚本**不崩**，
 * 而是明确报告「未安装」并退出 0，同时在输出里写清怎么装：
 *   cd plugin && npm install --no-save --no-package-lock typescript@5 @types/node@22
 *
 * ⚠️ 用 `--no-save` 装：`npm install <pkg>` 会按 `.package-lock.json` 重算整棵树，
 * 把上一次 `--no-save` 装的包删掉。两个包必须**同一条命令**装。
 *
 * 退出码：类型检查通过 0；有类型错误 1；typescript 未安装 0（但输出里明确标注）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'plugin')
const TSC = join(PLUGIN, 'node_modules', 'typescript', 'bin', 'tsc')
const NODE_TYPES = join(PLUGIN, 'node_modules', '@types', 'node')

if (!existsSync(TSC) || !existsSync(NODE_TYPES)) {
  const missing = []
  if (!existsSync(TSC)) missing.push('typescript')
  if (!existsSync(NODE_TYPES)) missing.push('@types/node')
  console.log(`类型检查: 跳过（plugin/node_modules 里缺 ${missing.join(' / ')}，不入库）`)
  console.log('安装方式（两个包必须同一条命令，--no-save 不写进 package.json）：')
  console.log('  cd plugin && npm install --no-save --no-package-lock typescript@5 @types/node@22')
  console.log('TYPES_SKIPPED')
  process.exit(0)
}

const result = spawnSync(process.execPath, [TSC, '-p', 'tsconfig.json', '--noEmit'], {
  cwd: PLUGIN,
  encoding: 'utf8',
})

const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
const errors = out.split('\n').filter((line) => line.includes('error TS'))

if (result.status === 0) {
  console.log(`TYPES_OK ${out.length === 0 ? '（无输出）' : ''}`.trim())
  process.exit(0)
}

console.log(`TYPES_FAIL ${errors.length} 个类型错误`)
for (const line of errors.slice(0, 40)) console.log(`  ${line}`)
if (errors.length > 40) console.log(`  …还有 ${errors.length - 40} 条，直接跑 node tools/check-types.mjs 看全量`)
process.exit(1)
