/**
 * 迁移影响面报告（只读、可审阅）。
 *
 * 报告面向**做决定的人**，不是日志：先给结论（能不能导入），再给阻断项、
 * 告警项、来源与计数，最后列出「需要你确认什么」。不写文件、不改旧数据。
 *
 * 为什么报告单独成模块：cutover 的确认必须基于同一份可复现的影响面。
 * CLI、面板和测试都渲染同一个结构，避免「命令行说 3 个孤儿、面板说 2 个」。
 */
import type { V1Analysis, V1ImportPlan } from './analyze.ts'

export interface MigrationReportSection {
  title: string
  lines: string[]
}

export interface MigrationReport {
  verdict: 'ready' | 'blocked'
  headline: string
  sections: MigrationReportSection[]
  markdown: string
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString()
}

function table(headers: string[], rows: string[][]): string[] {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`]
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`)
  return lines
}

/**
 * 生成报告。
 *
 * `plan` 可选：给了就附上候选导入顺序的统计；阻断时不应传 plan（调用方已拒绝）。
 */
export function buildMigrationReport(analysis: V1Analysis, plan: V1ImportPlan | null = null): MigrationReport {
  const blocking = analysis.issues.filter((issue) => issue.severity === 'blocking')
  const warnings = analysis.issues.filter((issue) => issue.severity === 'warning')
  const verdict: MigrationReport['verdict'] = analysis.readyToImport ? 'ready' : 'blocked'

  const sections: MigrationReportSection[] = []

  sections.push({
    title: '结论',
    lines: analysis.readyToImport
      ? [
          `旧数据可以进入**候选导入**（不会写旧文件、不启动 Effect）。`,
          warnings.length === 0 ? '没有需要确认的异常。' : `有 ${warnings.length} 项需要你确认（见下）。`,
        ]
      : [`发现 ${blocking.length} 项阻断问题，**不能**进入候选导入。`, '先修复或补充证据后重新分析。'],
  })

  if (blocking.length > 0) {
    sections.push({
      title: '阻断项',
      lines: blocking.map((issue) => `- \`${issue.code}\` ${issue.message}`),
    })
  }

  if (warnings.length > 0) {
    sections.push({
      title: '需要确认',
      lines: warnings.map((issue) => `- \`${issue.code}\` ${issue.message}`),
    })
  }

  sections.push({
    title: '来源',
    lines:
      analysis.sources.length === 0
        ? ['没有发现旧账本。']
        : table(
            ['团队', '来源', '事件数', '首个时间', '末个时间', '来源 hash'],
            analysis.sources.map((source) => {
              const first = source.events[0]
              const last = source.events[source.events.length - 1]
              return [
                source.teamId,
                source.kind,
                String(source.events.length),
                first === undefined ? '-' : formatTime(first.ts),
                last === undefined ? '-' : formatTime(last.ts),
                `\`${source.sourceHash.slice(0, 16)}…\``,
              ]
            }),
          ),
  })

  if (analysis.indexOnly.length > 0) {
    sections.push({
      title: '索引孤儿（只报告，不建团队）',
      lines: table(
        ['团队', '名称', '旧状态', '索引里的任务数'],
        analysis.indexOnly.map((team) => [
          team.teamId,
          team.name.length === 0 ? '(未命名)' : team.name,
          team.state,
          String(team.counts.tasks ?? 0),
        ]),
      ),
    })
  }

  const types = Object.entries(analysis.eventsByType).sort((left, right) => right[1] - left[1])
  if (types.length > 0) {
    sections.push({
      title: '事件类型',
      lines: table(['事件', '条数'], types.map(([type, count]) => [`\`${type}\``, String(count)])),
    })
  }

  if (plan !== null) {
    sections.push({
      title: '候选导入顺序',
      lines: [
        `共 ${plan.events.length} 条事件；${plan.syntheticOrder ? '跨团队顺序是**合成**的（旧账本没有全序），已在 legacy 元数据标记。' : '单团队，顺序沿用旧账本。'}`,
        `来源 hash 已记录 ${plan.sourceHashes.length} 份，cutover 后用于逐项对账。`,
      ],
    })
  }

  sections.push({
    title: '需要你决定',
    lines:
      analysis.issues.length === 0
        ? ['无。确认后即可准备候选导入。']
        : [
            ...(analysis.indexOnly.length > 0
              ? ['- 索引孤儿是否保持「不迁移」：它们没有账本，迁移会变成伪造历史。']
              : []),
            ...(warnings.some((issue) => issue.code === 'DUPLICATE_RULES')
              ? ['- 重复的规则版本事件保留原行、只初始化一次，是否接受。']
              : []),
            ...(blocking.length > 0 ? ['- 阻断项如何处理（补数据 / 放弃该团队）。'] : []),
          ],
  })

  const markdown = [
    '# myteam v1 → v2 迁移分析',
    '',
    `- 工作区：\`${analysis.rootDir}\``,
    `- 旧 manifest：${analysis.manifest === null ? '缺失' : `layoutVersion=${analysis.manifest.layoutVersion}, projectName=${analysis.manifest.projectName}`}`,
    `- 结论：**${analysis.readyToImport ? '可进入候选导入' : '阻断'}**`,
    '',
    ...sections.flatMap((section) => [`## ${section.title}`, '', ...section.lines, '']),
  ].join('\n')

  return {
    verdict,
    headline: analysis.readyToImport
      ? `可导入：${analysis.sources.length} 份账本、${Object.values(analysis.eventsByType).reduce((sum, count) => sum + count, 0)} 条事件`
      : `已阻断：${blocking.length} 项问题`,
    sections,
    markdown,
  }
}