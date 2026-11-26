/**
 * Generic template engine: a recipe (data) plus a template directory produces a
 * directory of files.
 *
 * The point of the abstraction is that a *scheme* — "how a DSH plugin bundle is
 * laid out", or any future one — is data: which variables exist, how they are
 * validated, which template file lands where under which condition, and what
 * invariants the result must satisfy. The engine knows nothing about plugins; it
 * knows about variables, files, placeholders, and rules.
 *
 * Three rules the engine enforces, because they are the failure modes that make
 * generators untrustworthy:
 *
 * - **selection, not conditionals**: a variant is a different template file
 *   (`index.js.tpl` vs `index.min.js.tpl`), chosen by a `when` clause. Templates
 *   are never evaluated as code.
 * - **unresolved placeholders are fatal**: a leftover `{{token}}` means the
 *   template and the recipe disagree, and shipping that is worse than failing.
 * - **the destination is never clobbered silently**: a non-empty directory needs
 *   `force`.
 *
 * Structured formats stay data: `package.json` is rendered from a template too,
 * with `{{name|json}}` for values that must be JSON-escaped. There is no
 * separate "build the manifest in code" path, so the recipe is the whole truth.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)(?:\|([a-z]+))?\}\}/g
const TRANSFORMS = {
  trim: value => String(value).trim(),
  'single-line': value => String(value).replace(/\s+/g, ' ').trim(),
}

/**
 * Read and validate a scheme's `recipe.json`.
 * @param {string} templateDir - directory holding `recipe.json` and the templates.
 */
export async function loadRecipe(templateDir) {
  const path = join(templateDir, 'recipe.json')
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(`generate: no recipe.json in ${templateDir}`)
  }
  let recipe
  try {
    recipe = JSON.parse(raw)
  } catch (error) {
    throw new Error(`generate: ${path} is not valid JSON: ${error.message}`)
  }
  if (typeof recipe.name !== 'string' || recipe.name.length === 0) {
    throw new Error(`generate: ${path} needs a "name"`)
  }
  if (!Array.isArray(recipe.variables) || recipe.variables.length === 0) {
    throw new Error(`generate: ${path} needs a non-empty "variables" array`)
  }
  if (!Array.isArray(recipe.files) || recipe.files.length === 0) {
    throw new Error(`generate: ${path} needs a non-empty "files" array`)
  }
  for (const file of recipe.files) {
    if (typeof file.from !== 'string' || typeof file.to !== 'string') {
      throw new Error(`generate: every entry in "files" needs "from" and "to" (${JSON.stringify(file)})`)
    }
  }
  return { ...recipe, directory: templateDir, recipePath: path }
}

/**
 * Resolve variables: derive, default, transform, validate.
 *
 * Order matters and is deliberate: `derive` runs before validation (a derived
 * value still has to satisfy its pattern), and `when` decides whether a variable
 * is required at all — `toolName` only matters when a tool is generated.
 */
export function buildValues(recipe, input, derivations = {}) {
  const provided = input !== null && typeof input === 'object' ? input : {}
  const values = {}
  const warnings = []

  for (const spec of recipe.variables) {
    if (spec.when !== undefined && !test(spec.when, values)) continue

    let value
    if (provided[spec.name] !== undefined && provided[spec.name] !== null) {
      value = provided[spec.name]
    } else if (spec.derive !== undefined) {
      const derive = derivations[spec.derive]
      if (typeof derive !== 'function') {
        throw new Error(`generate: recipe asks for derive "${spec.derive}" but the scheme does not provide it`)
      }
      value = derive(values)
    } else if (spec.default !== undefined) {
      value = spec.default
    } else if (spec.required === true) {
      throw new Error(`generate: ${spec.name} is required${spec.message === undefined ? '' : ` — ${spec.message}`}`)
    }

    if (value === undefined || value === null) continue
    if (spec.type === 'boolean') value = value !== false
    else if (typeof value === 'string' && spec.transform !== undefined) {
      const transform = TRANSFORMS[spec.transform]
      if (transform === undefined) throw new Error(`generate: unknown transform "${spec.transform}"`)
      value = transform(value)
    }
    if (typeof value === 'string' && value.length === 0 && spec.required === true) {
      throw new Error(`generate: ${spec.name} is required${spec.message === undefined ? '' : ` — ${spec.message}`}`)
    }
    if (spec.required === true && (value === undefined || value === '')) {
      throw new Error(`generate: ${spec.name} is required`)
    }
    if (typeof spec.minLength === 'number' && typeof value === 'string' && value.length < spec.minLength) {
      throw new Error(`generate: ${spec.name} must be at least ${spec.minLength} characters`)
    }
    if (typeof spec.pattern === 'string' && typeof value === 'string' && !new RegExp(spec.pattern).test(value)) {
      throw new Error(`generate: invalid ${spec.name} ${JSON.stringify(value)}${spec.patternMessage === undefined ? '' : `; ${spec.patternMessage}`}`)
    }
    values[spec.name] = value
  }

  // Second pass: derivations that read other derived values (summary, warnings).
  for (const spec of recipe.variables) {
    if (spec.derive === undefined || values[spec.name] !== undefined) continue
    const derive = derivations[spec.derive]
    if (typeof derive !== 'function') throw new Error(`generate: recipe asks for derive "${spec.derive}"`)
    values[spec.name] = derive(values)
  }

  if (recipe.warnings !== undefined) {
    const derive = derivations[recipe.warnings.derive]
    if (typeof derive !== 'function') throw new Error(`generate: recipe asks for warnings derive "${recipe.warnings.derive}"`)
    warnings.push(...derive(values))
  }
  return { values, warnings }
}

/** Which files this recipe generates for these values, as `{from, to}` pairs. */
export function selectFiles(recipe, values) {
  return recipe.files
    .filter(file => file.when === undefined || test(file.when, values))
    .map(file => ({ from: file.from, to: render(file.to, values) }))
}

/**
 * Create the directory from the recipe.
 *
 * @returns {Promise<{dest: string, files: string[], warnings: string[], values: object, checks: object|undefined}>}
 */
export async function generate(options) {
  const { recipe, dest, derivations = {} } = options
  const rules = options.rules ?? recipe.rules ?? []
  if (typeof dest !== 'string' || dest.trim().length === 0) {
    throw new Error('generate: dest is required (the directory to create)')
  }
  const target = resolve(dest.trim())
  const { values, warnings } = buildValues(recipe, options.values, derivations)
  const selected = selectFiles(recipe, values)

  await assertDestination(target, options.force === true)
  if (options.dryRun === true) {
    return { dest: target, files: selected.map(file => file.to).sort(), warnings, values, checks: undefined }
  }

  const written = []
  for (const file of selected) {
    const source = await readFile(join(recipe.directory, file.from), 'utf8')
    const path = join(target, file.to)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, render(source, values), 'utf8')
    written.push(file.to)
  }
  written.sort()

  let checks
  if (rules.length > 0) {
    const { runRules } = await import('./rules.js')
    // Files the recipe marks `"package": false` are local scaffolding (a
    // .gitignore), not package content: tell the whitelist rule to ignore them.
    const localOnly = recipe.files.filter(file => file.package === false).map(file => file.to)
    const effective = rules.map(rule => (rule.type === 'files-listed'
      ? { ...rule, exclude: [...(rule.exclude ?? []), ...localOnly] }
      : rule))
    checks = await runRules(target, effective, values)
  }

  return { dest: target, files: written, warnings, values, checks }
}

async function assertDestination(target, force) {
  let entries = []
  try {
    entries = await readdir(target)
  } catch {
    // Missing directory: the writes create it.
  }
  if (entries.length > 0 && !force) {
    throw new Error(`generate: ${target} already exists and is not empty; pass force: true to write into it anyway`)
  }
}

/**
 * Replace `{{name}}` and `{{name|json}}`, then fail loud on anything left over.
 *
 * `\{{` is the escape: it renders as a literal `{{` and is not a placeholder.
 * Templates that carry GitHub Actions syntax (`${{ secrets.X }}`) need it, and a
 * template that is mostly Actions YAML would otherwise be unwritable.
 */
export function render(text, values) {
  const ESCAPED = '\u0000open-brace-pair\u0000'
  const output = text
    .replace(/\\\{\{/g, ESCAPED)
    .replace(PLACEHOLDER, (match, name, filter) => {
      if (!(name in values)) return match
      const value = values[name]
      if (filter === 'json') return JSON.stringify(value === undefined ? null : value)
      if (filter !== undefined) throw new Error(`generate: unknown filter "${filter}" on {{${name}}}`)
      return value === undefined || value === null ? '' : String(value)
    })
  const leftovers = [...new Set([...output.matchAll(PLACEHOLDER)].map(match => match[1]))]
  if (leftovers.length > 0) {
    throw new Error(`generate: template left unresolved placeholders: ${leftovers.join(', ')} (a bug in the template or the recipe, not in your input)`)
  }
  return output.replaceAll(ESCAPED, '{{')
}

/** `when` grammar: `name`, `!name`, and `a || b`. No general expressions. */
export function test(expression, values) {
  return String(expression)
    .split('||')
    .some((part) => {
      const term = part.trim()
      const negate = term.startsWith('!')
      const name = negate ? term.slice(1).trim() : term
      const value = values[name]
      const truthy = Array.isArray(value) ? value.length > 0 : Boolean(value)
      return negate ? !truthy : truthy
    })
}
