    function TeamCard({ t, team, taskCount, gateCount, onOpen }) {
      const counts = team.counts ?? {}
      const tone = team.state === 'archived' ? 'idle' : team.state === 'draft' ? 'gate' : team.online ? 'run' : 'idle'
      return js('button', {
        className: 'mt-team-card' + (team.online ? '' : ' mt-team-offline'),
        onClick: () => onOpen(team.teamId),
        children: [
          js('div', { className: 'mt-team-head mt-tc-head', children: [
            js('span', { className: 'mt-tc-name', children: team.name || team.teamId }),
            js('span', { className: `mt-mini-chip mt-tone-${tone}`, children: [j('span', { className: 'mt-tc-dot', 'aria-hidden': true }), stateLabel(team.state)] }),
            js('span', { className: 'mt-tc-zone', children: [team.online ? j('span', { className: 'mt-tc-dot', 'aria-hidden': true }) : null, team.online ? t('shell.online') : t('shell.offline')] }),
          ] }),
          team.goal ? j('p', { className: 'mt-tc-desc', children: team.goal }) : null,
          js('p', { className: 'mt-tc-meta', children: [
            j('span', { children: t('shell.done').replace('{done}', String(counts.done ?? 0)).replace('{total}', String(counts.tasks ?? 0)) }),
            j('span', { children: t('shell.running').replace('{n}', String(counts.running ?? 0)) }),
            gateCount > 0 ? j('span', { children: t('shell.gatePending').replace('{n}', String(gateCount)) }) : null,
            j('span', { children: t('shell.members').replace('{n}', String((team.members ?? []).length)) }),
          ] }),
        ],
      })
    }

    /* CHG-83：design-v2/p-overview.html 的「全部团队」不再内联在全局页 —— 它把「角色库三层」与
     * 「团队 tab」两处内容又摆了一遍（用户："怎么还有一个这个区域"）。归档团队仍从
     * 「团队」tab 进来（TeamCard 带「已归档」状态 chip，点开就是归档回放）。 */
    /** 项目 · 团队列表（design-v2/p-teams.html：筛选行 + 按工作区分组的团队卡） */
    function TeamsHome({ t, teams, tasks, gateOf, onOpen, workspaceRoot, onCreateTeam }) {
      const [query, setQuery] = react.useState('')
      const needle = String(query ?? '').trim().toLowerCase()
      const list = (teams ?? []).filter((team) => !needle
        || [team.name, team.teamId, team.goal, team.workspaceRoot, workspaceRoot].some((field) => String(field ?? '').toLowerCase().includes(needle)))
      /* 项目聚合按单个 workspaceRoot 查询，团队摘要本身不带 workspaceRoot —— 组头的
       * 工作区名/路径回落当前项目根（跨工作区多组时才会用到 team 上的字段）。 */
      const groups = new Map()
      for (const team of list) {
        const key = team.workspaceRoot || workspaceRoot || '—'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(team)
      }
      const groupList = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      return js('div', { className: 'mt-home', children: [
        js('div', { className: 'mt-home-filter', children: [
          js('label', { className: 'mt-search-field', children: [
            j('span', { className: 'mt-search-ico', 'aria-hidden': true, children: j('svg', {
              width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
              children: j('path', { d: 'M10.6 10.6 14 14M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
            }) }),
            j('input', {
              type: 'search',
              value: query,
              placeholder: t('shell.filter'),
              'aria-label': t('shell.filter'),
              onChange: (event) => setQuery(event?.target?.value ?? ''),
            }),
          ] }),
          j('p', { className: 'mt-home-hint', children: t('shell.hint') }),
          /* CHG-84 收口：CHG-83 撤掉全局页的「全部团队」后，面板里就没有建团入口了
           * （预设卡上的「用这个建团队」只在项目层有预设时出现）。按 design-v2/p-teams.html
           * 工作区头的「新建」补回一颗，落在「项目 → 团队」tab。 */
          onCreateTeam ? j('button', { className: 'mt-btn mt-btn-primary', onClick: onCreateTeam, children: t('shell.newTeam') }) : null,
        ] }),
        list.length === 0
          ? j('div', { className: 'mt-empty-inline mt-hint', children: (teams ?? []).length === 0 ? t('shell.empty') : t('shell.noMatch') })
          : groupList.map(([root, group]) => js('section', { className: 'mt-home-group', key: root, children: [
            js('div', { className: 'mt-home-group-head', children: [
              j('b', { children: projectLabel(root) }),
              j('span', { className: 'mt-group-n', children: t('shell.groupCount').replace('{n}', String(group.length)) }),
              j('span', { className: 'mt-group-path', title: root, children: prettyPath(root) }),
            ] }),
            ...group.map((team) => j(TeamCard, {
              key: team.teamId,
              t,
              team,
              taskCount: (tasks ?? []).filter((task) => (task.participants ?? []).some((p) => p.teamId === team.teamId)).length,
              gateCount: gateOf ? gateOf(team.teamId) : 0,
              onOpen,
            })),
          ] })),
      ] })
    }


    /** 归档回放（design-v2/p-archive.html：归档条 + 结局卡 + 进度分段 + 名册 + 五项分解 + 任务历史 + 账本） */
    /**
     * 归档回放（design-v2/p-archive.html）。
     *
     * CHG-86 / P0-2：**优先用 `getArchive` 返回的真实快照**（`archive/<teamId>/team.json`、
     * `tokens.json`、`members/*.json`、`artifacts/` 的落盘内容），拿不到时（离线团队 /
     * 端点缺失 / 团队未归档）降级到 board + tokens + audit 派生——两条路径都走同一套渲染，
     * 但路径文案必须是真的：`archive.endPath` 显示 `archiveRoot/teamId`，不显示拼出来的假路径。
     */