/**
 * myteam 客户端插件入口（最小形态）。
 *
 * 宿主用 `window.__ModuleLoader__.load({ id, factory })` 装载：factory 返回
 * `{ apply, inject }`。当前阶段**只建立载体**，不注册任何插槽——目的是让
 * `myteam-carrier` 裸包名行成立（客户端模块图只认不带 `/` 的包名行），
 * 同时保证前端仍然正常渲染。
 *
 * 下一阶段在这里注册看板视图；在那之前 apply 只登记一个可清理的 effect，
 * 不碰 DOM、不发请求，避免任何渲染期副作用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-myteam',
  factory: () => {
    function apply(ctx) {
      // 预留：看板视图/侧栏入口将从这里注册（需要 ui-layout / ui-sidebar 注入）。
      const register = () => () => {}
      if (typeof ctx?.effect === 'function') ctx.effect(register)
      return register
    }
    return { apply, inject: [] }
  },
})
