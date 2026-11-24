#!/usr/bin/env node
/**
 * 一键门禁：测试、架构、三份契约、文档链接。
 *
 * 为什么要有：这四类检查以前散在 README 里靠人记，合并后曾漏跑到
 * 「客户端残留冲突标记、135 个测试全绿」的程度；一条命令才能真正常跑。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function run(label, command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false })
  const ok = result.status === 0
  const tail = (result.stdout ?? '').trim().split('\n').slice(-2).join(' ')
  console.log(`${ok ? '✔' : '✖'} ${label}${tail ? ` — ${tail}` : ''}`)
  if (!ok) {
    failures.push(label)
    const stderr = (result.stderr ?? '').trim()
    if (stderr) console.error(stderr.split('\n').slice(-12).join('\n'))
  }
}

const tests = readdirSync(join(ROOT, 'plugin', 'test'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('test', name))

run('单元测试', process.execPath, ['--test', ...tests], join(ROOT, 'plugin'))
run('架构分层', process.execPath, ['tools/check-architecture.mjs'])
run('面板契约', process.execPath, ['tools/gen-panel-contract.mjs', '--check'])
run('工具契约', process.execPath, ['tools/gen-tool-contract.mjs', '--check'])
run('配置契约', process.execPath, ['tools/gen-config-contract.mjs', '--check'])
run('权限矩阵', process.execPath, ['tools/gen-permission-doc.mjs', '--check'])
run('文档替换', process.execPath, ['tools/check-doc-replacement.mjs', '--strict'])
run('文档治理', process.execPath, ['tools/check-docs.mjs'])
run('文档链接', process.execPath, ['tools/check-doc-links.mjs'])
run('文档路径', process.execPath, ['tools/check-doc-paths.mjs'])
run('文档事实', process.execPath, ['tools/check-doc-facts.mjs'])

if (failures.length > 0) {
  console.error(`\n门禁未通过：${failures.join('、')}`)
  process.exit(1)
}
console.log('\nVERIFY_OK')