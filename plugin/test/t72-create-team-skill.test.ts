/**
 * T72（M2-7 / FR-18）+ CHG-102：队长技能里的「建团队」与「写章程」。
 *
 * 背景：PRD §5 FR-18 与任务板 M2-7 要求一个**团队章程技能**——产出
 * ①团队能力与边界 ②约束与文件治理章程，落在**项目层**（`.dsh-myteam/structure.md`）。
 *
 * CHG-102 修订（用户定案 2026-11-07「你创建角色、创建团队的这个技能做得不对」）：
 * 旧 `create-team` **名不副实**——名字叫建团队，正文却在写章程（不建名册、不派任务）。
 * 现在拆成两个技能：
 *   - `create-team`        = 创建项目级团队（名册 + 任务 DAG，落 `.dsh-myteam/`）；
 *   - `write-team-charter` = 写章程（只写 `structure.md`，不建名册不派任务）。
 *
 * 本文件只测**技能注册面**（纯数据，无 IO）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPTAIN_SKILLS } from '../src/core/roles/captain-skills.ts'

/** 既有四个技能（CHG-53 / CHG-57）：改动前必须一个不少 */
const EXISTING_SKILLS = ['create-role', 'modify-role', 'choose-team-template', 'manage-team-template'] as const

test('t72-1: CAPTAIN_SKILLS 含 create-team / write-team-charter，且既有四个技能一个不少', () => {
  const names = CAPTAIN_SKILLS.map((s) => s.name)
  assert.ok(names.includes('create-team'), 'create-team 未注册')
  // CHG-102：章程从 create-team 拆出独立技能
  assert.ok(names.includes('write-team-charter'), 'write-team-charter 未注册（章程与建团队已分家）')
  for (const name of EXISTING_SKILLS) {
    assert.ok(names.includes(name), `既有技能 ${name} 被误删`)
  }
  assert.equal(CAPTAIN_SKILLS.length, EXISTING_SKILLS.length + 2, '技能总数应为 6（4 既有 + create-team + write-team-charter）')
  // 名字不重复
  assert.equal(new Set(names).size, names.length, '技能名不得重复')
})

test('t72-2: create-team / write-team-charter 字段完整（名称/描述/触发语/正文）', () => {
  for (const name of ['create-team', 'write-team-charter']) {
    const skill = CAPTAIN_SKILLS.find((s) => s.name === name)
    assert.ok(skill, `${name} 未注册`)
    assert.equal(typeof skill!.description, 'string')
    assert.ok(skill!.description.trim().length > 0, `${name} 描述不得为空`)
    assert.equal(typeof skill!.whenToUse, 'string')
    assert.ok(skill!.whenToUse!.trim().length > 0, `${name} whenToUse 不得为空`)
    assert.equal(typeof skill!.content, 'string')
    assert.ok(skill!.content.trim().length > 0, `${name} 正文不得为空`)
  }
})

test('t72-3: write-team-charter 正文覆盖「能力与边界 / 章程 / 文件治理」三块必须写的内容', () => {
  const skill = CAPTAIN_SKILLS.find((s) => s.name === 'write-team-charter')
  assert.ok(skill)
  const content = skill!.content
  // ①团队能力与边界 ②约束与文件治理章程（PRD FR-18 的两项职责）
  assert.ok(content.includes('团队能力与边界'), '必须写「团队能力与边界」')
  assert.ok(content.includes('约束与文件治理章程'), '必须写「约束与文件治理章程」')
  assert.ok(content.includes('边界'), '必须出现「边界」')
  assert.ok(content.includes('章程'), '必须出现「章程」')
  assert.ok(content.includes('文件治理'), '必须出现「文件治理」')
  // 落点：项目层 structure.md
  assert.ok(content.includes('.dsh-myteam/structure.md'), '必须指明项目层落点 .dsh-myteam/structure.md')
  // 纪律：写章程的技能，不越权建名册/派任务
  assert.ok(content.includes('不建名册'), '必须声明不建名册')
  assert.ok(content.includes('不派任务'), '必须声明不派任务')
  assert.ok(content.includes('不越权'), '必须有不越权边界段')
  // 定位：项目层、每个项目一份（FR-18「放在每个项目里」）
  assert.ok(content.includes('项目层'), '必须声明章程落在项目层')
  assert.ok(content.includes('每个项目一份'), '必须声明每个项目一份（不是每团队一份）')
})

test('t72-4: create-team 触发语覆盖「建团队 / 项目级别 / 名册 / 任务」', () => {
  const skill = CAPTAIN_SKILLS.find((s) => s.name === 'create-team')
  assert.ok(skill)
  const when = skill!.whenToUse!
  for (const keyword of ['团队', '项目级别', '名册']) {
    assert.ok(when.includes(keyword), `whenToUse 缺触发关键词「${keyword}」`)
  }
  // CHG-102：建团队正文必须写清落盘位置（项目级 .dsh-myteam/）
  assert.ok(skill!.content.includes('.dsh-myteam/config/teams/'), '必须写清团队模板落点')
  assert.ok(skill!.content.includes('.dsh-myteam/tasks/'), '必须写清任务账本落点')
  assert.ok(skill!.content.includes('myteam_submit_plan'), '必须把「提交草稿」指给 myteam_submit_plan')
})

test('t72-5: create-team 不教建成员（成员由批准后的 spawn 管线负责）', () => {
  const skill = CAPTAIN_SKILLS.find((s) => s.name === 'create-team')
  assert.ok(skill)
  const content = skill!.content
  // 建团队 = 草稿（名册 + 任务 DAG）；真正召唤成员是批准后的事，不该在本技能里手把手教
  assert.ok(!content.includes('myteam_spawn_member'), '建团队技能不得出现 myteam_spawn_member（成员由批准管线召唤）')
})
