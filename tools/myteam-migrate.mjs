/**
 * myteam v1 → v2 迁移分析 CLI（只读）。
 *
 *   node tools/myteam-migrate.mjs analyze --root <工作区> [--json]
 *   node tools/myteam-migrate.mjs plan    --root <工作区> [--json]
 *
 * analyze 只读旧数据并输出影响面；plan 在 analyze 可导入的前提下给出候选顺序。
 * 两者都**不写**任何文件、不迁移、不启动 Effect。cutover 必须另经用户确认。
 *
 * 退出码：0 = 可继续；1 = 有阻断；2 = 参数错误。
 */
import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { analyzeV1Project, planV1Import } from '../plugin/src/infrastructure/migration/v1/analyze.ts'
import { buildMigrationReport } from '../plugin/src/infrastructure/migration/v1/report.ts'
import { convertV1Analysis, writeCandidateProject } from '../plugin/src/infrastructure/migration/v1/convert.ts'
import { newId } from '../plugin/src/contracts/ids.ts'

function parseArgs(argv) {
  const command = argv[0]
  let root = process.cwd()
  let candidate = ''
  let json = false
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      root = argv[index + 1] ?? ''
      index += 1
    } else if (arg === '--candidate') {
      candidate = argv[index + 1] ?? ''
      index += 1
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--help' || arg === '-h') {
      return { command: 'help', root, candidate, json }
    } else {
      return { command: 'bad', root, candidate, json, unknown: arg }
    }
  }
  return { command, root: resolve(root), candidate: candidate.length === 0 ? '' : resolve(candidate), json }
}

const parsed = parseArgs(process.argv.slice(2))

if (parsed.command === 'help' || parsed.command === 'bad') {
  console.log('用法：node tools/myteam-migrate.mjs analyze|plan --root <工作区> [--json]')
  process.exit(parsed.command === 'help' ? 0 : 2)
}

if (!existsSync(parsed.root)) {
  console.error(`工作区不存在：${parsed.root}`)
  process.exit(2)
}

const analysis = analyzeV1Project(parsed.root)

if (parsed.command === 'analyze') {
  const report = buildMigrationReport(analysis)
  if (parsed.json) {
    console.log(JSON.stringify({ analysis, report: { verdict: report.verdict, headline: report.headline } }, null, 2))
  } else {
    console.log(report.markdown)
  }
  process.exit(report.verdict === 'ready' ? 0 : 1)
}

if (parsed.command === 'plan') {
  if (!analysis.readyToImport) {
    const report = buildMigrationReport(analysis)
    if (parsed.json) {
      console.log(JSON.stringify({ verdict: 'blocked', issues: analysis.issues }, null, 2))
    } else {
      console.log(report.markdown)
    }
    process.exit(1)
  }
  const plan = planV1Import(analysis)
  const report = buildMigrationReport(analysis, plan)
  if (parsed.json) {
    console.log(
      JSON.stringify(
        {
          verdict: 'ready',
          events: plan.events.length,
          syntheticOrder: plan.syntheticOrder,
          sourceHashes: plan.sourceHashes,
        },
        null,
        2,
      ),
    )
  } else {
    console.log(report.markdown)
  }
  process.exit(0)
}

if (parsed.command === 'candidate') {
  if (parsed.candidate.length === 0) {
    console.error('candidate 需要 --candidate <候选目录>')
    process.exit(2)
  }
  if (!analysis.readyToImport) {
    console.error('存在阻断问题，不能生成候选项目：')
    for (const issue of analysis.issues.filter((item) => item.severity === 'blocking')) {
      console.error(`- ${issue.code} ${issue.message}`)
    }
    process.exit(1)
  }

  const plan = planV1Import(analysis)
  const now = new Date().toISOString()
  const conversion = convertV1Analysis({
    analysis,
    plan,
    now,
    ids: newId,
    // 全局角色库尚未接入 v2；遇到成员会明确阻断，而不是伪造角色。
    resolveRole: () => undefined,
  })

  if (!conversion.ok) {
    console.error('转换被阻断：')
    for (const issue of conversion.issues.filter((item) => item.severity === 'blocking')) {
      console.error(`- ${issue.code} ${issue.message}`)
    }
    process.exit(1)
  }

  const result = writeCandidateProject(conversion, {
    candidateRoot: parsed.candidate,
    projectId: newId('project'),
    projectName: `${basename(parsed.root)}-migrated`,
    now,
    ids: newId,
    clock: { now: () => new Date().toISOString() },
  })

  console.log(
    JSON.stringify(
      {
        verdict: result.verification.ok ? 'candidate-ready' : 'verification-failed',
        candidateRoot: result.rootDir,
        projectId: result.projectId,
        written: result.written,
        seq: result.seq,
        records: conversion.records.map((record) => ({ type: record.type, order: record.order })),
        skipped: conversion.skipped,
        verification: result.verification,
      },
      null,
      2,
    ),
  )
  process.exit(result.verification.ok ? 0 : 1)
}

console.error(`未知命令：${parsed.command}`)
process.exit(2)