/**
 * T106 · CHG-135（docs/20 §5.2）：成员卡（MemberCard）—— 子代理 / 会话依附角色的落盘事实。
 *
 * 断言：
 *  ① 路径形状：`<teamDir>/members/<memberId>/member.json`（会话 id **只在团队目录内**）；
 *  ② 写读往返：`writeMemberCard` → `readMemberCard` 字段一致；
 *  ③ **原子写**：写完不残留 `.tmp-*` 文件；
 *  ④ 校验守门：缺 `roleId` / 非法 `status` / `skills` 非数组 → 抛 `MT_VALIDATION`（**不落盘**）；
 *  ⑤ 读兼容：卡片不存在 / 坏 JSON → `undefined`（不抛，调用方回落投影）；
 *  ⑥ `listMemberCards` 坏卡跳过并按 id 排序。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  MEMBER_CARD_FILE,
  listMemberCards,
  memberCardPath,
  readMemberCard,
  validateMemberCard,
  writeMemberCard,
  type MemberCard,
} from '../src/core/members/member-card.ts'

const card = (overrides: Partial<MemberCard> = {}): MemberCard => ({
  version: 1,
  memberId: 'm-1',
  teamId: 'team-1',
  roleId: 'developer',
  instanceName: 'dev-1',
  sessionId: 'sess-9c2e',
  status: 'active',
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
})

test('t106-1: 路径形状 —— 只在团队目录内', () => {
  const path = memberCardPath('/ws/.dsh-myteam/tasks/team-1', 'm-1')
  assert.equal(path, join('/ws/.dsh-myteam/tasks/team-1', 'members', 'm-1', MEMBER_CARD_FILE))
  assert.ok(path.endsWith(`members${sep}m-1${sep}member.json`))
  assert.equal(MEMBER_CARD_FILE, 'member.json')
})

test('t106-2: 写读往返 + 原子（无 tmp 残留）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t106-'))
  try {
    const { filePath } = writeMemberCard(dir, card())
    assert.equal(filePath, memberCardPath(dir, 'm-1'))
    const read = readMemberCard(dir, 'm-1')
    assert.deepEqual(read, card())
    assert.equal(read?.sessionId, 'sess-9c2e', '会话 id 必须落在卡上（R3）')
    const memberDir = join(dir, 'members', 'm-1')
    assert.deepEqual(readdirSync(memberDir), ['member.json'], '不得残留临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t106-3: 校验守门 —— 非法卡不落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t106b-'))
  try {
    for (const [bad, field] of [
      [card({ memberId: '' }), 'memberId'],
      [card({ teamId: '' }), 'teamId'],
      [card({ roleId: '' }), 'roleId'],
      [card({ status: 'nope' as never }), 'status'],
      [card({ skills: 'x' as never }), 'skills'],
    ] as const) {
      assert.throws(() => writeMemberCard(dir, bad as MemberCard), (error: any) => error?.code === 'MT_VALIDATION' && error?.field === field)
    }
    assert.equal(existsSync(join(dir, 'members')), false, '非法卡必须零写入')
    assert.equal(validateMemberCard(undefined).ok, false)
    assert.equal(validateMemberCard(card()).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('t106-4: 读兼容 + 列表 —— 不存在/坏 JSON 返回 undefined，坏卡跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t106c-'))
  try {
    assert.equal(readMemberCard(dir, 'missing'), undefined, '没有卡片必须回落（不抛）')
    assert.deepEqual(listMemberCards(dir), [])
    writeMemberCard(dir, card({ memberId: 'm-b' }))
    writeMemberCard(dir, card({ memberId: 'm-a' }))
    const badDir = join(dir, 'members', 'm-bad')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'member.json'), '{not json', 'utf8')
    const cards = listMemberCards(dir)
    assert.deepEqual(cards.map((entry) => entry.memberId), ['m-a', 'm-b'], '坏卡跳过 + 按 id 排序')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
