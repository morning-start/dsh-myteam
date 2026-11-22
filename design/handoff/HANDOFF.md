# 交接：design → React + Vite（TypeScript）

> 给写代码的模型看：照这份把设计稿做成真页面。设计稿就是源码——每屏一个 HTML，样式在 tokens.css 等样式表里。先读源文件，截图只用来对照，别凭截图猜数值。

## 做什么

- 设计目录：`E:\Workplace\extension\dsh-myteam\design`（12 屏，web 1280×800）
- 做到：`E:\Workplace\extension\dsh-myteam\design-app`（新建项目：`npm create vite@latest design-app -- --template react-ts`，在 `E:\Workplace\extension\dsh-myteam` 里跑）
- 框架：React + Vite（TypeScript）
- 生成时间：2026-11-14 11:51（UTC+8）

## 屏幕和路由

| 屏 | 设计文件 | 建议路由 | 截图（handoff/shots/） | 跳到 |
| --- | --- | --- | --- | --- |
| 任务 · 看板 | board.html | `/board` | board-1.jpg、board-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、roster、shell.html（没有这一屏）、roles、tasks.html（没有这一屏）、lanes、dag、detail、dragging.html（没有这一屏） |
| 任务详情 · t7 抽结算服务边界与接口草案 | detail.html | `/detail` | detail-1.jpg、detail-2.jpg、detail-3.jpg、detail-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、roles、roster |
| 任务 · 流程视图 | lanes.html | `/lanes` | lanes-1.jpg、lanes-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、roles、tasks.html（没有这一屏）、dag、detail |
| 团队知识库 | knowledge.html | `/knowledge` | knowledge-1.jpg、knowledge-2.jpg、knowledge-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、roster、team-tasks.html（没有这一屏）、audit.html（没有这一屏）、settings |
| 队员 · 聘任记录 | roster.html | `/roster` | roster-1.jpg、roster-2.jpg、roster-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、team-tasks.html（没有这一屏）、knowledge、audit.html（没有这一屏）、settings、member-menu、detail、roles |
| 团队设置 | settings.html | `/settings` | settings-1.jpg、settings-2.jpg、settings-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、roster、team-tasks.html（没有这一屏）、knowledge、audit.html（没有这一屏）、confirm、archive.html（没有这一屏） |
| 解散团队 · 两段确认 | confirm.html | `/confirm` | confirm-1.jpg、confirm-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、roster、team-tasks.html（没有这一屏）、knowledge、audit.html（没有这一屏）、settings、archive.html（没有这一屏） |
| 全部团队 | overview.html | `/overview` | overview-1.jpg、overview-2.jpg、overview-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、new-team-1.html（没有这一屏）、roles、presets.html（没有这一屏）、archive.html（没有这一屏） |
| 项目 · 角色 | roles.html | `/roles` | roles-1.jpg、roles-2.jpg、roles-3.jpg、roles-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、tasks.html（没有这一屏）、role-detail.html（没有这一屏） |
| 任务 · 依赖图（横向） | dag.html | `/dag` | dag-1.jpg、dag-2.jpg、dag-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、roster、shell.html（没有这一屏）、roles、board、tasks.html（没有这一屏）、lanes、dag-vertical.html（没有这一屏）、detail |
| 创建团队 · 组建名册 | new-team.html | `/new-team` | new-team-1.jpg、new-team-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、roster、team-tasks.html（没有这一屏）、knowledge、audit.html（没有这一屏）、settings、new-team-1.html（没有这一屏） |
| 队员 · 管理菜单 | member-menu.html | `/member-menu` | member-menu-1.jpg、member-menu-2.jpg、member-menu-mobile.jpg | conversation.html（没有这一屏）、global.html（没有这一屏）、board、shell.html（没有这一屏）、roster、team-tasks.html（没有这一屏）、knowledge、audit.html（没有这一屏）、settings、roles |

## 设计变量

`tokens.css` 里 75 个变量（颜色 0 个：）。

- 把 tokens.css 原样放进项目的全局样式（如 `src/styles/tokens.css`）并在入口引入；组件样式里一律用 `var(--…)`，别写死色值、字号。
- 别的样式表：`app.css`（公共样式，拆进对应组件或全局样式）

## 几屏共用的部分（做成组件）

- `.dsh-brand`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `DshBrand` 组件
- `.dsh-nav`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `DshNav` 组件
- `.dsh-newchat`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `DshNewchat` 组件
- `.dsh-rail`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `DshRail` 组件
- `.dsh-sec`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `DshSec` 组件
- `.dsh-sess`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `DshSess` 组件
- `.dsh-user`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `DshUser` 组件
- `.dsh-ws`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `DshWs` 组件
- `.icon-btn`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `IconBtn` 组件
- `.main`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `Main` 组件
- `.panel-bar`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `PanelBar` 组件
- `.seg`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `Seg` 组件
- `.win`：12 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、dag、new-team、member-menu）→ `Win` 组件
- `.btn`：11 屏都有（board、detail、lanes、knowledge、roster、settings、confirm、overview、roles、new-team、member-menu）→ `Btn` 组件
- `icons.svg`：43 个图标（<symbol id>）→ 一个 `Icon` 组件按 id 取，或拆成单个 SVG 组件

## 交互和状态

- board.html：1 个输入控件（做成受控组件、加校验和出错状态）
- detail.html：2 个输入控件（做成受控组件、加校验和出错状态）
- knowledge.html：1 个输入控件（做成受控组件、加校验和出错状态）
- settings.html：4 个输入控件（做成受控组件、加校验和出错状态）
- confirm.html：1 个输入控件（做成受控组件、加校验和出错状态）
- roles.html：1 个输入控件（做成受控组件、加校验和出错状态）
- 悬停 / 聚焦 / 按下的样式 44 处：照搬，别丢。
- 有深色样式：项目里也要能切（跟系统，或 `<html data-theme="dark">`）。

## 图片和字体

- 没有单独的图片、字体文件（图形都写在 HTML / SVG 里）。

## 做法和验收

1. 搭骨架：新建项目 `npm create vite@latest design-app -- --template react-ts`，装好依赖和 react-router-dom；把 tokens.css（和公共样式表）搬进去。
2. 一屏一个页面，路由照上面的表；先抽几屏共用的组件，再拼页面。
3. 结构、文案、数字、图标照设计稿的 HTML 搬；class 名可以改成项目的习惯，样式值（间距、字号、颜色、圆角、阴影）一律用设计变量。
4. 每做完一屏：把开发服务器跑起来，调 `compare_design`（screen 填设计文件名，url 填这一屏在开发服务器上的地址），照差异图把不一样的地方改掉，直到差异在 3% 以内，或者剩下的差别说得出理由（比如真实数据、系统字体）。
5. 全部做完：每屏再对一遍；告诉用户做了哪些页面、怎么跑起来（命令和地址）、还有哪里和设计稿不一样。

别做：改设计（配色、文案、布局）、加设计稿里没有的功能、引入新的 UI 组件库（项目已经在用的除外）。
