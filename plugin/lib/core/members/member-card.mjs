/**
 * CHG-135（docs/20 §5.2）：**成员卡**（MemberCard）——子代理 / 会话**依附角色**的落盘事实。
 *
 * 为什么需要：
 *  - 目前 `sessionId` 只活在投影内存（`projection.members[].sessionId`），进程重启后
 *    「这个成员用的是哪个会话」只能靠账本重放**推断**——而它是**归属事实**，不是派生量；
 *  - docs/20 §5.2 定案：成员卡落在团队目录内 `members/<memberId>/member.json`，
 *    `roleId` + `sessionId` + 成员级 `skills` / `mcpAllowlist` 覆盖 + `currentTaskId` 就地归属。
 *
 * 三条纪律：
 *  ① **只在团队目录内**（`members/<memberId>/member.json`）——会话 id 不散落全局；
 *  ② **原子写**（tmp + rename）——半截卡片比没有卡片更糟；
 *  ③ **读兼容**：卡片不存在时调用方回落投影（`readMemberCard` 返回 `undefined`，不抛）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeTextAtomic } from '../fs/write-log.mjs'

export const MEMBER_CARD_FILE = 'member.json'

                             
            
                  
                
                              
                
                      
                                
                    
                                 
                   
                         
                                             
                        
                                                     
                                
                
                       
                   
                   
 

/** 团队目录下的成员卡路径：`<teamDir>/members/<memberId>/member.json` */
export function memberCardPath(teamDir        , memberId        )         {
  return join(teamDir, 'members', memberId, MEMBER_CARD_FILE)
}

/** 成员卡必填字段校验（写前守门；不合法不落盘） */
export function validateMemberCard(card                                 )                                                   {
  if (!card || typeof card !== 'object') return { ok: false, field: 'card', reason: 'card 必须是对象' }
  if (!String(card.memberId ?? '').trim()) return { ok: false, field: 'memberId', reason: 'memberId 必填' }
  if (!String(card.teamId ?? '').trim()) return { ok: false, field: 'teamId', reason: 'teamId 必填' }
  if (!String(card.roleId ?? '').trim()) return { ok: false, field: 'roleId', reason: 'roleId 必填（成员依附角色）' }
  if (!['active', 'suspended', 'released'].includes(String(card.status))) {
    return { ok: false, field: 'status', reason: 'status 必须是 active / suspended / released' }
  }
  if (card.skills !== undefined && !Array.isArray(card.skills)) return { ok: false, field: 'skills', reason: 'skills 必须是字符串数组' }
  if (card.mcpAllowlist !== undefined && !Array.isArray(card.mcpAllowlist)) return { ok: false, field: 'mcpAllowlist', reason: 'mcpAllowlist 必须是字符串数组' }
  // CHG-187：派生树（可选；写了就必须是合法形状——半截的父子边比没有更难查）
  if (card.parentMemberId !== undefined && card.parentMemberId !== null && String(card.parentMemberId).trim().length === 0) {
    return { ok: false, field: 'parentMemberId', reason: 'parentMemberId 为空串（一级成员请写 null 或省略）' }
  }
  if (card.depth !== undefined && (!Number.isInteger(card.depth) || card.depth < 0)) {
    return { ok: false, field: 'depth', reason: 'depth 必须是非负整数' }
  }
  if (card.rootMemberId !== undefined && String(card.rootMemberId).trim().length === 0) {
    return { ok: false, field: 'rootMemberId', reason: 'rootMemberId 不能为空串' }
  }
  return { ok: true }
}

/**
 * 原子写成员卡（tmp + rename）。
 *
 * 半截卡片（进程被杀在写一半）会让「这个成员用哪个会话」变成脏数据，
 * 所以**必须先写临时文件再 rename**——要么完整，要么不存在。
 */
export function writeMemberCard(teamDir        , card            )                       {
  const check = validateMemberCard(card)
  if (!check.ok) throw Object.assign(new Error(`invalid member card: ${check.field} — ${check.reason}`), { code: 'MT_VALIDATION', field: check.field })
  const filePath = memberCardPath(teamDir, String(card.memberId))
  const dir = join(teamDir, 'members', String(card.memberId))
  mkdirSync(dir, { recursive: true })
  writeTextAtomic(filePath, `${JSON.stringify({ ...card, updatedAt: card.updatedAt || Date.now() }, null, 2)}\n`)
  return { filePath }
}

/** 读成员卡（不存在 → `undefined`，**不抛**：调用方回落投影） */
export function readMemberCard(teamDir        , memberId        )                         {
  const filePath = memberCardPath(teamDir, String(memberId))
  if (!existsSync(filePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))              
    return validateMemberCard(parsed).ok ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 列团队内全部成员卡（坏卡跳过；按 memberId 排序） */
export function listMemberCards(teamDir        )               {
  const membersDir = join(teamDir, 'members')
  if (!existsSync(membersDir)) return []
  const cards               = []
  for (const name of readdirSync(membersDir)) {
    const card = readMemberCard(teamDir, name)
    if (card) cards.push(card)
  }
  return cards.sort((a, b) => a.memberId.localeCompare(b.memberId))
}


//# sourceURL=./src/core/members/member-card.ts