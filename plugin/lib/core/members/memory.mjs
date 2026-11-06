/**
 * 成员记忆数据层（T19，CHG-19，FR-6.1/6.2 + ADR-009）。
 *
 * 设计（ADR-009）：文件即真相 + 事后审计。
 *  - 记忆区 = state/teams/<teamId>/members/<memberId>/memory/（memory.md + notes/）
 *  - 跨会话持久（FR-6.1）：seedMemoryIfMissing 幂等，已存在不覆盖
 *  - 写入纪律（FR-6.2）：提示词层约束（member-setup T20 section）；host 层事后审计
 *    —— auditMemoryFile 解析条目级/frontmatter 级 evidence 指针，违规记 findings
 *  - R26：播种用 host 进程 fs（由 host.ts 在 spawn 流程调用，本文件纯函数不碰 ctx）
 *  - FR-6.4（不宣告交接）在提示词层（T20），不在本文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** 成员记忆目录（FR-6.1：绑定成员身份，随 identity 目录走） */
export function memoryDirFor(workspaceRoot        , teamId        , memberId        )         {
  return [workspaceRoot, '.team-workplace', 'state', 'teams', teamId, 'members', memberId, 'memory'].join('/')
}

/** memory.md 种子模板（frontmatter 归因头 + 占位正文；契约 docs/04 §1.2b） */
export function memorySeedTemplate(member                                                                            )         {
  const now = new Date().toISOString()
  return [
    '---',
    `member: ${member.memberId}`,
    `role: ${member.roleId}`,
    `team: ${member.teamId}`,
    'evidence: none',
    `updated: ${now}`,
    '---',
    '',
    `# 私有记忆（${member.instanceName}）`,
    '',
    '（此文件是你的私有记忆区，跨会话保留。记录任务中学到的项目背景、踩坑、口径。',
    '写入纪律见系统提示词：每条记忆必带证据指针，写在条目标题下一行：evidence: <taskId|账本seq|文件路径>。）',
    '',
  ].join('\n')
}

/**
 * 播种记忆目录（FR-6.1：激活时确保存在；幂等——已存在不覆盖，跨会话不重置）。
 * 返回是否实际播种（供 host 记日志）。
 * R26 注意：此函数必须在 host 进程内调用（插件服务 fs），不经 bash/成员子进程。
 */
export function seedMemoryIfMissing(
  dir        ,
  member                                                                            ,
)                                            {
  const memoryMdPath = [dir, 'memory.md'].join('/')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(memoryMdPath)) {
    writeFileSync(memoryMdPath, memorySeedTemplate(member), 'utf8')
    return { seeded: true, memoryMdPath }
  }
  return { seeded: false, memoryMdPath }
}

/* ── 审计（FR-6.2 事后审计；memory.evidenceRequired=true 时由 host 调用）── */

                                
              
                
                                               
 

                                    
                      
                           
                    
 

/** 解析 frontmatter（--- 包围的 key: value 区；不求全，只取审计需要的键） */
export function parseFrontmatter(text        )                                                 {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { data: {}, body: text }
  const data                         = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (kv) data[kv[1]] = kv[2].trim()
  }
  return { data, body: text.slice(m[0].length).replace(/^\r?\n/, '') }
}

/**
 * 审计单个 memory .md 内容（契约 docs/04 §1.2b）：
 *  - 条目单位 = 正文二级节 `## <条目标题>`；条目头紧跟 `evidence: <指针>` 行（允许空行/注释间隔后仍命中）
 *  - 条目级 evidence 优先于 frontmatter 级
 *  - 无二级节 → 整文件按单条目审计（用 frontmatter evidence）
 *  - 种子模板（无条目、frontmatter evidence: none）不算违规
 *  - evidence 值为 'none'/空 → empty-evidence；键缺失 → missing-evidence
 */
export function auditMemoryContent(fileName        , text        )                    {
  const { data, body } = parseFrontmatter(text)
  const findings                  = []

  // 按 ## 二级节切条目
  const sections = body.split(/^##\s+/m).slice(1) // 第 0 段是 frontmatter 后的引导文
  const entries = sections.map((sec) => {
    const lines = sec.split(/\r?\n/)
    return { title: (lines[0] ?? '').trim(), content: lines.slice(1).join('\n') }
  })

  if (entries.length === 0) {
    // 无条目：整文件按 frontmatter 审计；frontmatter 缺 evidence 键不算违规（种子/轻量使用）
    const v = (data.evidence ?? '').trim()
    if (data.evidence !== undefined && v.length > 0 && v.toLowerCase() !== 'none') {
      // frontmatter 有有效 evidence：合法
    }
    // 引导文中若出现裸 `evidence:` 行（无二级节的手写条目）也审计
    // 注意用 [ \t]* 而非 \s*：\s 含换行，会把下一行内容吞进值里
    const bare = /^evidence[ \t]*:[ \t]*(.*)$/m.exec(body)
    if (bare && (bare[1].trim().length === 0 || bare[1].trim().toLowerCase() === 'none')) {
      findings.push({ file: fileName, reason: 'empty-evidence' })
    } else if (bare && bare[1].trim().length > 0) {
      // 有效指针，合法
    }
  } else {
    for (const e of entries) {
      // 条目级 evidence：条目正文里第一处 `evidence:` 行
      const m = /^[ \t]*evidence[ \t]*:[ \t]*(.*)$/m.exec(e.content)
      if (!m) {
        // 无条目级 evidence：回退 frontmatter 级
        const v = (data.evidence ?? '').trim()
        if (data.evidence === undefined) {
          findings.push({ file: fileName, entry: e.title || undefined, reason: 'missing-evidence' })
        } else if (v.length === 0 || v.toLowerCase() === 'none') {
          findings.push({ file: fileName, entry: e.title || undefined, reason: 'empty-evidence' })
        }
      } else if (m[1].trim().length === 0 || m[1].trim().toLowerCase() === 'none') {
        findings.push({ file: fileName, entry: e.title || undefined, reason: 'empty-evidence' })
      }
    }
  }

  return { checkedFiles: 1, findings, violations: findings.length }
}


//# sourceURL=file:///E:/Workplace/extension/dsh-myteam/plugin/src/core/members/memory.ts