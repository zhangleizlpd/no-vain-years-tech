import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InspectAccountStatusByIdUseCase } from '../account/inspect-account-status-by-id.usecase';
import { CommitWechatBindUseCase } from '../account/commit-wechat-bind.usecase';
import { WECHAT_AUTH, type WechatAuthPort } from './wechat-auth.port';
import { WechatAlreadyBoundException } from './wechat-already-bound.exception';
import { WechatAccountAlreadyBoundException } from './wechat-account-already-bound.exception';

/**
 * BindWechat (auth 编排, authed) —— 绑定微信 (FR-S02, O7/R2)。
 *
 * accountId 来自 JWT。流: resolveIdentity(authCode) 换 openid (tx 外, 外部 I/O
 * 不持锁) → account 读半段判账号状态门槛 (仅 ACTIVE 可绑) → 非 ACTIVE 折叠反枚举
 * 401 `INVALID_CREDENTIALS` → account 写半段 create 绑定 → 4 态裁决:
 *   - CREATED / IDEMPOTENT → 成功返回 (O7: 同 201, controller @HttpCode(201))
 *   - CONFLICT → 409 `WECHAT_ALREADY_BOUND_OTHER` (openid 被他号占)
 *   - SELF_DIFFERENT → 409 `WECHAT_ACCOUNT_ALREADY_BOUND` (R2: 本账号已绑别的微信)
 *
 * MUST NOT 改 profile —— commit 层保证不回填 displayName/头像 (FR-S02)。
 */
@Injectable()
export class BindWechatUseCase {
  constructor(
    @Inject(WECHAT_AUTH) private readonly wechatAuth: WechatAuthPort,
    // CROSS-CONTEXT-SYNC: auth→account 读账号状态门槛 (R2 只读)
    private readonly inspectAccountStatusById: InspectAccountStatusByIdUseCase,
    // CROSS-CONTEXT-SYNC: auth→account create wechat binding (R2 写)
    private readonly commitWechatBind: CommitWechatBindUseCase,
  ) {}

  async execute(accountId: bigint, authCode: string): Promise<void> {
    const { openid, unionid } = await this.wechatAuth.resolveIdentity(authCode);

    const inspection = await this.inspectAccountStatusById.execute(accountId);
    if (inspection.kind !== 'ACTIVE') {
      // 反枚举折叠: NOT_FOUND / FROZEN / ANONYMIZED 一律同一 401, 字节级一致。
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    const result = await this.commitWechatBind.execute(accountId, openid, unionid);
    switch (result) {
      case 'CREATED':
      case 'IDEMPOTENT':
        return; // O7: 创建与自号幂等同 201
      case 'CONFLICT':
        throw new WechatAlreadyBoundException();
      case 'SELF_DIFFERENT':
        throw new WechatAccountAlreadyBoundException();
    }
  }
}
