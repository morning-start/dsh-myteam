    /* ── 依赖图（CHG-69/CHG-82：真实 DOM 测量 + SVG 贝塞尔连线 + 横向/竖向两种布局）──
     * 口径对齐 design-v2/p-dag.html：先把节点宽度钉死再测量（横向 176 定宽；竖向按容器 ~34%、240–400），
     * 依赖层级 = 主轴（h: 列 / v: 行），同层多节点在副轴居中，层间距 60；
     * 画布宽高取 max(内容, 容器)，节点在画布里居中；箭头永远从上游指到下游。
     * tasks 需要已把 deps 映射成图内 id（项目级用 ownerTeamId/taskId 复合键）。 */
    const DAG_GAP_MAIN = 60
    const DAG_GAP_CROSS = 16
    const DAG_PAD = 16
    const DAG_FALLBACK_H = 78
    const DAG_NODE_W_H = 176
    /** CHG-155：同一布局签名下最多重排几次（防「测量 → setState → 再测量」自激成 #185） */
    const DAG_MAX_LAYOUT_PASSES = 8
    const DAG_MODEL_RE = /^(sonnet|gpt-|claude|opus|qwen|gemini|deepseek|llama|mistral|glm)/i
    /** 任务状态 → 节点色带（H4：文字 + 形状为主，色带只作第三顺位） */
    /** 状态机允许的拖拽落点（design-v2/p-drag.html：门禁未过的卡进不了已完成） */
    const DRAG_LEGAL_TARGETS = {
      '待规划': ['就绪'],
      '就绪': ['进行中'],
      '进行中': ['门禁'],
      '门禁': ['已完成'],
      '已完成': [],
      '未完成': [],
    }

    function DagView({ t, tasks, onOpen, memberName, teamName, dir = 'h' }) {
      const [focus, setFocus] = react.useState(null)
      // 真实矩形：横向钉死 176 宽；高度靠 useLayoutEffect 量回来（mock 下量不到 → 固定 78）
      const [heights, setHeights] = react.useState({})
      const [avail, setAvail] = react.useState({ w: 320, h: 320 })
      const wrapRef = (react.useRef ?? ((init) => ({ current: init })))(null)
      const nodeRefs = (react.useRef ?? ((init) => ({ current: init })))(new Map())
      const useLayoutEffect = react.useLayoutEffect ?? react.useEffect ?? (() => {})
      const ready = Boolean(tasks && tasks.length > 0)
      /**
       * CHG-155（P1）：**测量-重排不能自激**（React #185 的根因）。
       *
       * 依赖图要「先量容器、再算坐标」：`clientWidth/Height` → 画布尺寸 → 可能反过来改容器尺寸
       * （滚动条出现/消失、换行数变化）。旧实现的 effect 依赖里同时有 `heights` 和 `avail`，
       * 等于**把自己的输出当输入** → 测量 → setState → 再测量 → 同步更新环 → React 抛
       * #185（Maximum update depth exceeded）→ 整块面板卸载（深色主题下就是黑屏）。
       *
       * 三条锁（缺一不可）：
       *  ① 依赖只留 `[tasks, dir, ready]`——不再把自己的输出当输入；
       *  ② 值没变就**不 setState**（对比本次渲染的 `avail` / `heights`）→ React 不用重排；
       *  ③ **同一布局签名最多重排 `DAG_MAX_LAYOUT_PASSES` 次**（熔断）——即使测量真的抖，
       *     也只抖有限次；一旦稳定立刻把计数清零，后续尺寸变化还能再测。
       */
      const layoutSigRef = (react.useRef ?? ((init) => ({ current: init })))('')
      const layoutPassRef = (react.useRef ?? ((init) => ({ current: init })))(0)
      useLayoutEffect(() => {
        if (!ready) return
        /* 布局签名（方向 + 任务集合）：换了布局才重新给熔断计数清零 */
        const sig = `${dir}|${tasks.length}|${tasks.map((task) => String(task.id)).join(',')}`
        if (sig !== layoutSigRef.current) {
          layoutSigRef.current = sig
          layoutPassRef.current = 0
        }
        const wrap = wrapRef.current
        const w = Math.max((wrap && wrap.clientWidth) || 0, 320)
        const h = Math.max((wrap && wrap.clientHeight) || 0, 320)
        const next = {}
        for (const task of tasks) {
          const el = nodeRefs.current?.get?.(task.id)
          const measured = el ? el.offsetHeight : 0
          if (measured > 0) next[task.id] = measured
        }
        const sizeChanged = w !== avail.w || h !== avail.h
        const nextKeys = Object.keys(next)
        const heightsChanged = nextKeys.length !== Object.keys(heights).length || nextKeys.some((key) => heights[key] !== next[key])
        if (!sizeChanged && !heightsChanged) {
          /* ②③：已经稳定 —— 不 setState，并把熔断计数归零（尺寸再变化时还能测） */
          layoutPassRef.current = 0
          return
        }
        if (layoutPassRef.current >= DAG_MAX_LAYOUT_PASSES) return
        layoutPassRef.current += 1
        if (sizeChanged) setAvail({ w, h })
        if (heightsChanged) setHeights(next)
      }, [tasks, dir, ready])
      if (!ready) return j('div', { className: 'mt-empty', children: t('dag.empty') })
      const byId = new Map(tasks.map((task) => [task.id, task]))
      // 层级 = 最长路径（与后端 core/tasks/graph.ts 同算法；环按 0 截断）
      const memo = new Map()
      const depthOf = (id, stack) => {
        if (memo.has(id)) return memo.get(id)
        const seen = stack ?? new Set()
        if (seen.has(id)) return 0
        seen.add(id)
        const deps = (byId.get(id)?.deps ?? []).filter((dep) => byId.has(dep))
        const depth = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, seen)))
        seen.delete(id)
        memo.set(id, depth)
        return depth
      }
      const layers = new Map()
      for (const task of tasks) {
        const depth = depthOf(task.id)
        if (!layers.has(depth)) layers.set(depth, [])
        layers.get(depth).push(task)
      }
      const depths = [...layers.keys()].sort((a, b) => a - b)
      const chain = new Set()
      if (focus && byId.has(focus)) {
        const walkUp = (id) => {
          for (const dep of byId.get(id)?.deps ?? []) {
            if (byId.has(dep) && !chain.has(dep)) { chain.add(dep); walkUp(dep) }
          }
        }
        walkUp(focus)
        let changed = true
        while (changed) {
          changed = false
          for (const task of tasks) {
            if (task.id === focus || chain.has(task.id)) continue
            if ((task.deps ?? []).some((dep) => dep === focus || chain.has(dep))) { chain.add(task.id); changed = true }
          }
        }
      }
      // 1) 主轴尺寸：横向钉死 176 宽；竖向按容器 ~34% 宽（240–400），单列不再挤在中间一条
      const nodeW = dir === 'v'
        ? Math.max(240, Math.min(400, Math.floor(avail.w * 0.34)))
        : DAG_NODE_W_H
      const heightOf = (id) => heights[id] ?? DAG_FALLBACK_H
      /* 同层节点超出容器宽度时折行。
       * CHG-85：横向模式原来同层节点全部纵向堆叠 —— 9 个无依赖任务拉成一列 900px 高，
       * 底部被面板裁掉、右侧还空一大片。现在横向也把层摊开：同层节点分成若干「列组」，
       * 组内横向并排、组间纵向堆叠（边仍指向节点真实坐标，语义不变）。 */
      const perRowV = Math.max(1, Math.floor((Math.max(avail.w, 320) - DAG_PAD * 2 + DAG_GAP_CROSS) / (nodeW + DAG_GAP_CROSS)))
      /* 横向：层内每行放几个（按可用宽度算，最多 3 —— 再多每张卡就太窄了） */
      const perRowH = dir === 'h'
        ? Math.max(1, Math.min(3, Math.floor((Math.max(avail.w, 640) - DAG_PAD * 2 + DAG_GAP_CROSS) / (nodeW + DAG_GAP_CROSS))))
        : 1
      const layerRows = new Map()
      for (const depth of depths) {
        const layer = layers.get(depth)
        const rowsOfLayer = []
        const per = dir === 'v' ? perRowV : perRowH
        for (let i = 0; i < layer.length; i += per) rowsOfLayer.push(layer.slice(i, i + per))
        layerRows.set(depth, rowsOfLayer)
      }
      // 2) 每层的主轴 / 副轴尺寸（h：主轴 = 层宽（列组数 × 节点宽），副轴 = 层内高度和；v：对调）
      const bandMain = new Map()
      const bandCross = new Map()
      let crossMax = 0
      for (const depth of depths) {
        const rowsOfLayer = layerRows.get(depth)
        if (dir === 'h') {
          /* 横向：层宽 = 最宽的一组有几个节点（每组横向占一格） */
          bandMain.set(depth, Math.max(...rowsOfLayer.map((row) => row.length)) * (nodeW + DAG_GAP_CROSS))
          bandCross.set(depth, rowsOfLayer.reduce((sum, row) => sum + Math.max(...row.map((task) => heightOf(task.id))), 0)
            + (rowsOfLayer.length - 1) * DAG_GAP_CROSS)
        } else {
          bandMain.set(depth, rowsOfLayer.reduce((sum, row) => sum + Math.max(...row.map((task) => heightOf(task.id))), 0) + (rowsOfLayer.length - 1) * DAG_GAP_CROSS)
          bandCross.set(depth, Math.max(...rowsOfLayer.map((row) => row.length * nodeW + (row.length - 1) * DAG_GAP_CROSS)))
        }
        crossMax = Math.max(crossMax, bandCross.get(depth))
      }
      // 3) 定位：主轴游标按层主轴尺寸推进，副轴在内容带内居中（每组各自居中）
      const pos = new Map()
      let cursor = DAG_PAD
      for (const depth of depths) {
        const rowsOfLayer = layerRows.get(depth)
        if (dir === 'h') {
          /* CHG-85：层内横向并排 —— 一层的节点占若干个 x 槽位，组内并排、组间纵向 */
          const layerW = bandMain.get(depth)
          const widest = Math.max(...rowsOfLayer.map((row) => row.length * (nodeW + DAG_GAP_CROSS) - DAG_GAP_CROSS))
          let groupY = DAG_PAD + (crossMax - bandCross.get(depth)) / 2
          for (const row of rowsOfLayer) {
            const rowH = Math.max(...row.map((task) => heightOf(task.id)))
            const rowW = row.length * (nodeW + DAG_GAP_CROSS) - DAG_GAP_CROSS
            let x = cursor + (layerW - rowW) / 2
            for (const task of row) {
              pos.set(task.id, { x, y: groupY, w: nodeW, h: heightOf(task.id) })
              x += nodeW + DAG_GAP_CROSS
            }
            groupY += rowH + DAG_GAP_CROSS
          }
        } else {
          let rowY = cursor
          for (const row of rowsOfLayer) {
            const rowW = row.length * nodeW + (row.length - 1) * DAG_GAP_CROSS
            let x = DAG_PAD + (crossMax - rowW) / 2
            const rowH = Math.max(...row.map((task) => heightOf(task.id)))
            for (const task of row) {
              pos.set(task.id, { x, y: rowY, w: nodeW, h: heightOf(task.id) })
              x += nodeW + DAG_GAP_CROSS
            }
            rowY += rowH + DAG_GAP_CROSS
          }
        }
        cursor += bandMain.get(depth) + DAG_GAP_MAIN
      }
      // 4) 画布撑满容器：宽高取「内容 vs 容器」较大值，内容在画布里居中（design 宽度修正）
      const contentW = dir === 'h' ? cursor - DAG_GAP_MAIN + DAG_PAD : crossMax + DAG_PAD * 2
      const contentH = dir === 'h' ? crossMax + DAG_PAD * 2 : cursor - DAG_GAP_MAIN + DAG_PAD
      const canvasW = Math.max(contentW, avail.w)
      const canvasH = Math.max(contentH, avail.h)
      const extraX = Math.max(0, (canvasW - contentW) / 2)
      const extraY = Math.max(0, (canvasH - contentH) / 2)
      // 5) 在跑的依赖链 = 运行节点 + 全部上游 + 全部下游（design-v2/p-dag.html 的 HOT 口径）
      const hot = new Set()
      for (const task of tasks) {
        if (dagChipOf(task.state) !== 'run') continue
        hot.add(task.id)
        const walkUp = (id) => {
          for (const dep of byId.get(id)?.deps ?? []) {
            if (byId.has(dep) && !hot.has(dep)) { hot.add(dep); walkUp(dep) }
          }
        }
        walkUp(task.id)
      }
      let hotChanged = true
      while (hotChanged) {
        hotChanged = false
        for (const task of tasks) {
          if (hot.has(task.id)) continue
          if ((task.deps ?? []).some((dep) => hot.has(dep))) { hot.add(task.id); hotChanged = true }
        }
      }
      const edges = []
      /* CHG-178（U2）：**边与卡必须用同一套坐标系**。
       * 卡片是 `left: pos.x + extraX`（竖向）/ `top: pos.y + extraY`（横向）——内容在画布里居中
       * 时才有那笔偏移；而边原来直接用裸 `pos.x/pos.y`，于是整条依赖链被画到卡片上方
       * `extraY`（横向，实测差 275px）处，看起来就是「一堆悬空的断线」。
       * 这里补上同款偏移，边才真正连到卡片的左右/上下边缘。 */
      const edgeDx = dir === 'v' ? extraX : 0
      const edgeDy = dir === 'h' ? extraY : 0
      for (const task of tasks) {
        for (const dep of task.deps ?? []) {
          if (!byId.has(dep)) continue
          const a = pos.get(dep)
          const b = pos.get(task.id)
          if (!a || !b) continue
          const ax = a.x + edgeDx
          const ay = a.y + edgeDy
          const bx = b.x + edgeDx
          const by = b.y + edgeDy
          let d
          if (dir === 'h') {
            const sx = ax + a.w + 1
            const sy = ay + a.h / 2
            const tx = bx - 2
            const ty = by + b.h / 2
            const c = Math.max(24, Math.abs(tx - sx) * 0.45)
            d = `M${sx} ${sy} C${sx + c} ${sy} ${tx - c} ${ty} ${tx} ${ty}`
          } else {
            const sx = ax + a.w / 2
            const sy = ay + a.h + 1
            const tx = bx + b.w / 2
            const ty = by - 2
            const c = Math.max(20, Math.abs(ty - sy) * 0.45)
            d = `M${sx} ${sy} C${sx} ${sy + c} ${tx} ${ty - c} ${tx} ${ty}`
          }
          const isHot = hot.has(dep) && hot.has(task.id)
          const dim = Boolean(focus) && !(dep === focus || task.id === focus || (chain.has(dep) && chain.has(task.id)))
          edges.push(j('path', {
            key: `${dep}->${task.id}`,
            d,
            className: 'mt-dag-edge' + (isHot ? ' mt-dag-edge-hot' : '') + (dim ? ' mt-dag-edge-dim' : ''),
            markerEnd: isHot ? 'url(#mt-arrow-hot)' : 'url(#mt-arrow)',
            'data-from': dep,
            'data-to': task.id,
          }))
        }
      }
      const nodeClass = (id) => {
        const focused = focus === id
        const related = !focus || focused || chain.has(id) || hot.has(id)
        return 'mt-dag-card mt-dag-card-' + dagChipOf(byId.get(id)?.state)
          + (focused ? ' mt-dag-node-focus' : '')
          + (hot.has(id) && !focused ? ' mt-dag-node-chain' : '')
          + (related ? '' : ' mt-dag-node-dim')
      }
      return js('div', {
        className: 'mt-dagwrap',
        ref: (el) => { wrapRef.current = el },
        children: [
          js('div', { className: 'mt-dag-canvas', style: { width: `${canvasW}px`, height: `${canvasH}px` }, children: [
            j('svg', {
              className: 'mt-dag-svg',
              width: canvasW,
              height: canvasH,
              viewBox: `0 0 ${canvasW} ${canvasH}`,
              role: 'img',
              'aria-label': t('dag.graphLabel'),
              children: [
                j('defs', { children: [
                  j('marker', { id: 'mt-arrow', viewBox: '0 0 10 10', refX: 8.6, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse', children: j('path', { d: 'M0 1 L9.2 5 L0 9 z', className: 'mt-dag-arrow' }) }),
                  j('marker', { id: 'mt-arrow-hot', viewBox: '0 0 10 10', refX: 8.6, refY: 5, markerWidth: 8.5, markerHeight: 8.5, orient: 'auto-start-reverse', children: j('path', { d: 'M0 1 L9.2 5 L0 9 z', className: 'mt-dag-arrow-hot' }) }),
                ] }),
                ...edges,
              ],
            }),
            ...tasks.map((task) => {
              const p = pos.get(task.id)
              const chip = dagChipOf(task.state)
              const names = (task.assignees ?? []).slice(0, 2).map((id) => memberName?.(id) ?? id)
              return js('button', {
                key: task.id,
                ref: (el) => { if (el) nodeRefs.current.set(task.id, el); else nodeRefs.current.delete(task.id) },
                className: nodeClass(task.id),
                style: { left: `${p.x + (dir === 'v' ? extraX : 0)}px`, top: `${p.y + (dir === 'h' ? extraY : 0)}px`, width: `${p.w}px` },
                'aria-current': focus === task.id ? 'true' : undefined,
                title: t('dag.hint'),
                onClick: () => setFocus(focus === task.id ? null : task.id),
                onDoubleClick: () => onOpen(task.id),
                children: [
                  js('div', { className: 'mt-dag-card-top', children: [
                    j('span', { className: 'mt-dag-code', children: task.code ?? task.id }),
                    js('span', { className: `mt-dag-chip mt-dag-chip-${chip}`, children: [
                      j('span', { className: 'mt-task-dot ' + stateDotClass(task.state), 'aria-hidden': true }),
                      j('span', { children: stateLabel(task.state) }),
                    ] }),
                  ] }),
                  j('div', { className: 'mt-dag-card-title', children: task.title }),
                  js('div', { className: 'mt-dag-card-meta', children: [
                    names.length > 0 ? j('span', { children: names.join('、') }) : null,
                    (task.participants ?? []).length > 1 ? j('span', { children: t('dag.teams').replace('{n}', String((task.participants ?? []).length)) }) : null,
                    task.evidenceCount > 0 ? j('span', { children: t('dag.evidence').replace('{n}', String(task.evidenceCount)) }) : null,
                    task.model ? j('span', { className: 'mt-task-model', title: task.model, children: task.model }) : null,
                  ] }),
                ],
              })
            }),
          ] }),
        ],
      })
    }

