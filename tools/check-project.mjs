#!/usr/bin/env node
/**
 * 项目规则执行器：跑 `plugin/checks.json` 里声明的规则。
 *
 *   node tools/check-project.mjs [dir] [--config <file>] [--only id,id] [--update]
 *
 * 引擎来自 dsh-plugin-creator（`tools/checks/{checks,rules,generate}.js`，MIT，零外部依赖），
 * 原样引入而不是重写：`dsh_project_check` 工具与本脚本跑的是**同一份实现**，
 * 所以「在对话里跑」和「在 CI 里跑」不会给出两个答案。
 *
 * 规则是数据：项目自己声明边界（分层依赖方向、no-console、入口/patch/本地化对等、
 * 包内文件白名单），引擎只负责执行与报告。规则类型见 dsh-plugin-creator 的 docs/CHECKS.md。
 *
 * 退出码：全部通过 0，有 fail 1。
 */
import { resolve } from 'node:path'
import { runProjectChecks } from './checks/checks.js'

function flag(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
  const only = flag('--only')
  const directory = resolve(positional[0] ?? process.cwd())

  const result = await runProjectChecks(directory, {
    config: flag('--config'),
    only: only === undefined ? undefined : only.split(',').map((item) => item.trim()).filter((item) => item.length > 0),
    update: process.argv.includes('--update'),
  })

  console.log(`${result.target}`)
  console.log(`${result.source} — ${result.ran}/${result.declared} rule(s)\n`)
  for (const check of result.checks) {
    const mark = check.status === 'pass' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL'
    console.log(`${mark} ${check.id}: ${check.message}`)
  }
  console.log(`\n${result.summary.pass} pass, ${result.summary.warn} warn, ${result.summary.fail} fail`)
  if (!result.ok) process.exitCode = 1
}

main().catch((error) => {
  console.error(`check-project: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
