/**
 * t69：补上两个「只有预览、没有执行」的令牌写方法。
 *
 * 背景（CHG-214 拆分时扫出来的真 bug）：`globalUnpublish` 与 `projectDestroy` 在
 * `PANEL_WRITE_KINDS` 里登记为 `token`、预览分支也在，但 `applyPanelWrite` 的 switch
 * 里**没有对应 case** —— 用户点「确认」会落到 `default` 报「未实现的写方法」。
 * 更糟的是当时 `TokenPanelWriteMethod` 因为注解拓宽塌成了 `never`，`default` 里的
 * `const exhaustive: never = method` 变成空转，编译器完全看不见漏的 case。
 *
 * 这组用例钉住补好之后的不变量：
 *   1. 预览签发令牌 → 凭令牌确认**真的执行**（下架只隐藏不删文件；销毁真的删目录）；
 *   2. 令牌绑定的目标变了（文件被改 / 目录里又多写了东西）→ 拒绝，且不留半截副作用；
 *   3. 不可逆动作的名字校验在服务端（不能只靠界面拦）；
 *   4. 端口没装配 → INTERNAL，而不是静默跳过这一步写动作；
 *   5. 走错通道（把 direct 方法发给令牌通道）→ 明确报错，而不是「未实现」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyDirectPanelWrite,
  applyPanelWrite,
  createPanelWriteAuthorizer,
  previewPanelWrite,
} from '../src/application/panel-writes.ts'
import { createGlobalEditor, globalEntryFile } from '../src/infrastructure/global-library/write.ts'
import { readGlobalLibrary } from '../src/infrastructure/global-library/library.ts'
import { createProjectDestroyer } from '../src/infrastructure/fs/project-destroy.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { EVENTS_FILE } from '../src/contracts/versions.ts'
import { createReviewTaskFixture } from './fixtures/review-task.ts'

/** 全局方法免会话：装配层传的就是 undefined，用例里同样不造项目运行时。 */
const NO_RUNTIME = undefined as never

const ROLE = {
  profile: { name: '实现者', purpose: '实现', instructions: '按 AC', specialties: [] },
  capabilities: { tools: { allow: ['read'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
}

function codeOf(error: unknown): string {
  return error instanceof MyTeamError ? error.code : `NOT_MYTEAM_ERROR(${String(error)})`
}

function withGlobalRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'myteam-t69-global-'))
  return body(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

function seedGlobalRole(root: string): string {
  return createGlobalEditor(root).writeFile({
    kind: 'role',
    id: 'role_1',
    definition: ROLE,
    revision: 1,
    operationId: 'op_seed',
    expectedHash: null,
    editedAt: '2026-01-01T00:00:00.000Z',
    editor: 'owner',
  }).globalHash
}

function withAuditDir(body: (auditFile: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'myteam-t69-audit-'))
  return body(join(dir, 'global-operations.jsonl')).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function readAudit(auditFile: string): Array<Record<string, unknown>> {
  if (!existsSync(auditFile)) return []
  return readFileSync(auditFile, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('globalUnpublish：预览 → 凭令牌确认，目录里看不到但文件还在', async () => {
  await withGlobalRoot(async (root) => {
    seedGlobalRole(root)
    assert.equal(readGlobalLibrary(root).entries.length, 1, '下架前目录里有一条')

    const editor = createGlobalEditor(root)
    const auth = createPanelWriteAuthorizer()

    const preview = previewPanelWrite(NO_RUNTIME, auth, 'globalUnpublish', { kind: 'role', id: 'role_1' }, {
      globalEditor: editor,
    })
    assert.equal(preview.confirmation.action, 'definition.global.write', '令牌绑的是全局写这类动作')

    const applied = await applyPanelWrite(
      NO_RUNTIME,
      auth,
      'globalUnpublish',
      {
        params: { kind: 'role', id: 'role_1', expectedHash: preview.confirmation.targetHash },
        confirmation: preview.confirmation,
        reason: '面板确认（下架全局定义）',
      },
      { globalEditor: editor },
    )

    assert.equal(applied.operationId, preview.operationId, '返回的是这一次操作')
    assert.equal(readGlobalLibrary(root).entries.length, 0, '下架后目录里不再出现')
    assert.ok(existsSync(join(root, globalEntryFile('role', 'role_1'))), '文件必须还在 —— 下架不是删除')
    assert.deepEqual(editor.hiddenIds('role'), ['role_1'], '隐藏索引里能查到')
  })
})

test('globalDefinitionSave：免会话确认也能落库（不能向 runtime 要时间）', async () => {
  await withGlobalRoot(async (root) => {
    const editor = createGlobalEditor(root)
    const entries = { list: () => [] }
    const auth = createPanelWriteAuthorizer()

    const preview = previewPanelWrite(NO_RUNTIME, auth, 'globalDefinitionSave', {
      kind: 'role',
      id: 'role_save_1',
      definition: ROLE,
      expectedHash: null,
    }, { globalEditor: editor, globalEntries: entries })
    assert.equal(preview.confirmation.action, 'definition.global.write')

    const applied = await applyPanelWrite(
      NO_RUNTIME,
      auth,
      'globalDefinitionSave',
      {
        params: { kind: 'role', id: 'role_save_1', definition: ROLE, expectedHash: null },
        confirmation: preview.confirmation,
        reason: '验收：写入全局角色',
      },
      { globalEditor: editor, globalEntries: entries },
    )

    assert.equal((applied.committed as { outcome: string }).outcome, 'edited')
    assert.ok(existsSync(join(root, globalEntryFile('role', 'role_save_1'))), '文件要真的写出来')
    assert.equal(readGlobalLibrary(root).entries.length, 1, '目录里能看到')
  })
})

test('globalUnpublish：令牌签完之后文件被改 → 拒绝，不能把别人的新版本藏掉', async () => {
  await withGlobalRoot(async (root) => {
    const hash = seedGlobalRole(root)
    const editor = createGlobalEditor(root)
    const auth = createPanelWriteAuthorizer()

    const preview = previewPanelWrite(NO_RUNTIME, auth, 'globalUnpublish', { kind: 'role', id: 'role_1' }, {
      globalEditor: editor,
    })

    // 预览之后有人改了这份定义：hash 变了，令牌绑的已经是旧内容。
    editor.writeFile({
      kind: 'role',
      id: 'role_1',
      definition: { profile: { ...ROLE.profile, purpose: '别人刚改过' }, capabilities: ROLE.capabilities },
      revision: 2,
      operationId: 'op_other',
      expectedHash: hash,
      editedAt: '2026-01-02T00:00:00.000Z',
      editor: 'other',
    })

    await assert.rejects(
      () => applyPanelWrite(
        NO_RUNTIME,
        auth,
        'globalUnpublish',
        { params: { kind: 'role', id: 'role_1' }, confirmation: preview.confirmation, reason: '下架' },
        { globalEditor: editor },
      ),
      (error: unknown) => codeOf(error) === 'CONFIRMATION_TARGET_CHANGED',
    )
    assert.deepEqual(editor.hiddenIds('role'), [], '拒绝时不能留下隐藏索引')
    assert.equal(readGlobalLibrary(root).entries.length, 1, '拒绝时目录里还在')
  })
})

test('projectDestroy：预览 → 凭令牌确认，先关运行时再删，目录真的没了', async () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-t69-destroy-' })
  try {
    await withAuditDir(async (auditFile) => {
      const destroyer = createProjectDestroyer(auditFile)
      const auth = createPanelWriteAuthorizer()
      let closed = false
      const deps = {
        destroyer,
        rootDir: fx.dir,
        closeProject: async (): Promise<void> => {
          closed = true
          fx.runtime.close()
        },
      }

      const preview = previewPanelWrite(fx.runtime, auth, 'projectDestroy', {}, deps)
      assert.equal(preview.confirmation.action, 'project.destroy')
      const name = (preview.impact as { name: string }).name

      const applied = await applyPanelWrite(
        fx.runtime,
        auth,
        'projectDestroy',
        { params: { name }, confirmation: preview.confirmation, reason: '面板确认（删除项目数据）' },
        deps,
      )

      assert.equal(applied.operationId, preview.operationId)
      assert.equal(closed, true, '删目录前必须先关运行时（否则写者租约变成悬空锁）')
      assert.equal(existsSync(fx.dir), false, '目录必须真的没了')

      const audit = readAudit(auditFile)
      assert.equal(audit.length, 2, '一条 destroying、一条 destroyed')
      assert.equal(audit[0]!.status, 'destroying')
      assert.equal(audit[1]!.status, 'destroyed')
      assert.equal(audit[1]!.actor, 'panel:owner')
    })
  } finally {
    // 目录已被销毁：dispose 里的 runtime.close() 有 lease=null 的短路，rmSync 也是 force。
    fx.dispose()
  }
})

test('projectDestroy：名字不符 → 服务端拒绝，目录必须还在', async () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-t69-name-' })
  try {
    await withAuditDir(async (auditFile) => {
      const destroyer = createProjectDestroyer(auditFile)
      const auth = createPanelWriteAuthorizer()
      const deps = { destroyer, rootDir: fx.dir, closeProject: async (): Promise<void> => fx.runtime.close() }

      const preview = previewPanelWrite(fx.runtime, auth, 'projectDestroy', {}, deps)

      await assert.rejects(
        () => applyPanelWrite(
          fx.runtime,
          auth,
          'projectDestroy',
          { params: { name: '打错的名字' }, confirmation: preview.confirmation, reason: '删' },
          deps,
        ),
        (error: unknown) => codeOf(error) === 'PRECONDITION_FAILED',
      )
      assert.ok(existsSync(join(fx.dir, EVENTS_FILE)), '拒绝后事件日志必须还在')
      assert.equal(readAudit(auditFile).length, 0, '拒绝后不该写审计')
    })
  } finally {
    fx.dispose()
  }
})

test('projectDestroy：预览之后又多写了事件 → 令牌目标变了，拒绝删除', async () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-t69-growth-' })
  try {
    await withAuditDir(async (auditFile) => {
      const destroyer = createProjectDestroyer(auditFile)
      const auth = createPanelWriteAuthorizer()
      const deps = { destroyer, rootDir: fx.dir, closeProject: async (): Promise<void> => fx.runtime.close() }

      const preview = previewPanelWrite(fx.runtime, auth, 'projectDestroy', {}, deps)
      const name = (preview.impact as { name: string }).name

      // 预览之后项目又长胖了：字节数进了令牌的 targetHash。
      appendFileSync(join(fx.dir, EVENTS_FILE), '{"seq":99,"note":"预览之后新增"}\n', 'utf8')

      await assert.rejects(
        () => applyPanelWrite(
          fx.runtime,
          auth,
          'projectDestroy',
          { params: { name }, confirmation: preview.confirmation, reason: '删' },
          deps,
        ),
        (error: unknown) => codeOf(error) === 'CONFIRMATION_TARGET_CHANGED',
      )
      assert.ok(existsSync(fx.dir), '拒绝后目录必须还在')
    })
  } finally {
    fx.dispose()
  }
})

test('端口没装配 → INTERNAL，而不是静默跳过这一步', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-t69-wiring-' })
  try {
    const auth = createPanelWriteAuthorizer()
    assert.throws(
      () => previewPanelWrite(fx.runtime, auth, 'projectDestroy', {}, {}),
      (error: unknown) => codeOf(error) === 'INTERNAL',
    )
    assert.throws(
      () => previewPanelWrite(NO_RUNTIME, auth, 'globalUnpublish', { kind: 'role', id: 'role_1' }, {}),
      (error: unknown) => codeOf(error) === 'INTERNAL',
    )
  } finally {
    fx.dispose()
  }
})

test('走错通道 → 明确报「该走另一条通道」，不是「未实现」', async () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-t69-channel-' })
  try {
    const auth = createPanelWriteAuthorizer()
    // direct 方法发给令牌通道（异步函数里的 fail() 表现为 rejected promise）
    await assert.rejects(
      () => applyPanelWrite(fx.runtime, auth, 'gateVerdict', {
        params: {},
        confirmation: {} as never,
        reason: '',
      }),
      (error: unknown) => codeOf(error) === 'INVALID_COMMAND',
    )
    // token 方法发给直接确认通道
    assert.throws(
      () => applyDirectPanelWrite(fx.runtime, 'planApprove', { params: {}, confirm: true }),
      (error: unknown) => codeOf(error) === 'INVALID_COMMAND',
    )
  } finally {
    fx.dispose()
  }
})