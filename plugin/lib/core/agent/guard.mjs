/**
 * P1-5 单调用护栏四类检测（docs/21 §6 P1-5；来源 TeamFlow `host/core/agent/guard.ts:1-70`、
 * `host/constants.ts:83-108`）。
 *
 * 为什么需要这一层：成员「复读同一命令 / 挂死 / 空转 / 撞环境不可用」时，当前实现只会一直
 * 烧 token 到失败——事后才从账本里看出「它其实在打转」。护栏要回答的是**烧钱之前**的那个问题：
 * 这一次调用是否已经证明「继续跑下去不会有新结果」？证明成立就给一条**可执行**的提醒
 * （停手 / 换做法 / 转人工），而不是等 token 烧完再报错。
 *
 * 四类判据（顺序即协议，不要调换——同一调用可能同时满足多条，先命中者为准）：
 *  ① `env-unavailable`：同签名连续 N（默认 3）次调用**都**以非 0 退出码 + 同一类环境特征
 *     失败（命令不存在 / `command not found` / `ENOENT` / 权限不足 …）。重试、换参数、用推理
 *     代替执行都修不好环境，继续跑只会白烧钱。**优先级最高，且一旦成立就 latch**：
 *     `blocksCompletion` 为真 —— 模型随后声称「完成了」也不得放行（环境根本不可用，
 *     「完成」一定是假的）。只有一次**真实成功**（exit 0）才解除。
 *  ② `repeat`：同签名连续 N（默认 3）次。签名 = 工具名 + 规范化参数，所以「同一命令再来一遍」
 *     会命中；第 N 次的结果不会与第 N-1 次不同是常识，继续重跑只烧 token。
 *  ③ `stuck`：同签名 + **同输出指纹**连续 N（默认 2）次，且距本连续段首次调用已超过
 *     `timeoutMs`（默认 120s）。进程卡在等输入 / 网络静默时，调用会「看起来还在跑」但输出
 *     一字不差——只有指纹相同才判挂死，输出变了（哪怕还是失败）就不算。
 *  ④ `empty-turn`：连续 `emptyTurns >= 2` 个回合没有任何工具调用（纯推理打转 / 只说不做）。
 *     反过来，任何一次**有签名**的工具调用都会把空回合计数清零（有动作就不是空转）。
 *
 * 设计纪律：
 *  - **纯函数、无 IO、零依赖**〔J1〕：时间由调用方经 `call.at` 注入，护栏自己**不读
 *    `Date.now()`**——否则单测只能靠 sleep，且同一份事件流回放两次会得出不同结论；
 *  - **状态是纯数据**（`createGuardState`），计数只依赖「上一条调用 + 本条调用」，
 *    调用方崩溃重启后重建即可，不需要持久化；
 *  - **不可判就不猜**：缺签名 / 缺输出指纹 / 非法时间一律不触发（宁可少杀一次，
 *    也不让一次误判把合法长任务打成一个「环境故障」）；
 *  - 阈值常量导出且可被 `opts` 覆盖（不同档位/不同成员可以取更严格的值），
 *    非法覆盖值（负数 / NaN / 0）回落到默认——配置错误不得静默变成「永不触发」。
 *
 * 接线（后续工作，本模块只给判定面）：成员每完成一次工具调用就 `observeCall(state, call)`；
 * 拿到 verdict 时把 `guardReminder(verdict)` 注入提醒 / 落账；任务收尾判定「是否完成」前先看
 * `blocksCompletion(lastVerdict)`，为真则直接转人工（needs-human），不得放行。
 *
 * `GuardCall.exitCode` 的形状复用 `gates/command-gate.ts` 的 `CommandRunResult.exitCode`
 * （`number | null`，null = 被信号杀死 / 未知），不要在这里另立一套退出码口径。
 */
                                                                

/**
 * 复读判据：同签名连续调用达到这个次数就判定「再来一遍不会有新结果」。
 * 取 3 而不是 2：一次失败后重试一次是正常自愈（第二次往往就过了），第三次还一样才是打转。
 */
export const GUARD_REPEAT_THRESHOLD = 3

/**
 * 挂死判据：同签名 + 同输出指纹连续达到这个次数才「够格」判挂死。
 * 取 2 而不是 1：单次输出是「上次的残留」还是「进程又吐了一遍」分不清，两次一字不差才可信。
 */
export const GUARD_STUCK_THRESHOLD = 2

/**
 * 挂死判据的时间窗：距本连续段首次调用超过这个时长（默认 2 分钟）才算挂死。
 * 为什么必须配时间：短任务里连续两次同输出可能只是「跑得快」，长静默才是挂死信号。
 */
export const GUARD_STUCK_TIMEOUT_MS = 120_000

/**
 * 环境不可用判据：同签名连续失败达到这个次数就中止（TeamFlow 的 ABORT 阈值同款）。
 * 取 3 而不是更大：实测模型第 2 次就会「按策略停止重试」转去绕道，提醒要早于它放弃
 * （第 2 次），中止要在绕道成规模之前（第 3 次）。
 */
export const GUARD_ENV_THRESHOLD = 3

/** 空转判据：连续这么多个回合没有工具调用就判定「只说不做」。 */
export const GUARD_EMPTY_TURN_THRESHOLD = 2

/**
 * 环境不可用的输出特征（**正则片段**，不是字面量）。只能追加，不得删改已有项。
 *
 * 为什么钉死「只增不改」：这组词是「工作区坏了」与「这次命令恰好失败」的分界，
 * 改一个词就等于改「什么算环境故障」的口径；而环境故障会直接 latch 成 needs-human，
 * 误判的代价是整条线停摆、人工介入。加词安全（还有「非 0 退出码 + 连续 3 次」两道门），
 * 改词危险。
 *
 * 同时覆盖中英文与 Windows / POSIX 两套报错形态：宿主跑在 Windows 上，
 * `pwsh` 的中文报错是「无法将“xxx”项识别为 cmdlet」，与 POSIX 的 `command not found`
 * 语义相同，不能只认英文。
 */
export const ENV_UNAVAILABLE_PATTERN = new RegExp(
  [
    '命令不存在',
    '不是内部或外部命令',
    '无法将[^\\n]*识别为',
    'command not found',
    'ENOENT',
    '权限不足',
    'Permission denied',
    'EACCES',
    'Access is denied',
    '拒绝访问',
  ].join('|'),
  'i',
)

/** 四类判据（也是账本/日志里的枚举值，不要改字面量） */
                                                                             

/** 一次护栏判定（`message` 说「发生了什么」，`hint` 说「下一步做什么」） */
                               
                 
                                   
                 
                                 
              
                         
                    
                            
                
 

/**
 * 一次工具调用的观测（调用方从 `tool/result` 事件投影出来）。
 *
 * `output` 是**输出尾部原文**，只用于 `env-unavailable` 的特征匹配，不进状态、不落账
 * （账本只存 `outputHash`：完整输出可能几 MB，纯函数也不该持有它）。
 */
                            
                                              
              
                                            
                   
                                      
                     
                                                                      
                                         
                                      
            
                                         
                 
 

/** 阈值覆盖（只允许「更严格或更宽松」，非法值回落默认） */
                               
                                               
                          
                                                      
                         
                                           
                         
                                              
                       
                                               
                             
 

/** 环境不可用证据（latch 的载体：一旦成立就保持，直到出现真实成功） */
                                   
            
              
           
                   
                        
                  
                   
               
 

/**
 * 护栏计数状态（**纯数据**；`createGuardState()` 建一份，随成员会话存活）。
 *
 * 为什么用 `Map` 而不是普通对象：签名来自命令参数，`__proto__` / `constructor` 这类名字
 * 在普通对象上会走原型链（赋值被忽略或遮蔽），计数会静默丢失——丢失在判定里等于
 * 「这条签名第一次出现」，护栏就永远不触发。`Map` 没有这个问题，也不必防御式地
 * `Object.create(null)`。
 */
                             
                                 
                              
                                            
                        
                                                  
                  
                                            
                         
                                     
                     
                                                          
                     
                                                
                                   
                           
                    
 

/** 建一份空状态（每次成员会话/每次重试各一份；状态不跨会话共享） */
export function createGuardState()             {
  return {
    repeats: new Map                (),
    stuckStreak: 0,
    envFailures: 0,
    emptyTurns: 0,
  }
}

/**
 * 观测一次工具调用，返回触发中的护栏判定（没有触发 → `undefined`）。
 *
 * 传 `null` / `undefined` 等价于「这个回合没有工具调用」——委托给 `observeEmptyTurn`。
 * 这样调用方在「turn 结束」这一个切点上永远只需要调一个函数，不会出现
 * 「工具调用走 observeCall、空回合忘了计数」的接线漏洞。
 *
 * 会**原地更新** `state`（计数是护栏的全部产出；返回新状态反而会让调用方必须处理旧引用）。
 */
export function observeCall(
  state            ,
  call                              ,
  opts               = {},
)                           {
  if (!call || typeof call !== 'object') return observeEmptyTurn(state, opts)

  // 签名是「同一条命令」的唯一身份。缺签名 = 不可判，直接放过（不猜、不计数）：
  // 猜一个签名会让两条无关调用被认成复读，误杀的代价比漏杀高。
  const signature = typeof call.signature === 'string' ? call.signature.trim() : ''
  if (signature.length === 0) return undefined

  const at = typeof call.at === 'number' && Number.isFinite(call.at) ? call.at : 0
  const repeatThreshold = positiveInt(opts.repeatThreshold, GUARD_REPEAT_THRESHOLD)
  const stuckThreshold = positiveInt(opts.stuckThreshold, GUARD_STUCK_THRESHOLD)
  const stuckTimeoutMs = positiveInt(opts.stuckTimeoutMs, GUARD_STUCK_TIMEOUT_MS)
  const envThreshold = positiveInt(opts.envThreshold, GUARD_ENV_THRESHOLD)

  // 有动作就不是空转：工具调用把「连续空回合」打断（空转只看回合，不看结果）
  state.emptyTurns = 0

  // 换签名 = 开一个全新的连续段：复读 / 挂死 / 环境失败三个计数都只认「连续」，
  // 旧段落的计数必须清掉，否则 A A B A 会被算成 A 的第 3 次（B 之后的 A 是新段落）。
  if (state.lastSignature !== signature) {
    state.repeats.clear()
    state.lastSignature = signature
    state.firstAt = at
    state.lastOutputHash = undefined
    state.stuckStreak = 0
    state.envFailures = 0
  }

  const repeatCount = (state.repeats.get(signature) ?? 0) + 1
  state.repeats.set(signature, repeatCount)

  // 输出指纹：缺失 = 不可判（不猜「两次都没输出」就是挂死——静默可能只是工具本来不产字）。
  // 连续段内指纹相同才累加；输出变了（哪怕还是失败）说明进程在动，不算挂死。
  const outputHash = typeof call.outputHash === 'string' ? call.outputHash : undefined
  if (outputHash === undefined) {
    state.stuckStreak = 0
  } else {
    state.stuckStreak = outputHash === state.lastOutputHash ? state.stuckStreak + 1 : 1
  }
  state.lastOutputHash = outputHash

  const label = signatureLabel(call.tool, signature)
  const exitCode = call.exitCode
  const envHit =
    typeof exitCode === 'number' &&
    exitCode !== 0 &&
    ENV_UNAVAILABLE_PATTERN.test(String(call.output ?? ''))
  if (envHit) {
    state.envFailures += 1
  } else {
    state.envFailures = 0
    // 只有**真实成功**（exit 0）才解除环境不可用的 latch：
    // 另一次无关失败不能证明坏掉的环境恢复了，而成功是恢复的充分证据。
    if (exitCode === 0) state.envUnavailable = undefined
  }

  // ① 环境不可用（最高优先级）：达到阈值就落证据并 latch
  if (envHit && state.envFailures >= envThreshold) {
    state.envUnavailable = {
      tool: label,
      signature,
      evidence: clipEvidence(call.output),
      count: state.envFailures,
    }
  }
  // 已 latch：即使本次调用没有再次命中（模型换命令重试 / 声称完成），也照旧返回判定——
  // 这正是「env-unavailable 优先于『完成了』」的实现面。
  if (state.envUnavailable !== undefined) return envUnavailableVerdict(state.envUnavailable)

  // ② 复读：同一签名连续 N 次
  if (repeatCount >= repeatThreshold) {
    return {
      kind: 'repeat',
      signature,
      count: repeatCount,
      message:
        `复读：同一签名「${label}」连续第 ${repeatCount} 次调用（阈值 ${repeatThreshold}）——` +
        '同一条命令重跑不会得到不同结果，继续下去只是烧 token。',
      hint:
        `下一步：停止复读——先看第 ${repeatCount - 1} 次的实际输出（失败原因 / 断言差异 / 缺什么前置条件），` +
        '然后换一条**不同签名**的做法（改参数、改代码、换命令）再重跑；不要原样重试。',
    }
  }

  // ③ 挂死：同签名 + 同输出指纹连续 N 次，且已静默超过时间窗
  const elapsedMs = at - (state.firstAt ?? at)
  if (state.stuckStreak >= stuckThreshold && elapsedMs > stuckTimeoutMs) {
    return {
      kind: 'stuck',
      signature,
      count: state.stuckStreak,
      message:
        `挂死：「${label}」连续 ${state.stuckStreak} 次输出完全相同，且距本连续段首次调用已 ${elapsedMs}ms` +
        `（超过 ${stuckTimeoutMs}ms 时间窗）——进程很可能卡在等交互式输入或网络静默。`,
      hint:
        '下一步：停止空等——把这条命令最后一次的输出尾部贴出来，确认是否在等输入（提示符 / 密码 / 确认），' +
        '加上非交互参数（如 -y / --no-input）或超时再重跑；若确实是长任务，改为后台执行并轮询进度。',
    }
  }

  return undefined
}

/**
 * 记录一个「没有任何工具调用」的模型回合。
 *
 * 为什么单独一个入口：空转的判据是**回合**而不是调用——一个空回合在 `observeCall` 眼里
 * 什么都不存在。调用方在 turn 结束且本回合零工具调用时调它；一旦有工具调用，
 * `observeCall` 会把计数清零（见上）。
 */
export function observeEmptyTurn(
  state            ,
  opts               = {},
)                           {
  const threshold = positiveInt(opts.emptyTurnThreshold, GUARD_EMPTY_TURN_THRESHOLD)
  state.emptyTurns += 1
  if (state.emptyTurns < threshold) return undefined
  return {
    kind: 'empty-turn',
    count: state.emptyTurns,
    message: `空转：连续 ${state.emptyTurns} 个回合没有任何工具调用（纯推理打转 / 只说不做）。`,
    hint:
      '下一步：先落一次真实动作（读文件 / 跑命令 / 写产物）再继续推理——空回合不会产生交付物，' +
      '不要用推理代替执行；若确实无动作可做，直接把当前结论写清楚并结束，不要空转。',
  }
}

/**
 * 护栏提醒文案（注入模型上下文的形态）。
 *
 * 为什么固定带 `[GUARD · <kind>]` 前缀：模型要能一眼看出「这是宿主的护栏提醒，不是用户的新需求」，
 * 前缀也是日志里 grep 判定类型的锚点。`hint` 必须给「下一步做什么」——只写「请注意」的提醒
 * 在实测里只会让模型换个说法继续打转。
 */
export function guardReminder(verdict                                 )         {
  if (!verdict) return ''
  return `[GUARD · ${verdict.kind}] ${verdict.message}\n${verdict.hint}`
}

/**
 * 这条判定是否阻止「完成」放行（**判据优先级**的最后一道闸）。
 *
 * 只有 `env-unavailable` 返回 true：环境根本不可用，任何「完成了」的声明都一定是假的
 * （命令跑不起来，交付物不可能被验证），必须转人工。
 *
 * 其余三类**不**阻止完成：复读 / 挂死 / 空转是「进度」信号，说明当前做法在打转，
 * 应该提醒或中止**当前尝试**；但它们不能证伪一次真实交付（模型完全可能已经写完了文件，
 * 只是又多跑了一遍命令）。把它们当成「未完成」会把「做完了但多跑一次」误判成失败，
 * 这属于把护栏变成新的误杀源。空转尤其如此：有合法任务确实不需要工具调用。
 */
export function blocksCompletion(verdict                                 )          {
  return verdict?.kind === 'env-unavailable'
}

/** 环境不可用判定（latch 命中时始终返回同一条，`count` 保留触发时的次数） */
function envUnavailableVerdict(evidence                  )               {
  return {
    kind: 'env-unavailable',
    signature: evidence.signature,
    count: evidence.count,
    message:
      `环境不可用：${evidence.tool} 连续 ${evidence.count} 次以同一类错误失败（${evidence.evidence}）——` +
      '重试、换参数、用推理代替执行都修不好环境，继续跑只会白烧 token。',
    hint:
      `下一步：停止重试 ${evidence.tool}——先确认环境（命令是否安装、PATH 是否正确、权限是否足够），` +
      `无法自修就把「${evidence.tool} 不可用：${evidence.evidence}」写进任务结论并转人工；` +
      '不要再用同一条命令重试，也不要把本次尝试报告成「已完成」。',
  }
}

/** 提醒里用的工具名（`tool` 为空时退化为签名首段；都没有则用 `command`） */
function signatureLabel(tool         , signature        )         {
  if (typeof tool === 'string' && tool.trim().length > 0) return tool.trim()
  const head = signature.split('|')[0]?.trim() ?? ''
  return head.length > 0 ? head : 'command'
}

/** 证据摘录：压平空白 + 有界（账本/提醒里只放「哪一句」，不放整段输出） */
function clipEvidence(text         , limit = 160)         {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return '无输出'
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * 阈值归一：非有限数 / 非正数回落到默认值。
 *
 * 为什么非法值不静默变成「永不触发」：0 或负数会让 `count >= threshold` 永远成立（或永远不成立），
 * 配置写错时护栏会静默消失——这比报错更危险，因为没人会去查「为什么没拦住」。
 */
function positiveInt(value         , fallback        )         {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}


//# sourceURL=./src/core/agent/guard.ts