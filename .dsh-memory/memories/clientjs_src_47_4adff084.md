---
id: "clientjs_src_47_4adff084"
title: "客户端 client.js 是构建产物，源码是 src/ 的 47 个片段"
kind: "convention"
about: "修改 DSH 插件客户端（plugin/client/）代码时必须知道的构建协议与依赖方向约束"
confidence: "inferred"
provenance: "measured"
authority: "observed"
status: "active"
actionRisk: "R2"
createdAt: "2026-11-15T03:26:36Z"
modifiedAt: "2026-11-15T03:26:36Z"
lastVerifiedAt: "2026-11-15T03:26:36Z"
reviewBy: null
expiresAt: null
pinned: null
scope: ["repo:acme/myteam"]
triggers: ["client.js", "客户端构建", "build:client", "check:client", "片段", "client/src", "依赖方向"]
supersedes: ["single_file_anchor_append_protocol"]
evidence:
  - kind: "file"
    ref: "plugin/client/src/README.md"
    hash: "44b8856e7d01c62e55c5b8b2631971bdcbd41851dfaece21c9674b7d5880796c"
    excerpt: "47 个片段 / 13,645 行；纯文本拼接"
  - kind: "file"
    ref: "plugin/scripts/build-client.mjs"
    hash: "570dd80418c2413d6a72a00d4855a8717826eee965b4b420b2aa8b7379000482"
    excerpt: "拼接器：按文件名排序 + 一致性校验"
  - kind: "file"
    ref: "tools/check-client-arch.mjs"
    hash: "74078d1bc3018b320754a70bd8be8061dea204d73c722969c993eaa3843864e7"
    excerpt: "依赖方向门禁（词法扫描 + 棘轮基线 0/0）"
  - kind: "doc"
    ref: "plugin/README.md"
    hash: "fe933162cffaf94bafea8c32758cf6b8e285a73f5c63f03e0dc0f3fcffc42201"
    excerpt: "客户端构建纪律：为什么不用 ESM、两条纪律"
  - kind: "doc"
    ref: "docs/22-架构梳理.md"
    hash: "1f3813230fb0e6f9cdf5678af5996229c4f18bba9ad180833d27a0bdc0a2e66f"
    excerpt: "新增 §6 客户端架构（三层约束表 + 片段分层清单）"
relations: []
claims: []
---

## 功能名
客户端片段构建协议（`plugin/client/`）

## 生效条件
要修改 DSH 插件的浏览器端代码（`plugin/client/client.js` 及其 `src/` 片段）时。

## 子功能
- 产物与源码的分工
- 构建 / 校验命令
- 片段依赖方向约束

## 执行

**`client/client.js` 是构建产物，不是源码。** 源码是 `client/src/*.js` 的 **47 个片段**（按域切：`00 引导 → 10 词条 → 20 RPC → 30 原语 → 40 样式 → 50-69 功能组件 → 70-79 组合 → 90 注册`）。

```bash
cd plugin
npm run build:client     # 片段 → client/client.js
npm run check:client     # 校验产物与片段一致（CI 用，退出码 0 = 一致）
npm run bundle           # build:client + build:lib（打包前必须跑）
node ../tools/check-client-arch.mjs   # 依赖方向门禁（棘轮基线 0/0）
```

**为什么是纯文本拼接而不是 ESM / 打包器**：宿主 `__ModuleLoader__` 只提供 `react` 这类**裸模块名**（没有跨文件 `require`）；`client.js` 被 `new Function('window','document',source)` 当**脚本**执行（不能用 `import`/`export`）；131 个测试断言 `source.includes('...')`（任何转译都会让断言失效）。

**依赖方向**：片段被拼进**同一个闭包**，编译器不拦「底层引用高层」，靠 `check-client-arch.mjs` 守——**片段只能引用更早片段声明的名字**。首轮抓出 23 处历史倒挂（11 TDZ + 12 hoisting），CHG-202j~q 已全部还清，**棘轮基线锁 0/0**。

## 验证方式
- `npm run check:client` 退出码 0
- `node --check plugin/client/client.js` 退出码 0
- `node ../tools/check-client-arch.mjs` 打印「依赖方向单向」且基线 0/0
- 全量 `npm test` 绿（950 条）

## 不适用条件
- 改的是**服务端**（`plugin/src/**/*.ts`）—— 那是 TS 源码，走 `build-lib.mjs`，与客户端无关
- 改的是 `design/` 里的静态设计稿 —— 那是设计工作台的 HTML，不参与插件构建
- 宿主插件契约变更（`__ModuleLoader__` 语义变化）—— 那时本文的「不能用 ESM」前提可能失效，需重新评估
