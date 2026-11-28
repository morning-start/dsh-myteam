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
import { isAbsolute, join, relative, resolve } from 'node:path'
import { render, test } from './generate.js'
import { cardProblems, loadCards } from './errors-card.js'
import { RULE_TYPES } from './rule-types.js'

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
    case 'session-message-identity': {
      const sourceRoot = rule.root ?? '.'
      const extensions = rule.extensions ?? ['.ts', '.tsx', '.js', '.mjs', '.cjs']
      const exclude = (rule.exclude ?? []).map(pattern => new RegExp(pattern))
      const files = (await walk(join(root, sourceRoot)))
        .filter(file => extensions.some(extension => file.endsWith(extension)))
        .filter(file => !exclude.some(pattern => pattern.test(file)))
      const findings = await scanSessionMessages(join(root, sourceRoot), files)
      return {
        passed: findings.length === 0,
        message: findings.length === 0
          ? `${files.length} source file(s) under ${sourceRoot}: every message handed to the session carries a nonempty id`
          : `${findings.length} message(s) without an id would be refused when the session is loaded: ${findings.slice(0, 4).join(' | ')}${findings.length > 4 ? ' …' : ''}`,
      }
    }
    case 'undeclared-inject': {
      const sourceRoot = rule.root ?? '.'
      const files = await sourceFiles(root, sourceRoot, rule)
      const findings = []
      for (const file of files) {
        const raw = await readFile(join(root, sourceRoot, file), 'utf8')
        const masked = maskSource(raw)
        // `ctx.<service>` is only a capability gate when `ctx` is the plugin's own
        // context (an `apply(ctx)` / `constructor(ctx)` parameter). A local record
        // named `ctx` is not the plugin context and has no inject list to check.
        if (!takesPluginContext(masked)) continue
        // The inject list carries string literals, which `maskSource` blanks; read
        // the declarations from the raw text, and the usages from the masked one.
        const declared = declaredServices(raw)
        const used = servicesUsed(raw, masked)
        for (const name of used) {
          if (declared.has(name)) continue
          findings.push(`${file}:${lineAt(raw, raw.indexOf(`ctx.${name}`))} uses ctx.${name} but does not declare it in inject`)
        }
      }
      return {
        passed: findings.length === 0,
        message: findings.length === 0
          ? `${files.length} source file(s): every ctx.<service> access is declared in inject`
          : `undeclared service access is refused by the context Proxy: ${findings.slice(0, 4).join(' | ')}${findings.length > 4 ? ' …' : ''}`,
      }
    }
    case 'bare-name-dependency': {
      const sourceRoot = rule.root ?? '.'
      const files = await sourceFiles(root, sourceRoot, rule)
      const declared = await declaredDependencies(root)
      const findings = []
      for (const file of files) {
        const raw = await readFile(join(root, sourceRoot, file), 'utf8')
        for (const specifier of specifiersOf(raw)) {
          if (isRelativeOrBuiltin(specifier)) continue
          if (scopedAllowed(specifier) || declared.has(packageNameOf(specifier))) continue
          findings.push(`${file}: imports "${specifier}", which is not a declared dependency and not in the @deepseek-ai namespace`)
        }
      }
      return {
        passed: findings.length === 0,
        message: findings.length === 0
          ? `${files.length} source file(s): every import resolves in the @deepseek-ai closure or a declared dependency`
          : `bare import(s) the loader closure cannot resolve: ${findings.slice(0, 4).join(' | ')}${findings.length > 4 ? ' …' : ''}`,
      }
    }
    case 'manifest-shape': {
      const manifestPath = rule.manifest ?? 'package.json'
      let manifest
      try {
        manifest = JSON.parse(await readFile(join(root, manifestPath), 'utf8'))
      } catch (error) {
        return { passed: false, message: `${manifestPath} unreadable or invalid: ${error.message}` }
      }
      const problems = []
      const dsh = manifest.dsh
      if (dsh !== undefined && (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh))) {
        problems.push('dsh must be an object')
      } else if (dsh !== undefined) {
        for (const key of Object.keys(dsh)) {
          if (!['bundle', 'client', 'profile'].includes(key)) problems.push(`unknown dsh field "${key}"`)
        }
        if (dsh.bundle !== undefined) {
          const patch = dsh.bundle?.patch
          if (typeof patch !== 'string' || patch.length === 0) {
            problems.push('dsh.bundle.patch must be a single string path (not an array)')
          } else {
            const target = resolve(root, patch)
            if (!isUnderPath(resolve(root), target)) problems.push(`dsh.bundle.patch escapes the package: ${patch}`)
            else if (!existsSync(target)) problems.push(`dsh.bundle.patch names a missing file: ${patch}`)
          }
        }
        if (dsh.client !== undefined) {
          const client = manifest.exports?.['./client']
          if (client === undefined) problems.push('dsh.client declared but exports["./client"] is missing')
        }
      }
      return {
        passed: problems.length === 0,
        message: problems.length === 0
          ? `${manifestPath}: the dsh manifest has a recognised shape`
          : `malformed dsh manifest: ${problems.join('; ')}`,
      }
    }
    case 'custom-session-event': {
      const sourceRoot = rule.root ?? '.'
      const files = await sourceFiles(root, sourceRoot, rule)
      const appended = []
      const declared = new Set()
      for (const file of files) {
        const raw = await readFile(join(root, sourceRoot, file), 'utf8')
        const masked = maskSource(raw)
        // The event type is a string literal, which `maskSource` blanks. Match the
        // call in the raw text, but only count it when the same offset is real code
        // in the masked text, so a `session.append(...)` inside a comment does not count.
        for (const match of raw.matchAll(/session\s*\.\s*append\s*\(\s*(['"`])([^'"`]+)\1/g)) {
          if (masked[match.index] !== 's') continue
          appended.push({ file, type: match[2], line: lineAt(raw, match.index) })
        }
        for (const match of raw.matchAll(/interface\s+SessionEventMap\s*\{([\s\S]*?)\n\s*\}/g)) {
          for (const key of match[1].matchAll(/(['"])([^'"]+)\1\s*:/g)) declared.add(key[2])
        }
      }
      const findings = appended
        .filter(item => !declared.has(item.type))
        .map(item => `${item.file}:${item.line} appends "${item.type}", which is not in SessionEventMap`)
      return {
        passed: findings.length === 0,
        message: findings.length === 0
          ? `${files.length} source file(s): every session.append type is declared in SessionEventMap`
          : `session.append refuses undeclared types: ${findings.slice(0, 4).join(' | ')}${findings.length > 4 ? ' …' : ''}`,
      }
    }
    case 'errors-card': {
      const cards = await loadCards(root)
      const problems = cards.flatMap(card => cardProblems(card, RULE_TYPES))
      return {
        passed: problems.length === 0,
        message: problems.length === 0
          ? `${cards.length} error card(s): every card carries name / cause / matches / location / consequence / fix`
          : `${problems.length} card problem(s): ${problems.slice(0, 4).join(' | ')}${problems.length > 4 ? ' …' : ''}`,
      }
    }
    case 'template-variants': {
      const directory = rule.directory ?? 'templates/bundle'
      const recipeName = rule.recipe ?? 'recipe.json'
      let recipe
      try {
        recipe = JSON.parse(await readFile(join(root, directory, recipeName), 'utf8'))
      } catch (error) {
        return { passed: false, message: `${directory}/${recipeName} unreadable: ${error.message}` }
      }
      const entries = (Array.isArray(recipe.files) ? recipe.files : [])
        .filter(entry => typeof entry?.from === 'string' && typeof entry?.to === 'string')
      const problems = []

      // 1. Every template must be referenced by the recipe, or it is dead weight
      //    nobody will ever notice is stale.
      const referenced = new Set(entries.map(entry => entry.from))
      let present = []
      try {
        present = (await readdir(join(root, directory))).filter(name => name.endsWith('.tpl') || name.endsWith('.txt'))
      } catch (error) {
        return { passed: false, message: `${directory} unreadable: ${error.message}` }
      }
      for (const name of present) {
        if (!referenced.has(name)) problems.push(`${directory}/${name} is not referenced by ${recipeName}`)
      }

      // 2. Every `{{placeholder}}` must be declared, or generation leaves it in
      //    the output and `placeholder-free` only catches it later.
      const declaredVariables = new Set((recipe.variables ?? []).map(variable => variable.name))
      const shapes = new Map()
      for (const source of referenced) {
        let text
        try {
          text = await readFile(join(root, directory, source), 'utf8')
        } catch (error) {
          problems.push(`${directory}/${source}: unreadable (${error.message})`)
          continue
        }
        const shape = templateShape(text)
        shapes.set(source, shape)
        for (const placeholder of shape.placeholders) {
          if (!declaredVariables.has(placeholder)) {
            problems.push(`${directory}/${source} uses {{${placeholder}}}, which ${recipeName} does not declare`)
          }
        }
        for (const service of shape.inject) {
          if (shape.touches.includes(service)) continue
          problems.push(`${directory}/${source} declares inject "${service}" but never touches ctx.${service}; the plugin would wait for it forever`)
        }
        for (const service of shape.touches) {
          if (shape.inject.includes(service)) continue
          problems.push(`${directory}/${source} touches ctx.${service} without declaring it in inject`)
        }
      }

      // 3. Variants that write the same destination must expose the same contract:
      //    same plugin name, both export `apply(ctx)`. Only the registrations may
      //    differ — the hello variant and the real one are the same plugin shape.
      const groups = new Map()
      for (const entry of entries) {
        if (!groups.has(entry.to)) groups.set(entry.to, [])
        groups.get(entry.to).push(entry.from)
      }
      for (const [destination, sources] of groups) {
        if (sources.length < 2) continue
        const first = shapes.get(sources[0])
        if (first === undefined) continue
        for (const source of sources.slice(1)) {
          const shape = shapes.get(source)
          if (shape === undefined) continue
          if (shape.exportsName !== first.exportsName) {
            problems.push(`${destination}: ${sources[0]} exports name ${first.exportsName}, but ${source} exports ${shape.exportsName}`)
          }
          if (shape.exportsApply !== first.exportsApply) {
            problems.push(`${destination}: ${source} does not export apply(ctx) the way ${sources[0]} does`)
          }
        }
      }

      return {
        passed: problems.length === 0,
        message: problems.length === 0
          ? `${entries.length} template(s) in ${directory}/${recipeName}: referenced, declared, and every variant group agrees on its contract`
          : `template problem(s): ${problems.slice(0, 4).join(' | ')}${problems.length > 4 ? ' …' : ''}`,
      }
    }
    case 'release-pipeline': {
      const workflowPath = rule.workflow ?? '.github/workflows/release.yml'
      let workflow
      try {
        workflow = await readFile(join(root, workflowPath), 'utf8')
      } catch {
        return {
          passed: false,
          message: `no release workflow at ${workflowPath}; a release must be driven by a tag push, not by a command someone remembers to run`,
        }
      }
      const problems = []

      // Trigger: pushing a `v*` tag is the only way in.
      const triggeredByTag = /on:\s*\n(?:[\s\S]*?\n)?\s+push:\s*\n\s+tags:\s*\[[^\]]*['"]?v\*/.test(workflow)
        || /tags:\s*\n\s*-\s*['"]?v\*/.test(workflow)
      if (!triggeredByTag) problems.push('the workflow is not triggered by pushing a v* tag')

      // The tag and the manifest must be reconciled before anything ships,
      // otherwise a release can go out under the wrong version number.
      const comparesTag = /GITHUB_REF_NAME/.test(workflow)
      const comparesVersion = /package\.json['"]?\)?\.version|require\(['"]\.\/package\.json['"]\)/.test(workflow)
      if (!(comparesTag && comparesVersion)) {
        problems.push('no step compares the tag (GITHUB_REF_NAME) with package.json version')
      }

      // Publish and the GitHub Release both belong to CI; doing either by hand
      // is what loses provenance and lets two people race the same version.
      if (!/\b(?:npm|pnpm)\s+publish\b/.test(workflow)) problems.push('the workflow does not publish to the registry')
      if (!/\bgh\s+release\s+create\b/.test(workflow)) problems.push('the workflow does not create the GitHub Release')

      // Two tags pushed together used to race on the `latest` dist-tag; the
      // concurrency group is what serialises them.
      if (!(/^concurrency:/m.test(workflow) && /^\s+group:/m.test(workflow))) {
        problems.push('no concurrency group: two tags pushed together race on the latest dist-tag')
      }

      // Credential: a stored token is fine, OIDC is fine, both is best. What must
      // not happen is the token being *required* — a step gated on it silently
      // skips publishing when the secret is absent, and nothing fails.
      if (/^\s*if:.*NPM_TOKEN|^\s*if:.*NODE_AUTH_TOKEN/m.test(workflow)) {
        problems.push('the publish step is gated on a registry token (an `if:` on NPM_TOKEN / NODE_AUTH_TOKEN), so a repository without that secret silently stops publishing; run the step unconditionally and choose the credential inside it')
      }
      if (!/id-token:\s*write/.test(workflow)) {
        problems.push('no `id-token: write` permission: trusted publishing and provenance both need the OIDC identity, which is also what lets a tokenless repository publish')
      }
      if (/\bNPM_TOKEN\b|\bNODE_AUTH_TOKEN\b/.test(workflow) && !/id-token:\s*write/.test(workflow)) {
        problems.push('publishing depends on a stored token with no OIDC fallback')
      }
      // `npm publish | tee log` reports tee's exit status, so a failed publish
      // looks like a success and the release goes on to build itself from a
      // tarball nobody can install. Comment lines are not commands.
      const commandLines = workflow
        .split('\n')
        .filter(line => !/^\s*#/.test(line))
        .join('\n')
      if (/\b(?:npm|pnpm)\s+publish\b[^\n]*\|[^\n]*/.test(commandLines)) {
        problems.push('the publish command is piped into another command, so its exit status is lost; capture the output and test the real status instead')
      }

      return {
        passed: problems.length === 0,
        message: problems.length === 0
          ? `${workflowPath}: tag push drives check -> pack -> publish -> release -> verify, serialised per ref; credential is NPM_TOKEN when present, OIDC otherwise`
          : `the release pipeline is not the fixed one: ${problems.join('; ')}`,
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
    // `errors/` is an entry-format directory: its markdown quotes the broken
    // shapes on purpose, so it is never read as project source.
    if (entry.name === 'errors' && prefix.length === 0) continue
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
 * The session write path is lenient and the load path is strict, so a message
 * without an id is a time bomb: it is accepted, persisted, and then refuses the
 * whole session at restore (`... lacks an identified message`). The rule below
 * looks for the producers that skip the identifying constructors.
 */
const MESSAGE_ROLE = {
  user: 'user',
  developer: 'developer',
  system: 'system',
  assistant: 'assistant',
  tool: 'tool',
}

/** `createUserMessage(...)`, `createDeveloperMessage(...)`, … — the identifying constructors. */
const MESSAGE_FACTORY = /\bcreate(User|Developer|System|Assistant|ToolResult|Message)\b/g

/** Calls that carry a message into the agent or the session log. */
const MESSAGE_SINK = /\b(?:followup|steer|inject|send|append|push|unshift|splice|toSpliced)\s*\(/g

/** `role: 'user'` — the shape of a message literal, whatever it is called. */
const MESSAGE_LITERAL = /\brole\s*:\s*(['"`])(user|developer|system|assistant|tool)\1/

/** An `id` that is present and not empty. */
const IDENTIFIED = /\bid\s*:\s*(?!['"`]\s*['"`])[^\s,}]+/

/** A message event appended with a payload that is not an identifying constructor. */
const MESSAGE_EVENT_APPEND = /\.\s*append\s*\(\s*(['"`])((?:user|developer|system|assistant)\/message|tool\/result)\1\s*,\s*(\S+)/g

/** A role literal that opens the object it belongs to. */
const ROLE_OPENS_OBJECT = /^(\{[^{}]*?)\brole\s*:\s*(['"`])(user|developer|system|assistant|tool)\2/

/**
 * Source ranges of the arguments of every call to one of `names`, so a sink can
 * be told apart from an unrelated `push` on an array of numbers.
 * @param {string} text - source without comments and strings.
 * @param {RegExp} pattern - a `g` regex ending in `\s*\(`.
 */
function callArguments(text, pattern) {
  const calls = []
  for (const match of text.matchAll(pattern)) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let index = open
    for (; index < text.length; index += 1) {
      const character = text[index]
      if (character === '(' || character === '[' || character === '{') depth += 1
      else if (character === ')' || character === ']' || character === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (depth !== 0) continue
    calls.push({
      name: match[0].replace(/\s*\($/, '').split('.').pop(),
      start: open + 1,
      end: index,
      text: text.slice(open + 1, index),
    })
  }
  return calls
}

/** Whether a source range contains a position. */
function within(range, position) {
  return position >= range.start && position < range.end
}

/**
 * Blank comments and the contents of string and template literals, keeping
 * offsets and newlines so a reported line number still points at the real line.
 * A template literal keeps its `${…}` expressions: those are code, and a
 * message literal can live inside one.
 */
export function maskSource(text) {
  const out = text.split('')
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) if (out[index] !== '\n') out[index] = ' '
  }
  const templateStack = []
  let index = 0
  while (index < text.length) {
    const character = text[index]
    const next = text[index + 1]
    if (character === '/' && next === '/') {
      const end = text.indexOf('\n', index)
      const stop = end === -1 ? text.length : end
      blank(index, stop)
      index = stop
      continue
    }
    if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2)
      const stop = end === -1 ? text.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (character === '"' || character === "'") {
      let cursor = index + 1
      while (cursor < text.length && text[cursor] !== character && text[cursor] !== '\n') {
        cursor += text[cursor] === '\\' ? 2 : 1
      }
      blank(index, Math.min(cursor + 1, text.length))
      index = cursor + 1
      continue
    }
    // CHG-217 · 上游缺陷修复：模板串的**收尾**反引号必须 pop，而不是再 push 一层。
    //
    // 原实现把「遇到反引号 → push」放在「模板栈内部」判断**之前**，于是模板串的
    // 收尾反引号走的是 push 分支 → 模板栈多压一层、永不归零 → **该文件后续所有
    // 代码都被当成字符串抹掉** → 下游规则以为那些行是注释/字符串，直接跳过。
    //
    // 真实后果（实测）：`plugin/src/composition/host.ts` 里
    // `targetAgent.followup({ role: 'user', content })` 缺 id/source 的真缺陷，
    // 正好被这一个模板串（`label: \`myteam-${input.roleId}\``）藏住，
    // `session-message-identity` 规则报「全部合规」——**假绿**。
    //
    // 修法：只有**不在**模板里时才 push；模板内的反引号交给下面的 pop 分支。
    if (character === '`' && templateStack.length === 0) {
      templateStack.push(0)
      index += 1
      continue
    }
    if (templateStack.length > 0) {
      if (character === '\\') {
        blank(index, Math.min(index + 2, text.length))
        index += 2
        continue
      }
      if (character === '$' && next === '{') {
        templateStack[templateStack.length - 1] += 1
        index += 2
        continue
      }
      if (character === '}' && templateStack[templateStack.length - 1] > 0) {
        templateStack[templateStack.length - 1] -= 1
        index += 1
        continue
      }
      if (character === '`') {
        templateStack.pop()
        index += 1
        continue
      }
      blank(index, index + 1)
      index += 1
      continue
    }
    index += 1
  }
  return out.join('')
}

/** The 1-based line of a character offset. */
function lineAt(text, position) {
  let line = 1
  for (let index = 0; index < position && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
}

/**
 * Messages that would reach the session without an id.
 *
 * Four findings, each tied to a mechanism rather than to a spelling:
 *
 * 1. a message literal (an object whose `role` is a message role) with no `id`
 *    — the direct cause;
 * 2. a `user/message` (or sibling) event appended with a payload that is not
 *    one of the identifying constructors — the event path;
 * 3. a message handed to `followup` / `steer` / `inject` / `send` / `append`
 *    as a literal or a bare parameter — the inbox path, which persists first
 *    and validates later;
 * 4. a message-shaped parameter declared without an `id` — the same defect one
 *    call away, where the literal lives in the caller.
 *
 * The scan is deliberately syntactic. It cannot prove a message is fine, only
 * point at the places where a missing id is plausible; that is why the rule
 * reports and the caller decides whether it is a failure.
 *
 * @param {string} root - the directory the relative paths are reported against.
 * @param {string[]} files - posix-style relative source paths.
 * @returns {Promise<string[]>} one line per finding, `file:line — what`.
 */
async function scanSessionMessages(root, files) {
  const findings = []
  for (const file of files) {
    const raw = await readFile(join(root, file), 'utf8')
    const text = maskSource(raw)
    const factories = callArguments(text, MESSAGE_FACTORY)
    const sinks = callArguments(text, MESSAGE_SINK)
    const report = (position, what) => findings.push(`${file}:${lineAt(raw, position)} — ${what}`)

    // A literal this file builds for itself. The role is read from the raw line
    // (the masked one has its strings blanked); whether the line is code at all
    // is read from the masked one, so a doc comment or a regex that merely
    // spells the shape out does not count.
    const literals = []
    for (const [index, line] of raw.split('\n').entries()) {
      const match = MESSAGE_LITERAL.exec(line)
      if (match === null) continue
      const opening = line.lastIndexOf('{', match.index)
      const closing = line.indexOf('}', match.index)
      if (opening === -1 || closing === -1) continue
      const position = offsetOfLine(raw, index) + match.index
      // `maskSource` blanked comments and strings, so an `r` here means the
      // `role` is real code. A comment or a string that merely spells the shape
      // out leaves a space, and is not a finding.
      if (text[position] !== 'r') continue
      literals.push({ position, role: match[2], object: line.slice(opening, closing + 1) })
    }

    for (const literal of literals) {
      if (IDENTIFIED.test(literal.object)) continue
      // A literal that is the argument of a factory is the factory's job.
      if (factories.some(call => within(call, literal.position))) continue
      report(literal.position, `a ${literal.role} message literal has no id; DSH loads such a session with "lacks an identified message"`)
    }

    for (const match of raw.matchAll(MESSAGE_EVENT_APPEND)) {
      if (text[match.index] !== '.') continue
      if (/^(?:create[A-Z]|freeze[A-Z])/.test(match[3])) continue
      report(match.index, `appends a ${match[2]} event from a payload that is not an identifying constructor (createUserMessage / createDeveloperMessage / createSystemMessage / createAssistantMessage / createToolResultMessage)`)
    }

    for (const call of sinks) {
      if (!ROLE_OPENS_OBJECT.test(call.text)) continue
      const hint = ['followup', 'steer', 'inject', 'send'].includes(call.name)
        ? 'build it with createUserMessage so it carries an id'
        : 'build it with the identifying constructor'
      report(call.start, `${call.name}() receives a message literal; ${hint}`)
    }

    for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([^=\n]+)=/g)) {
      const [, name, annotation] = match
      if (!/\bMessage\b/.test(annotation) || /\bid\b/.test(annotation)) continue
      const role = Object.keys(MESSAGE_ROLE).find(candidate => new RegExp(`\\b${candidate}\\b`).test(annotation))
      if (role === undefined) continue
      if (!new RegExp(`\\b${name}\\b`).test(text.slice(match.index + match[0].length))) continue
      report(match.index, `"${name}" is declared as a ${role} message without an id; the message DSH persists always has one`)
    }
  }
  return findings
}

/**
 * The contract a template file exposes, regardless of what it happens to
 * register. Two templates writing the same destination (`index.js` from the
 * tool variant and from the hello variant) must agree on this; only the
 * registration body may differ.
 *
 * @param {string} text - the template source.
 */
function templateShape(text) {
  const placeholders = [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map(match => match[1]))].sort()
  const nameMatch = /export\s+const\s+name\s*=\s*([^\n]+)/.exec(text)
  const injectMatch = /export\s+const\s+inject\s*(?::[^=]+)?=\s*\[([^\]]*)\]/.exec(text)
  return {
    placeholders,
    exportsName: nameMatch === null ? undefined : nameMatch[1].trim(),
    exportsApply: /export\s+(?:async\s+)?function\s+apply\s*\(\s*ctx\b/.test(text)
      || /export\s+const\s+apply\s*=/.test(text),
    // A declared service that is never touched leaves the plugin waiting for it
    // forever; a touched service that is never declared is refused outright.
    inject: injectMatch === null
      ? []
      : [...injectMatch[1].matchAll(/(['"`])([^'"`]+)\1/g)].map(match => match[2]).sort(),
    touches: [...new Set([...text.matchAll(/\bctx\s*\.\s*([A-Za-z_$][\w$]*)/g)]
      .map(match => match[1])
      .filter(name => !CTX_VERBS.has(name)))].sort(),
  }
}

/** Whether `child` resolves inside `parent` (no escape via `..`). */
function isUnderPath(parent, child) {
  const relativePath = relative(parent, child)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

/** Source files under `root/sourceRoot`, filtered by `rule.extensions` and `rule.exclude`. */
async function sourceFiles(root, sourceRoot, rule) {
  const extensions = rule.extensions ?? ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']
  const exclude = (rule.exclude ?? []).map(pattern => new RegExp(pattern))
  const directory = join(root, sourceRoot)
  let entries
  try {
    entries = await walk(directory)
  } catch {
    // The source root may not exist yet (a fresh package, or `lib/` before a build).
    // An absent directory has nothing to scan, which is a pass, not an error.
    return []
  }
  return entries
    .filter(file => extensions.some(extension => file.endsWith(extension)))
    .filter(file => !exclude.some(pattern => pattern.test(file)))
}

/** The ctx verbs that are not services; accessing them needs no `inject`. */
const CTX_VERBS = new Set([
  'on', 'once', 'off', 'emit', 'parallel', 'serial', 'bail', 'waterfall',
  'effect', 'get', 'set', 'plugin', 'inject', 'provide', 'isolate', 'intercept',
  'fiber', 'scope', 'logger', 'baseUrl',
])

/**
 * Service names declared for a file: `export const inject = [...]`, `static inject`
 * (array or object keys), and `export const inject = { a: ..., b: ... }`.
 */
function declaredServices(masked) {
  const names = new Set()
  const arrayForm = /\b(?:export\s+)?(?:const|static)\s+inject\s*(?:\s*:\s*[^=]+?)?\s*=\s*\[([^\]]*)\]/g
  for (const match of masked.matchAll(arrayForm)) {
    for (const quoted of match[1].matchAll(/(['"`])([^'"`]+)\1/g)) names.add(quoted[2])
  }
  const objectForm = /\b(?:export\s+)?(?:const|static)\s+inject\s*(?:\s*:\s*[^=]+?)?\s*=\s*\{([\s\S]*?)\}/g
  for (const match of masked.matchAll(objectForm)) {
    for (const key of match[1].matchAll(/(?:^|[,\s])(['"`]?)([A-Za-z_$][\w$]*)\1\s*:/g)) names.add(key[2])
  }
  return names
}

/** Service names accessed as `ctx.<name>` in real code (comments/strings masked out). */
function servicesUsed(raw, masked) {
  const names = new Set()
  for (const match of masked.matchAll(/\bctx\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
    const name = match[1]
    if (CTX_VERBS.has(name)) continue
    names.add(name)
  }
  return names
}

/** Whether the file receives a plugin `ctx` (an `apply(ctx)` parameter). */
function takesPluginContext(masked) {
  return /\bapply\s*\(\s*ctx\b/.test(masked)
    || /\bfunction\s+apply\s*\(\s*ctx\b/.test(masked)
    || /constructor\s*\(\s*ctx\b/.test(masked)
}

/** Dependency names declared by the package at `root`. */
async function declaredDependencies(root) {
  const names = new Set()
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  } catch {
    return names
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name)
  }
  return names
}

/** Bare module specifiers imported, required, or re-exported by `text`. */
function specifiersOf(text) {
  const specifiers = []
  const patterns = [
    /\bimport\s+(?:[^'"`;]*?\s+from\s+)?(['"`])([^'"`]+)\1/g,
    /\bexport\s+(?:[^'"`;]*?\s+from\s+)(['"`])([^'"`]+)\1/g,
    /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.push(match[2])
  }
  return specifiers
}

/** A relative path, absolute path, or Node builtin — never a bare package import. */
function isRelativeOrBuiltin(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')
    || specifier.startsWith('node:') || specifier.startsWith('#')) return true
  return NODE_BUILTINS.has(specifier)
}

/** Node's builtin module names, so a bare `fs` import is not mistaken for a package. */
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain', 'events', 'fs', 'http',
  'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
  'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib',
])

/** The `@deepseek-ai/*` namespace resolves from the loader closure. */
function scopedAllowed(specifier) {
  return specifier.startsWith('@deepseek-ai/')
}

/** The package part of a specifier: `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`. */
function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** The character offset where a 0-based line starts. */
export function offsetOfLine(text, line) {
  let offset = 0
  for (let index = 0; index < line; index += 1) {
    const next = text.indexOf('\n', offset)
    if (next === -1) return text.length
    offset = next + 1
  }
  return offset
}

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
