/**
 * 面板 HTML 渲染（纯字符串，无 DOM）。
 *
 * 为什么先做字符串渲染：面板最终要跑在 DSH 的 Client 环境里，但**渲染规则**
 * 与宿主无关。把它写成纯函数，就能在 Node 里测试——尤其是转义：任务标题、
 * 团队名、证据摘要都来自模型输出，未转义就是 XSS。
 *
 * 约定：所有来自数据的文本必须经 `escapeHtml`；只有本文件里写死的标签与
 * 类名可以裸拼。
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function chip(text, extraClass = '') {
  return `<span class="mt-chip ${extraClass}">${escapeHtml(text)}</span>`
}

/** 看板：空列显式写「无任务」，不渲染成空白。 */
export function renderBoard(model) {
  const columns = model.columns
    .map((column) => {
      const tasks = column.tasks
        .map(
          (task) => `<article class="mt-card" data-task-id="${escapeHtml(task.id)}">
  <h3 class="mt-card-title">${escapeHtml(task.title)}</h3>
  <p class="mt-card-meta">${escapeHtml(task.team)}</p>
  ${task.blocked ? `<p class="mt-card-blocked">等待：${escapeHtml(task.blockedBy.join('、'))}</p>` : ''}
</article>`,
        )
        .join('')
      return `<section class="mt-column" data-status="${escapeHtml(column.status)}">
  <header class="mt-column-head"><span>${escapeHtml(column.label)}</span><span class="mt-count">${column.count}</span></header>
  ${column.empty ? '<p class="mt-empty">无任务</p>' : ''}${tasks}
</section>`
    })
    .join('')

  return `<div class="mt-board">${columns}</div>`
}

/** 任务详情：裁决与依赖都按原值渲染，缺失显示「未知」。 */
export function renderTask(model) {
  const rows = model.dependencies
    .map(
      (item) =>
        `<li class="mt-dep" data-status="${escapeHtml(item.status ?? 'unknown')}">${escapeHtml(item.title)} · ${escapeHtml(item.statusLabel)}</li>`,
    )
    .join('')

  return `<article class="mt-task" data-task-id="${escapeHtml(model.id)}">
  <h2>${escapeHtml(model.title)} ${chip(model.statusLabel)}</h2>
  <p class="mt-meta">${model.team === null ? '未分配团队' : escapeHtml(model.team.name)}</p>
  ${
    model.verdict === null
      ? '<p class="mt-verdict mt-verdict-none">尚未裁决</p>'
      : `<p class="mt-verdict" data-outcome="${escapeHtml(model.verdict.outcome)}">裁决：${escapeHtml(model.verdict.outcome)}</p>`
  }
  <h3>验收标准</h3>
  <ul>${model.acceptance.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
  <h3>依赖</h3>
  ${rows === '' ? '<p class="mt-empty">无依赖</p>' : `<ul>${rows}</ul>`}
</article>`
}

/** 定义清单：本地已改 / 上游未知 / 已归档 三类状态必须能同时看见。 */
export function renderDefinitions(rows) {
  if (rows.length === 0) return '<p class="mt-empty">项目还没有角色、工作流或蓝图定义</p>'
  const body = rows
    .map(
      (row) => `<tr data-archived="${row.archived}">
  <td>${escapeHtml(row.name)}</td>
  <td>${escapeHtml(row.kind)}</td>
  <td>r${row.revision}</td>
  <td>${row.localChanged ? chip('本地已改', 'mt-chip-warn') : '<span class="mt-muted">与基准一致</span>'}</td>
  <td>${escapeHtml(row.upstreamLabel)}</td>
  <td>${row.archived ? '已归档' : row.published ? '已发布' : '未发布'}</td>
</tr>`,
    )
    .join('')
  return `<table class="mt-table mt-defs"><thead><tr><th>名称</th><th>类型</th><th>版本</th><th>本地</th><th>上游</th><th>状态</th></tr></thead><tbody>${body}</tbody></table>`
}

/** 迁移审查：报告正文按纯文本渲染（不执行 markdown 里的任何标记）。 */
export function renderMigration(model) {
  return `<section class="mt-migration">
  <h2 class="mt-migration-head">迁移审查 <span class="mt-chip ${model.verdict === 'ready' ? '' : 'mt-chip-warn'}">${escapeHtml(model.verdictLabel)}</span></h2>
  <p class="mt-meta">${escapeHtml(model.headline)}</p>
  <pre class="mt-report">${escapeHtml(model.markdown)}</pre>
</section>`
}
export function renderOverview(model) {
  const attention = model.attention
    .map(
      (item) =>
        `<li class="mt-attention${item.active ? ' is-active' : ''}" data-key="${escapeHtml(item.key)}">${escapeHtml(item.label)} ${item.count}</li>`,
    )
    .join('')
  const teams = model.teams
    .map(
      (team) =>
        `<tr><td>${escapeHtml(team.name)}</td><td>${escapeHtml(team.status)}</td><td>${team.members}</td><td>${team.tasks}</td><td>${escapeHtml(team.captain)}</td></tr>`,
    )
    .join('')

  return `<section class="mt-overview">
  <ul class="mt-attention-list">${attention}</ul>
  <table class="mt-teams"><thead><tr><th>团队</th><th>状态</th><th>成员</th><th>任务</th><th>队长</th></tr></thead><tbody>${teams}</tbody></table>
</section>`
}