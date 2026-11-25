# Caption: myteam 收口（先底层后上层）

- **任务**：继续 dsh-myteam 的收口工作，按「配置 → 数据源 → 功能 → UI」的优先级推进，让 39 页设计稿全部有真实实现、文档与代码一致、门禁全绿。
- **验收判据**：
  1. `node tools/verify.mjs` → `VERIFY_OK`（十道门禁）
  2. `node --test plugin/test/*.test.ts` → 全绿
  3. 工作区无未提交改动（每个批次一个提交）
  4. 设计稿 39 页中，未实现页数为 0 或每页都有明确「不做」的书面理由
  5. 文档里的事实数字与代码一致（由 `check-doc-facts` 守着）
- **门禁**：`node tools/verify.mjs`（含单测、架构、四份生成契约、权限矩阵、文档治理/链接/路径/事实）

## 起始状态（2026-11-25）

- 上一轮「简化」留下 5 个未提交文件（+18 / −15），已过门禁但未提交。
- 已知缺口（来自上一轮盘查，待逐条核实）：
  - `p-archive` 归档回放未做（39 页里唯一没有实现的）
  - `planPropose` 服务端有写方法，客户端无界面入口
  - `commands.ts:700/745` 的 `system:undefined` 缺陷
  - `p-roster-tree` 归档成员位置未验证
  - 实现对齐 §6.1 覆盖表过期
  - 真机（CDP）未覆盖最近三批

## 1. 提交上一轮简化改动，建立干净基线
- Saw: 工作区有 5 个未提交文件（上一轮 simplify 的产物），门禁已绿但没提交；新建的 docs/caption/ 触发文档治理「缺 README.md」。
- Decided: 先补 README 让门禁回绿，再提交，得到一个可回溯的起点。否则后面每批都混着旧改动，红了分不清是谁的。
- Did: 新建 docs/caption/README.md；提交 5 个简化文件 + 台账。
- Evidence: `node tools/verify.mjs` → VERIFY_OK，exit 0（补 README 前是 exit 1，报「docs/caption/ 缺 README.md」）。
- Outcome: done

## 2. 核实 `system:undefined` 缺陷 —— 判断被推翻
- Saw: 上一轮报告里记了一条「缺陷」：`commands.ts:700/745` 的内联 actor 标签对 `system` actor 取 `input.actor.sessionId`，而 `ActorRef` 的 system 分支没有这个字段，会产出 `system:undefined`。
- Decided: 按「先底层」原则，缺陷优先于功能。但先跑探针确认它真能发生 —— 只读代码推断不算证据。
- Did: 写 `.tmp/probe-actor.mjs`（四个 actor 各提一次计划）与 `.tmp/probe-discard2.mjs`（每个 actor 用独立计划各丢一次）。
- Evidence:
  - `node .tmp/probe-actor.mjs` → `human → "human:u1"` / `captain → "captain:ses_c"` / `member → 抛错 FORBIDDEN: 成员不能发起动作 plan.propose` / `system → 抛错 FORBIDDEN: 系统身份不能发起业务动作 plan.propose`，exit 0
  - `node .tmp/probe-discard2.mjs` → `human → "human:u1"` / `captain → "captain:ses_c"` / `member → 抛错 FORBIDDEN: 成员不能发起动作 plan.discard` / `system → 抛错 FORBIDDEN: 系统身份不能发起业务动作 plan.discard`，exit 0
- Outcome: dead end —— **不是缺陷**。`authorize` 在到达那行之前就拒了 member/system，三元链的最后一支不可达。上一轮那条「缺陷」判断是错的，撤销。代码保持原样。
