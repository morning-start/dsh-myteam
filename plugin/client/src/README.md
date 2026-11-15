# client 源码片段（构建产物 = `../client.js`）

13,343 行的客户端按**域**拆成 46 个片段。片段本身不是模块——它们由
`../../scripts/build-client.mjs` 按**文件名排序纯文本拼接**，包进唯一的
`window.__ModuleLoader__.load({ id, factory })` 闭包。

## 为什么是「拼接」而不是 ESM / 打包器

| 约束 | 后果 |
|---|---|
| 宿主 `__ModuleLoader__` 只提供 `react` / `react/jsx-runtime` 这类**裸模块名** | 没有跨文件 `require` 可用 |
| `client.js` 被 `new Function('window','document',source)` 当**脚本**执行 | 不能用 `import` / `export` |
| 131 个测试断言 `source.includes('...')` | 任何转译（压缩 / 重命名）都会让断言失效 |

所以：**片段必须逐字节保留**。`npm run check:client` 校验「片段拼接 === 产物」，
`git diff client.js` 为空就是「重构零行为变化」的形式化证据。

## 改代码的正确姿势

1. 改 `src/*.js`（**不要直接改 `../client.js`**，它是产物，下次构建会被覆盖）
2. `npm run build:client`
3. `npm test`

## 片段清单（顺序即层）

| 文件 | 行数 | 域 |
|---|---:|---|
| `00-header.js` | 27 | Loader 契约 + React 绑定 + `PANEL_KEY` |
| `01-render-boundary.js` | 111 | 渲染错误边界（CHG-155：异常 ≠ 面板消失） |
| `02-theme.js` | 81 | 宿主深色信号 |
| `10-locale-zh.js` | 1046 | zh 词条表（键源） |
| `11-locale-en.js` | 1430 | en 词条表（对照） |
| `20-rpc.js` | 124 | M2 RPC 通道 + 门面 |
| `21-entry-nav.js` | 42 | — |
| `30-badges.js` | 178 | 状态徽标（H4：文字 + 形状） |
| `40-styles.js` | 1328 | 样式（只用 `--dsw-alias-*` token） |
| `45-panel-helpers.js` | 111 | 面板 helpers（项目列 / 图任务 / 打开目标，纯派生） |
| `46-edit-history.js` | 37 | — |
| `47-diag.js` | 112 | — |
| `50-helpers.js` | 32 | 展示小工具（纯派生） |
| `51-roster.js` | 371 | 名册卡 |
| `52-board-card.js` | 102 | 看板卡 |
| `53-lanes.js` | 558 | 泳道 |
| `54-task-detail.js` | 453 | 任务详情 |
| `55-discard.js` | 77 | 丢弃暂存确认 |
| `56-disband.js` | 78 | 解散团队确认 |
| `57-plan-banner.js` | 42 | 暂存横幅三动作（唯一写入口） |
| `58-cost-tab.js` | 242 | 成本 tab |
| `59-knowledge-tab.js` | 147 | 知识 tab |
| `60-presets.js` | 181 | 预设库 |
| `61-skills-mcp.js` | 181 | 技能 & MCP |
| `62-dag.js` | 330 | 依赖图 |
| `63-audit.js` | 159 | 审计回放 |
| `64-settings.js` | 662 | 团队设置 |
| `65-costbar.js` | 39 | 成本栏 |
| `66-role-components.js` | 372 | 角色卡 / 项目角色卡 / 建角色 / 访客调用 / 角色库 |
| `66-role-detail.js` | 257 | 角色详情抽屉 |
| `67-archive-replay.js` | 255 | 归档回放 |
| `67-team-components.js` | 92 | 团队卡 + 全局团队首页 |
| `68-diag.js` | 8 | 诊断 chip + 一键修复 |
| `68-prompt.js` | 36 | 复制指令 + 建队提示词拼装 |
| `69-capability-picker.js` | 61 | 能力选择器（角色 / 任务表单共用） |
| `69-role-form.js` | 145 | 角色表单抽屉 |
| `69-task-form.js` | 277 | 任务表单抽屉 |
| `69-team-create.js` | 270 | 建队向导抽屉（G6） |
| `71-conversation.js` | 222 | — |
| `72-team-overview.js` | 334 | — |
| `73-dock-chip.js` | 86 | — |
| `75-dialogs.js` | 277 | 改派 / 取消确认对话框 |
| `78-batch-bar.js` | 176 | 批量操作条 |
| `79-panel.js` | 2067 | 主工作台 Panel（全局视图 / 团队视图） |
| `90-apply.js` | 124 | 注册（`inject` + `apply` + `ctx.effect`） |
| `99-footer.js` | 3 | 闭包收尾 |

合计 13343 行 / 46 个片段。

合计 13645 行 / 46 个片段。

合计 13647 行 / 46 个片段。

合计 13819 行 / 46 个片段。

## 依赖方向（`tools/check-client-arch.mjs` 守）

```
00 引导 → 10 词条 → 20 RPC → 30 原语 → 40 样式 → 50-69 功能组件 → 70-79 组合 → 90 注册
```

片段**只能引用更早片段**声明的名字。当前有 **11 处 TDZ 倒挂 + 12 处 hoisting 倒挂**
的历史债（`52/53/54` 用了 `63-audit` 的 `fmtClock`、`70-panel` 的 `PROJECT_COLUMNS` 等），
用**棘轮**锁着：只许降不许升。还一批就把 `tools/check-client-arch.mjs` 里的
`BASELINE` 调小。

> 为什么这些倒挂「能跑」：它们都只在组件**渲染时**求值（模块初始化早已完成），
> 所以不会撞 TDZ。但这是靠时序侥幸，不是靠结构保证——所以登记为债。
