/**
 * 人类确认令牌（HumanAuthorizer）。
 *
 * 解决的是「怎么证明这次写是用户本人同意的」——`actor:'human'` 参数和
 * `confirm:true` 字段都只是普通数据，任何人（包括模型）都能填。
 *
 * 令牌绑定五件事，服务端在提交时必须逐项复验：
 *   1. operationId —— 哪一次操作；
 *   2. action —— 哪一类人类专属动作；
 *   3. targetHash —— 用户看到并同意的那份内容；
 *   4. impactHash —— 用户看到的那个影响面（引用、覆盖、不可逆后果）；
 *   5. 一次性 nonce + 过期时间 —— 防重放与无限期有效。
 *
 * 任何一项对不上都拒绝，并且**不做自动重试或自动 rebase**：上游变了就让用户
 * 重新看差异、重新确认。审计只保存 nonce 的 hash，不保存令牌本体。
 */
import { ERROR_CODES, fail } from '../../contracts/errors.ts'
import type { ActorRef } from '../../contracts/events.ts'
import { hashContent } from '../../contracts/json.ts'

export type HumanAction =
  | 'definition.publish'
  | 'definition.publish.confirm'
  | 'definition.delete'
  | 'definition.global.write'
  | 'team.disband'
  | 'plan.approve'
  | 'captain.takeover'
  | 'project.destroy'
  | 'migration.cutover'

export interface ConfirmationRequest {
  operationId: string
  action: HumanAction
  /** 目标内容的规范化 hash。 */
  targetHash: string
  /** 影响面的规范化 hash（引用列表、覆盖对象、不可逆后果）。 */
  impactHash: string
}

export interface HumanConfirmation {
  operationId: string
  action: HumanAction
  targetHash: string
  impactHash: string
  /** 令牌本体只在签发时返回一次；服务端与审计只保存它的 hash。 */
  nonce: string
  nonceHash: string
  issuedAt: string
  expiresAt: string
  confirmedBy: string
}

export interface HumanAuthorizerOptions {
  now: () => string
  /** 一次性随机串；测试注入确定性实现。 */
  createNonce: () => string
  /** 令牌有效期，默认 10 分钟。 */
  ttlMs?: number
}

export class HumanAuthorizer {
  private readonly options: HumanAuthorizerOptions
  private readonly used = new Set<string>()

  constructor(options: HumanAuthorizerOptions) {
    this.options = options
  }

  /**
   * 签发令牌。只有 human 能签发——这是「入口不可伪造」的第一道，但不是唯一
   * 一道：调用方仍必须来自 DSH 不向模型暴露的用户操作通道。
   */
  issue(request: ConfirmationRequest, actor: ActorRef): HumanConfirmation {
    if (actor.kind !== 'human') {
      fail(ERROR_CODES.HUMAN_ONLY, '只有人类可以签发确认令牌', { details: { action: request.action, actorKind: actor.kind } })
    }
    if (request.targetHash.trim().length === 0 || request.impactHash.trim().length === 0) {
      fail(ERROR_CODES.INVALID_PAYLOAD, '确认令牌必须绑定目标 hash 与影响面 hash')
    }

    const nonce = this.options.createNonce()
    const nonceHash = hashContent({ nonce })
    if (this.used.has(nonceHash)) {
      fail(ERROR_CODES.HUMAN_CONFIRMATION_INVALID, 'nonce 重复，疑似重放')
    }

    const issuedAt = this.options.now()
    const expiresAt = new Date(Date.parse(issuedAt) + (this.options.ttlMs ?? 600_000)).toISOString()
    if (Number.isNaN(Date.parse(expiresAt))) {
      fail(ERROR_CODES.INTERNAL, '无法计算确认令牌过期时间')
    }

    return {
      operationId: request.operationId,
      action: request.action,
      targetHash: request.targetHash,
      impactHash: request.impactHash,
      nonce,
      nonceHash,
      issuedAt,
      expiresAt,
      confirmedBy: actor.userId,
    }
  }

  /**
   * 复验令牌。
   *
   * 顺序有意为之：先校验身份与绑定（便宜且确定），再看过期，最后检查重放。
   * 「目标变了」与「过期」分开报错，因为用户要做的事不同：前者要重新看差异，
   * 后者只需重新确认。
   */
  verify(confirmation: HumanConfirmation, request: ConfirmationRequest): void {
    if (confirmation.operationId !== request.operationId || confirmation.action !== request.action) {
      fail(ERROR_CODES.HUMAN_CONFIRMATION_INVALID, '确认令牌与操作不匹配', {
        details: { expectedOperation: request.operationId, tokenOperation: confirmation.operationId },
      })
    }
    if (confirmation.targetHash !== request.targetHash) {
      fail(ERROR_CODES.CONFIRMATION_TARGET_CHANGED, '目标内容在确认后已变化，请重新查看差异并确认', {
        details: { confirmedHash: confirmation.targetHash, currentHash: request.targetHash },
      })
    }
    if (confirmation.impactHash !== request.impactHash) {
      fail(ERROR_CODES.CONFIRMATION_TARGET_CHANGED, '影响面在确认后已变化，请重新查看并确认', {
        details: { confirmedImpact: confirmation.impactHash, currentImpact: request.impactHash },
      })
    }
    if (Date.parse(confirmation.expiresAt) <= Date.parse(this.options.now())) {
      fail(ERROR_CODES.HUMAN_CONFIRMATION_EXPIRED, '确认令牌已过期，请重新确认', {
        details: { expiresAt: confirmation.expiresAt },
      })
    }
    if (this.used.has(confirmation.nonceHash)) {
      fail(ERROR_CODES.HUMAN_CONFIRMATION_INVALID, '确认令牌已被使用（一次性）')
    }
  }

  /** 复验通过后消费 nonce：同一令牌不能被用第二次。 */
  consume(confirmation: HumanConfirmation): void {
    this.used.add(confirmation.nonceHash)
  }

  /** 已消费数量（诊断用，不含令牌内容）。 */
  consumedCount(): number {
    return this.used.size
  }
}