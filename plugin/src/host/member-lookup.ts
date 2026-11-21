/**
 * 成员查找（跨团队；CHG-213 从 `host.ts` 搬出，A6 入口层只减不增）。
 *
 * 两个口径必须只有一份实现：
 *   ① 查哪些团队——**已打开的** + **磁盘上有账本的**（重启后没打开过也要能找到成员）；
 *   ② 投影 → 成员实例的**字段归一**：投影是 `MemberProjection`（主键叫 `id`，不带 `teamId`），
 *      成员族用的是 `MemberInstance`（`memberId` / `teamId`）。旧实现直接 `as` 强转后比较
 *      `member.memberId`，于是 `memberById` **永远返回 undefined**（`teamId` 也是 undefined
 *      → 成员工具的 teamId 全错）。实测由 `myteam_message` 的 delivered:false 暴露。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { storeLayout } from '../core/workspace/layout.ts'
import type { MemberInstance } from '../core/members/member-setup.ts'

/** 宿主面（只列用到的成员） */
export interface MemberLookupHost {
  /** 已打开的团队 id（TeamService 缓存键） */
  openTeamIds: () => string[]
  /** 团队投影（惰性打开；只要读 members） */
  membersOf: (teamId: string) => Record<string, { id?: unknown; sessionId?: unknown }>
  /** 项目根（账本目录从这里推） */
  workspaceRoot: () => string
}

export function createMemberLookup(host: MemberLookupHost) {
  function memberMatching(match: (member: MemberInstance) => boolean, teamId?: string): MemberInstance | undefined {
    const teamIds = new Set(host.openTeamIds())
    try {
      const tasksDir = storeLayout(host.workspaceRoot()).tasks
      for (const id of readdirSync(tasksDir)) if (existsSync(join(tasksDir, id, 'ledger.jsonl'))) teamIds.add(id)
    } catch { /* 目录不可读：只查已开团队 */ }
    /* 成员 id 只在**团队内**唯一（`m1-implementer` 每个团队都有）——给了 teamId 就只查该团队，
     * 否则会跨团队串到同名的另一个成员上（实测：新团队的消息被当成老团队同名成员去投递）。 */
    for (const id of teamId === undefined ? teamIds : [teamId]) {
      try {
        for (const projected of Object.values(host.membersOf(id))) {
          const member = { ...projected, memberId: projected.id, teamId: id } as unknown as MemberInstance
          if (match(member)) return member
        }
      } catch { continue }
    }
    return undefined
  }

  return {
    /** 按成员会话 id 找（成员工具 / 上岗简报 / 收窄都走这条；会话 id 全局唯一，不需要 teamId） */
    bySession: (sessionId: string): MemberInstance | undefined => memberMatching((member) => member.sessionId === sessionId),
    /** 按 memberId 找（**必须带 teamId**：成员 id 只在团队内唯一） */
    byId: (memberId: string, teamId?: string): MemberInstance | undefined =>
      memberMatching((member) => member.memberId === memberId, teamId),
  }
}
