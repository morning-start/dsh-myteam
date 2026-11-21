/**
 * 成员上岗简报（CHG-212 / ADR-010 P4b）：角色纪律 + 知识索引 + 记忆召回，压成一段提示词。
 *
 * 为什么需要它：成员改成子代理后，`setup` 里那些 section（角色提示词 / 知识索引 / 记忆纪律）
 * 一律注入不了了——子代理的 setup 是管理器私有的。于是改由成员 preset 在**首次提示词组装**时
 * 向 host 要这段文本（与 C5 收窄同一个时机，见 `src/member.ts`）。
 *
 * 纯函数：只读角色定义、成员身份与工作区；不碰 ctx、不写盘（记忆库由 `memoryBrief` 自己开关）。
 */
                                                               
import { memoryBrief } from '../memory/recall.mjs'
import { memoryPromptSection, memberPromptSection,                     } from './member-setup.mjs'
import { knowledgeDirOf, listKnowledge, renderIndexSection } from '../knowledge/knowledge.mjs'
import { memoryDirFor } from './memory.mjs'

                                   
                      
                        
                       
                                                        
                            
 

/** 角色纪律 + 知识索引 + 记忆召回（顺序即提示词里的顺序；空段自动省略） */
export function buildMemberBrief(input                  )         {
  const { role, member, workspaceRoot } = input
  const parts           = [memberPromptSection(role, member).text]

  try {
    const kb = listKnowledge(knowledgeDirOf(workspaceRoot))
    if (kb.length > 0) {
      const { text } = renderIndexSection(
        kb.map((entry) => ({
          id: entry.id, title: entry.title, tags: entry.tags, updated: entry.updated,
          unverified: entry.unverified, core: entry.core, staleSince: entry.staleSince,
          proofCount: entry.proofCount, audience: entry.audience ?? [], words: 0,
        })),
        { audience: member.roleId },
      )
      if (text.trim().length > 0) parts.push(text)
    }
  } catch { /* 知识库不可读：不阻断上岗（索引是增强） */ }

  const memory = memoryBrief(workspaceRoot, member.teamId, member.memberId)
  if (memory.count > 0) parts.push(memory.text)

  const discipline = memoryPromptSection(member, memoryDirFor(workspaceRoot, member.teamId, member.memberId), input.evidenceRequired ?? true)
  parts.push(discipline.text)

  return parts.filter((part) => part.trim().length > 0).join('\n\n')
}

//# sourceURL=./src/core/members/member-brief.ts