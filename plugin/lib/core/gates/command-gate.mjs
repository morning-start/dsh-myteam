/**
 * FR-5.3 command 门禁（CHG-87 / M2-C 剩余）：verify 门由 **host 执行命令**取真实退出码。
 *
 * 为什么必须有这一层：`gate:verify` 在状态机里从 CHG-71 起就存在，但 host 从未执行过任何命令——
 * `reviewTask` 把 verify 门当 review 门处理（要 `reviewerMemberId` 人工裁决）。这等于
 * **门禁本来要防的东西（模型自述"测试通过"）反而从 verify 门漏了进来**
 * （FR-5.3 原文：「绝不采信模型自述"测试通过"」）。
 *
 * 设计纪律：
 *  - **纯函数在前**（`validateVerifyCommand` / `classifyVerifyResult` / `truncateOutput`）：
 *    判定逻辑可在无 ctx 环境下单测〔J1〕；
 *  - **宿主适配器在后**（`runVerifyCommand`）：只接受注入的 `subprocess` 服务，
 *    缺失/形状不符 → 明确的 `MT_UNAVAILABLE`，**绝不静默降级成"人工点通过"**
 *    （静默降级 = 把 FR-5.3 的防线换成新的自述口子）；
 *  - **argv 数组直传**（无 shell 解释）：PRD §9 / docs/02 实测边界——命令需自行解析，
 *    或调用方显式以 `sh -c` 包装。字符串拼接会被当成可注入面，故 schema 层只收数组。
 */

/** 任务声明的 verify 门命令（TaskInput.verifyCommand） */
                                
                                                            
                
                                                  
              
                                                            
                    
 

/** 一次命令门禁的真实执行结果（落账本的字段子集） */
                                   
                           
                         
                                     
                       
                 
                    
                                  
                    
                                               
                   
 

                                           

/** 输出尾部预算（字符）：足够看清断言失败摘要，又不会把账本撑爆 */
export const OUTPUT_TAIL_LIMIT = 2000

/** 超时默认值（与 config 默认一致；config 缺省时兜底） */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/**
 * 取有界输出尾部（账本只存尾部：完整输出可能几 MB，账本是 JSONL，不能无界增长）。
 * 截断时前置 `…[truncated N chars]…` 标记——审计能看出「这里被截了」，不伪装成完整。
 */
export function truncateOutput(text        , limit = OUTPUT_TAIL_LIMIT)         {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const dropped = value.length - limit
  return `…[truncated ${dropped} chars]…\n${value.slice(-limit)}`
}

/** 命令 schema 校验（拒绝式；返回 null 表示通过） */
export function validateVerifyCommand(command         )                                                      {
  if (command === undefined || command === null) return null // 缺省合法：verify 门在运行期才判定 MT_VERIFY_NO_COMMAND
  if (typeof command !== 'object' || Array.isArray(command)) {
    return { ok: false, code: 'MT_VALIDATION', message: 'verifyCommand must be an object {argv, cwd?, timeoutMs?}' }
  }
  const cmd = command                           
  const unknown = Object.keys(cmd).filter((key) => !['argv', 'cwd', 'timeoutMs'].includes(key))
  if (unknown.length > 0) {
    return { ok: false, code: 'MT_VALIDATION', message: `unknown verifyCommand field(s): ${unknown.join(', ')}` }
  }
  if (!Array.isArray(cmd.argv) || cmd.argv.length === 0) {
    return { ok: false, code: 'MT_VALIDATION', message: 'verifyCommand.argv must be a non-empty string array（无 shell 解释，FR-5.3）' }
  }
  for (const arg of cmd.argv) {
    if (typeof arg !== 'string') {
      return { ok: false, code: 'MT_VALIDATION', message: 'verifyCommand.argv entries must be strings' }
    }
  }
  if (typeof cmd.argv[0] !== 'string' || cmd.argv[0].trim().length === 0) {
    return { ok: false, code: 'MT_VALIDATION', message: 'verifyCommand.argv[0] (executable) must be a non-empty string' }
  }
  if (cmd.cwd !== undefined && typeof cmd.cwd !== 'string') {
    return { ok: false, code: 'MT_VALIDATION', message: 'verifyCommand.cwd must be a string' }
  }
  if (cmd.timeoutMs !== undefined) {
    if (typeof cmd.timeoutMs !== 'number' || !Number.isFinite(cmd.timeoutMs) || cmd.timeoutMs <= 0) {
      return { ok: false, code: 'MT_VALIDATION', message: 'verifyCommand.timeoutMs must be a positive finite number' }
    }
  }
  return null
}

/**
 * 退出码 → 门禁结论。
 *
 * 判定只看**真实退出码**（FR-5.3）：exit 0 = pass；非 0 / 被信号杀 = fail。
 * 超时也算 fail（超时不是"没结论"——它意味着命令没跑完，按未通过处理，
 * 同时 timedOut 另存，面板可区分"跑挂了"与"跑超时"）。
 */
export function classifyVerifyResult(result                                                            )                {
  if (result.timedOut) return 'fail'
  if (result.signal) return 'fail'
  return result.exitCode === 0 ? 'pass' : 'fail'
}

/**
 * 超时取值：任务声明与配置硬上限取更严格者（K5「冲突取更严格者」）。
 * 配置缺省/非法时回落到 DEFAULT_COMMAND_TIMEOUT_MS。
 */
export function resolveTimeoutMs(declared                    , configured                    )         {
  const hard = typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_COMMAND_TIMEOUT_MS
  const wanted = typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : hard
  return Math.min(wanted, hard)
}

/** 宿主 subprocess 服务的最小形状（防御式读取，见 runVerifyCommand 的兼容说明） */
                                 
                                                    
 

                                          
                        
                                       
                 
                                        
                   
                                              
                     
 

                                    
                                          
                                                

/**
 * 宿主适配器：经 `ctx.subprocess` 跑命令，取**真实** exit code / signal / 输出尾部。
 *
 * 形状兼容（宿主服务不同版本/包装层不同）：docs/02 实测口径是
 * `ctx.subprocess.spawn({argv, cwd, stdio, graceMs})` → 句柄，句柄的 `done` 解析为
 * `{exitCode, signal}`；输出走 collect（有界）。这里同时接受：
 *   ① `handle.done()` 返回 Promise；
 *   ② `handle.done` 本身是 Promise；
 *   ③ `handle` 自身是 thenable。
 * 形状都不匹配 → MT_UNAVAILABLE（**不猜、不假装通过**）。
 *
 * 超时：由 graceMs 交给宿主执行；若宿主不认 graceMs，仍以返回的 exitCode 为准
 * （调用方在 timeoutMs 上做兜底 race 会杀掉进程树，这里不做二次 kill）。
 */
export async function runVerifyCommand(opts                         )                                  {
  const sp = opts.subprocess                              
  if (!sp || typeof sp.spawn !== 'function') {
    return {
      ok: false,
      code: 'MT_UNAVAILABLE',
      message:
        'host 未提供 subprocess 服务（FR-5.3 command 门禁需要在任务 workdir 执行命令并取真实退出码）；' +
        '本门禁不做静默降级——请改用人工强制放行（confirm=true + 理由），或由宿主启用 subprocess 服务',
    }
  }
  const startedAt = Date.now()
  let handle         
  try {
    handle = sp.spawn({ argv: [...opts.command.argv], cwd: opts.workdir, stdio: 'pipe', graceMs: opts.timeoutMs })
  } catch (e) {
    return { ok: false, code: 'MT_EXTERNAL_FAILURE', message: `subprocess.spawn failed: ${String((e         )?.message ?? e)}` }
  }
  const settled = await settleHandle(handle)
  if (!settled) {
    return {
      ok: false,
      code: 'MT_UNAVAILABLE',
      message: 'subprocess 句柄形状不受支持（既无 done() 也不是 thenable）；无法取得真实退出码，拒绝按"通过"处理',
    }
  }
  const exitCode = typeof settled.exitCode === 'number' ? settled.exitCode : null
  const signal = typeof settled.signal === 'string' && settled.signal.length > 0 ? settled.signal : null
  if (exitCode === null && signal === null) {
    return {
      ok: false,
      code: 'MT_UNAVAILABLE',
      message: 'subprocess 返回既无数字 exitCode 也无 signal；无法判定命令结果，拒绝按"通过"处理',
    }
  }
  const durationMs = Math.max(0, Date.now() - startedAt)
  // 超时判定：宿主通常以 signal 终止并以 timedOut 标记；形状不提供时用 signal + 耗时兜底
  const timedOut = settled.timedOut === true || (exitCode === null && signal !== null)
  return {
    ok: true,
    result: {
      exitCode,
      signal,
      durationMs,
      outputTail: truncateOutput(String(settled.output ?? settled.stdout ?? '')),
      timedOut,
    },
  }
}

                          
                          
                        
                 
                 
                    
 

/** 把各种句柄形状收敛成一次 `{exitCode, signal, output}` 结算 */
async function settleHandle(handle         )                                 {
  if (handle === null || handle === undefined) return null
  const anyHandle = handle                                                
  const readOutput = ()         => {
    for (const key of ['output', 'stdout', 'text']) {
      const value = anyHandle[key]
      if (typeof value === 'string') return value
      if (typeof value === 'function') {
        try {
          const out = (value                 ).call(handle)
          if (typeof out === 'string') return out
        } catch {
          // 读取输出失败不影响退出码判定
        }
      }
    }
    return ''
  }
  const done = anyHandle.done
  if (typeof done === 'function') {
    const settled = (await (done                 ).call(handle))                              
    return { ...(settled ?? {}), output: readOutput() }
  }
  if (done && typeof (done                      ).then === 'function') {
    const settled = (await (done                    ))                              
    return { ...(settled ?? {}), output: readOutput() }
  }
  if (typeof anyHandle.then === 'function') {
    const settled = (await (handle                    ))                              
    return { ...(settled ?? {}), output: readOutput() }
  }
  // 已经同步给出退出码的同步实现
  if (typeof anyHandle.exitCode === 'number' || typeof anyHandle.signal === 'string') {
    return { exitCode: anyHandle.exitCode          , signal: anyHandle.signal          , output: readOutput() }
  }
  return null
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/gates/command-gate.ts