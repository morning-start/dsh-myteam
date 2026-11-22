/**
 * 真实 cutover 的一键入口（默认只演练）。
 *
 *   node tools/myteam-cutover.mjs --root <工作区>
 *     # 只读演练：分析 → 在临时目录生成候选 → 校验源未变 → 打印切换计划
 *   node tools/myteam-cutover.mjs --root <工作区> --apply --confirm --backup <备份目录>
 *     # 真切换：先备份旧 .dsh-myteam，再用候选替换 manifest/events，最后只读打开校验
 *
 * 安全线：
 *   - 演练不写工作区（候选写在系统临时目录，结束即删）；
 *   - `--apply` 要求 `--confirm` 与 `--backup`；
 *   - 切换前重新分析并校验来源 hash：分析之后源数据有变化就拒绝；
 *   - 切换后只用 v2 打开一次做计数校验（不产生业务事件）；
 *   - 旧数据整目录备份，回滚 = 把备份目录放回去。
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { analyzeV1Project, planV1Import } from '../plugin/src/infrastructure/migration/v1/analyze.ts'
import { convertV1Analysis, writeCandidateProject } from '../plugin/src/infrastructure/migration/v1/convert.ts'
import { inspectCandidate, planCutover, sourceMatchesCandidate } from '../plugin/src/infrastructure/migration/v1/cutover.ts'
import { newId } from '../plugin/src/contracts/ids.ts'
import { ProjectHosts } from '../plugin/src/infrastructure/dsh/project-hosts.ts'
import { EVENTS_FILE, MANIFEST_FILE } from '../plugin/src/contracts/versions.ts'

function parseArgs(argv) {
  const options = { root: process.cwd() }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--apply' || key === '--confirm') {
      options[key.slice(2)] = true
      continue
    }
    if (key.startsWith('--')) {
      options[key.slice(2)] = argv[index + 1]
      index += 1
    }
  }
  return options
}

/** 生成候选并把计划算出来；失败抛错，由调用方决定退出码。 */
function buildPlan(root) {
  const analysis = analyzeV1Project(root)
  if (!analysis.readyToImport) {
    throw new Error(`分析未通过：${analysis.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code).join(', ') || 'unknown'}`)
  }
  const plan = planV1Import(analysis)
  const conversion = convertV1Analysis({
    analysis,
    plan,
    now: new Date().toISOString(),
    ids: newId,
    resolveRole: () => undefined,
  })
  if (!conversion.ok) {
    throw new Error(`转换被阻断：${JSON.stringify(conversion.blockers ?? conversion)}`)
  }

  const workdir = mkdtempSync(join(tmpdir(), 'myteam-cutover-'))
  const candidateDir = join(workdir, 'candidate')
  try {
    const written = writeCandidateProject(conversion, {
      candidateRoot: candidateDir,
      projectId: newId('project'),
      projectName: `${root.split(/[\\/]/).filter(Boolean).pop() ?? 'project'}-cutover`,
      now: new Date().toISOString(),
      ids: newId,
      clock: { now: () => new Date().toISOString() },
      sourceHashes: plan.sourceHashes.map((item) => ({ teamId: item.teamId, sourceHash: item.sourceHash })),
    })
    const inspection = inspectCandidate(candidateDir)
    const cutover = planCutover({
      analysis,
      candidate: written,
      candidateInspection: inspection,
      sourceUnchanged: sourceMatchesCandidate(analysis, candidateDir),
    })
    return { workdir, candidateDir, written, inspection, cutover, analysis }
  } catch (error) {
    rmSync(workdir, { recursive: true, force: true })
    throw error
  }
}

const options = parseArgs(process.argv.slice(2))
const root = resolve(options.root)

let plan
try {
  plan = buildPlan(root)
} catch (error) {
  console.error(`失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const { cutover, inspection } = plan
console.log(
  JSON.stringify(
    {
      ready: cutover.ready,
      candidate: {
        seq: inspection.seq,
        teams: inspection.teams,
        members: inspection.members,
        tasks: inspection.tasks,
        knowledge: inspection.knowledge,
      },
      steps: cutover.steps?.map((step) => step.title ?? step.id ?? step) ?? [],
      blockers: cutover.blockers ?? [],
    },
    null,
    2,
  ),
)

if (!cutover.ready) {
  rmSync(plan.workdir, { recursive: true, force: true })
  console.error('\n计划未就绪，未做任何改动。')
  process.exit(1)
}

if (options.apply !== true) {
  rmSync(plan.workdir, { recursive: true, force: true })
  console.log('\n（演练）未改动工作区。确认无误后加 --apply --confirm --backup <目录>。')
  process.exit(0)
}

if (options.confirm !== true || typeof options.backup !== 'string' || options.backup.length === 0) {
  rmSync(plan.workdir, { recursive: true, force: true })
  console.error('--apply 需要 --confirm 与 --backup')
  process.exit(2)
}

const target = join(root, '.dsh-myteam')
const backup = resolve(options.backup)
const eventsRel = EVENTS_FILE.split('/').slice(1).join('/')
const manifestRel = MANIFEST_FILE.split('/').slice(1).join('/')
if (existsSync(backup) && existsSync(join(backup, '.dsh-myteam.bak'))) {
  rmSync(plan.workdir, { recursive: true, force: true })
  console.error(`备份目录已存在旧备份，拒绝覆盖：${join(backup, '.dsh-myteam.bak')}`)
  process.exit(2)
}

try {
  cpSync(target, join(backup, '.dsh-myteam.bak'), { recursive: true })
  rmSync(join(target, eventsRel.split('/')[0]), { recursive: true, force: true })
  rmSync(join(target, manifestRel), { force: true })
  cpSync(join(plan.candidateDir, '.dsh-myteam', manifestRel), join(target, manifestRel))
  cpSync(join(plan.candidateDir, '.dsh-myteam', eventsRel), join(target, eventsRel), { recursive: true })
  const migrationFile = join(plan.candidateDir, '.dsh-myteam', 'migration.json')
  if (existsSync(migrationFile)) cpSync(migrationFile, join(target, 'migration.json'))

  const hosts = new ProjectHosts()
  const runtime = await hosts.open(root)
  const verified = {
    seq: runtime.state.seq,
    teams: runtime.state.teams.size,
    members: runtime.state.members.size,
    tasks: runtime.state.tasks.size,
    knowledge: runtime.state.knowledge.size,
  }
  await hosts.closeAll()
  console.log(`\n已切换并只读校验：${JSON.stringify(verified)}`)
  console.log(`旧数据备份：${join(backup, '.dsh-myteam.bak')}`)
  console.log('回滚：删除 .dsh-myteam 后把备份目录放回原位。')
} finally {
  rmSync(plan.workdir, { recursive: true, force: true })
}