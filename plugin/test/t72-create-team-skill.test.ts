/**
 * T72（M2-7 / FR-18）：create-team 团队章程技能。
 *
 * 背景：PRD §5 FR-18 与任务板 M2-7 要求一个**团队章程技能**——产出
 * ①团队能力与边界 ②约束与文件治理章程，落在**项目层**（`.team-workplace/structure.md`，
 * 与 host-workspace.ensureWorkplaceDirs 预置的骨架同一路径），供队长按需引用。
 *
 * 本文件只测**技能注册面**（纯数据，无 IO）：
 *  - create-team 存在、字段完整、正文覆盖必须写的三块（能力与边界 / 章程 / 文件治理）；
 *  - 落点路径与宿主实际约定一致（`.team-workplace/structure.md`）；
 *  - 四个既有技能仍在、数量未被误改（防误删）；
 *  - create-team **不越权**：正文不含建成员/建任务的工具名（那两个是队长本来就有的独立工具，
 *    章程技能不该重复教）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPTAIN_SKILLS } from '../src/core/roles/captain-skills.ts'

/** 既有四个技能（CHG-53 / CHG-57）：改动前必须一个不少 */
const EXISTING_SKILLS = ['create-role', 'modify-role', 'choose-team-template', 'manage-team-template'] as const

test('t72-1: CAPTAIN_SKILLS 含 create-team，且既有四个技能一个不少', () => {
  const names = CAPTAIN_SKILLS.map((s) => s.name)
  assert.ok(names.includes('create-team'), 'create-team 未注册')
  for (const name of EXISTING_SKILLS) {
    assert.ok(names.includes(name), `既有技能 ${name} 被误删`)
  }
  assert.equal(CAPTAIN_SKILLS.length, EXISTING_SKILLS.length + 1, '技能总数应为 5（4 既有 + create-team）')
  // 名字不重复
  assert.equal(new Set(names).size, names.length, '技能名不得重复')
})

test('t72-2: create-team 字段完整（名称/描述/触发语/正文）', () => {
  const skill = CAPTAIN_SKILLS.find((s) => s.name === 'create-team')
  assert.ok(skill, 'create-team 未注册')
  assert.equal(typeof skill!.description, 'string')
  assert.ok(skill!.description.trim().length > 0, '描述不得为空')
  assert.equal(typeof skill!.whenToUse, 'string')
  assert.ok(skill!.whenToUse!.trim().length > 0, 'whenToUse 不得为空')
  assert.equal(typeof skill!.content, 'string')
  assert.ok(skill!.content.trim().length > 0, '正文不得为空')
})

test('t72-3: create-team 正文覆盖「能力与边界 / 章程 / 文件治理」三块必须写的内容', () => {
  const skill = CAPTAIN_SKILLS.find((s) => s.name === 'create-team')
  assert.ok(skill)
  const content = skill!.content
  // ①团队能力与边界 ②约束与文件治理章程（PRD FR-18 的两项职责）
  assert.ok(content.includes('团队能力与边界'), '必须写「团队能力与边界」')
  assert.ok(content.includes('约束与文件治理章程'), '必须写「约束与文件治理章程」')
  assert.ok(content.includes('边界'), '必须出现「边界」')
  assert.ok(content.includes('章程'), '必须出现「章程」')
  assert.ok(content.includes('文件治理'), '必须出现「文件治理」')
  // 落点：项目层 structure.md（host-workspace.ensureWorkplaceDirs 预置的同一路径）
  assert.ok(content.includes('.team-workplace/structure.md'), '必须指明项目层落点 .team-workplace/structure.md')
  // 纪律：写章程的技能，不越权建名册/派任务
  assert.ok(content.includes('不建名册'), '必须声明不建名册')
  assert.ok(content.includes('不派任务'), '必须声明不派任务')
  assert.ok(content.includes('不越权'), '必须有不越权边界段')
  // 定位：项目层、每个项目一份（FR-18「放在每个项目里」）
  assert.ok(content.includes('项目层'), '必须声明章程落在项目层')
  assert.ok(content.includes('每个项目一份'), '必须声明每个项目一份（不是每团队一份）')
})

test('t72-4: create-team 触发语覆盖「组建团队/写章程/定边界/文件治理」', () => {
  const skill = CAPTAIN_SKILLS.find((s) => s.name === 'create-team')
  assert.ok(skill)
  const when = skill!.whenToUse!
  for (const keyword of ['组建团队', '章程', '边界', '文件治理']) {
    assert.ok(when.includes(keyword), `whenToUse 缺触发关键词「${keyword}」`)
  }
})

test('t72-5: create-team 不教建成员/建任务（那两件事是队长既有的独立工具）', () => {
  const skill = CAPTAIN_SKILLS.find((s) => s.name === 'create-team')
  assert.ok(skill)
  const content = skill!.content
  assert.ok(!content.includes('myteam_spawn_member'), '章程技能不得出现 myteam_spawn_member（建成员不归它）')
  assert.ok(!content.includes('myteam_create_task'), '章程技能不得出现 myteam_create_task（派任务不归它）')
  // 反向：它只能把组队/改名指给队长本就有的工具
  assert.ok(content.includes('myteam_submit_plan'), '应把「组队」指给既有工具 myteam_submit_plan')
  assert.ok(content.includes('myteam_update_team'), '应把「改团队名/目标」指给既有工具 myteam_update_team')
})
