/**
 * T0S 动态冒烟（M1 首个需真实宿主会话的任务）。
 *
 * 运行方式：在启用了本插件的 DSH 会话内由 Lead 执行（宿主 API 仅在 host 进程可用），
 * 或作为插件 dev profile 的 bootstrap 脚本。本文件是「冒烟脚本本体」，不进 CI。
 *
 * 验证清单（docs/02-技术可行性.md POC-T0 的动态兜底，六项对应）：
 *   ① agents.create 直连 + setup 作用域（restrict/section 注册）
 *   ② followup 唤醒 + whenIdle 静默（零请求语义）
 *   ③ tools.restrict 掩码语法（名单 vs glob——T0-④ 遗留确认项）
 *   ④ tokenMeter.measure / tokenUsage 投影读数
 *   ⑤ skills.registerProvider 作用域注册可见性
 *   ⑥ dispose 拆卸（会话与会话日志留存）
 *
 * 预期输出：每个探针一行 [PASS]/[FAIL]，退出码 0 = 全绿。
 * 结果回填 docs/02-技术可行性.md POC-T0S 记录。
 */

                       
              
               
                
 

export async function runProbes(ctx     )                         {
  const results                = []
  const record = (name        , pass         , detail        ) => {
    results.push({ name, pass, detail })
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}: ${detail}`)
  }

  // ── ① create + setup 作用域 ─────────────────────────────────
  let handle      = undefined
  try {
    const created = await ctx.agents.create({
      sessionId: `mt-probe-${Date.now()}`,
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
      setup: (agentCtx     ) => {
        agentCtx.systemPrompt.section({
          name: 'myteam:probe',
          order: 9999,
          text: 'T0S probe marker.',
        })
        agentCtx.tools.restrict({ allow: ['bash'] })
      },
    })
    handle = created
    record(
      '① agents.create + setup scope',
      !!handle?.agent,
      handle?.agent ? `session=${handle.agent.session?.id ?? 'unknown'}` : 'no agent on handle',
    )
  } catch (e) {
    record('① agents.create + setup scope', false, String(e))
  }

  // ── ③ restrict 掩码语法确认 ──────────────────────────────────
  try {
    const visible = ctx.tools.schemas(handle.agent.ctx).map((s     ) => s.name ?? s)
    const hasBash = visible.includes('bash')
    const hasHidden = visible.includes('edit') || visible.includes('write')
    record('③ restrict mask semantics', hasBash, `allow=[bash] visible=${visible.length}${hasHidden ? ' (WARN: unexpected tools visible)' : ''}`)
  } catch (e) {
    record('③ restrict mask semantics', false, `schemas(scope) probe: ${String(e)}`)
  }

  // ── ② followup 唤醒 + whenIdle ──────────────────────────────
  try {
    handle.agent.followup({
      content: [{ type: 'text', text: 'Reply with exactly: PROBE-OK' }],
      source: { kind: 'user' },
    })
    await handle.agent.whenIdle()
    record('② followup + whenIdle', true, 'turn completed and agent quiesced')
  } catch (e) {
    record('② followup + whenIdle', false, String(e))
  }

  // ── ④ tokenMeter 读数 ───────────────────────────────────────
  try {
    const meter = ctx.tokenMeter
    if (!meter) throw new Error('ctx.tokenMeter not mounted')
    const measure = meter.measure(handle.agent.session)
    record('④ tokenMeter.measure', typeof measure.totalTokens === 'number', `totalTokens=${measure.totalTokens}`)
  } catch (e) {
    record('④ tokenMeter.measure', false, String(e))
  }

  // ── ⑤ skills 作用域注册 ─────────────────────────────────────
  try {
    handle.agent.ctx.skills?.registerProvider?.({
      name: 'myteam-probe',
      rank: 50,
      list: async () => [
        { name: 'probe-skill', description: 'probe', instructionPath: undefined },
      ],
      load: async (name        ) => (name === 'probe-skill' ? { name, description: 'probe', body: 'probe body' } : undefined),
    })
    const catalog = await ctx.skills?.list?.(handle.agent.ctx)
    const found = Array.isArray(catalog) ? catalog.some((s     ) => s.name === 'probe-skill') : false
    record('⑤ scoped skill registration', found, found ? 'probe-skill visible in member scope' : 'not visible (check provider shape)')
  } catch (e) {
    record('⑤ scoped skill registration', false, `API shape mismatch: ${String(e)}`)
  }

  // ── ⑥ dispose ───────────────────────────────────────────────
  try {
    await handle.dispose()
    record('⑥ dispose', true, 'handle disposed cleanly')
  } catch (e) {
    record('⑥ dispose', false, String(e))
  }

  return results
}

/** 直接执行入口（host bootstrap 用） */
export async function smokeMain(ctx     )                   {
  console.log('=== myteam T0S dynamic smoke ===')
  const results = await runProbes(ctx)
  const failed = results.filter((r) => !r.pass)
  console.log(`=== ${results.length - failed.length}/${results.length} passed ===`)
  return failed.length === 0
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/members/smoke.ts