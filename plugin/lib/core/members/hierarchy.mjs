/**
 * CHG-187（FR-32 支柱一）：成员派生树的**纯规则层**。
 * 三件事：深度、直接子、级联顺序。都不碰 IO，方便单测与复用（宿主/面板/工具共用）。
 *
 * ── 语义（docs/23 §③）────────────────────────────────────────────────────────
 *  - **深度**：队长直接召唤的成员深度 0，其子成员深度 1……`limits.memberMaxDepth` 限的是
 *    子成员还能往下几层（默认 1、硬上限 2）；
 *  - **子数**：每个成员最多 `limits.maxChildren` 个直接子成员（默认 3、硬上限 5）；
 *  - **级联顺序**：释放是**倒序**的——叶子先、父最后。反过来（父先没了）子成员会一瞬间变成
 *    没有父的孤儿，面板上就再也拼不回这棵树。
 *
 * ── 为什么是纯函数 ───────────────────────────────────────────────────────────
 * 这三条规则同时被宿主写路径（spawn/release）、面板名册（listMembers）和工具面用到。
 * 塞进任何一处都会让另外两处各写一遍，而「深度算错一级」这类缺陷在真机上极难复现。
 */
import { MTError } from '../errors.mjs'

                             
            
                               
               
                      
 

/** 派生深度（未知成员按根 0 处理——读旧账本时不该炸） */
export const depthOf = (roster              , id        )         =>
  roster.find((x) => x.id === id)?.depth ?? 0

/** 直接子成员（不含孙子；顺序 = 账本顺序） */
export const childrenOf = (roster              , id        )               =>
  roster.filter((x) => x.parentMemberId === id)

/** 倒序 = 叶子先、父最后（释放级联必须这个顺序，否则父先没了子就成孤儿） */
export function cascadeOrder(roster              , rootId        )           {
  const out           = []
  const walk = (id        ) => { for (const child of childrenOf(roster, id)) walk(child.id); out.push(id) }
  walk(rootId)
  return out
}

/**
 * 派生准入（深度 + 子数，**拒绝式**）。
 *
 * `parentId === null` = 队长直接召唤的根成员，与派生树无关，永远放行。
 * 父成员不存在 → `MT_VALIDATION`（不是静默当根成员：那会把拼错的 id 变成一条假父子边。
 * 不新增「找不到」专用码 —— 「成员不存在」在本仓统一走 `MT_VALIDATION` + 消息点名（见
 * `releaseMember` / `memberOp`），多一个近义码只会让客户端分支更难写）。
 */
export function assertSpawnAllowed(
  roster              ,
  parentId               ,
  limits                                           ,
)       {
  if (parentId === null) return
  const parent = roster.find((x) => x.id === parentId)
  if (!parent) throw new MTError('MT_VALIDATION', `parent member ${parentId} not found`)
  const depth = parent.depth + 1
  if (depth > limits.maxDepth) {
    throw new MTError('MT_DEPTH_EXCEEDED', `depth ${depth} > maxDepth ${limits.maxDepth}`)
  }
  const count = childrenOf(roster, parentId).length
  if (count >= limits.maxChildren) {
    throw new MTError('MT_CHILDREN_LIMIT', `children ${count} >= maxChildren ${limits.maxChildren}`)
  }
}

/** 投影的 `members` 是 `Record<memberId, …>`；树规则按数组走（顺序 = 账本顺序，级联顺序可预期） */
export const rosterOf = (members                            )               => Object.values(members)

/** spawn 落账本用的派生树三字段 */
                                  
                               
               
                      
 

/**
 * 团队配置的 `limits` → 派生树配额。
 *
 * 为什么要有这层改名：配置面（`team-config.ts` / schema / 文档）叫 `memberMaxDepth`（历史字段名，
 * 改名会破配置兼容），规则面叫 `maxDepth`（规则就是规则，不带域前缀）。**只在一处映射**，
 * 免得两个地方各写一遍 `memberMaxDepth` → `maxDepth` 然后写错一个。
 */
export const spawnLimitsOf = (limits                                                 )                                            => ({
  maxDepth: limits.memberMaxDepth,
  maxChildren: limits.maxChildren,
})

/**
 * 算派生树字段（**落账本前**算，宿主只负责塞进 payload）。
 *
 * 先过准入（深度 / 子数 / 父成员存在），再算：根成员（`parentId === null`）的
 * `rootMemberId` 是**它自己**——这样「按 root 树对账」对根成员也成立，不用特判。
 */
export function spawnTreeFields(
  roster              ,
  memberId        ,
  parentId               ,
  limits                                           ,
)                  {
  assertSpawnAllowed(roster, parentId, limits)
  if (parentId === null) return { parentMemberId: null, depth: 0, rootMemberId: memberId }
  const parent = roster.find((x) => x.id === parentId) 
  return { parentMemberId: parentId, depth: parent.depth + 1, rootMemberId: parent.rootMemberId }
}

/**
 * 释放顺序（FR-32 排空纪律）：有子成员且未声明 `cascade` → **拒绝**（`MT_HAS_CHILDREN`）。
 *
 * 抛错发生在**任何 commit 之前**，所以「被拒 = 账本零写入」是结构保证，不是约定。
 * 放行时返回**倒序** id 序列（叶子先、父最后）。
 */
export function releaseOrder(roster              , memberId        , cascade         )           {
  const kids = childrenOf(roster, memberId)
  if (kids.length > 0 && !cascade) {
    throw new MTError('MT_HAS_CHILDREN', `${memberId} 还有 ${kids.length} 个子成员；传 cascade:true 倒序级联释放`)
  }
  return cascadeOrder(roster, memberId)
}


//# sourceURL=./src/core/members/hierarchy.ts