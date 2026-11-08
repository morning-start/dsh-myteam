/**
 * P1-1 产物新鲜度指纹（docs/21 §6 P1-1；来源 TeamFlow `store.ts:56-61`、`host/util.ts:717-776`）。
 *
 * 为什么需要这一层：`task.evidence` 是**自述内容**——成员说「我写了 X、跑了 Y」就落账。
 * 真正的漏洞不在自述本身，而在**下游凭旧文件判交付**：上游阶段越界写了本该属于下游的产物
 * （TF 实锤 run `tf-mv9o5fkk-orjou4`：架构师写了 `QA-REPORT.md` / `ACCEPTANCE.md`），
 * 下游阶段自己什么都没写，host 一看「文件在、还够长」就判它交付了 —— 假绿，且假绿的那次
 * 会被写进验收记录，事后无法区分「真做了」与「继承了别人的文件」。
 *
 * 判据必须**客观且与模型自律无关**：阶段/任务开始时给候选产物拍一次指纹基线，
 * 只有指纹**变了**才认「本阶段真的写过它」。基线在阶段开始时拍一次即固定，
 * 重试与续跑都沿用**首次**基线 —— 语义是「本阶段是否写过」而不是「本次尝试是否写过」，
 * 后者会把「上一轮就写好的旧文件」重新认成新鲜。
 *
 * 为什么用 `size:mtimeMs` 而不是内容哈希：每次真实写入都必然改变其一（同毫秒同大小重写
 * 不可能发生 —— 阶段粒度按分钟计），却省掉一次全文读取与哈希。`mtimeMs` 取整，
 * 规避浮点尾数导致的「同一文件两次指纹不同」的假 stale。
 *
 * 纯函数（无 IO、无 ctx）〔J1〕：`stat` 由调用方注入，测试可完全脱离文件系统。
 */

/** 一次 stat 的结果（只取判新鲜度用的两个字段） */
                               
            
              
                               
                 
 

/**
 * 产物指纹基线：`路径 → "size:mtimeMs"`。
 *
 * 只记录**拍基线时读得到**的路径；读不到的（文件不存在 / stat 失败）**不写键**。
 * 缺键的语义交给 `artifactIsStale` 判（当前实现：缺键 = 不可判 = 不认交付）。
 */
                                                     

/** 调用方注入的 stat 读取器：读不到返回 undefined（不要把异常抛进纯函数） */
                                                                           

/** 指纹串的分隔符：`size:mtimeMs`（TeamFlow 同款；冒号不是合法文件名语义的一部分，但这里只做值，不做路径） */
const FINGERPRINT_SEPARATOR = ':'

/**
 * 把一次 stat 折叠成指纹串 `"size:mtimeMs"`。
 *
 * 非法输入（缺字段 / 非有限数）→ undefined：**宁可判不可判，也不编一个指纹**——
 * 编出来的指纹只会在下次比对时「恰好不同」而把陈旧文件认成新鲜。
 */
export function artifactFingerprint(stat                                 )                     {
  if (!stat || typeof stat !== 'object') return undefined
  const { size, mtimeMs } = stat
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return undefined
  return `${Math.trunc(size)}${FINGERPRINT_SEPARATOR}${Math.round(mtimeMs)}`
}

/**
 * 拍产物基线（阶段/任务开始时调用一次）。
 *
 * @param paths 候选产物路径（相对工作区；重复路径只保留一次）
 * @param stat  调用方注入的 stat 读取器
 *
 * 读不到 / 路径为空 / 指纹不可判的路径**不写入**——基线里出现 `undefined` 这种键，
 * 比缺键更糟：它会让「没拍过」与「拍了但文件不在」在 JSON 里长得一样，审计时分不清。
 */
export function artifactBaseline(paths          , stat                    )                   {
  const baseline                   = {}
  if (!Array.isArray(paths)) return baseline
  for (const path of paths) {
    if (typeof path !== 'string') continue
    const key = path.trim()
    if (key.length === 0) continue
    const fingerprint = artifactFingerprint(stat(key))
    if (fingerprint === undefined) continue
    assignOwn(baseline, key, fingerprint)
  }
  return baseline
}

/**
 * 合并两份基线：**只补缺失键，不覆盖已有值**。
 *
 * 为什么是「只补缺失」而不是「以新为准」：阶段可能重试多次、进程可能续跑，
 * 每次进入都重拍一次基线。如果重拍能覆盖，那么「第一轮写了文件、第二轮什么都没写」
 * 就会把第一轮的写入洗成基线，第二轮反而凭第一轮的文件被判新鲜 —— 正是要防的假绿。
 * 因此基线一经写下就固定为**首次**快照，后续只允许补齐「首次没拍到的路径」。
 *
 * 纯函数：返回新对象，不改 `prev` / `next`（调用方可能还要用旧基线做对比）。
 */
export function mergeBaseline(
  prev                                     ,
  next                                     ,
)                   {
  const merged                   = {}
  for (const [path, fingerprint] of Object.entries(prev ?? {})) {
    if (typeof fingerprint === 'string') assignOwn(merged, path, fingerprint)
  }
  for (const [path, fingerprint] of Object.entries(next ?? {})) {
    if (typeof fingerprint !== 'string') continue
    if (Object.prototype.hasOwnProperty.call(merged, path)) continue
    assignOwn(merged, path, fingerprint)
  }
  return merged
}

/**
 * 产物是否陈旧（= 不是本阶段写的，不可信）。
 *
 * 判据只有一条语义：**只有指纹变了才认「本阶段真的写过它」**（docs/21 §6 P1-1）。
 * 因此 stale 为真的三种形态全部指向「不能认交付」：
 *  ① **基线缺失该路径** → 陈旧（不可判即不认——没拍过基线就没法证明本阶段写过它）；
 *  ② 当前读不到（文件被删 / stat 失败）→ 陈旧；
 *  ③ 当前指纹与基线**相同** → 陈旧（阶段开始到现在没动过 = 不是本阶段写的）。
 *
 * 反过来，指纹**不同** = 本阶段改过它 = 新鲜（stale=false）。
 * 注意这不是「文件新旧」判定：一个 2019 年的文件只要本阶段重写过，它也是新鲜的；
 * 而一个刚被**上游**写过的文件，对本阶段来说就是陈旧的 —— 正是要防的假绿。
 *
 * @param baseline 阶段开始时拍的基线（`artifactBaseline` / `mergeBaseline` 的产物）
 * @param path     要判定的产物路径
 * @param current  当前 stat（调用方注入；读不到传 undefined）
 */
export function artifactIsStale(
  baseline                                     ,
  path        ,
  current                                 ,
)          {
  if (!baseline || typeof baseline !== 'object') return true
  const key = String(path ?? '').trim()
  if (key.length === 0) return true
  if (!Object.prototype.hasOwnProperty.call(baseline, key)) return true
  const recorded = baseline[key]
  if (typeof recorded !== 'string') return true
  const now = artifactFingerprint(current)
  if (now === undefined) return true
  // 指纹没变 = 本阶段没写过 = 陈旧；变了才是新鲜
  return recorded === now
}

/**
 * 写自有属性（不用 `obj[key] = value`）。
 *
 * 为什么不直接赋值：产物路径来自仓库，`__proto__` / `constructor` 这类名字在普通对象上
 * 会走原型链（`__proto__` 赋值直接被忽略、`constructor` 会遮蔽成普通值），
 * 结果是指纹**静默丢失**——而丢失在 JSON 里看起来只是「没拍过」，恰好被 ① 判成陈旧，
 * 属于「碰巧安全」；显式 defineProperty 让它不再依赖运气。
 */
function assignOwn(target                  , key        , value        )       {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}


//# sourceURL=./src/core/gates/artifact-freshness.ts