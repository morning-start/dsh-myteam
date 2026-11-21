#!/usr/bin/env node
/**
 * CHG-209：**一键门禁**——本地与 CI 共用入口。
 *
 * 为什么要包一层：几个死代码扫描器「发现死词条也 exit 0」（它们只打印计数），
 * 直接串进 CI 会出现「流水线绿着，但仓库里有 3 条死代码」。这里按**输出行**断言数量，
 * 任何一项不等就红——门禁的可信度只能靠「会红」来证明。
 *
 * 跑法：`node tools/check-all.mjs`（CI 与本地同一个命令，不做两套）。
 * 不含测试套件：那条命令是 `cd plugin && node --test test/*.test.ts test/*.test.js`，
 * 放 CI 里单独一步（耗时最长，失败时想一眼看出是「测试挂了」还是「门禁挂了」）。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** @type {{ name: string, argv: string[], expect: string[] }[]} */
const checks = [
  { name: '架构门禁 A1–A6', argv: ['tools/check-architecture.mjs'], expect: ['ARCH_VIOLATIONS: 0'] },
  { name: '构建指纹（src ↔ lib）', argv: ['tools/check-drift.mjs'], expect: ['MISMATCH: 0'] },
  { name: '文档链接', argv: ['tools/check-doc-links.mjs'], expect: ['断链 0'] },
  { name: '客户端依赖方向', argv: ['tools/check-client-arch.mjs'], expect: ['与基线持平'] },
  { name: '死词条', argv: ['tools/find-dead-locale.mjs'], expect: ['死词条（zh 侧）: 0'] },
  { name: '死导出', argv: ['tools/find-dead-exports.mjs'], expect: ['死导出: 0'] },
  {
    // CHG-210：写了、测了、没接线——`find-dead-exports` 抓不到（测试引用了它）。
    // 判定看「新增 0」：存量债走棘轮（tools/unwired-exports-allow.json 的 maxTodo），只减不增。
    name: '未接线导出（棘轮）',
    argv: ['tools/find-unwired-exports.mjs', '--strict'],
    expect: ['新增 0'],
  },
  {
    name: '死模块',
    argv: ['tools/find-dead-modules.mjs', 'plugin/src/host.ts', 'plugin/src/panel.ts', 'plugin/src/smoke.ts'],
    expect: ['不可达: 0'],
  },
]

let failed = 0
for (const check of checks) {
  const result = spawnSync(process.execPath, check.argv, { cwd: root, encoding: 'utf8' })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const missing = check.expect.filter((line) => !out.includes(line))
  if (result.status === 0 && missing.length === 0) {
    console.log(`✓ ${check.name}`)
    continue
  }
  failed += 1
  console.error(`✗ ${check.name}`)
  if (result.status !== 0) console.error(`  退出码 ${result.status}`)
  for (const line of missing) console.error(`  缺输出行：${line}`)
  const tail = out.split('\n').map((line) => line.trimEnd()).filter(Boolean).slice(-12)
  for (const line of tail) console.error(`  | ${line}`)
}

if (failed > 0) {
  console.error(`\n✗ ${failed}/${checks.length} 项门禁未通过`)
  process.exit(1)
}
console.log(`\n✓ 全部 ${checks.length} 项门禁通过`)
