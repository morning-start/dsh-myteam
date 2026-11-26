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
  {
    // 期望行必须与扫描器的**成功分支**一致：`check-architecture.mjs` 通过时打印
    // `ARCH_OK files=N violations=0`，失败时才打印 `ARCH_VIOLATIONS ...`。
    // 旧版断言的是失败分支的字符串，于是「门禁通过」反而被判成缺行 —— 这条门禁
    // 从来没绿过，正是 CHG-209「按输出行断言」时写错的那一行。
    name: '架构门禁 A1–A6',
    argv: ['tools/check-architecture.mjs'],
    expect: ['ARCH_OK', 'violations=0'],
  },
  { name: '构建指纹（src ↔ lib）', argv: ['tools/check-drift.mjs'], expect: ['MISMATCH: 0'] },
  {
    // 类型门禁：构建用 stripTypeScriptTypes **只擦类型、从不校验**，所以「访问不存在的
    // 属性」这类错误永远逃过编译器。2026-11-26 第一次真跑 tsc 就抓出 123 个错误，
    // 其中两个是真实运行时缺陷（`input is not defined` 让面板「全局下架」必崩、
    // `context.actor` 恒 undefined 让两个工具必崩）——它们都是「测试绿着、真实调用坏着」。
    // 这条门禁就是让那类缺陷在提交前就红。
    name: '类型检查（tsc --noEmit）',
    argv: ['tools/check-types.mjs'],
    expect: ['TYPES_OK'],
  },
  { name: '文档链接', argv: ['tools/check-doc-links.mjs'], expect: ['断链 0'] },
  { name: '客户端依赖方向', argv: ['tools/check-client-arch.mjs'], expect: ['与基线持平'] },
  { name: '死词条', argv: ['tools/find-dead-locale.mjs'], expect: ['死词条（zh 侧）: 0'] },
  {
    // 死导出走棘轮（tools/dead-exports-allow.json 的 maxTodo），与未接线导出同一套纪律：
    // 新增必须接线或写理由，存量只减不增。旧版断言的是「死导出: 0」——那个数字在
    // 扫描器路径归一化失效时**恒为 0**（一个导出都没扫到），门禁常年假绿。
    name: '死导出（棘轮）',
    argv: ['tools/find-dead-exports.mjs', '--strict'],
    expect: ['新增 0'],
  },
  {
    // CHG-210：写了、测了、没接线——`find-dead-exports` 抓不到（测试引用了它）。
    // 判定看「新增 0」：存量债走棘轮（tools/unwired-exports-allow.json 的 maxTodo），只减不增。
    name: '未接线导出（棘轮）',
    argv: ['tools/find-unwired-exports.mjs', '--strict'],
    expect: ['新增 0'],
  },
  {
    // 入口必须与 `package.json` 的 `exports` 一一对应（v2 的五层架构下，装载面是
    // `src/composition/*.ts`）。旧版这里写的是 v1 的 `src/host.ts` / `src/panel.ts` /
    // `src/member.ts` / `src/smoke.ts`——那些文件在 v2 里根本不存在，扫描器把它们当成
    // 「入口」后可达集为空，`不可达: 0` 永远不可能出现，这条门禁等于常年空转。
    name: '死模块',
    argv: [
      'tools/find-dead-modules.mjs',
      'plugin/src/composition/host.ts',
      'plugin/src/composition/member.ts',
      'plugin/src/composition/panel.ts',
      'plugin/src/composition/human-command.ts',
      'plugin/src/composition/human-card-kind.ts',
      'plugin/src/composition/human-actions-skill.ts',
    ],
    expect: ['不可达: 0'],
  },
  {
    // 项目自己声明的结构规则（dsh-project-check 引擎）：分层依赖方向、no-console、
    // 入口/patch/本地化对等、包内文件白名单。与上面的专用扫描器互补，不重复。
    name: '项目规则（checks.json）',
    argv: ['tools/check-project.mjs', 'plugin'],
    expect: ['0 fail'],
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
