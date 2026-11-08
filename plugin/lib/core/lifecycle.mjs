/**
 * P1-4 dispose 有界结算（docs/21 §6 P1-4；来源官方 `dsh-experimental-agent-team/lib/types/lifecycle.js:1-103`）。
 *
 * 为什么需要这一层：`dispose()` 现在的实现是「挨个 `void handle.dispose()`，然后清空 Map」——
 * 它**同步返回**，宿主把它当 effect disposer 调用时不会 await，于是：
 *  ① 成员会话的排空（`dispose()` 内部可能等事件循环、等子进程退出）没有任何上界，
 *     卸载/HMR 时要么卡住宿主，要么被宿主直接砍掉，**排空状态无人知道**；
 *  ② 排空过程中的失败（不是取消，是真的错了）被 `catch {}` 吞掉 —— 静默丢错误；
 *  ③ 卸载期间新起的操作（成员结算、消息投递）没有任何准入截止，会继续往正在拆的运行时里写。
 *
 * 设计口径（与官方一致的三段式）：
 *  **准入截止 → 收集已准入操作 → `allSettled` + 超时 → 非预期失败聚合成一条 `AggregateError` 语义**。
 *
 * 三条纪律：
 *  - **预期取消不告警**：卸载时被取消的操作是**正常**的（`isCancellation` 沿 `cause` 链识别
 *    `AbortError` / `ABORT_ERR`）。把取消当失败报，会让每次正常卸载都留一条假告警，
 *    真正的失败于是被淹没（告警疲劳比没有告警更糟）。
 *  - **超时也要留痕**：`settleWithin` 返回 `timedOut` 名单——有界结算是「不再等」，
 *    不是「假装已经收干净」。调用方据此 warn，人知道卸载没排空。
 *  - **纯函数**（无 IO、不依赖宿主）〔J1〕：`track` 只接已构造好的 Promise，
 *    单测可以用「永远悬着」的 Promise 精确验证超时路径，不需要真起会话。
 */

/** 默认卸载结算超时（毫秒）：足够成员会话收尾，又不至于让宿主卸载无限等待 */
export const DEFAULT_DISPOSAL_TIMEOUT_MS = 5000

/** 取消类错误的 `name` 标识（DOMException / Node 通用写法都走这个字段） */
const CANCELLATION_NAMES                      = new Set(['AbortError'])
/** 取消类错误的 `code` 标识（Node 的 `AbortError` 用 `ABORT_ERR`） */
const CANCELLATION_CODES                      = new Set(['ABORT_ERR'])

/** 一条已准入的在飞操作（`name` 只用于日志/超时名单，不参与判定） */
                                     
                                                             
              
                                                      
                           
 

/** 有界结算结果：**结算了多少、谁没排空、哪些是真失败**（三个都要，缺一个就没法定位） */
                                     
                                                         
                 
                                     
                    
                                                        
                                                    
 

/** 准入闸门（官方 `TeamRuntimeLifecycle` 的贴地版：只保留我们需要的四个动作） */
                                
                                    
                            
                                                    
                                    
     
               
    
                                                      
                                                         
                               
     
                                                            
                                  
                                 
              
                        
                                        
                               
                                           
                                                         
                                                            
                                          
 

/** 构造一条「卸载取消」错误：`name`/`code` 都是标准取消标识，`isCancellation` 认它 */
export function disposalCancellationError(message = 'myteam host disposed: admission closed')        {
  const error = new Error(message)
  // 两个字段都设：`name` 覆盖 DOMException 那套写法，`code` 覆盖 Node 的 ABORT_ERR 口径
  error.name = 'AbortError'
  ;(error                             ).code = 'ABORT_ERR'
  return error
}

/**
 * 是否**预期取消**（卸载期间被取消 = 正常，不该告警）。
 *
 * 判定沿 `cause` 链走（`AggregateError` / 包装错误会层层 cause），并带 `seen` 集合防环：
 * 自己 cause 自己的错误在真实世界里存在（循环引用被 JSON 化过又解回来），
 * 没有 `seen` 的 while 会在这里死循环——**卸载路径死循环 = 宿主永远关不掉**。
 *
 * 非对象（字符串 / 数字 / null）没有 cause 可走，直接判否。
 */
export function isCancellation(reason         )          {
  const seen = new Set         ()
  let current          = reason
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (typeof current !== 'object' && typeof current !== 'function') return false
    seen.add(current)
    const candidate = current                                                       
    if (typeof candidate.name === 'string' && CANCELLATION_NAMES.has(candidate.name)) return true
    if (typeof candidate.code === 'string' && CANCELLATION_CODES.has(candidate.code)) return true
    current = candidate.cause
  }
  return false
}

/**
 * 有界结算一批操作：`Promise.allSettled` 等**全部**结算，但最多等 `timeoutMs`。
 *
 * 为什么不是 `Promise.race` 掉整个 allSettled：那会丢掉「谁已经好了」，
 * 于是超时后既不知道排空了多少，也不知道哪几条最可疑。这里逐个登记结算事实，
 * 超时只决定「还等不等」，不决定「已知什么」。
 *
 * 超时**不抛错**（返回值里 `timedOut` 列表就是结论）：卸载路径上抛错会被
 * `void promise` 吃掉变成 unhandled rejection，反而更不可观测。
 *
 * 副作用：超时返回后，仍未结算的操作**继续被 allSettled 接住**（rejection 不会逃逸成
 * unhandled rejection），只是调用方不再等它——这是「有界」的全部含义。
 *
 * @param operations 待结算操作（`name` 进超时名单）
 * @param timeoutMs  等待上限（非有限 / ≤0 按 0 处理：只结算已经完成的）
 */
export async function settleWithin(
  operations                               ,
  timeoutMs        ,
)                              {
  const list = [...operations]
  if (list.length === 0) return { settled: 0, timedOut: [], failures: [] }

  /** 已结算的下标（用下标而不是 name：名字允许重复，重复名字会互相掩盖「没结算」） */
  const settledIndexes = new Set        ()
  const failures                                 = []
  const all = Promise.allSettled(
    list.map((operation, index) =>
      Promise.resolve(operation.promise).then(
        () => {
          settledIndexes.add(index)
        },
        (reason         ) => {
          settledIndexes.add(index)
          failures.push({ name: operation.name, reason })
        },
      ),
    ),
  )

  const budget = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0
  let timer                                           
  const timeout = new Promise      ((resolve) => {
    // 用普通定时器（与官方 `withTimeout` 同款），**不 unref**：
    // 未结算的操作本身还挂在事件循环上，卸载路径多等一个上界正是「有界」的代价；
    // 反过来 unref 会让「只有卸载在等」的进程提前退出，连超时告警都来不及落日志。
    timer = setTimeout(resolve, budget)
  })
  try {
    await Promise.race([all.then(() => undefined), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  const timedOut = list.filter((_operation, index) => !settledIndexes.has(index)).map((operation) => operation.name)
  return { settled: settledIndexes.size, timedOut, failures }
}

/**
 * 构造准入闸门（一段生命周期的「准入 → 截止 → 有界结算」三态）。
 *
 * 用法（`host.dispose()` 的形状）：
 * ```ts
 * const gate = createAdmissionGate({ disposalTimeoutMs: 5000 })
 * // …运行期：gate.track(member.dispose(), 'member:m1')
 * gate.close()                       // ① 关闸：之后新操作立即拒绝
 * const outcome = await gate.settle() // ②③ 收集 + 有界结算
 * ```
 *
 * @param options.disposalTimeoutMs 默认结算超时（缺省 `DEFAULT_DISPOSAL_TIMEOUT_MS`）
 */
export function createAdmissionGate(options                                 = {})                {
  const operations = new Set                    ()
  let disposed = false
  let disposalReason                   
  const timeoutOf = ()         => {
    const value = options.disposalTimeoutMs
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_DISPOSAL_TIMEOUT_MS
  }

  return {
    get disposed() {
      return disposed
    },
    get reason() {
      return disposalReason
    },
    track   (operation            , name = 'operation')             {
      // 关闸后立即拒绝：不登记、不等——已经开始的卸载不该被新操作拖长。
      // 拒绝的 Promise **自己先接一个空 handler**：调用方常常 `void track(...)`，
      // 不接的话卸载期间每次迟到准入都会冒一条 unhandled rejection（假失败）。
      if (disposed) {
        const rejected = Promise.reject(disposalReason ?? disposalCancellationError())
        void rejected.catch(() => {})
        return rejected
      }
      const entry                     = { name, promise: operation                     }
      operations.add(entry)
      // 结算即摘除（成败都摘）：闸门只关心「还没好的」，不是历史账
      const forget = ()       => {
        operations.delete(entry)
      }
      void operation.then(forget, forget)
      return operation
    },
    pending()                       {
      return [...operations]
    },
    pendingCount()         {
      return operations.size
    },
    close(message         )       {
      // 幂等：重复关闭保留**首次**原因——后一次调用不该改写「这次卸载为什么开始」
      if (disposed) return
      disposed = true
      disposalReason = disposalCancellationError(message)
    },
    settle(timeoutMs         )                              {
      return settleWithin([...operations], typeof timeoutMs === 'number' ? timeoutMs : timeoutOf())
    },
    isCancellation,
  }
}


//# sourceURL=./src/core/lifecycle.ts