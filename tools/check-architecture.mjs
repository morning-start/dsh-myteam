/**
 * v2 架构门禁：把「分层」与「依赖方向」做成可机械检查的 CI 规则。
 *
 * 为什么必须有机检：v1 的分层只写在文档和 code review 里，一次「顺手 import
 * 一下」就能让 core 反向依赖 remote——TypeScript 完全不报错，依赖图已经成环，
 * 装载顺序变成运气问题。v2 的分层是**目标**而不是现状，所以门禁从第一天就开。
 *
 * 规则（稳定 id，改规则要同步改文档与测试，不要悄悄放宽）：
 *   V1 目录归属      src 下每个 .ts 必须落在已知分层目录里
 *   V2 依赖方向      contracts/domain/application 不得 import 更外层的分层
 *   V3 宿主与 IO     contracts/domain/application 不得 import fs/child_process 等
 *   V4 外部包        contracts/domain/application 不得 import 第三方包
 *   V5 打印边界      contracts/domain/application 不得 console.log
 *
 * 运行：node tools/check-architecture.mjs
 * 退出码：违规为 0 时 0，否则 1。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_ROOT = join(REPO_ROOT, 'plugin', 'src')

const LAYERS = ['contracts', 'domain', 'application', 'infrastructure', 'composition']

const FORBIDDEN_LAYERS = {
  contracts: ['domain', 'application', 'infrastructure', 'composition'],
  domain: ['application', 'infrastructure', 'composition'],
  application: ['infrastructure', 'composition'],
  infrastructure: ['composition'],
  composition: [],
}

const FORBIDDEN_BUILTINS = {
  contracts: ['fs', 'child_process', 'path', 'os', 'net', 'http', 'worker_threads'],
  domain: ['fs', 'child_process', 'path', 'os', 'net', 'http', 'worker_threads'],
  application: ['fs', 'child_process', 'path', 'os', 'net', 'http', 'worker_threads'],
  infrastructure: [],
  composition: [],
}

const ALLOW_EXTERNAL = new Set(['infrastructure', 'composition'])

/** 递归列出 .ts 文件（确定性顺序）。 */
function listFiles(dir, result = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(full, result)
    else if (entry.isFile() && entry.name.endsWith('.ts')) result.push(full)
  }
  return result
}

const IMPORT_PATTERN = /(?:^|\n)[ \t]*(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\sfrom\s+)?['"]([^'"]+)['"]/g
const CONSOLE_PATTERN = /\bconsole\s*\.\s*(log|info|debug)\s*\(/g

function layerOf(relativePath) {
  const [first] = relativePath.split('/')
  return LAYERS.includes(first) ? first : null
}

function lineOf(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

/**
 * 检查整个 src 树，返回违规清单。
 *
 * 导出成函数而不是只在 CLI 里跑，是为了让测试能直接断言「当前实现零违规」，
 * 而不是靠人记得在提交前手动执行。
 */
export function checkArchitecture(srcRoot = SRC_ROOT) {
  const violations = []
  const files = listFiles(srcRoot)

  for (const file of files) {
    const relativePath = relative(srcRoot, file).split(sep).join('/')
    const layer = layerOf(relativePath)
    if (layer === null) {
      violations.push({
        rule: 'V1',
        file: relativePath,
        line: 1,
        message: `文件不在已知分层目录（${LAYERS.join('/')}）内`,
      })
      continue
    }

    const source = readFileSync(file, 'utf8')

    IMPORT_PATTERN.lastIndex = 0
    let match
    while ((match = IMPORT_PATTERN.exec(source)) !== null) {
      const specifier = match[1]
      const line = lineOf(source, match.index)

      if (specifier.startsWith('.')) {
        const resolved = posix.normalize(
          posix.join(posix.dirname(`/${relativePath}`), specifier).replace(/^\/+/, ''),
        )
        const targetLayer = layerOf(resolved)
        if (targetLayer === null) continue
        if (FORBIDDEN_LAYERS[layer].includes(targetLayer)) {
          violations.push({
            rule: 'V2',
            file: relativePath,
            line,
            message: `${layer} 不得 import ${targetLayer}（${specifier}）`,
          })
        }
        continue
      }

      if (specifier.startsWith('node:')) {
        const builtin = specifier.slice('node:'.length).split('/')[0]
        if (FORBIDDEN_BUILTINS[layer].includes(builtin)) {
          violations.push({
            rule: 'V3',
            file: relativePath,
            line,
            message: `${layer} 不得 import 宿主模块 ${specifier}`,
          })
        }
        continue
      }

      if (!ALLOW_EXTERNAL.has(layer)) {
        violations.push({
          rule: 'V4',
          file: relativePath,
          line,
          message: `${layer} 不得直接依赖第三方包（${specifier}）`,
        })
      }
    }

    if (!ALLOW_EXTERNAL.has(layer)) {
      CONSOLE_PATTERN.lastIndex = 0
      let consoleMatch
      while ((consoleMatch = CONSOLE_PATTERN.exec(source)) !== null) {
        violations.push({
          rule: 'V5',
          file: relativePath,
          line: lineOf(source, consoleMatch.index),
          message: `${layer} 不得直接打印，请注入 LoggerPort`,
        })
      }
    }
  }

  return { files: files.length, violations }
}

function main() {
  const { files, violations } = checkArchitecture()
  if (violations.length === 0) {
    console.log(`ARCH_OK files=${files} violations=0`)
    return 0
  }
  for (const violation of violations) {
    console.log(`${violation.rule} ${violation.file}:${violation.line} ${violation.message}`)
  }
  console.log(`ARCH_VIOLATIONS files=${files} violations=${violations.length}`)
  return 1
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  process.exitCode = main()
}