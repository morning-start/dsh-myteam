/**
 * 面板视图模型：把 RPC 返回值折成界面直接可用的结构。
 *
 * 这里**不重新计算业务**：不判断任务能不能完成、不合并配置、不推导权限。
 * 只做三件事：排序、分组、把 null 变成「未知」而不是猜一个值。
 *
 * 纯函数、无 DOM、无网络：面板、测试与将来的 CLI 共用同一份转换，
 * 避免「命令行说 blocked、界面显示可认领」。
 */

const STATUS_LABELS = {
  planned: '待规划',
  ready: '可认领',
  claimed: '已认领',
  in_progress: '进行中',
  blocked: '阻塞',
  review: '评审中',
  done: '已完成',
  cancelled: '已取消',
}

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? '未知状态'
}

/** 看板：保留服务端列顺序与计数，只补标签与空列标记。 */
export function toBoardModel(board) {
  const columns = (board.columns ?? []).map((column) => ({
    status: column.status,
    label: statusLabel(column.status),
    count: column.count,
    empty: column.count === 0,
    tasks: (column.tasks ?? []).map((task) => ({
      id: task.id,
      title: task.title,
      team: task.ownerTeamName ?? '未分配团队',
      blockedBy: task.blockedBy ?? [],
      blocked: (task.blockedBy ?? []).length > 0,
      attempt: task.attemptId,
    })),
  }))
  return {
    totals: board.totals ?? { all: 0, done: 0, blocked: 0, review: 0 },
    graphRevision: board.graphRevision ?? null,
    columns,
  }
}

/** 任务详情：裁决、证据、依赖都保留原值；缺的显示为「未知」，不补默认。 */
export function toTaskModel(detail) {
  const task = detail.task
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    statusLabel: statusLabel(task.status),
    acceptance: task.acceptance ?? [],
    team: detail.team === null ? null : { id: detail.team.id, name: detail.team.name },
    attempt: detail.attempt === null ? null : { id: detail.attempt.id, generation: detail.attempt.generation },
    verdict:
      detail.verdict === null
        ? null
        : { outcome: detail.verdict.outcome, checks: detail.verdict.checks ?? [], decidedAt: detail.verdict.decidedAt },
    evidence: detail.evidence ?? [],
    dependencies: (detail.dependencies ?? []).map((item) => ({
      id: item.taskId,
      title: item.title ?? '（已不存在）',
      status: item.status,
      statusLabel: item.status === null ? '未知' : statusLabel(item.status),
    })),
    dependents: detail.dependents ?? [],
  }
}

/** 概览：需要关注项在 0 时显示为「无」，避免出现「0 个但不明显」。 */
export function toOverviewModel(overview) {
  const attention = overview.attention ?? { review: 0, blocked: 0, unknownEffects: 0 }
  return {
    totals: overview.totals ?? { all: 0, done: 0, blocked: 0, review: 0 },
    attention: [
      { key: 'review', label: '待裁决', count: attention.review ?? 0, active: (attention.review ?? 0) > 0 },
      { key: 'blocked', label: '阻塞', count: attention.blocked ?? 0, active: (attention.blocked ?? 0) > 0 },
      {
        key: 'unknownEffects',
        label: '结果未知的 Effect',
        count: attention.unknownEffects ?? 0,
        active: (attention.unknownEffects ?? 0) > 0,
      },
    ],
    teams: (overview.teams ?? []).map((team) => ({
      id: team.id,
      name: team.name,
      status: team.status,
      members: team.members,
      tasks: team.tasks,
      captain: team.captain === null ? '未指派' : `generation ${team.captain.generation}`,
    })),
  }
}

/**
 * 定义清单：三种状态分开显示（本地已改 / 上游已变 / 可发布）。
 *
 * `upstreamChanged === null` 表示「拿不到全局库、无法判断」，显示为「未知」；
 * 这与「没有变化」是两件事，界面不能混。
 */
export function toDefinitionRows(definitions) {
  return (definitions.items ?? []).map((item) => ({
    kind: item.kind,
    id: item.id,
    name: item.name,
    revision: item.revision,
    archived: item.archived,
    localChanged: item.localChanged,
    upstreamChanged: item.upstreamChanged,
    updateAvailable: item.updateAvailable,
    upstreamLabel:
      item.upstreamChanged === null ? '未知（未接入全局库）' : item.upstreamChanged ? '上游已更新' : '与上游一致',
    published: item.published === null ? null : item.published.globalHash,
  }))
}

/** 迁移报告：把 markdown 原样保留，只补结论标签。 */
export function toMigrationModel(report) {
  return {
    verdict: report.verdict,
    verdictLabel: report.verdict === 'ready' ? '可进入候选导入' : '阻断',
    headline: report.headline,
    markdown: report.markdown,
  }
}