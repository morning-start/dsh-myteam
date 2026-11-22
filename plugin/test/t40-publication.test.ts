/**
 * t40：全局发布（项目 → `$DSH_HOME/myteam`）。
 *
 * 为什么这组测试值钱：发布是唯一**跨作用域**的写——账本在项目里，文件在全局库里，
 * 中间还有人类的确认令牌。任何一步「看起来成功了」都不算数：必须同时验账本（requested
 * → authorized → outcome）、文件（内容与原子写）、审计（global-operations.jsonl），
 * 以及三条负路径（令牌绑定的影响面变了、agent 不能确认、写失败要落 failed）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectWorkflowCommand } from '../src/application/commands.ts'
import { confirmDefinitionPublication, requestDefinitionPublication } from '../src/application/publication.ts'
import { applyPanelWrite, createPanelWriteAuthorizer, previewPanelWrite } from '../src/application/panel-writes.ts'
import { FIXTURE_HUMAN, FIXTURE_NOW, createReviewTaskFixture } from './fixtures/review-task.ts'
import { HumanAuthorizer } from '../src/domain/permissions/human-authorizer.ts'
import { MyTeamError } from '../src/contracts/errors.ts'
import { createGlobalPublisher, globalEntryFile } from '../src/infrastructure/global-library/write.ts'
import { readGlobalAudit, readGlobalLibrary } from '../src/infrastructure/global-library/library.ts'
import type { TaskTemplate } from '../src/contracts/entities.ts'
import type { ActorRef } from '../src/contracts/events.ts'

function authorizer(): HumanAuthorizer {
  let counter = 0
  return new HumanAuthorizer({ now: () => FIXTURE_NOW, createNonce: () => `nonce-${++counter}`, ttlMs: 60_000 })
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof MyTeamError, `应抛 MyTeamError，实际 ${String(error)}`)
    assert.equal(error.code, code)
    return
  }
  assert.fail(`应抛 ${code}`)
}

function issue(auth: HumanAuthorizer, preview: { operationId: string; targetHash: string; impactHash: string }) {
  return auth.issue(
    {
      operationId: preview.operationId,
      action: 'definition.publish.confirm',
      targetHash: preview.targetHash,
      impactHash: preview.impactHash,
    },
    FIXTURE_HUMAN,
  )
}

function template(key: string, roleId: string): TaskTemplate {
  return {
    key,
    title: key,
    description: '',
    acceptance: ['done'],
    requiredRoleId: roleId,
    dependsOn: [],
    gate: { commands: [], requireEvidence: true, requireArtifacts: false },
    deliverable: null,
  }
}

test('发布角色：requested 落账 → 确认后写出文件、审计与 outcome', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-pub-' })
  const globalRoot = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  try {
    const publisher = createGlobalPublisher(globalRoot)
    const auth = authorizer()

    const preview = requestDefinitionPublication(fx.runtime, { publisher }, { actor: FIXTURE_HUMAN, kind: 'role', id: fx.roleId })
    assert.match(preview.summary, /发布角色/)
    assert.equal(preview.impact.overwrites, false, '全局库还空着，不该说覆盖')
    assert.equal(preview.targetHash, preview.target.targetHash)

    const requested = fx.runtime.readEvents().find((event) => event.type === 'definition.publication.requested')
    assert.ok(requested !== undefined, 'requested 必须落账本（否则事后查不到谁想发）')
    assert.equal((requested!.payload as { operationId: string }).operationId, preview.operationId)

    const token = issue(auth, preview)
    const result = confirmDefinitionPublication(fx.runtime, { authorizer: auth, publisher }, {
      actor: FIXTURE_HUMAN,
      operationId: preview.operationId,
      kind: 'role',
      id: fx.roleId,
      confirmation: token,
    })
    assert.equal(result.outcome, 'published')

    const file = join(globalRoot, globalEntryFile('role', fx.roleId))
    assert.ok(existsSync(file), '全局库里应出现定义文件')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { id: string; revision: number }
    assert.equal(parsed.id, fx.roleId)

    const types = fx.runtime.readEvents().map((event) => event.type)
    assert.ok(types.includes('definition.publication.authorized'), '缺 authorized')
    assert.ok(types.includes('definition.publication.outcome'), '缺 outcome')

    const audit = readGlobalAudit(globalRoot, 10)
    assert.equal(audit.items.length, 1, '每个发布动作都要留一条全局审计')
    assert.equal(audit.items[0]!.operationId, preview.operationId)
    assert.equal(audit.items[0]!.status, 'published')

    const library = readGlobalLibrary(globalRoot)
    assert.equal(library.counts.role, 1, '只读视图要能看见刚发布的角色')
    assert.equal(library.entries[0]!.id, fx.roleId)

    // 再发一次：这次是覆盖，影响面要如实说。
    const again = requestDefinitionPublication(fx.runtime, { publisher }, { actor: FIXTURE_HUMAN, kind: 'role', id: fx.roleId })
    assert.equal(again.impact.overwrites, true)
    assert.match(again.summary, /覆盖/)
  } finally {
    fx.dispose()
    rmSync(globalRoot, { recursive: true, force: true })
  }
})

test('工作流发布：引用与缺失引用都算进影响面', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-pub-' })
  const globalRoot = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  try {
    const publisher = createGlobalPublisher(globalRoot)
    const workflow = createProjectWorkflowCommand(fx.runtime, {
      actor: FIXTURE_HUMAN,
      name: '发布流程',
      description: '',
      templates: [template('build', fx.roleId), template('ghost', 'role_missing')],
    })
    const workflowId = (workflow.events[0]!.payload as { workflow: { id: string } }).workflow.id

    const preview = requestDefinitionPublication(fx.runtime, { publisher }, {
      actor: FIXTURE_HUMAN,
      kind: 'workflow',
      id: workflowId,
    })
    assert.deepEqual(
      preview.impact.references.map((reference) => reference.id).sort(),
      [fx.roleId, 'role_missing'].sort(),
      '两个模板的角色引用都要列出来',
    )
    assert.deepEqual(preview.impact.missingReferences, ['role:role_missing'], '项目里没有的角色要标成缺失')
  } finally {
    fx.dispose()
    rmSync(globalRoot, { recursive: true, force: true })
  }
})

test('令牌绑的是影响面：预览后全局库被写、再确认必须失效', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-pub-' })
  const globalRoot = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  try {
    const publisher = createGlobalPublisher(globalRoot)
    const auth = authorizer()
    const preview = requestDefinitionPublication(fx.runtime, { publisher }, { actor: FIXTURE_HUMAN, kind: 'role', id: fx.roleId })
    const token = issue(auth, preview)

    // 预览之后，全局库里已经有人写了同名定义：影响面从「新增」变成「覆盖」。
    publisher.publish({
      kind: 'role',
      id: fx.roleId,
      definition: { id: fx.roleId, revision: 1 },
      operationId: 'op_other',
      revision: 1,
      sourceProjectId: 'prj_other',
      publishedAt: FIXTURE_NOW,
    })

    expectCode(
      () =>
        confirmDefinitionPublication(fx.runtime, { authorizer: auth, publisher }, {
          actor: FIXTURE_HUMAN,
          operationId: preview.operationId,
          kind: 'role',
          id: fx.roleId,
          confirmation: token,
        }),
      'CONFIRMATION_TARGET_CHANGED',
    )
  } finally {
    fx.dispose()
    rmSync(globalRoot, { recursive: true, force: true })
  }
})

test('agent 不能确认发布：HUMAN_ONLY', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-pub-' })
  const globalRoot = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  try {
    const publisher = createGlobalPublisher(globalRoot)
    const auth = authorizer()
    const preview = requestDefinitionPublication(fx.runtime, { publisher }, { actor: FIXTURE_HUMAN, kind: 'role', id: fx.roleId })
    const token = issue(auth, preview)
    const captain: ActorRef = { kind: 'captain', teamId: fx.teamId, sessionId: 'ses_cap', generation: 1 }

    expectCode(
      () =>
        confirmDefinitionPublication(fx.runtime, { authorizer: auth, publisher }, {
          actor: captain,
          operationId: preview.operationId,
          kind: 'role',
          id: fx.roleId,
          confirmation: token,
        }),
      'HUMAN_ONLY',
    )
    assert.equal(existsSync(join(globalRoot, globalEntryFile('role', fx.roleId))), false, '被拒绝的发布不能留下文件')
  } finally {
    fx.dispose()
    rmSync(globalRoot, { recursive: true, force: true })
  }
})

test('写全局库失败：账本落 outcome=failed，错误码 GLOBAL_PUBLISH_FAILED', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-pub-' })
  try {
    const broken = {
      exists: () => false,
      publish: () => {
        throw new Error('disk full')
      },
    }
    const auth = authorizer()
    const preview = requestDefinitionPublication(fx.runtime, { publisher: broken }, { actor: FIXTURE_HUMAN, kind: 'role', id: fx.roleId })
    const token = issue(auth, preview)

    expectCode(
      () =>
        confirmDefinitionPublication(fx.runtime, { authorizer: auth, publisher: broken }, {
          actor: FIXTURE_HUMAN,
          operationId: preview.operationId,
          kind: 'role',
          id: fx.roleId,
          confirmation: token,
        }),
      'GLOBAL_PUBLISH_FAILED',
    )

    const outcome = fx.runtime
      .readEvents()
      .filter((event) => event.type === 'definition.publication.outcome')
      .at(-1)
    assert.ok(outcome !== undefined, '失败也要落 outcome，账本不能停在「已授权」')
    const payload = outcome!.payload as { outcome: string; globalHash: string | null }
    assert.equal(payload.outcome, 'failed')
    assert.equal(payload.globalHash, null)
  } finally {
    fx.dispose()
  }
})

test('定义不存在：发布申请直接 NOT_FOUND', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-pub-' })
  const globalRoot = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  try {
    const publisher = createGlobalPublisher(globalRoot)
    expectCode(
      () => requestDefinitionPublication(fx.runtime, { publisher }, { actor: FIXTURE_HUMAN, kind: 'role', id: 'role_missing' }),
      'NOT_FOUND',
    )
  } finally {
    fx.dispose()
    rmSync(globalRoot, { recursive: true, force: true })
  }
})

test('面板写通道：definitionPublish 预览签发令牌 → 凭令牌发布到全局库', () => {
  const fx = createReviewTaskFixture({ prefix: 'myteam-pub-' })
  const globalRoot = mkdtempSync(join(tmpdir(), 'myteam-global-'))
  try {
    const publisher = createGlobalPublisher(globalRoot)
    const auth = createPanelWriteAuthorizer()

    const preview = previewPanelWrite(fx.runtime, auth, 'definitionPublish', { kind: 'role', id: fx.roleId }, { publisher })
    assert.match(preview.summary, /全局库/)
    assert.equal(preview.confirmation.action, 'definition.publish.confirm')

    const applied = applyPanelWrite(
      fx.runtime,
      auth,
      'definitionPublish',
      { params: { kind: 'role', id: fx.roleId }, confirmation: preview.confirmation, reason: '发布到全局' },
      { publisher },
    )
    assert.equal(applied.operationId, preview.operationId)
    assert.match(String((applied.committed as { file: string }).file), /roles\//)
    assert.ok(existsSync(join(globalRoot, globalEntryFile('role', fx.roleId))))
  } finally {
    fx.dispose()
    rmSync(globalRoot, { recursive: true, force: true })
  }
})