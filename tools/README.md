# tools/ — 实弹与探针工具

> 这些是**验证用工具**，不是插件运行时的一部分（插件本身零依赖，见 `plugin/package.json`）。

| 文件 | 用途 |
|---|---|
| `boot-myteam.cmd` / `boot-myteam-noopen.cmd` | CLI 实弹 boot：`dsh --profile myteam-dump`（打开/不打开浏览器），输出日志到同目录 |
| `run-headless.cmd` | headless 模式启动（无 GUI，供脚本驱动） |
| `rpc.mjs` / `rpc-diag.mjs` / `rpc-call.ps1` | 网关 RPC 调用器（cookie 鉴权 → POST `/api`，K 系列实弹用） |
| `ki2-drive.mjs` | KI-2 实弹驱动脚本（session/create → prompt → planAction → approve 全链路） |
| `check-drift.mjs` / `diff-one.mjs` | 源码-产物一致性对比 / 单文件差异对比（R38 人工核查用） |
| `extract-asar.mjs` | 宿主 asar 解包器（产出 `refs/host-src/`） |
| `mount.js` | preset 挂载实验脚本（装载链分析用） |
| `probe_register.mjs` | isolate 服务泄漏探针（CHG-32 探针 A） |
| `cdp-debug.mjs` | 无头 Chrome CDP 驱动：`node tools/cdp-debug.mjs <scenario.mjs> <url>`（导航/求值/截图到 `.debug/`，`CDP_SIZE` 切尺寸；场景脚本见 `.debug/scenario-*.mjs`） |
| `seed-demo-project.mjs` / `seed-demo-team.mjs` | 播演示数据：项目级（2 团队/9 任务/参与关系/角色）或单团队（3 队员/5 任务/门禁/证据/tokens） |
| `seed-panel-check.mjs` | 播「面板验收」活团队（panel-check：2 实现者 + 1 评审者；CHG-73 起另含证据过期 t4、已取消 t5 + 上游已取消 t6、批量候选 b1/b2、可删角色 panel-temp-role；panel-draft：草稿态），`--clean` 清理（会把 manifest 里登记的演示角色文件一并删掉） |
| `cordis.patch.probe.yml` | 装载链实验用的 patch 变体（勿与 `plugin/cordis.patch.yml` 混淆） |
| `runtime/package.json` | **实弹运行时的锁定依赖清单**（@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.3）——非插件包；`cd tools/runtime && npm install` 可复现实弹环境 |

> 安全：boot 过程生成的 `.mt-token`、cookie 等凭证每次重新生成，**不得提交**；本目录不放任何密钥。
