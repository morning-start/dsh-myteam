    /* ── CHG-99（C13）：宿主深色信号 ──────────────────────────────────────────
     * 宿主 ui-layout 的 ThemePresenter 把**解析后的**主题写在 `body[data-ds-dark-theme]`
     * （dark → `setAttribute("")`，light → `removeAttribute`），同一份 apply 里还写
     * `document.documentElement.style.color-scheme` 与 `data-ds-theme-source`。
     * 面板原来读「系统偏好」媒体查询：用户在宿主里手动切深色（不跟随系统）时它不触发
     * → 13 组 color-mix 叠加色不重算 → 深色底上叠出浅色胶囊
     * （`.mt-note-info` / `.mt-mini-chip-lead` / `.mt-rolecard-captain` / `.mt-guestbar` /
     * `.mt-status-filled` 等，对比度低于 2:1）。
     * 现在按宿主自己的发布方式读：MutationObserver 订阅 body 属性 +
     * useSyncExternalStore 接进 React（参照 dsh-talk-map `use-dark.ts`）。
     * **降级是必需项**：老宿主从不发布该属性 → 回退 `matchMedia` 的系统偏好（见 darkMediaQuery）。
     * 全程 try/catch：factory 求值期与渲染期都不得抛（宿主把插件 entry 未激活当致命错误）。 */
    const DARK_ATTRIBUTE = 'data-ds-dark-theme'
    /** 宿主是否在发布「解析后的主题」（新宿主同时写 root 的 color-scheme / data-ds-theme-source） */
    const hostPublishesResolvedTheme = () => {
      if (typeof document === 'undefined') return false
      try {
        const root = document.documentElement
        if (!root) return false
        if (root.style && root.style.colorScheme) return true
        return typeof root.hasAttribute === 'function' && root.hasAttribute('data-ds-theme-source')
      } catch {
        return false
      }
    }
    /** 系统偏好媒体查询（老宿主的降级通道；没有 matchMedia 的环境返回 null） */
    const darkMediaQuery = () => {
      try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)')
          : null
      } catch {
        return null
      }
    }
    /** 系统是否偏好深色（无 matchMedia 一律浅色） */
    const systemPrefersDark = () => darkMediaQuery()?.matches === true
    /** 当前**解析后**的深色态：宿主信号优先，老宿主回退系统偏好（返回裸布尔，快照才稳定） */
    const readDarkTheme = () => {
      if (typeof document === 'undefined') return false
      try {
        const body = document.body
        if (body && typeof body.hasAttribute === 'function' && body.hasAttribute(DARK_ATTRIBUTE)) return true
        return hostPublishesResolvedTheme() ? false : systemPrefersDark()
      } catch {
        return false
      }
    }
    /** 订阅：body 的主题属性变化 +（老宿主）系统偏好变化；返回退订函数 */
    const subscribeDarkTheme = (listener) => {
      if (typeof document === 'undefined' || !document.body) return () => {}
      const unsubs = []
      try {
        if (typeof MutationObserver === 'function') {
          const observer = new MutationObserver(() => listener())
          observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
          unsubs.push(() => observer.disconnect())
        }
      } catch { /* 无 MutationObserver：退化为一次性快照，至少首帧正确 */ }
      try {
        const media = darkMediaQuery()
        if (media && typeof media.addEventListener === 'function') {
          media.addEventListener('change', listener)
          unsubs.push(() => media.removeEventListener('change', listener))
        }
      } catch { /* 同上 */ }
      return () => { for (const off of unsubs) { try { off() } catch { /* 退订失败不影响卸载 */ } } }
    }
    /** useSyncExternalStore 的兜底（老 React / 测试替身没有该 API 时退化为 useState + useEffect） */
    const useSyncExternalStoreSafe = typeof react.useSyncExternalStore === 'function'
      ? react.useSyncExternalStore
      : (subscribe, getSnapshot) => {
        const [value, setValue] = react.useState(getSnapshot)
        react.useEffect(() => subscribe(() => setValue(getSnapshot())), [subscribe, getSnapshot])
        return value
      }
    /** useRef 的兜底（测试替身没有 useRef 时不 throw；与 DAG 测量处的写法一致） */
    const useRefSafe = react.useRef ?? ((init) => ({ current: init }))
    /** 面板表面根：把「解析后的深色态」写到插件自己的根节点上（见 CHG-99 / C13） */
    const useDarkTheme = () => useSyncExternalStoreSafe(subscribeDarkTheme, readDarkTheme) === true
