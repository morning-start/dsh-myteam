/**
 * Cards: the scannable half of an `errors/` entry.
 *
 * An entry is one markdown file: a frontmatter *card* that answers "is this my
 * problem, and is it quick to fix?", then a body that explains the mechanism.
 * The card is deliberately structured rather than prose, so a skill (or a
 * maintainer under time pressure) can decide in seconds whether to keep reading.
 *
 * Node built-ins only: this is read by both the checker and the bundled skill.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The summary fields every card must carry, in the order they should read. */
export const CARD_FIELDS = ['name', 'cause', 'matches', 'location', 'consequence', 'fix']

/** Severity vocabulary: how bad is it, not how likely. */
export const CARD_SEVERITIES = ['fatal', 'broken', 'noisy']

/**
 * Parse the subset of YAML these cards use: `key: value` scalars, and
 * `key:` followed by `  - item` list items. Nothing nested, nothing multiline.
 *
 * A real YAML parser would be more general and also would not be importable
 * here: this package ships no dependencies on purpose.
 *
 * @param {string} text - the file contents.
 * @returns {{data: object, body: string, bodyOffset: number}|undefined}
 */
export function parseCard(text) {
  if (!text.startsWith('---')) return undefined
  const end = text.indexOf('\n---', 3)
  if (end < 0) return undefined
  const front = text.slice(text.indexOf('\n', 3) + 1, end)
  const data = {}
  let list = undefined
  for (const raw of front.split('\n')) {
    if (raw.trim().length === 0) continue
    const item = /^\s+-\s+(.*)$/.exec(raw)
    if (item !== null && list !== undefined) {
      data[list].push(unquote(item[1].trim()))
      continue
    }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw)
    if (pair === null) continue
    const [, key, rest] = pair
    if (rest.trim().length === 0) {
      data[key] = []
      list = key
      continue
    }
    list = undefined
    data[key] = unquote(rest.trim())
  }
  const bodyOffset = end + 4
  return { data, body: text.slice(bodyOffset).replace(/^\n+/, ''), bodyOffset }
}

function unquote(value) {
  const quoted = /^(['"])([\s\S]*)\1$/.exec(value)
  return quoted === null ? value : quoted[2]
}

/**
 * Load every card under `<root>/errors`, sorted by id.
 * `README.md` is the directory's own documentation, not a card.
 *
 * @param {string} root - the project directory.
 * @returns {Promise<{id: string, file: string, data: object, body: string}[]>}
 */
export async function loadCards(root) {
  const directory = join(root, 'errors')
  let names
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const cards = []
  for (const name of names.filter(entry => entry.endsWith('.md') && entry !== 'README.md').sort()) {
    const text = await readFile(join(directory, name), 'utf8')
    const parsed = parseCard(text)
    if (parsed === undefined) {
      cards.push({ id: name.replace(/\.md$/, ''), file: `errors/${name}`, data: undefined, body: '' })
      continue
    }
    cards.push({
      id: typeof parsed.data.id === 'string' && parsed.data.id.length > 0
        ? parsed.data.id
        : name.replace(/\.md$/, ''),
      file: `errors/${name}`,
      data: parsed.data,
      body: parsed.body,
    })
  }
  return cards
}

/**
 * The problems with one card, as short human sentences.
 * @param {{id: string, file: string, data: object|undefined}} card
 * @param {string[]} knownChecks - rule types a card may point at.
 */
export function cardProblems(card, knownChecks) {
  const problems = []
  if (card.data === undefined) {
    problems.push(`${card.file}: no frontmatter card`)
    return problems
  }
  const { data } = card
  const expectedId = card.file.replace(/^errors\//, '').replace(/\.md$/, '')
  if (data.id !== expectedId) problems.push(`${card.file}: id is ${JSON.stringify(data.id)}, expected "${expectedId}"`)
  for (const field of CARD_FIELDS) {
    const value = data[field]
    if (Array.isArray(value)) {
      if (value.length === 0) problems.push(`${card.file}: card field "${field}" is empty`)
      continue
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      problems.push(`${card.file}: card field "${field}" is missing`)
    }
  }
  // `matches` is what makes an entry findable from a real error message, so it
  // has to quote the system, not describe it. The host's messages are English;
  // an entry written in Chinese is a summary, and a summary cannot be searched
  // for. This is also the cheapest guard against filing a *process* here.
  for (const entry of data.matches ?? []) {
    if (/[\u3400-\u9fff\uff00-\uffef]/.test(entry)) {
      problems.push(`${card.file}: matches entry ${JSON.stringify(entry)} reads like a description; quote the message the system actually prints`)
    }
  }
  if (typeof data.severity !== 'string' || !CARD_SEVERITIES.includes(data.severity)) {
    problems.push(`${card.file}: severity ${JSON.stringify(data.severity)} is not one of ${CARD_SEVERITIES.join(' / ')}`)
  }
  if (typeof data.check !== 'string' || data.check.length === 0) {
    problems.push(`${card.file}: no "check" naming the rule type that catches it`)
  } else if (data.check !== 'none' && !knownChecks.includes(data.check)) {
    problems.push(`${card.file}: check "${data.check}" is not a known rule type`)
  }
  if (typeof data.title !== 'string' || data.title.trim().length === 0) {
    problems.push(`${card.file}: no "title"`)
  }
  return problems
}