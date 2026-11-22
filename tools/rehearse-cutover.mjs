/**
 * cutover 演练：在**临时副本**上完整走一遍「分析 → 候选 → 切换 → 首次打开 → 回滚」。
 *
 *   node tools/rehearse-cutover.mjs --root <旧工作区> [--workdir <临时目录>] [--keep]
 *
 * 全程不碰真实工作区：先把 `.dsh-myteam`（与 `.team-workplace`，若存在）复制到
 * 演练目录，再在副本上执行切换与回滚。演练通过只说明流程与数据形状没问题，
 * 不等于真机验收。
 *
 * 退出码：0 = 演练全绿；1 = 任一步失败；2 = 参数错误。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeV1Project, planV1Import } from '../plugin/src/infrastructure/migration/v1/analyze.ts'
import { convertV1Analysis, writeCandidateProject } from '../plugin/src/infrastructure/migration/v1/convert.ts'
import { inspectCandidate, planCutover, sourceMatchesCandidate } from '../plugin/src/infrastructure/migration/v1/cutover.ts'
import { newId } from '../plugin/src/contracts/ids.ts'
import { FileEventStore } from '../plugin/src/infrastructure/event-store/file-store.ts'
import { rebuildProjectState } from '../plugin/src/application/projections/project-state.ts'
import { EVENTS_FILE } from '../plugin/src/contracts/versions.ts'

function parseArgs(argv) {
  let root = process.cwd()
  let workdir = ''
  let keep = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      root = argv[index + 1] ?? ''
      index += 1
    } else if (arg === '--workdir') {
      workdir = argv[index + 1] ?? ''
      index += 1
    } else if (arg === '--keep') {
      keep = true
    } else {
      return { bad: arg }
    }
  }
  return { root: resolve(root), workdir: workdir === '' ? '' : resolve(workdir), keep }
}

const args = parseArgs(process.argv.slice(2))
if (args.bad !== undefined) {
  console.error(`未知参数：${args.bad}`)
  process.exit(2)
}

const report = { steps: [], ok: true }
function step(name, fn) {
  try {
    const detail = fn()
    report.steps.push({ name, ok: true, detail })
    return detail
  } catch (error) {
    report.ok = false
    report.steps.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

const work = args.workdir === '' ? mkdtempSync(join(tmpdir(), 'myteam-rehearsal-')) : args.workdir
const project = join(work, 'project')
const candidateDir = join(work, 'candidate')
const backupDir = join(work, 'backup')

step('准备临时副本', () => {
  mkdirSync(project, { recursive: true })
  cpSync(join(args.root, '.dsh-myteam'), join(project, '.dsh-myteam'), { recursive: true })
  const workplace = join(args.root, '.team-workplace')
  if (existsSync(workplace)) cpSync(workplace, join(project, '.team-workplace'), { recursive: true })
  return project
})

const analysis = step('分析副本', () => analyzeV1Project(project))
if (analysis === null || !analysis.readyToImport) {
  console.error(JSON.stringify({ ...report, verdict: 'blocked' }, null, 2))
  process.exit(1)
}

const plan = step('生成导入顺序', () => planV1Import(analysis))
const conversion = step('转换事件', () =>
  convertV1Analysis({ analysis, plan, now: new Date().toISOString(), ids: newId, resolveRole: () => undefined }),
)
if (conversion === null || !conversion.ok) {
  console.error(JSON.stringify({ ...report, verdict: 'conversion-blocked' }, null, 2))
  process.exit(1)
}

const written = step('写候选项目', () =>
  writeCandidateProject(conversion, {
    candidateRoot: candidateDir,
    projectId: newId('project'),
    projectName: `${basename(args.root)}-rehearsal`,
    now: new Date().toISOString(),
    ids: newId,
    clock: { now: () => new Date().toISOString() },
    sourceHashes: plan.sourceHashes.map((item) => ({ teamId: item.teamId, sourceHash: item.sourceHash })),
  }),
)

const inspection = step('检查候选落盘', () => inspectCandidate(candidateDir))
const cutover = step('生成 cutover 计划', () =>
  planCutover({
    analysis,
    candidate: written,
    candidateInspection: inspection,
    sourceUnchanged: sourceMatchesCandidate(analysis, candidateDir),
  }),
)

step('备份旧数据', () => {
  mkdirSync(backupDir, { recursive: true })
  cpSync(join(project, '.dsh-myteam'), join(backupDir, '.dsh-myteam.bak'), { recursive: true })
  return backupDir
})

step('切换到候选', () => {
  const target = join(project, '.dsh-myteam')
  rmSync(join(target, 'events'), { recursive: true, force: true })
  rmSync(join(target, 'manifest.json'), { force: true })
  cpSync(join(candidateDir, '.dsh-myteam', 'manifest.json'), join(target, 'manifest.json'))
  cpSync(join(candidateDir, '.dsh-myteam', 'events'), join(target, 'events'), { recursive: true })
  if (existsSync(join(candidateDir, '.dsh-myteam', 'migration.json'))) {
    cpSync(join(candidateDir, '.dsh-myteam', 'migration.json'), join(target, 'migration.json'))
  }
  return target
})

step('首次打开验证', () => {
  const manifest = JSON.parse(readFileSync(join(project, '.dsh-myteam', 'manifest.json'), 'utf8'))
  const events = new FileEventStore(join(project, EVENTS_FILE)).readCommitted().events
  const rebuilt = rebuildProjectState(manifest.projectId, events)
  const expected = inspection
  const problems = []
  if (rebuilt.seq !== expected.seq) problems.push(`seq ${rebuilt.seq} ≠ ${expected.seq}`)
  if (rebuilt.teams.size !== expected.teams) problems.push(`teams ${rebuilt.teams.size} ≠ ${expected.teams}`)
  if (rebuilt.members.size !== expected.members) problems.push(`members ${rebuilt.members.size} ≠ ${expected.members}`)
  if (rebuilt.tasks.size !== expected.tasks) problems.push(`tasks ${rebuilt.tasks.size} ≠ ${expected.tasks}`)
  if (rebuilt.knowledge.size !== expected.knowledge) problems.push(`knowledge ${rebuilt.knowledge.size} ≠ ${expected.knowledge}`)
  if (problems.length > 0) throw new Error(problems.join('; '))
  return { seq: rebuilt.seq, teams: rebuilt.teams.size, members: rebuilt.members.size, tasks: rebuilt.tasks.size, knowledge: rebuilt.knowledge.size }
})

step('回滚到旧数据（首次写入前）', () => {
  const target = join(project, '.dsh-myteam')
  rmSync(target, { recursive: true, force: true })
  renameSync(join(backupDir, '.dsh-myteam.bak'), target)
  const manifest = JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 1) throw new Error(`回滚后 manifest 版本为 ${manifest.schemaVersion}`)
  if (existsSync(join(target, 'events'))) throw new Error('回滚后仍残留 v2 events 目录')
  return { schemaVersion: manifest.schemaVersion }
})

if (!args.keep && args.workdir === '') rmSync(work, { recursive: true, force: true })

console.log(
  JSON.stringify(
    {
      verdict: report.ok && cutover?.ready ? 'rehearsal-passed' : 'rehearsal-failed',
      workdir: args.keep || args.workdir !== '' ? work : '(已清理)',
      steps: report.steps,
    },
    null,
    2,
  ),
)
process.exit(report.ok && cutover?.ready ? 0 : 1)