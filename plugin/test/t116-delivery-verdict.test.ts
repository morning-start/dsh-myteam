/**
 * T116 · P1-2 交付判定三级信号 + 空收尾兜底（docs/21 §6 P1-2；来源 TeamFlow `host/util.ts:654-664`、`:934-954`）。
 *
 * 锁五件事：
 *  ① **判定顺序即协议**：空收尾 → 证据块 → 客观形态 → 拒绝兜底 → 其余（调换顺序 = 换口径）；
 *  ② **有证据时拒绝词不否决**（TF 实锤：如实汇报环境限制被误杀，16 分钟 + 一轮重跑）；
 *     但无证据时拒绝词仍是兜底判据（「光说不做」不能放行）；
 *  ③ **空收尾兜底**：`stopReason=completed` + 空正文 + 产物落盘达下限 → 交付（用文件内容顶替），
 *     产物不存在 / 空文件 / 未达下限 → needs-human；**空文件不算交付**（minLength=0 也不能绕过）；
 *  ④ `extractEvidenceBlock` 同时认 docs/04 §1.3 的 JSON 形态与 TeamFlow 的 markdown 行形态；
 *  ⑤ 拒绝词表**只增不改**（常量导出、大小写不敏感、无 `g` 状态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVIDENCE_MARKER,
  REFUSAL_PATTERN,
  REFUSAL_PATTERNS,
  extractEvidenceBlock,
  judgeDeliverable,
  refusalHit,
} from '../src/core/gates/delivery-verdict.ts'

const repeat = (char: string, times: number) => char.repeat(times)

test('t116-1: 空收尾兜底——completed + 空正文 + 产物达下限 → 交付（用文件内容顶替）', () => {
  const verdict = judgeDeliverable({
    stopReason: 'completed',
    text: '',
    minLength: 100,
    docText: repeat('产物内容', 30), // 120 字符
    hasEvidence: false,
  })
  assert.equal(verdict.verdict, 'delivered')
  assert.equal(verdict.signal, 'empty-turn')
  assert.match(verdict.reason, /空收尾兜底/)
  // 纯空白正文同样算空正文
  assert.equal(judgeDeliverable({ stopReason: 'completed', text: ' \n\t ', minLength: 10, docText: repeat('x', 10) }).verdict, 'delivered')
})

test('t116-2: 空文件不算交付（docText 为空 / 纯空白 / 未达下限 → needs-human）', () => {
  // 空文件：minLength=0 时 `0 >= 0` 也不能判交付
  assert.deepEqual(
    (({ verdict, signal }) => ({ verdict, signal }))(
      judgeDeliverable({ stopReason: 'completed', text: '', minLength: 0, docText: '' }),
    ),
    { verdict: 'needs-human', signal: 'empty-turn' },
  )
  // 纯空白文件同样不算
  assert.equal(judgeDeliverable({ stopReason: 'completed', text: '', minLength: 0, docText: '  \n ' }).verdict, 'needs-human')
  // 未达下限
  assert.equal(judgeDeliverable({ stopReason: 'completed', text: '', minLength: 100, docText: repeat('x', 99) }).verdict, 'needs-human')
  // 产物不存在
  assert.equal(judgeDeliverable({ stopReason: 'completed', text: '', minLength: 0 }).verdict, 'needs-human')
})

test('t116-3: 有证据块时拒绝词不否决（命中「无法执行」仍判交付，措辞只作诊断）', () => {
  const verdict = judgeDeliverable({
    stopReason: 'completed',
    text: '7 条 runCli 用例与 spec/verify.mjs 全部 26 例无法执行（沙箱禁止子进程管道）。',
    minLength: 100,
    hasEvidence: true,
  })
  assert.equal(verdict.verdict, 'delivered')
  assert.equal(verdict.signal, 'evidence')
  assert.match(verdict.reason, /不否决/)
  // 证据块优先于长度：正文未达下限也判交付
  assert.equal(judgeDeliverable({ text: '抱歉', minLength: 999, hasEvidence: true }).verdict, 'delivered')
})

test('t116-4: 客观形态——无证据、达长度下限、无拒绝词 → 交付', () => {
  const body = repeat('实现说明', 25) // 100 字符
  const verdict = judgeDeliverable({ stopReason: 'completed', text: body, minLength: 100, hasEvidence: false })
  assert.equal(verdict.verdict, 'delivered')
  assert.equal(verdict.signal, 'shape')
  // 空正文不因 minLength=0 走「客观形态」（否则空收尾会绕过 ① 的产物兜底）
  assert.deepEqual(
    (({ verdict, signal }) => ({ verdict, signal }))(
      judgeDeliverable({ stopReason: 'stop', text: '', minLength: 0, hasEvidence: false }),
    ),
    { verdict: 'needs-human', signal: 'none' },
  )
})

test('t116-5: 拒绝兜底——无证据 + 命中拒绝词 → 未交付（即使正文很短）', () => {
  const verdict = judgeDeliverable({ stopReason: 'completed', text: '抱歉，我无法完成这个任务。', minLength: 100, hasEvidence: false })
  assert.equal(verdict.verdict, 'not-delivered')
  assert.equal(verdict.signal, 'refusal')
  assert.match(verdict.reason, /抱歉|无法完成/)
  // 短正文 + 拒绝词：④ 在 ⑤ 之前（未交付，不是 needs-human）
  assert.equal(judgeDeliverable({ text: '无法继续', minLength: 500, hasEvidence: false }).verdict, 'not-delivered')
})

test('t116-6: 其余——短正文、无证据、无拒绝词 → needs-human（不判交付，也不按未交付重跑）', () => {
  const verdict = judgeDeliverable({ stopReason: 'completed', text: repeat('x', 10), minLength: 100, hasEvidence: false })
  assert.equal(verdict.verdict, 'needs-human')
  assert.equal(verdict.signal, 'none')
  assert.match(verdict.reason, /10 字符 < 下限 100/)
})

test('t116-7: 判定顺序①先于②——空收尾 + 有证据 + 产物不足 → needs-human（空收尾分支自己结案）', () => {
  const verdict = judgeDeliverable({ stopReason: 'completed', text: '', minLength: 100, docText: 'short', hasEvidence: true })
  assert.equal(verdict.verdict, 'needs-human')
  assert.equal(verdict.signal, 'empty-turn')
  // 非 completed 的 stopReason 不触发空收尾（截断/中止不是「正常收尾」）
  assert.equal(judgeDeliverable({ stopReason: 'length', text: '', minLength: 0, docText: repeat('x', 10) }).verdict, 'needs-human')
})

test('t116-8: minLength 边界——恰好等于下限交付、差 1 字符 needs-human、非有限/负数归 0', () => {
  assert.equal(judgeDeliverable({ text: repeat('x', 100), minLength: 100, hasEvidence: false }).verdict, 'delivered')
  assert.equal(judgeDeliverable({ text: repeat('x', 99), minLength: 100, hasEvidence: false }).verdict, 'needs-human')
  // trim 后再比：前后空白不凑数
  assert.equal(judgeDeliverable({ text: `  ${repeat('x', 99)}  `, minLength: 100, hasEvidence: false }).verdict, 'needs-human')
  // 非法下限归一为 0：非空正文交付，空正文仍 needs-human
  assert.equal(judgeDeliverable({ text: 'x', minLength: Number.NaN, hasEvidence: false }).verdict, 'delivered')
  assert.equal(judgeDeliverable({ text: 'x', minLength: -5, hasEvidence: false }).verdict, 'delivered')
  assert.equal(judgeDeliverable({ text: 'x', minLength: 2.9, hasEvidence: false }).verdict, 'needs-human')
  assert.equal(judgeDeliverable({ text: '', minLength: 0, hasEvidence: false }).verdict, 'needs-human')
})

test('t116-9: extractEvidenceBlock 认 docs/04 §1.3 的 JSON 形态（kind=commands）', () => {
  const text = [
    '实现完成，改了 host.ts。',
    '',
    EVIDENCE_MARKER,
    '```json',
    JSON.stringify({
      kind: 'commands',
      commands: [
        { cmd: 'pnpm test', exitCode: 0, assertions: 667, durationMs: 3400, filesTouched: ['plugin/src/host.ts'] },
        { cmd: 'pnpm run bundle', exitCode: 0 },
      ],
    }),
    '```',
    '',
    '<!-- state: {"phase":"dev"} -->',
  ].join('\n')
  const evidence = extractEvidenceBlock(text)
  assert.ok(evidence)
  assert.equal(evidence.command, 'pnpm test')
  assert.equal(evidence.exitCode, 0)
  assert.equal(evidence.assertions, 667)
  // raw 是块内原文（不含 state 块），审计可逐字对照
  assert.ok(evidence.raw.includes('plugin/src/host.ts'))
  assert.equal(evidence.raw.includes('<!-- state'), false)
})

test('t116-10: extractEvidenceBlock——kind=na 只有 raw；无标记 / 空块 → undefined', () => {
  const na = extractEvidenceBlock(`${EVIDENCE_MARKER}\n{ "kind": "na", "na": { "reason": "纯文档任务无可执行验证" } }`)
  assert.deepEqual(na, { raw: '{ "kind": "na", "na": { "reason": "纯文档任务无可执行验证" } }' })

  assert.equal(extractEvidenceBlock('普通回复，没有证据块'), undefined)
  assert.equal(extractEvidenceBlock(`${EVIDENCE_MARKER}\n\n`), undefined)
  assert.equal(extractEvidenceBlock(`${EVIDENCE_MARKER}\n<!-- state: {} -->`), undefined)
  assert.equal(extractEvidenceBlock(''), undefined)
})

test('t116-11: extractEvidenceBlock 认 markdown 行形态（TeamFlow 提示词同款）', () => {
  const evidence = extractEvidenceBlock(
    ['摘要：修好了。', EVIDENCE_MARKER, '- cmd: pnpm test → exit 0, 667/667 asserts', '- N/A: 纯文档任务'].join('\n'),
  )
  assert.ok(evidence)
  assert.equal(evidence.command, 'pnpm test')
  assert.equal(evidence.exitCode, 0)
  assert.equal(evidence.assertions, 667)
  // 只有 N/A 行：契约兑现但无命令细节 → 仍返回 raw（不是「没有证据块」）
  const na = extractEvidenceBlock(`${EVIDENCE_MARKER}\n- N/A: 纯文档任务无可执行验证`)
  assert.ok(na)
  assert.equal(na.command, undefined)
  // 形态不认但块非空：raw 仍在（可审计 > 伪装成没有）
  const weird = extractEvidenceBlock(`${EVIDENCE_MARKER}\n随便写点什么`)
  assert.deepEqual(weird, { raw: '随便写点什么' })
})

test('t116-12: 拒绝词表只增不改——常量导出、大小写不敏感、无 g 状态、命中带上下文', () => {
  assert.ok(Array.isArray(REFUSAL_PATTERNS))
  for (const phrase of ['无法完成', '不能完成', '无法继续', '抱歉', '对不起', '无法执行', 'cannot complete', 'unable to']) {
    assert.ok(REFUSAL_PATTERNS.includes(phrase), `词表缺少既有项：${phrase}`)
  }
  assert.ok(REFUSAL_PATTERN instanceof RegExp)
  assert.equal(REFUSAL_PATTERN.flags.includes('g'), false, 'g 标志会把 lastIndex 状态带进两次调用')
  // 大小写不敏感（英文词表只在英文产出里出现）
  assert.equal(refusalHit('Unable to complete the task')?.phrase.toLowerCase(), 'unable to')
  // 两次调用结果一致（无 g 状态残留）
  assert.equal(refusalHit('无法执行').phrase, refusalHit('无法执行').phrase)
  // 上下文：前后各 ~40 字符、空白压平
  const hit = refusalHit(`${repeat('a', 100)} 无法执行 ${repeat('b', 100)}`)
  assert.ok(hit)
  assert.equal(hit.phrase, '无法执行')
  assert.ok(hit.context.length <= 40 + '无法执行'.length + 40)
  assert.equal(hit.context.includes('\n'), false)
  // 正常交付文本不命中
  assert.equal(refusalHit('667 个用例全部通过，产物已落盘。'), null)
})
