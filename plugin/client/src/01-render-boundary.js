window.__ModuleLoader__.load({
  id: 'dsh-plugin-myteam',
  factory: (require) => {
    const { jsx: j, jsxs: js } = require('react/jsx-runtime')
    const react = require('react')

    const PANEL_KEY = 'myteam'

    /**
     * CHG-155（P1）：**渲染错误边界**——插槽里任何组件抛错，宿主只看到一块空白
     * （深色主题下就是「黑屏」），用户拿不到任何可读信息，也没法自己恢复。
     *
     * 兜底口径：**渲染异常 ≠ 面板消失**。
     *  - 显示「渲染失败 + 错误摘要 + 重试」，重试只清 error（不重载页面）；
     *  - 异常照常 `console.error`（保留堆栈，便于定位真因）；
     *  - 边界自身绝不抛错（locale/console 都不可用时降级成中文常量）。
     *
     * 注意：类组件是这里的有意选择——React 的 `getDerivedStateFromError` 只有类有。
     * 宿主/测试的 react shim 不一定导出 `Component`（mock loader 只给 hooks），
     * 所以取不到实体时退回一个最小基类：边界在任何 shim 下都能构造。
     */
    const RenderBoundaryBase = react.Component ?? class { constructor(props) { this.props = props } }
    class MyTeamRenderBoundary extends RenderBoundaryBase {
      constructor(props) {
        super(props)
        this.state = { error: null, info: null }
        this.retry = () => this.setState({ error: null, info: null })
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        /* 组件栈是定位「谁在循环」的唯一线索（#185 尤其如此）：存进 state 直接显示出来 */
        this.setState({ info: info ?? null })
        try {
          console.error('[myteam] 渲染异常（已兜住，未黑屏）：', error, info?.componentStack)
        } catch {
          /* 控制台不可用也不影响兜底 */
        }
      }

      render() {
        const { t, children } = this.props ?? {}
        if (!this.state.error) return children
        const label = (key, fallback) => {
          try {
            const value = typeof t === 'function' ? t(key) : undefined
            return value && value !== key ? value : fallback
          } catch {
            return fallback
          }
        }
        const detail = String(this.state.error?.message ?? this.state.error ?? '')
        /* 组件栈只取前 3 帧（再长也没人看），一行内用 ← 串起来 */
        const frames = String(this.state.info?.componentStack ?? '')
          .split('\n')
          .map((line) => line.trim().replace(/^at\s+/, ''))
          .filter(Boolean)
          .slice(0, 3)
        return j('div', { className: 'mt-empty', role: 'alert', children: [
          j('b', { children: label('errors.renderTitle', '面板渲染失败') }),
          j('p', { className: 'mt-hint', children: detail.slice(0, 400) }),
          frames.length > 0
            ? j('p', { className: 'mt-hint', children: `${label('errors.renderWhere', '出错组件')}：${frames.join(' ← ')}` })
            : null,
          j('button', { className: 'mt-btn mt-btn-sm', onClick: this.retry, children: label('errors.renderRetry', '重试') }),
        ] })
      }
    }

    /**
     * 给插槽组件套一层边界（登记处调用；props 原样透传，`t` 单独取出给兜底 UI 用）。
     * 每次登记新建一个包装组件：插槽是单例登记，不存在重复挂载的开销。
     */
    const withRenderBoundary = (Component) => {
      const Guarded = (props) => j(MyTeamRenderBoundary, { t: props?.t, children: j(Component, props) })
      Guarded.displayName = `MyTeamBoundary(${Component?.name || 'Component'})`
      return Guarded
    }
    /**
     * CHG-114：**入口 → 工作台的上下文交接**。
     *
     * 全局/项目不拆成两个宿主表面，但**入口必须带层级**：从团队会话的「团队视图」
     * 点进来时，用户期望落在**这个团队的看板**，而不是回到全局库。
     *
     * 宿主选择面板的 API 是 `ctx.layout.selectPanel(id)`（ui-layout 服务）。
     * CHG-114 之前这里调的是 `ctx.get('uiWorkspace')?.openPanel?.(PANEL_KEY)`——
     * `uiWorkspace` 上没有 `openPanel`，可选链把 TypeError 吞成 undefined，
     * 于是「打开面板」和 composer chip **点了都没反应**，团队视图成了死端。
     *
     * 交接用模块级一次性变量：打开前写 `pendingNav`，Panel 挂载时 `takePendingNav()` 消费。
     * 只在事件回调里赋值（不在渲染期），并发打开也只会落在最后一次。
     */
    /** 打开工作台并交接上下文；返回是否真的调到了宿主 API（测试可断言） */
    /** 消费一次性入口上下文（Panel 挂载时调用一次） */
    /** 会话 → 入口上下文：能解析出团队就落团队页，解析不到回全局库（不空转） */
    const NS = 'myteam.panel'
    /**
     * 轮询间隔（R34 / design-v2/README.md §十：面板 5s 轮询）。
     *
     * 修复前两处各自写死 15000 / 20000，且**完全不看** `document.visibilityState`——
     * 面板切到后台（或宿主窗口最小化）时仍在按秒发 RPC，白烧网关与账本折叠。
     * 现在统一走这个常量：到点先看可见性，hidden 直接跳过（不请求），
     * `visibilitychange` 回到 visible 时立刻补一次。
     */
    const POLL_MS = 5000
    /** 后台标签页是否该跳过本轮（无 document 的 SSR/测试环境一律视为可见） */
    const isHidden = () => (typeof document === 'undefined' ? false : document.visibilityState === 'hidden')
