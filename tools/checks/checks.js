/**
 * Project checks: the "开发规范化" half that runs on a finished project.
 *
 * A `checks.json` at the project root declares the rules; `lib/rules.js` runs
 * them. The rule types that matter for a plugin project are the ones a real one
 * had to hand-write as separate scripts: relative documentation links must
 * resolve, the locale files must carry the same keys, and a layered source tree
 * must not import outward or reach for the host from an inner layer.
 *
 * Keeping them as data is the point: a project states its own boundaries, and the
 * same engine, the same pass/warn/fail vocabulary, and the same report apply.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runRules } from './rules.js'

const CONFIG_NAMES = ['checks.json', 'dsh-checks.json']

/**
 * Load a project's checks file.
 * @param {string} root - the project directory.
 * @param {string} [configPath] - an explicit file, instead of the conventional names.
 */
export async function loadChecks(root, configPath) {
  const candidates = configPath === undefined ? CONFIG_NAMES.map(name => join(root, name)) : [resolve(configPath)]
  for (const candidate of candidates) {
    let text
    try {
      text = await readFile(candidate, 'utf8')
    } catch {
      continue
    }
    let config
    try {
      config = JSON.parse(text)
    } catch (error) {
      throw new Error(`${candidate} is not valid JSON: ${error.message}`)
    }
    if (!Array.isArray(config.rules) || config.rules.length === 0) {
      throw new Error(`${candidate} needs a non-empty "rules" array`)
    }
    for (const rule of config.rules) {
      if (typeof rule.type !== 'string') throw new Error(`${candidate}: every rule needs a "type"`)
    }
    return { path: candidate, config }
  }
  throw new Error(`no checks file in ${root} (looked for ${CONFIG_NAMES.join(', ')})`)
}

/**
 * Run a project's declared checks.
 * @returns {Promise<{ok: boolean, target: string, source: string, summary: object, checks: object[]}>}
 */
export async function runProjectChecks(root, options = {}) {
  const target = resolve(root)
  const { path, config } = await loadChecks(target, options.config)
  const only = Array.isArray(options.only) && options.only.length > 0 ? new Set(options.only) : undefined
  const rules = only === undefined
    ? config.rules
    : config.rules.filter(rule => only.has(rule.id ?? rule.type))

  const result = await runRules(target, rules, {}, { update: options.update === true })
  return { ...result, target, source: path, ran: rules.length, declared: config.rules.length }
}

/** The rules a project can declare, for help text and error messages. */
export const RULE_TYPES = [
  'doc-links',
  'contract-drift',
  'locale-parity',
  'import-boundary',
  'no-console',
  'file-exists',
  'file-absent',
  'files-listed',
  'placeholder-free',
  'json-field',
  'frontmatter-name',
]
