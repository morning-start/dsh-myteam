    const copyText = async (text) => {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* 降级 */ }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok
      } catch {
        return false
      }
    }

    /**
     * 建队指令（P1 引导：不新增写路径，把结构交给团队模式会话里的队长）。
     *
     * CHG-202x（P0-7）：**名册必须进指令**。修复前第 2 步「组建名册」只改本地状态参与渲染，
     * 生成的消息里一个字都没有——用户在向导里挑的角色被**静默丢弃**，队长按 `submit_plan` 的
     * 预设兜底（`presetTeamRoster('triad')`）召唤；「不套预设」的意图同样失效。
     * 现在把「最终名册」原样写进消息，并明确禁止用模板默认名册替换它。
     */
    const buildTeamPrompt = ({ name, goal, presetId, presetName, roster }) => {
      const lines = ['请帮我创建一个团队：', `- 团队名：${name || '（待定）'}`, `- 目标：${goal || '（待补充）'}`]
      if (presetId) lines.push(`- 模板：${presetId}${presetName ? `（${presetName}）` : ''}`)
      const list = Array.isArray(roster) ? roster.filter((item) => item && item.roleId) : []
      if (list.length > 0) {
        const text = list.map((item) => (item.instanceName && item.instanceName !== item.roleId
          ? `${item.roleId}（实例名 ${item.instanceName}）`
          : String(item.roleId))).join('、')
        lines.push(`- 名册（${list.length} 个成员；队长 = 本会话，不占名册）：${text}`)
        lines.push('  - **严格按这份名册提交 roster**；不要用模板默认名册替换它，也不要自行增删。')
      } else {
        lines.push('- 名册：**不套预设**（先与我确认要哪些角色，不要用模板默认名册兜底）。')
      }
      lines.push('', '要求：')
      lines.push('1. 先澄清必要信息（taste 类必须问，fact 类给默认值并标注假设），追问不超过 3 轮；')
      lines.push('2. 用 myteam_submit_plan 提交草稿（roster 必含且仅含一个 captain），不要直接开跑；')
      lines.push('3. 等我批准后再召唤队员、开始执行。')
      return lines.join('\n')
    }

    /** 建队引导抽屉（CHG-72，FR-26 P1）：填名称/目标/模板 → 打开团队模式会话并预填首条消息 */
    /** 建团向导（CHG-82 / G6）：design-v2/README.md 第 1 步「选预设」→ design-v2/README.md 第 2 步「组建名册」→ 第 3 步「写目标」。
     *  名册里存角色引用（实例名决定将创建的实例，同名自动加 -2）；队长 = 会话本身，不占名册；成员会话在点「创建团队」后才创建。 */