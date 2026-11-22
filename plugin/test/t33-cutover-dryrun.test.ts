import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(PLUGIN_DIR, '..', 'tools', 'myteam-cutover.mjs')

function buildSource(root) {
  const workspace = join(root, '.dsh-myteam')
  mkdirSync(join(workspace, 'state', 'teams', 'default'), { recursive: true })
  writeFileSync(join(workspace, 'manifest.json'), JSON.stringify({ schemaVersion: 1, layoutVersion: 1, projectName: 'demo' }))
  writeFileSync(join(workspace, 'state', 'teams.json'), JSON.stringify({ version: 1, teams: [] }))
  writeFileSync(
    join(workspace, 'state', 'teams', 'default', 'ledger.jsonl'),
    `${JSON.stringify({ seq: 0, ts: 1000, actor: 'host', type: 'rules.version.adopted', payload: { version: 1 } })}\n`,
  )
  return {
    manifest: readFileSync(join(workspace, 'manifest.json')),
    teams: readFileSync(join(workspace, 'state', 'teams.json')),
    ledger: readFileSync(join(workspace, 'state', 'teams', 'default', 'ledger.jsonl')),
  }
}

test('cutover 演练：给出就绪计划，且一个字节都不改工作区', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-cutover-dry-'))
  try {
    const before = buildSource(source)
    const stdout = execFileSync(process.execPath, [SCRIPT, '--root', source], { encoding: 'utf8' })
    const plan = JSON.parse(stdout.slice(0, stdout.indexOf('\n\n')))

    assert.equal(plan.ready, true, stdout)
    assert.equal(plan.blockers.length, 0)
    assert.ok(plan.steps.length >= 6, JSON.stringify(plan.steps))
    assert.equal(plan.candidate.seq, 1)

    const workspace = join(source, '.dsh-myteam')
    assert.deepEqual(readFileSync(join(workspace, 'manifest.json')), before.manifest, '演练不得改 manifest')
    assert.deepEqual(readFileSync(join(workspace, 'state', 'teams.json')), before.teams, '演练不得改索引')
    assert.deepEqual(
      readFileSync(join(workspace, 'state', 'teams', 'default', 'ledger.jsonl')),
      before.ledger,
      '演练不得改账本',
    )
    assert.ok(!readFileSync(join(workspace, 'manifest.json'), 'utf8').includes('"schemaVersion":2'), '演练不得升级 manifest')
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})