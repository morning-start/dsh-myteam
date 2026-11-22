import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(PLUGIN_DIR, '..', 'tools', 'rehearse-cutover.mjs')

function buildSource(root: string): void {
  const workspace = join(root, '.dsh-myteam')
  mkdirSync(join(workspace, 'state', 'teams', 'default'), { recursive: true })
  writeFileSync(join(workspace, 'manifest.json'), JSON.stringify({ schemaVersion: 1, layoutVersion: 1, projectName: 'demo' }))
  writeFileSync(join(workspace, 'state', 'teams.json'), JSON.stringify({ version: 1, teams: [] }))
  writeFileSync(
    join(workspace, 'state', 'teams', 'default', 'ledger.jsonl'),
    `${JSON.stringify({ seq: 0, ts: 1000, actor: 'host', type: 'rules.version.adopted', payload: { version: 1 } })}\n`,
  )
}

test('cutover 演练：副本上完整走通分析→候选→切换→首次打开→回滚', () => {
  const source = mkdtempSync(join(tmpdir(), 'myteam-rehearse-src-'))
  const work = mkdtempSync(join(tmpdir(), 'myteam-rehearse-work-'))
  try {
    buildSource(source)
    const output = execFileSync(process.execPath, [SCRIPT, '--root', source, '--workdir', work], {
      encoding: 'utf8',
    })
    const parsed = JSON.parse(output) as { verdict: string; steps: { name: string; ok: boolean }[] }
    assert.equal(parsed.verdict, 'rehearsal-passed')
    assert.ok(parsed.steps.length >= 9)
    assert.ok(parsed.steps.every((step) => step.ok), JSON.stringify(parsed.steps.filter((step) => !step.ok)))
    assert.deepEqual(
      parsed.steps.map((step) => step.name),
      [
        '准备临时副本',
        '分析副本',
        '生成导入顺序',
        '转换事件',
        '写候选项目',
        '检查候选落盘',
        '生成 cutover 计划',
        '备份旧数据',
        '切换到候选',
        '首次打开验证',
        '回滚到旧数据（首次写入前）',
      ],
    )
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})