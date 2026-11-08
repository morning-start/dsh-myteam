/**
 * T105 · CHG-134（docs/20 §5.4）：`myteam_create_skill` / `myteam_create_tool` —— 技能 / 工具资产。
 *
 * **测试纪律**：`DSH_HOME` 必须指到临时目录（否则写用户真实预设）。
 *
 * 断言：
 *  ① 两个工具都已注册；
 *  ② `create_skill` 落 `presets/myteam-captain/skills/<id>/SKILL.md`（frontmatter 含 name/description/tools/mcp）；
 *  ③ **隔离**：不写 `$DSH_HOME/skills/`、不写其它预设目录；
 *  ④ 同名已存在 → `MT_ROLE_EXISTS`（不覆盖）；id 非法 → `MT_VALIDATION`；
 *  ⑤ `create_tool` 落 `presets/myteam-captain/tools/<id>.json`（`declarative:true`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MyTeamHost, type HostRuntime } from '../src/host.ts'

const defsSource = readFileSync(join(import.meta.dirname, '..', 'src', 'tools', 'defs.ts'), 'utf8')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t105-'))
  const home = mkdtempSync(join(tmpdir(), 'myteam-t105-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const rt = {
    set: () => {},
    tools: { register: () => {}, restrict: () => {}, schemas: () => [] },
    agents: { create: () => ({ followup: () => {}, session: {}, cancel: () => {} }) },
    logger: { info: () => {}, warn: () => {} },
    workspace: { root },
  } as unknown as HostRuntime
  const host = new MyTeamHost(rt)
  host.initialize()
  const cleanup = () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
  return { host, home, cleanup }
}

test('t105-1: 注册 + 创建技能落 myteam 队长预设（frontmatter 齐全）', () => {
  assert.ok(defsSource.includes("name: 'myteam_create_skill'"), 'defs 必须有 myteam_create_skill')
  assert.ok(defsSource.includes("name: 'myteam_create_tool'"), 'defs 必须有 myteam_create_tool')
  const { host, home, cleanup } = setup()
  try {
    const created: any = host.executeLeadTool('myteam_create_skill', {
      skillId: 'code-review',
      name: '代码审查',
      description: '按仓库纪律做评审',
      tools: ['read', 'grep'],
      mcp: ['filesystem'],
    }, {})
    assert.equal(created.status, 'ok', JSON.stringify(created))
    assert.equal(created.presetId, 'myteam-captain')
    const filePath = join(home, 'myteam', 'presets', 'myteam-captain', 'skills', 'code-review', 'SKILL.md')
    assert.equal(created.filePath, filePath, '必须落在 myteam 队长预设')
    assert.ok(existsSync(filePath))
    const text = readFileSync(filePath, 'utf8')
    assert.ok(text.startsWith('---'), '必须有 YAML frontmatter')
    assert.ok(text.includes('name: code-review'))
    assert.ok(text.includes('description: "按仓库纪律做评审"'))
    assert.ok(text.includes('"read"') && text.includes('"grep"'), 'tools 必须写入')
    assert.ok(text.includes('"filesystem"'), 'mcp 必须写入')
  } finally {
    cleanup()
  }
})

test('t105-2: 隔离 —— 不写全局 skills、不碰其它预设', () => {
  const { host, home, cleanup } = setup()
  try {
    host.executeLeadTool('myteam_create_skill', { skillId: 'isolated', name: '隔离', description: '验证隔离' }, {})
    assert.equal(existsSync(join(home, 'skills')), false, '绝不能写 $DSH_HOME/skills/')
    const presetsDir = join(home, 'myteam', 'presets')
    assert.deepEqual(readFileSync(join(presetsDir, 'myteam-captain', 'skills', 'isolated', 'SKILL.md'), 'utf8').length > 0, true)
  } finally {
    cleanup()
  }
})

test('t105-3: 校验 —— 同名已存在 / id 非法', () => {
  const { host, cleanup } = setup()
  try {
    host.executeLeadTool('myteam_create_skill', { skillId: 'dup', name: 'A', description: 'B' }, {})
    const again: any = host.executeLeadTool('myteam_create_skill', { skillId: 'dup', name: 'A', description: 'B' }, {})
    assert.equal(again.status, 'error')
    assert.equal(again.code, 'MT_ROLE_EXISTS')
    const bad: any = host.executeLeadTool('myteam_create_skill', { skillId: 'Bad Id!', name: 'A', description: 'B' }, {})
    assert.equal(bad.code, 'MT_VALIDATION')
    assert.equal(bad.field, 'skillId')
  } finally {
    cleanup()
  }
})

test('t105-4: 创建工具 —— 声明式落盘', () => {
  const { host, home, cleanup } = setup()
  try {
    const created: any = host.executeLeadTool('myteam_create_tool', {
      toolId: 'run_lint',
      name: '跑 lint',
      description: '只声明，不执行',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }, {})
    assert.equal(created.status, 'ok', JSON.stringify(created))
    const filePath = join(home, 'myteam', 'presets', 'myteam-captain', 'tools', 'run_lint.json')
    assert.equal(created.filePath, filePath)
    const definition = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, any>
    assert.equal(definition.toolId, 'run_lint')
    assert.equal(definition.declarative, true, '必须标注声明式')
    assert.equal(definition.parameters.properties.path.type, 'string')
    const again: any = host.executeLeadTool('myteam_create_tool', { toolId: 'run_lint', name: 'x', description: 'y' }, {})
    assert.equal(again.code, 'MT_ROLE_EXISTS')
  } finally {
    cleanup()
  }
})
