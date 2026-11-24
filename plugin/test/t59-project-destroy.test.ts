/**
 * t59：项目数据销毁（`project.destroy`）—— 不可逆动作的三条不变量。
 *
 * 设计稿 `p-settings`：「删除事件日志、SQLite 与生成视图，不可撤销。」
 * 这里钉住四件事：
 *   1. 预览列出要删的每一样东西与总字节数，且**不删任何东西**；
 *   2. 输入的项目名与 manifest 不符 → 拒绝，目录必须还在；
 *   3. 销毁前先写全局审计（因为项目的账本正是被删的东西），删完再写一条 destroyed；
 *   4. 销毁之后目录真的没了，且审计里能查到「谁删的、删了多大」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProjectDestroyer } from '../src/infrastructure/fs/project-destroy.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { EVENTS_FILE, MANIFEST_FILE } from '../src/contracts/versions.ts'

function withProject(body: (rootDir: string, auditFile: string) => Promise<void>): Promise<void> {
  const rootDir = mkdtempSync(join(tmpdir(), 'myteam-destroy-'))
  const auditDir = mkdtempSync(join(tmpdir(), 'myteam-audit-'))
  const auditFile = join(auditDir, 'global-operations.jsonl')
  mkdirSync(join(rootDir, '.dsh-myteam', 'events'), { recursive: true })
  mkdirSync(join(rootDir, 'memory'), { recursive: true })
  writeFileSync(join(rootDir, MANIFEST_FILE), JSON.stringify({ projectId: 'project_1', name: '演示项目', layoutVersion: 2 }), 'utf8')
  writeFileSync(join(rootDir, EVENTS_FILE), '{"seq":1}\n', 'utf8')
  writeFileSync(join(rootDir, 'memory', 'memory.db'), 'x'.repeat(64), 'utf8')
  return body(rootDir, auditFile).finally(() => {
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(auditDir, { recursive: true, force: true })
  })
}

function readAudit(auditFile: string): Array<Record<string, unknown>> {
  if (!existsSync(auditFile)) return []
  return readFileSync(auditFile, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test('预览：列出事件日志与记忆库，给出总字节数，且不删任何东西', async () => {
  await withProject(async (rootDir, auditFile) => {
    const destroyer = createProjectDestroyer(auditFile)
    const preview = destroyer.preview(rootDir)

    assert.equal(preview.name, '演示项目')
    assert.equal(preview.projectId, 'project_1')
    const paths = preview.targets.map((item) => item.path)
    assert.ok(paths.includes(EVENTS_FILE), '要列出事件日志')
    assert.ok(paths.includes('memory/memory.db'), '要列出记忆库')
    assert.ok(preview.totalBytes > 64, '总字节数要含记忆库那 64 字节')
    assert.ok(preview.irreversible.length >= 3, '要逐条写清不可逆后果')

    // 预览不删东西
    assert.ok(existsSync(join(rootDir, EVENTS_FILE)), '预览之后事件日志必须还在')
    assert.equal(readAudit(auditFile).length, 0, '预览不该写审计')
  })
})

test('名字不符 → 拒绝，目录与审计都不动', async () => {
  await withProject(async (rootDir, auditFile) => {
    const destroyer = createProjectDestroyer(auditFile)
    await assert.rejects(
      () => destroyer.destroy({
        rootDir,
        expectedName: '打错的名字',
        operationId: 'op_1',
        auditAt: '2026-01-01T00:00:00.000Z',
        actor: 'owner',
        closeRuntime: async () => false,
      }),
      (error: unknown) => error instanceof MyTeamError && error.code === 'PRECONDITION_FAILED',
    )
    assert.ok(existsSync(join(rootDir, EVENTS_FILE)), '拒绝后事件日志必须还在')
    assert.equal(readAudit(auditFile).length, 0, '拒绝后不该写审计')
  })
})

test('销毁：先写审计再删，目录真的没了，审计里能查到谁删的', async () => {
  await withProject(async (rootDir, auditFile) => {
    const destroyer = createProjectDestroyer(auditFile)
    let closed = false
    const result = await destroyer.destroy({
      rootDir,
      expectedName: '演示项目',
      operationId: 'op_destroy',
      auditAt: '2026-01-01T00:00:00.000Z',
      actor: 'owner',
      closeRuntime: async () => {
        closed = true
        return true
      },
    })

    assert.equal(result.destroyed, true)
    assert.equal(result.name, '演示项目')
    assert.equal(closed, true, '必须先关运行时再删目录')
    assert.equal(existsSync(rootDir), false, '目录必须真的删掉')

    const audit = readAudit(auditFile)
    const statuses = audit.map((entry) => entry.status)
    assert.deepEqual(statuses, ['destroying', 'destroyed'], '先记 destroying 再记 destroyed')
    assert.equal(audit[1]!.action, 'project.destroy')
    assert.equal(audit[1]!.actor, 'owner')
    assert.equal(audit[1]!.projectId, 'project_1')
    assert.ok(typeof audit[1]!.bytes === 'number')
  })
})

test('没有 manifest 的工作区 → 拒绝销毁（不是项目就别删）', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'myteam-nomanifest-'))
  const auditDir = mkdtempSync(join(tmpdir(), 'myteam-audit2-'))
  const auditFile = join(auditDir, 'global-operations.jsonl')
  try {
    const destroyer = createProjectDestroyer(auditFile)
    assert.throws(
      () => destroyer.preview(rootDir),
      (error: unknown) => error instanceof MyTeamError && error.code === 'PROJECT_NOT_INITIALIZED',
    )
    assert.ok(existsSync(rootDir), '拒绝之后目录不能被删')
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(auditDir, { recursive: true, force: true })
  }
})
