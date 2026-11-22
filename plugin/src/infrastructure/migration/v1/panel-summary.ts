/**
 * 迁移报告的面板适配层。
 *
 * 为什么要这一层：面板契约里的 `migration` 只承诺 `{verdict, headline, markdown}`，
 * 而迁移模块产出的是 `MigrationReport`（多一份 `sections`）。适配点集中在这里，
 * 面板就不必知道候选导入计划、来源哈希这些内部结构。
 *
 * 只读：分析不改任何文件；`plan` 只在可导入时生成，用于报告里的顺序统计。
 */
import { analyzeV1Project, planV1Import } from './analyze.ts'
import { buildMigrationReport } from './report.ts'

export interface PanelMigrationSummary {
  verdict: 'ready' | 'blocked'
  headline: string
  markdown: string
}

/**
 * 分析一个项目的 v1 旧数据并折叠成面板摘要。
 * @param rootDir - 项目根目录。
 * @returns 面板可直接序列化的摘要。
 */
export function migrationSummaryFor(rootDir: string): PanelMigrationSummary {
  const analysis = analyzeV1Project(rootDir)
  const plan = analysis.readyToImport ? planV1Import(analysis) : null
  const report = buildMigrationReport(analysis, plan)
  return { verdict: report.verdict, headline: report.headline, markdown: report.markdown }
}