# tools — 实弹与探针工具

> 验证用脚本，**不是插件运行时的一部分**（插件本身零依赖，见 `plugin/package.json`）。这里的脚本按「怎么证明它能跑」组织：离线机制层之外，还有 CLI boot、网关 RPC、无头浏览器 CDP、真实宿主安装四条实弹路径。

## 按你想做什么

| 我想… | 用这些 |
|---|---|
| 把插件真的跑起来看一眼 | `boot-myteam.cmd` / `boot-myteam-noopen.cmd` / `run-headless.cmd` |
| 直接调网关 RPC 验证端点 | `rpc.mjs` / `rpc-diag.mjs` / `rpc-call.ps1` |
| 走完整链路（建队 → 派任务 → 审批） | `ki2-drive.mjs` |
| 用浏览器按真实渲染查 UI | `cdp-debug.mjs`（配合 `.debug/scenario-*.mjs`） |
| 造一份能点的演示数据 | `seed-demo-project.mjs` / `seed-demo-team.mjs` / `seed-panel-check.mjs` |
| 核对 src 与 lib 是否一致 | `check-drift.mjs` / `diff-one.mjs` |
| 量提交性能 | `smoke-commit-perf.mjs` |
| 复现实弹环境 | `tools/runtime/package.json` |
| 解包宿主 asar 取源码 | `extract-asar.mjs` |

## 启动与驱动

| 文件 | 用途 |
|---|---|
| `boot-myteam.cmd` / `boot-myteam-noopen.cmd` | CLI 实弹 boot：`dsh --profile myteam-dump`（打开 / 不打开浏览器），日志输出到同目录 |
| `run-headless.cmd` | headless 模式启动（无 GUI，供脚本驱动） |
| `rpc.mjs` / `rpc-diag.mjs` / `rpc-call.ps1` | 网关 RPC 调用器：cookie 鉴权 → `POST /api`（K 系列实弹用）。`rpc-diag` 逐步打印鉴权链，用来定位 cookie 问题 |
| `ki2-drive.mjs` | KI-2 实弹驱动脚本（`session/create` → `prompt` → `planAction` → `approve` 全链路） |

## 面板 UI 调试

| 文件 | 用途 |
|---|---|
| `cdp-debug.mjs` | 无头 Chrome CDP 驱动：`node tools/cdp-debug.mjs <scenario.mjs> <url>`；场景里可导航 / 求值 / 截图到 `.debug/`，`CDP_SIZE` 切尺寸（场景脚本见 `.debug/scenario-*.mjs`） |
| `seed-demo-project.mjs` | 播**项目级**演示数据：2 团队 / 9 任务 / 参与关系 / 角色（含项目自身角色） |
| `seed-demo-team.mjs` | 播**单团队**演示数据：3 队员 / 5 任务 / 门禁 / 证据 / token 计量 |
| `seed-panel-check.mjs` | 播「面板验收」活团队（panel-check：2 实现者 + 1 评审者）。CHG-73 起另含证据过期 `t4`、已取消 `t5` + 上游已取消 `t6`、批量候选 `b1`/`b2`、可删角色 `panel-temp-role`；`panel-draft` 为草稿态。`--clean` 清理（会把 manifest 里登记的演示角色文件一并删掉） |

## 构建与一致性

| 文件 | 用途 |
|---|---|
| `check-drift.mjs` | 源码 ↔ 产物漂移检查（R38、D9 的独立复算面）。直接复用 `plugin/scripts/build-lib.mjs` 的 `compileSource`，编译口径只有一个来源；`sourceURL` 行两边归一化。`MISMATCH: 0` 退 0，否则退 1（可当 CI 门禁） |
| `diff-one.mjs` | 单文件差异对比（人工核查某一份产物用） |
| `gen-error-docs.mjs` | 从 `plugin/src/core/errors.ts` **生成** `docs/04-API与数据契约.md` 的「错误码」一节。`--check` 只校验不写文件（CI / 测试用）。**手改文档会被下次生成覆盖，也会被 `t81` 判红** |
| `smoke-commit-perf.mjs` | 提交性能冒烟（CHG-59）：真实 lib 产物上对比「增量提交」与「全量重放」的耗时，并验证两者投影一致 |

## 取证与探针

| 文件 | 用途 |
|---|---|
| `extract-asar.mjs` | 宿主 asar 解包器（产出 `refs/host-src/`） |
| `mount.js` | preset 挂载实验脚本（装载链分析用） |
| `probe_register.mjs` | isolate 服务泄漏探针（CHG-32 探针 A） |
| `cordis.patch.probe.yml` | 装载链实验用的 patch 变体（**勿与** `plugin/cordis.patch.yml` 混淆） |
| `demo-crud.mjs` | 端到端演示「创建 / 编辑」链路（非插件产物） |
| `runtime/package.json` | **实弹运行时的锁定依赖清单**（`@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.3）—— 不是插件包；`cd tools/runtime && npm install` 可复现实弹环境 |

> [!WARNING]
> boot 过程生成的 `.mt-token`、cookie 等凭证每次重新生成，**不得提交**；本目录不放任何密钥。

---

[← 上级目录](../README.md)
