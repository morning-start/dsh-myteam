/**
 * dsh-plugin-myteam — 包入口（标准 bundle 形态）。
 *
 * 为什么根上要有一个 `index.js`：DSH 插件契约要求装载入口是**纯 JS**，且
 * `dsh_plugin_check` 的 `recipe:entry` 规则只认包根的 `index.js`。本包的实现是
 * TypeScript，由 `scripts/build-lib.mjs` 擦除类型后产出 `lib/**/*.mjs`（构建产物，
 * 不入库），所以这里只做一件事：把队长侧（`composition/host.ts` → `lib/composition/host.mjs`）
 * 的 `apply` / `inject` 原样转发出去。
 *
 * 转发而不是重写：`cordis.patch.yml` 里 `myteam-host` 行装载的就是这个包名，
 * 宿主拿到的 `apply` / `inject` 必须与 `lib/composition/host.mjs` 完全同一份，
 * 否则「行级 inject 双保险」这条约定会悄悄失效。
 *
 * 其余装载面（`./member`、`./panel`、`./commands`、`./human-actions-skill`、
 * `./human-cards`）仍由 `package.json` 的 `exports` 直接指向各自的 `lib/` 产物：
 * 它们各自是独立的装载行，不需要经过本文件。
 *
 * ⚠️ 本文件**不要**加 `export default`：`host.ts` 没有默认导出，凭空补一个会让
 * 宿主在 `apply` 与 `default` 之间产生两种装载语义。
 */
export { apply, inject } from './lib/composition/host.mjs'
