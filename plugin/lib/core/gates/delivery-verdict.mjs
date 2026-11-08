/**
 * P1-2 交付判定三级信号 + 空收尾兜底（docs/21 §6 P1-2；来源 TeamFlow `host/util.ts:654-664`、`:934-954`）。
 *
 * 背景（为什么不能只看「措辞」）：旧判据 = 非空 + **全文拒绝词** + 长度下限，把措辞当交付门禁。
 * 实锤 TF `tf-mtwvwpxa-p3vw08` 的 T5：子代理 `stopReason=completed`、41 次工具调用、证据块与
 * state 块齐全、代码已落盘，只因如实汇报「7 条 runCli 用例与 spec/verify.mjs 全部 26 例无法执行
 * （沙箱禁止子进程管道）」命中「无法执行」→ 判「视为未交付」→ 提测门禁停整条线 + 人工 resume
 * （16 分钟 + 一轮重跑）。教训不是「词表少了一个词」，而是**模型如实汇报环境限制是本分**，
 * 换一种说法（跑不通 / 环境不允许 / 需在无限制 shell 复跑）旧判据照样误杀。
 *
 * 现判据按「客观优先、措辞退为兜底」分级（判定顺序即协议，不要调换）：
 *  ① `empty-turn`：`stopReason === 'completed'` 且正文为空 —— 推理模型空收尾（实测一次 ≈150 万
 *     token 整轮重跑）。此时若任务夹产物已落盘且达长度下限，用**文件内容顶替**空回复并判交付；
 *     产物不存在 / 空文件 / 未达下限 → `needs-human`（空收尾死在写文件之前，照旧重跑）。
 *     ⚠ **空文件绝不可能是交付物**：`minLength=0` 时 `0 >= 0` 会误判，故长度必须为正。
 *  ② `evidence`：带 `[Verification evidence]` 证据块 → 判交付。拒绝 / 放弃类产出给不出具体
 *     命令 + 退出码细节；命中拒绝词只记诊断，**不否决**（这是「有证据时拒绝词不否决」的由来）。
 *  ③ `shape`：正文非空且达长度下限、且无拒绝词 → 判交付（不读语义，只读客观形态）。
 *  ④ `refusal`：无证据块且命中拒绝词 → 判**未交付**（「光说不做 / 自称做不到」的形态）。
 *  ⑤ 其余（短正文、无证据、无拒绝词）→ `needs-human`：既不能证明交付，也不该按未交付重跑。
 *
 * 纯函数（无 IO、无 ctx）〔J1〕：`docText` / `hasEvidence` 均由调用方注入，测试可完全脱离
 * 文件系统与宿主。`extractEvidenceBlock` 负责把回复文本解析成结构化证据（接线层用）。
 */

/** prompt 强制的证据块标记（FR-5.0；结构件，非措辞） */
export const EVIDENCE_MARKER = '[Verification evidence]'

/**
 * 拒绝 / 放弃措辞词表（**正则片段**，不是字面量）。只能**追加**，不得删改已有项。
 *
 * 为什么钉死「只增不改」：这组词是**兜底判据**，改一个词就等于改「什么算未交付」的口径，
 * 历史上口径漂移的代价是整轮重跑与人工 resume。而且它只在不满足 ①②③ 时才会被读到，
 * 增词的风险被前面两级客观信号挡住——所以加词安全、改词危险。
 */
export const REFUSAL_PATTERNS                    = [
  '无法完成',
  '不能完成',
  '无法继续',
  '抱歉',
  '对不起',
  '我(无法|不能)',
  '无法执行',
  'cannot complete',
  'unable to',
  'I cannot',
  "I can['’]t",
  'not able to',
]

/**
 * 拒绝词正则（大小写不敏感；**不加 `g`**——`g` 会让 `exec` 带 `lastIndex` 状态，
 * 同一个正则在两次调用间「记得」上次位置，判定结果依赖调用顺序）。
 */
export const REFUSAL_PATTERN = new RegExp(`(?:${REFUSAL_PATTERNS.join('|')})`, 'i')

/** 命中的拒绝措辞（含原文上下文，供留痕 / 重试诊断回灌） */
                             
                
                
                               
                 
 

/**
 * 在文本里找第一个拒绝词命中点。找不到 → null。
 *
 * 上下文只截前后各 40 字符：诊断要的是「哪句话」，不是把整段回复复制进账本。
 */
export function refusalHit(text                           )                    {
  const source = String(text ?? '')
  const match = REFUSAL_PATTERN.exec(source)
  if (!match || match.index < 0) return null
  const start = Math.max(0, match.index - 40)
  const end = Math.min(source.length, match.index + match[0].length + 40)
  return { phrase: match[0], context: source.slice(start, end).replace(/\s+/g, ' ').trim() }
}

/**
 * 从回复文本里抽证据块（文档契约：docs/00 FR-5.0 + docs/04 §1.3 EvidenceBlock）。
 *
 * 块内支持两种形态（都真实存在于提示词契约里，不要只认一种）：
 *  ① **JSON**（docs/04 §1.3 的落账结构）：
 *     `{ "kind": "commands", "commands": [{ "cmd": "pnpm test", "exitCode": 0, "assertions": 12 }] }`
 *     或 `{ "kind": "na", "na": { "reason": "纯文档任务无可执行验证" } }`；
 *  ② **markdown 行**（TeamFlow 提示词同款，人读友好）：
 *     `- cmd: <exact command> → exit <code>, <passed>/<failed> asserts`
 *     `- N/A: <reason>`（无命令细节，只有 raw）。
 *
 * 返回单条命令摘要（多命令只取**第一条**，全部原文仍在 `raw` 里）：
 * 判定只需要「有没有具体的命令 + 退出码」，不需要把整块结构化。
 * 没有标记 / 块内为空 → undefined（= 契约未兑现，调用方按 warn 或拒绝处理）。
 */
                                    
                                      
                  
                                                                 
                   
                                                              
                     
                                
             
 

/** 证据块结束标记：状态块（`<!-- state`）之后是宿主元数据，不属于证据 */
const STATE_BLOCK_MARKER = /<!--\s*state/i

export function extractEvidenceBlock(text        )                                {
  const source = String(text ?? '')
  const markerIndex = source.toLowerCase().indexOf(EVIDENCE_MARKER.toLowerCase())
  if (markerIndex < 0) return undefined
  let block = source.slice(markerIndex + EVIDENCE_MARKER.length)
  // 到状态块为止（证据块按契约写在 state 块之前）；再剥掉包裹的 ``` 代码围栏
  const stateIndex = block.search(STATE_BLOCK_MARKER)
  if (stateIndex >= 0) block = block.slice(0, stateIndex)
  block = block.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '').trim()
  if (block.length === 0) return undefined

  const fromJson = parseJsonEvidence(block)
  if (fromJson) return { ...fromJson, raw: block }
  const fromMarkdown = parseMarkdownEvidence(block)
  if (fromMarkdown) return { ...fromMarkdown, raw: block }
  // 块有内容但形态不认：仍返回 raw（「契约兑现了但内容不可解析」是可审计的事实，
  // 比伪装成「没有证据块」更接近真相）
  return { raw: block }
}

/** JSON 形态：块内第一个 `{` 到最后一个 `}`（容忍前后说明文字与围栏） */
function parseJsonEvidence(block        )                                             {
  const start = block.indexOf('{')
  const end = block.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed         
  try {
    parsed = JSON.parse(block.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed                           
  // kind 显式声明时只认 commands / na 两态（docs/04 §1.3 是闭合 union）
  const kind = typeof record.kind === 'string' ? record.kind : undefined
  const commands = Array.isArray(record.commands) ? record.commands : []
  const first = commands.length > 0 && commands[0] && typeof commands[0] === 'object' && !Array.isArray(commands[0])
    ? (commands[0]                           )
    : undefined
  if (kind === 'na') return {}
  if (!first) {
    // 没有 commands[]：兼容「直接给单条 {cmd, exitCode}」的写法
    if (typeof record.cmd === 'string' || typeof record.exitCode === 'number') {
      return pickCommand(record)
    }
    return kind === 'commands' ? {} : undefined
  }
  return pickCommand(first)
}

/** 从一条命令对象里取三字段（类型不对就缺省，不猜） */
function pickCommand(entry                         )                                 {
  const out                                 = {}
  const command = typeof entry.cmd === 'string' ? entry.cmd.trim() : typeof entry.command === 'string' ? entry.command.trim() : ''
  if (command.length > 0) out.command = command
  if (typeof entry.exitCode === 'number' && Number.isFinite(entry.exitCode)) out.exitCode = Math.trunc(entry.exitCode)
  if (typeof entry.assertions === 'number' && Number.isFinite(entry.assertions) && entry.assertions >= 0) {
    out.assertions = Math.trunc(entry.assertions)
  }
  return out
}

/** markdown 行形态：`- cmd: ... → exit <code>, <passed>/<failed> asserts` */
function parseMarkdownEvidence(block        )                                             {
  const cmdLine = /^[ \t]*[-*]?[ \t]*cmd[ \t]*[:：][ \t]*(.+?)[ \t]*(?:→|->)[ \t]*exit[ \t]*(-?\d+)(.*)$/im.exec(block)
  if (!cmdLine) return undefined
  const out                                 = { command: cmdLine[1].trim(), exitCode: Number.parseInt(cmdLine[2], 10) }
  const tail = cmdLine[3] ?? ''
  const passed = /(\d+)[ \t]*\/[ \t]*\d+[ \t]*assert/i.exec(tail)
  const named = /assert(?:ion)?s?[ \t]*[:：=]?[ \t]*(\d+)/i.exec(tail)
  const count = passed ?? named
  if (count) out.assertions = Number.parseInt(count[1], 10)
  return out
}

/** 交付判定输入（纯数据；`stopReason` / `docText` / `hasEvidence` 均由调用方从宿主侧取） */
                                   
                                             
                     
                
              
                                      
                   
                                                  
                  
                                                                             
                      
 

/** 判交付走的是哪一级信号（诊断 / 面板展示用） */
                                                                                     

/** 交付结论 */
                                                                           

                                    
                          
                                                    
                        
                                   
                
 

/**
 * 交付判定（三级信号 + 空收尾兜底）。**判定顺序即协议**，不要调换：
 * 空收尾 → 证据块 → 客观形态 → 拒绝兜底 → 其余。
 *
 * @param input 见 `DeliverableInput`
 */
export function judgeDeliverable(input                  )                    {
  const text = String(input?.text ?? '')
  const trimmed = text.trim()
  const minLength = normalizeMinLength(input?.minLength)

  // ① 空收尾兜底：`stopReason=completed` 但正文为空——推理模型在 reasoning 之后、正文之前
  //    被服务端收尾。此时**不整轮重跑**（一次 ≈150 万 token），用已落盘的产物内容顶替。
  if (input?.stopReason === 'completed' && trimmed.length === 0) {
    const doc = String(input?.docText ?? '').trim()
    // 空文件不算交付：`doc.length > 0` 是独立判据，不能被 `minLength=0` 的 `0 >= 0` 绕过
    if (doc.length > 0 && doc.length >= minLength) {
      return {
        verdict: 'delivered',
        signal: 'empty-turn',
        reason: `空收尾兜底：正文为空，产物已落盘 ${doc.length} 字符（下限 ${minLength}）——用文件内容顶替，判交付`,
      }
    }
    return {
      verdict: 'needs-human',
      signal: 'empty-turn',
      reason: `空收尾但产物不可用（${doc.length} 字符，下限 ${minLength}，空文件不算交付）——不判交付，需人工续跑`,
    }
  }

  // ② 证据块：结构件优先于措辞。拒绝 / 放弃类产出给不出「命令 + 退出码」的具体细节，
  //    所以带证据块即判交付；命中拒绝词只作诊断，不否决（docs/21 §4.4 的换轨结论）。
  if (input?.hasEvidence === true) {
    return {
      verdict: 'delivered',
      signal: 'evidence',
      reason: '带 [Verification evidence] 证据块：拒绝措辞只作诊断，不否决交付',
    }
  }

  const refusal = refusalHit(trimmed)
  // ③ 客观形态：非空 + 达长度下限 + 无拒绝词。空正文不因 `minLength=0` 判交付
  //    （空收尾只能走 ① 的产物兜底，否则「什么都没说」会被当成合规）。
  if (trimmed.length > 0 && trimmed.length >= minLength && !refusal) {
    return {
      verdict: 'delivered',
      signal: 'shape',
      reason: `正文 ${trimmed.length} 字符 ≥ 下限 ${minLength} 且无拒绝措辞`,
    }
  }

  // ④ 拒绝兜底：无证据块 + 命中拒绝词 = 「光说不做 / 自称做不到」的形态
  if (refusal) {
    return {
      verdict: 'not-delivered',
      signal: 'refusal',
      reason: `命中拒绝措辞「${refusal.phrase}」且无证据块——判未交付（措辞仅在此级否决）`,
    }
  }

  // ⑤ 其余：既证明不了交付，也不该按未交付重跑
  return {
    verdict: 'needs-human',
    signal: 'none',
    reason: `正文 ${trimmed.length} 字符 < 下限 ${minLength}（无证据块、无拒绝措辞）——不判交付，交人工判定`,
  }
}

/** 长度下限归一：非有限数 / 负数按 0（缺省不等于「必须非空」，空正文另由 ①③ 的显式判据挡） */
function normalizeMinLength(value         )         {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(value))
}


//# sourceURL=./src/core/gates/delivery-verdict.ts