/**
 * Declarative structure checks.
 *
 * A scheme's recipe declares the invariants its output must satisfy, and this
 * module runs them. Keeping the rules as data — rather than a hand-written
 * validator per scheme — is what lets "开发规范化" grow by adding a scheme
 * instead of adding code.
 *
 * The result shape matches `lib/bundle-check.js` on purpose: one renderer, one
 * vocabulary (pass / warn / fail), so a caller can concatenate both.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { render, test } from './generate.js'

const SKIP = new Set(['node_modules', '.git'])

/**
 * @param {string} root - the generated directory.
 * @param {object[]} rules - see the types below.
 * @param {object} [values] - recipe values, for `{{placeholder}}` in rule fields.
 * @returns {Promise<{ok: boolean, summary: {pass: number, warn: number, fail: number}, checks: object[]}>}
 */
export async function runRules(root, rules, values = {}, options = {}) {
  const checks = []
  for (const rule of rules) {
    if (rule.when !== undefined && !test(rule.when, values)) continue
    const level = rule.level === 'warn' ? 'warn' : 'fail'
    let result
    try {
      result = await runRule(root, rule, values, options)
    } catch (error) {
      result = { passed: false, message: `${rule.type} threw: ${error.message}` }
    }
    checks.push({
      id: rule.id ?? rule.type,
      status: result.passed ? 'pass' : level,
      message: result.message,
    })
  }
  const summary = { pass: 0, warn: 0, fail: 0 }
  for (const check of checks) summary[check.status] += 1
  return { ok: summary.fail === 0, summary, checks }
}

async function runRule(root, rule, values, options = {}) {
  const at = (value) => render(String(value), values)
  switch (rule.type) {
    case 'file-exists': {
      const path = at(rule.path)
      return { passed: await exists(join(root, path)), message: rule.message ?? `${path} exists` }
    }
    case 'file-absent': {
      const path = at(rule.path)
      return { passed: !(await exists(join(root, path))), message: rule.message ?? `${path} is absent` }
    }
    case 'placeholder-free': {
      const files = await walk(root)
      const offenders = []
      for (const file of files) {
        const text = await readFile(join(root, file), 'utf8')
        const leftover = /\{\{([A-Za-z0-9_]+)(?:\|[a-z]+)?\}\}/.exec(text)
        if (leftover !== null) offenders.push(`${file} ({{${leftover[1]}}})`)
      }
      return {
        passed: offenders.length === 0,
        message: offenders.length === 0 ? 'no unresolved placeholders' : `unresolved placeholders in: ${offenders.join(', ')}`,
      }
    }
    case 'files-listed': {
      const manifestPath = rule.manifest ?? 'package.json'
      const manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'))
      const listed = Array.isArray(manifest.files) ? manifest.files : []
      const excluded = Array.isArray(rule.exclude) ? rule.exclude : []
      const files = await walk(root)
      const uncovered = files.filter(file => file !== manifestPath
        && !excluded.some(pattern => covers(pattern, file))
        && !listed.some(pattern => covers(pattern, file)))
      return {
        passed: uncovered.length === 0,
        message: uncovered.length === 0
          ? `every generated file is inside ${manifestPath} "files"`
          : `not covered by ${manifestPath} "files": ${uncovered.join(', ')}`,
      }
    }
    case 'json-field': {
      const path = at(rule.path)
      let parsed
      try {
        parsed = JSON.parse(await readFile(join(root, path), 'utf8'))
      } catch (error) {
        return { passed: false, message: `${path} is not readable JSON: ${error.message}` }
      }
      const value = rule.field.split('.').reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), parsed)
      const ok = rule.equals === undefined ? value !== undefined : JSON.stringify(value) === JSON.stringify(rule.equals)
      return {
        passed: ok,
        message: ok ? `${path} has ${rule.field}` : `${path} is missing ${rule.field}${rule.equals === undefined ? '' : ` (expected ${JSON.stringify(rule.equals)})`}`,
      }
    }
    case 'frontmatter-name': {
      const path = at(rule.path)
      let text
      try {
        text = await readFile(join(root, path), 'utf8')
      } catch {
        return { passed: false, message: `${path} does not exist` }
      }
      const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
      if (block === null) return { passed: false, message: `${path} has no frontmatter` }
      const match = /^name:\s*(.+)$/m.exec(block[1])
      if (match === null) return { passed: false, message: `${path} frontmatter has no name` }
      const actual = match[1].trim().replace(/^["']|["']$/g, '')
      const expected = at(rule.equals ?? '')
      return {
        passed: expected === '' || actual === expected,
        message: expected === '' ? `${path} frontmatter name is ${actual}` : `${path} frontmatter name is ${actual} (expected ${expected})`,
      }
    }
    case 'doc-links': {
      // `lib` is deliberately absent: exempting a source directory once let five
      // dead links pass while the report said zero (see docs/CHECKS.md).
      const skip = new Set(rule.skip ?? ['node_modules', '.git', 'tmp', '.tmp', '.debug', 'dist', 'coverage'])
      const exclude = (rule.exclude ?? []).map(pattern => new RegExp(pattern))
      const docs = (await walk(root)).filter(file => file.endsWith('.md') && !isUnder(file, skip))
      const broken = []
      let checked = 0
      for (const doc of docs) {
        const text = await readFile(join(root, doc), 'utf8')
        for (const match of text.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
          const target = match[2]
          if (/^(https?:|mailto:|#|\/)/.test(target)) continue
          const clean = target.split('#')[0]
          if (clean.length === 0) continue
          if (exclude.some(pattern => pattern.test(clean))) continue
          checked += 1
          const resolved = join(root, doc, '..', clean)
          if (!(await exists(resolved))) broken.push(`${doc} → ${target}`)
        }
      }
      return {
        passed: broken.length === 0,
        message: broken.length === 0
          ? `${docs.length} markdown file(s), ${checked} relative link(s), none broken`
          : `${broken.length} broken link(s): ${broken.slice(0, 6).join(' | ')}${broken.length > 6 ? ` …` : ''}`,
      }
    }
    case 'locale-parity': {
      const files = Array.isArray(rule.files) ? rule.files : ['locale/en.json', 'locale/zh.json']
      const keysets = []
      for (const file of files) {
        const path = at(file)
        let parsed
        try {
          parsed = JSON.parse(await readFile(join(root, path), 'utf8'))
        } catch (error) {
          return { passed: false, message: `${path} is not readable JSON: ${error.message}` }
        }
        keysets.push({ file: path, keys: new Set(flattenKeys(parsed)) })
      }
      const problems = []
      for (const current of keysets) {
        for (const other of keysets) {
          if (current === other) continue
          const missing = [...other.keys].filter(key => !current.keys.has(key))
          if (missing.length > 0) problems.push(`${current.file} is missing ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` (+${missing.length - 5})` : ''} from ${other.file}`)
        }
      }
      return {
        passed: problems.length === 0,
        message: problems.length === 0
          ? `${files.length} locale file(s) carry the same keys`
          : problems.join(' | '),
      }
    }
    case 'import-boundary': {
      const sourceRoot = rule.root ?? 'src'
      const extensions = rule.extensions ?? ['.ts', '.tsx', '.js', '.mjs']
      const layers = rule.layers ?? {}
      const builtins = rule.builtins ?? {}
      const allowExternal = new Set(rule.allowExternal ?? [])
      const files = (await walk(join(root, sourceRoot))).filter(file => extensions.some(extension => file.endsWith(extension)))
      const violations = []
      for (const file of files) {
        const layer = layerOf(file, Object.keys(layers))
        if (layer === undefined) continue
        const text = await readFile(join(root, sourceRoot, file), 'utf8')
        for (const match of text.matchAll(IMPORT_PATTERN)) {
          const specifier = match[1]
          const target = layerOf(specifier, Object.keys(layers), /^\.\.?\/+/)
          if (target !== undefined && (layers[layer] ?? []).includes(target)) {
            violations.push(`${sourceRoot}/${file}: ${layer} must not import ${target} (${specifier})`)
            continue
          }
          const bare = /^[a-z][a-z0-9-]*$/.exec(specifier.replace(/^node:/, ''))
          if (bare !== null && (builtins[layer] ?? []).includes(bare[0])) {
            violations.push(`${sourceRoot}/${file}: ${layer} must not import ${bare[0]}`)
            continue
          }
          const external = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:')
          if (external && !allowExternal.has(layer) && !(builtins[layer] ?? []).includes(specifier)) {
            violations.push(`${sourceRoot}/${file}: ${layer} must not import the package ${specifier}`)
          }
        }
      }
      return {
        passed: violations.length === 0,
        message: violations.length === 0
          ? `${files.length} file(s) under ${sourceRoot} respect the layer boundaries`
          : `${violations.length} violation(s): ${violations.slice(0, 5).join(' | ')}${violations.length > 5 ? ' …' : ''}`,
      }
    }
    case 'no-console': {
      const sourceRoot = rule.root ?? 'src'
      const extensions = rule.extensions ?? ['.ts', '.tsx', '.js', '.mjs']
      const layers = rule.layers ?? []
      const files = (await walk(join(root, sourceRoot))).filter(file => extensions.some(extension => file.endsWith(extension)))
      const offenders = []
      for (const file of files) {
        if (layers.length > 0 && !layers.includes(file.split('/')[0])) continue
        const text = await readFile(join(root, sourceRoot, file), 'utf8')
        if (CONSOLE_PATTERN.test(text)) offenders.push(`${sourceRoot}/${file}`)
      }
      return {
        passed: offenders.length === 0,
        message: offenders.length === 0
          ? `no console logging under ${sourceRoot}${layers.length > 0 ? ` in ${layers.join(', ')}` : ''}`
          : `console logging in: ${offenders.slice(0, 6).join(', ')}${offenders.length > 6 ? ' …' : ''}`,
      }
    }
    case 'file-contains': {
      const path = at(rule.path)
      let text
      try {
        text = await readFile(join(root, path), 'utf8')
      } catch {
        return { passed: false, message: `${path} does not exist` }
      }
      const needles = Array.isArray(rule.contains) ? rule.contains : [rule.contains]
      const missing = needles.filter(needle => !text.includes(at(needle)))
      return {
        passed: missing.length === 0,
        message: missing.length === 0
          ? `${path} contains ${needles.length === 1 ? 'the expected text' : `all ${needles.length} expected fragments`}`
          : `${path} is missing: ${missing.map(item => JSON.stringify(at(item))).join(', ')}`,
      }
    }
    case 'contract-drift': {
      const file = at(rule.file)
      const generator = at(rule.generator)
      const mode = rule.mode ?? 'stdout'
      const path = join(root, file)
      const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined

      if (mode === 'file') {
        // The generator writes the file itself; a change means the committed copy
        // was stale. With `update` the rewrite is the fix, so it counts as passing.
        if (before === undefined) {
          return { passed: false, message: `${file} does not exist; run \`${generator}\`` }
        }
        const beforeHash = fingerprint(before)
        const run = spawnSync(generator, { cwd: root, shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
        if (run.status !== 0) {
          return { passed: false, message: `generator failed (${run.status}): ${clip(run.stderr || run.stdout, 300)}` }
        }
        if (!existsSync(path)) return { passed: false, message: `generator removed ${file}` }
        const changed = fingerprint(readFileSync(path, 'utf8')) !== beforeHash
        if (!changed) return { passed: true, message: `${file} matches its generator` }
        return options.update === true
          ? { passed: true, message: `${file} regenerated` }
          : { passed: false, message: `${file} was out of date; the generator rewrote it (run with update to keep it)` }
      }

      if (mode !== 'stdout') throw new Error(`contract-drift: unknown mode "${mode}"`)
      const run = spawnSync(generator, { cwd: root, shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
      if (run.status !== 0) {
        return { passed: false, message: `generator failed (${run.status}): ${clip(run.stderr || run.stdout, 300)}` }
      }
      const expected = normalize(run.stdout)
      const actual = before === undefined ? undefined : normalize(before)
      if (actual === expected) return { passed: true, message: `${file} matches its generator` }
      if (options.update === true) {
        writeFileSync(path, expected, 'utf8')
        return { passed: true, message: `${file} regenerated from \`${generator}\`` }
      }
      if (actual === undefined) return { passed: false, message: `${file} does not exist; run \`${generator}\`` }
      return { passed: false, message: `${file} differs from its generator${firstDifference(actual, expected)}` }
    }
    default:
      throw new Error(`unknown rule type "${rule.type}"`)
  }
}

/** Every file under `root`, as posix-style relative paths, sorted. */
export async function walk(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...await walk(root, relative))
    else files.push(relative)
  }
  return files.sort()
}

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    try {
      await readdir(path)
      return true
    } catch {
      return false
    }
  }
}

/** Does a `package.json` `files` entry cover a generated path?
 * Entries are the npm forms: an exact file, a directory (covers everything under
 * it), or a single-level glob such as `locale/*.json`.
 */
export function covers(pattern, path) {
  if (pattern === path) return true
  if (pattern.endsWith('/')) return path.startsWith(pattern)
  if (!pattern.includes('*')) return path.startsWith(`${pattern}/`)
  const source = pattern
    .split('*')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${source}$`).test(path)
}

/* -------------------------------------------------------------- helpers */

const IMPORT_PATTERN = /(?:^|\n)[ \t]*(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\sfrom\s+)?['"]([^'"]+)['"]/g
const CONSOLE_PATTERN = /\bconsole\s*\.\s*(log|info|debug)\s*\(/

/**
 * The layer a path or an import specifier belongs to.
 *
 * `domain/user.ts` and `../domain/user.js` both answer `domain`; `./local` and a
 * bare package name answer undefined, which is what "not a layer" means.
 */
function layerOf(value, layers) {
  const segments = String(value).replace(/\\/g, '/').split('/')
  const first = segments.find(segment => segment !== '.' && segment !== '..')
  return first !== undefined && layers.includes(first) ? first : undefined
}

/** Dotted keys of a JSON tree, so two locale files can be compared by shape. */
function flattenKeys(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [prefix]
  const keys = []
  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`
    if (child !== null && typeof child === 'object') keys.push(...flattenKeys(child, path))
    else keys.push(path)
  }
  return keys
}

function isUnder(file, skip) {
  return file.split('/').some(segment => skip.has(segment))
}

function clip(value, limit = 300) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Compare generators and files after line endings and trailing space stop mattering. */
function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '\n')
}

function fingerprint(text) {
  return normalize(text)
}

/** The first line where the committed copy and the generator disagree. */
function firstDifference(actual, expected) {
  const left = actual.split('\n')
  const right = expected.split('\n')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return ` (first difference at line ${index + 1}: ${clip(JSON.stringify(left[index] ?? '<missing>'), 80)} vs ${clip(JSON.stringify(right[index] ?? '<missing>'), 80)})`
    }
  }
  return ''
}
