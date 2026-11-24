/**
 * t57：面板写 `globalDefinitionSave`（G3）—— 全局库直改的两段式通道。
 *
 * 锁住四件事：
 *   1. 它是 token 通道：`applyDirectPanelWrite` 必须拒绝（不能绕过预览与令牌）；
 *   2. 第一步 `previewPanelWrite` 给出影响面并签令牌，令牌 action 是 `definition.global.write`；
 *   3. 第二步凭令牌真正写文件，文件进全局目录；
 *   4. 伪造/篡改令牌被拒（目标 hash 不匹配）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectRuntime } from '../src/application/project-runtime.ts'
import { FileEventStore } from '../src/infrastructure/event-store/file-store.ts'
import { WriterLeaseManager } from '../src/infrastructure/event-store/writer-lease.ts'
import { ensureProjectManifest } from '../src/infrastructure/fs/project-manifest.ts'
import { initializeProject } from '../src/application/commands.ts'
import {
  applyDirectPanelWrite,
  applyPanelWrite,
  createPanelWriteAuthorizer,
  panelWriteKind,
  previewPanelWrite,
} from '../src/application/panel-writes.ts'
import type { PanelWriteDeps } from '../src/application/panel-writes.ts'
import { createGlobalEditor, globalEntryFile } from '../src/infrastructure/global-library/write.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { readFileSync } from 'node:fs'
import { join as joinPath, dirname as dirnamePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newId } from '../src/contracts/ids.ts'
import type { ActorRef } from '../src/contracts/events.ts'
import { EVENTS_FILE, WRITER_LOCK_FILE } from '../src/contracts/versions.ts'

const HUMAN: ActorRef = { kind: 'human', userId: 'user-1', via: 'confirmation' }
const NOW = '2026-01-01T00:00:00.000Z'

function openRuntime(dir: string): ProjectRuntime {
  const manifest = ensureProjectManifest(dir, { projectId: newId('project'), createdAt: NOW })
  return ProjectRuntime.open({
    projectId: manifest.projectId,
    eventStore: new FileEventStore(join(dir, EVENTS_FILE)),
    writerLock: new WriterLeaseManager(join(dir, WRITER_LOCK_FILE)),
    clock: { now: () => NOW },
    ids: newId,
  })
}

const ROLE = (name: string) => ({
  profile: { name, purpose: '实现', instructions: '按 AC', specialties: [] },
  capabilities: { tools: { allow: ['read', 'write'], deny: [] }, mcp: { allow: [], deny: [] }, skills: [] },
})

function withBoth(body: (runtime: ProjectRuntime, deps: PanelWriteDeps, globalRoot: string) => void): void {
  const projectDir = mkdtempSync(join(tmpdir(), 'myteam-t57-proj-'))
  const globalRoot = mkdtempSync(join(tmpdir(), 'myteam-t57-global-'))
  const runtime = openRuntime(projectDir)
  try {
    initializeProject(runtime, { actor: HUMAN, name: '全局直改项目' })
    const deps: PanelWriteDeps = {
      globalEditor: createGlobalEditor(globalRoot),
      globalEntries: { list: () => [] },
    }
    body(runtime, deps, globalRoot)
  } finally {
    runtime.close()
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(globalRoot, { recursive: true, force: true })
  }
}

test('globalDefinitionSave 登记为 token 通道', () => {
  assert.equal(panelWriteKind('globalDefinitionSave'), 'token')
})

test('applyDirectPanelWrite 拒绝 globalDefinitionSave（不能绕过令牌直接执行）', () => {
  withBoth((runtime, deps) => {
    assert.throws(
      () => applyDirectPanelWrite(runtime, 'globalDefinitionSave', {
        confirm: true,
        params: { kind: 'role', id: 'role_1', definition: ROLE('实现者'), expectedHash: null },
      }, deps),
      (error: unknown) => error instanceof MyTeamError,
    )
  })
})

test('两步：先出影响面与令牌，再凭令牌写文件（进全局目录）', () => {
  withBoth((runtime, deps, globalRoot) => {
    const authorizer = createPanelWriteAuthorizer()
    const params = { kind: 'role', id: 'role_1', definition: ROLE('实现者'), expectedHash: null }

    // 第一步：预览 + 令牌
    const preview = previewPanelWrite(runtime, authorizer, 'globalDefinitionSave', params, deps)
    assert.ok(typeof preview.confirmation === 'object' && preview.confirmation !== null, '第一步要签出令牌')
    assert.ok(String(preview.summary).includes('role_1'), '影响面要说清改的是哪份')

    // 第二步：凭令牌执行
    const applied = applyPanelWrite(runtime, authorizer, 'globalDefinitionSave', {
      params: { ...params, expectedHash: null },
      confirmation: preview.confirmation!,
      reason: '改个描述',
    }, deps)

    assert.equal(applied.method, 'globalDefinitionSave')
    assert.ok(existsSync(join(globalRoot, globalEntryFile('role', 'role_1'))), '文件必须真的写进全局目录')
  })
})

test('伪造令牌（目标 hash 不匹配）被拒，且不写文件', () => {
  withBoth((runtime, deps, globalRoot) => {
    const authorizer = createPanelWriteAuthorizer()
    assert.throws(
      () => applyPanelWrite(runtime, authorizer, 'globalDefinitionSave', {
        params: { kind: 'role', id: 'role_1', definition: ROLE('实现者'), expectedHash: null },
        confirmation: {
          operationId: 'forged',
          action: 'definition.global.write',
          targetHash: 'sha256:deadbeef',
          impactHash: 'impact:bad',
          nonceHash: 'nonce',
          expiresAt: '2099-01-01T00:00:00.000Z',
          confirmedBy: 'owner',
        } as never,
        reason: '伪造',
      }, deps),
      (error: unknown) => error instanceof MyTeamError,
    )
    assert.equal(existsSync(join(globalRoot, globalEntryFile('role', 'role_1'))), false, '伪造令牌不能写文件')
  })
})

test('装配层守卫：composition/panel.ts 必须把 globalEditor 与 globalEntries 传进写通道', () => {
  const here = dirnamePath(fileURLToPath(import.meta.url))
  const root = joinPath(here, '..', 'src', 'composition', 'panel.ts')
  const source = readFileSync(root, 'utf8')
  // t55/t56/t57 都是直接注入 deps，抓不到「端口写了、装配层没接」这种漏法。
  assert.ok(source.includes('createGlobalEditor('), '装配层必须建 globalEditor')
  const activeLines = source.split('\n').map((line) => line.trim()).filter((line) => !line.startsWith('//'))
  assert.ok(activeLines.some((line) => line === 'globalEditor,'), 'writeDeps 必须带上 globalEditor（且不能被注释掉）')
  assert.ok(activeLines.some((line) => line === 'globalEntries,'), 'writeDeps 必须带上 globalEntries（直改的引用校验要读全局目录）')
  assert.ok(/previewPanelWrite([^)]*writeDeps)/s.test(source) || source.includes('params, writeDeps)'), '预览必须传 writeDeps')
  assert.ok(source.includes('writeDeps)'), '确认必须传 writeDeps')
})
