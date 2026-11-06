/* 任务依赖图渲染器：data-layout="h" 横向 / "v" 竖向
   节点先按真实 DOM 排版测量，再画 SVG 贝塞尔连线 + 箭头。
   依赖边 [上游, 下游]，箭头指向下游（谁解锁谁）。
   主轴 = 依赖层级方向（h: 列，v: 行）；副轴 = 同层并排。
   画布始终撑满容器（宽高取「内容 vs 容器」较大值），节点在画布内居中。 */
(function () {
  const root = document.getElementById('dag');
  if (!root) return;

  const layout = root.getAttribute('data-layout') === 'v' ? 'v' : 'h';
  const box = root.parentElement;
  const availW = Math.max((box && box.clientWidth) || 0, 320);
  const availH = Math.max((box && box.clientHeight) || 0, 320);

  const NODES = [
    { id: 't0',  title: '摸清结算页现状与依赖',        state: 'done',    chip: '完成',  foot: ['需求验证', '4 条证据'] },
    { id: 't1',  title: '梳理结算页现有调用点清单',    state: 'idle',    chip: '待认领', foot: ['需求验证', 'S · 约 1h'] },
    { id: 't2',  title: '确定模块包对外 API 契约',     state: 'blocked', chip: '阻塞',  foot: ['等 t1 完成'] },
    { id: 't7',  title: '抽结算服务边界与接口草案',    state: 'run',     chip: '在跑',  foot: ['实现者', 'sonnet'] },
    { id: 't6',  title: '结算页 UI 迁移到模块包',      state: 'run',     chip: '在跑',  foot: ['实现者 2', 'gpt-5.1'] },
    { id: 't5',  title: '旧调用点替换与灰度开关',      state: 'idle',    chip: '就绪',  foot: ['reviewer', '解锁 t8 / t9'] },
    { id: 't4',  title: '替换调用点并跑通 4 条冒烟',   state: 'gate',    chip: '审查中', foot: ['acceptor', '重派过 2 次'] },
    { id: 't8',  title: '补 12 条结算回归用例',        state: 'idle',    chip: '就绪',  foot: ['需求验证', 'S · 约 2h'] },
    { id: 't3',  title: '移除旧结算组件目录',          state: 'gate',    chip: '验证中', foot: ['需求验证', '等 t4 通过'] },
    { id: 't9',  title: 'CI 增加模块包构建产物校验',   state: 'done',    chip: '完成',  foot: ['reviewer', '3 条证据'] },
    { id: 't11', title: '补 README 与迁移说明',        state: 'done',    chip: '完成',  foot: ['实现者 2', '2 条证据'] },
  ];

  // 依赖边：上游 → 下游
  const EDGES = [
    ['t0', 't1'], ['t0', 't2'], ['t1', 't2'],
    ['t2', 't7'], ['t7', 't6'], ['t6', 't5'],
    ['t5', 't4'], ['t5', 't8'], ['t5', 't9'],
    ['t4', 't3'], ['t4', 't9'], ['t8', 't11'], ['t9', 't11'],
  ];

  const HOT = new Set(['t2', 't7', 't6']); // t7 依赖链（上游 + 下游）
  const GAP_MAIN = 60;   // 层间距
  const GAP_CROSS = 16;  // 同层节点间距
  const PAD = 16;
  const MODEL_RE = /^(sonnet|gpt-)/;

  // 节点宽度：横向固定 176；竖向按容器宽度放宽（单列也占得住场面）
  const W_NODE = layout === 'v'
    ? Math.max(240, Math.min(400, Math.floor(availW * 0.34)))
    : 176;

  // 1) 层级（最长路径深度）
  const depth = {};
  NODES.forEach(n => { depth[n.id] = 0; });
  for (let i = 0; i < NODES.length; i++) {
    for (const [a, b] of EDGES) depth[b] = Math.max(depth[b], depth[a] + 1);
  }
  const groups = {};
  NODES.forEach(n => { (groups[depth[n.id]] = groups[depth[n.id]] || []).push(n.id); });
  const levels = Object.keys(groups).map(Number).sort((a, b) => a - b);

  // 2) 造节点并钉死宽度，再测量
  const els = {};
  for (const n of NODES) {
    const a = document.createElement('a');
    a.className = 'dnode ' + n.state;
    a.href = 'detail.html';
    if (n.id === 't7') a.setAttribute('aria-current', 'true');
    const chipShape = { run: 'run', gate: 'gate', done: 'done', idle: 'idle', blocked: 'idle' }[n.state];
    a.innerHTML =
      '<div class="dnode-top"><span class="tid">' + n.id + '</span>' +
      '<span class="chip ' + n.state + '"><span class="shape ' + chipShape + '"></span>' + n.chip + '</span></div>' +
      '<div class="dnode-title">' + n.title + '</div>' +
      '<div class="dnode-foot">' +
      n.foot.map(f => MODEL_RE.test(f) ? '<span class="tcard-model">' + f + '</span>' : '<span>' + f + '</span>').join('') +
      '</div>';
    a.style.width = W_NODE + 'px';
    root.appendChild(a);
    els[n.id] = a;
  }
  const size = {};
  NODES.forEach(n => {
    const e = els[n.id];
    size[n.id] = { w: e.offsetWidth, h: e.offsetHeight };
  });

  // 3) 每层的主轴 / 副轴尺寸（h：主轴=列宽，副轴=列内高度和；v：对调）
  const bandMain = {}, bandCross = {};
  let crossMax = 0;
  for (const d of levels) {
    const ids = groups[d];
    if (layout === 'h') {
      bandMain[d] = Math.max.apply(null, ids.map(id => size[id].w));
      bandCross[d] = ids.reduce((s, id) => s + size[id].h, 0) + (ids.length - 1) * GAP_CROSS;
    } else {
      bandMain[d] = Math.max.apply(null, ids.map(id => size[id].h));
      bandCross[d] = ids.reduce((s, id) => s + size[id].w, 0) + (ids.length - 1) * GAP_CROSS;
    }
    crossMax = Math.max(crossMax, bandCross[d]);
  }

  // 4) 定位：主轴游标按层主轴尺寸推进，副轴在内容带内居中
  const pos = {};
  let cursor = PAD;
  for (const d of levels) {
    const ids = groups[d];
    let off = PAD + (crossMax - bandCross[d]) / 2;
    for (const id of ids) {
      if (layout === 'h') {
        pos[id] = { x: cursor, y: off, w: size[id].w, h: size[id].h };
        off += size[id].h + GAP_CROSS;
      } else {
        pos[id] = { x: off, y: cursor, w: size[id].w, h: size[id].h };
        off += size[id].w + GAP_CROSS;
      }
    }
    cursor += bandMain[d] + GAP_MAIN;
  }

  // 5) 画布撑满容器：宽高取「内容 vs 容器」较大值，内容在画布里居中
  let contentW, contentH;
  if (layout === 'h') {
    contentW = cursor - GAP_MAIN + PAD;
    contentH = crossMax + PAD * 2;
  } else {
    contentH = cursor - GAP_MAIN + PAD;
    contentW = crossMax + PAD * 2;
  }
  const canvasW = Math.max(contentW, availW);
  const canvasH = Math.max(contentH, availH);
  const extraX = Math.max(0, (canvasW - contentW) / 2);
  const extraY = Math.max(0, (canvasH - contentH) / 2);
  root.style.width = canvasW + 'px';
  root.style.height = canvasH + 'px';

  NODES.forEach(n => {
    const p = pos[n.id], e = els[n.id];
    e.style.left = (p.x + (layout === 'v' ? extraX : 0)) + 'px';
    e.style.top = (p.y + (layout === 'h' ? extraY : 0)) + 'px';
  });

  // 6) 连线：锚点取渲染后的真实矩形，箭头指向下游
  const rr = root.getBoundingClientRect();
  const rectOf = id => {
    const r = els[id].getBoundingClientRect();
    return { x: r.left - rr.left, y: r.top - rr.top, w: r.width, h: r.height };
  };

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'edges');
  svg.setAttribute('width', canvasW);
  svg.setAttribute('height', canvasH);
  svg.innerHTML =
    '<defs>' +
    '<marker id="arw" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">' +
    '<path d="M0 1 L9.2 5 L0 9 z" fill="var(--muted-2)"/></marker>' +
    '<marker id="arw-hot" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="8.5" markerHeight="8.5" orient="auto-start-reverse">' +
    '<path d="M0 1 L9.2 5 L0 9 z" fill="var(--primary)"/></marker>' +
    '</defs>';

  for (const [a, b] of EDGES) {
    const pa = rectOf(a), pb = rectOf(b);
    let d;
    if (layout === 'h') {
      const sx = pa.x + pa.w + 1, sy = pa.y + pa.h / 2;
      const tx = pb.x - 2, ty = pb.y + pb.h / 2;
      const c = Math.max(24, Math.abs(tx - sx) * 0.45);
      d = 'M' + sx + ' ' + sy + ' C' + (sx + c) + ' ' + sy + ' ' + (tx - c) + ' ' + ty + ' ' + tx + ' ' + ty;
    } else {
      const sx = pa.x + pa.w / 2, sy = pa.y + pa.h + 1;
      const tx = pb.x + pb.w / 2, ty = pb.y - 2;
      const c = Math.max(20, Math.abs(ty - sy) * 0.45);
      d = 'M' + sx + ' ' + sy + ' C' + sx + ' ' + (sy + c) + ' ' + tx + ' ' + (ty - c) + ' ' + tx + ' ' + ty;
    }
    const hot = HOT.has(a) && HOT.has(b);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'edge' + (hot ? ' hot' : ''));
    path.setAttribute('marker-end', hot ? 'url(#arw-hot)' : 'url(#arw)');
    svg.appendChild(path);
  }

  root.insertBefore(svg, root.firstChild);
})();
