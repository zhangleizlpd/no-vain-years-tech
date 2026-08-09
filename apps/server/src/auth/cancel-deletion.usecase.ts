import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { authConfig, type AuthConfig } from '../config/auth.config';
import { PrismaService } from '../security/prisma.service';
import { JwtTokenService } from '../security/jwt-token.service';
import { RefreshTokenService } from '../security/refresh-token.service';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import { InspectAccountStatusUseCase } from '../account/inspect-account-status.usecase';
import { CommitAccountCancellationUseCase } from '../account/commit-account-cancellation.usecase';
import { isWithinGrace } from '../account/account.rules';
import {
  ACCOUNT_DELETION_CANCELLED_EVENT_TYPE,
  buildAccountDeletionCancelledEvent,
} from '../account/account-deletion-cancelled.event';
import { DeletionCodeStore } from './deletion-code.store';
import { SmsPurpose, verifyDeletionCode } from './deletion-code.rules';
import { TIMING_DEFENSE_EXECUTOR, type TimingDefenseExecutor } from './timing-defense.port';
import type { LoginDeviceContext, PhoneSmsAuthResult } from './phone-sms-auth.usecase';

/**
 * CancelDeletion (auth 编排, **public unauthed, 持 tx**) —— 提交撤销码解冻 +
 * 重发登录态 (FR-S09/S10/S11/S12)。
 *
 * 反枚举折叠 (FR-S11): 5 类失败 (手机号未注册 / ACTIVE / ANONYMIZED / grace 已过 /
 * 码无效) 全部折叠为字节级一致 401 `INVALID_CREDENTIALS`。**两段都跑 timingDefense.pad()**
 * —— phone-class 4 类在 inspection 后 pad; code-class (eligible phone + 错码) 也 pad,
 * 否则 eligible 的快速 401 会与 phone-class 的慢 pad 可区分, 泄漏 FROZEN-in-grace 状态
 * (镜像 001 phone-sms-auth: ANONYMIZED 状态失败与码失败均 pad → 全失败时延均一)。
 *
 * **auth 持 tx 跨 3 ctx** (per delete-account 同范式; ADR-0032 编排 + ADR-0043 两段式
 * 委托写半段): 码校验在 tx 外 (fail-fast + pad); tx 内顺序委托 auth(markUsed) +
 * account(解冻) + security(持久化新 token) + outbox(发事件), 任一步失败整 tx 回滚
 * (FR-S10 原子性: 账号留 FROZEN / 码留 active / 无 token / 无事件)。
 *
 * 并发裁决 + 互斥 (FR-S12/S16, plan D2): tx 内 markUsed affected-count (码 exactly-once)
 * + commitAccountCancellation 的 `WHERE status=FROZEN AND freezeUntil>now` (解冻
 * exactly-once + 与匿名化 `<=now` 互斥)。任一 won=false → 折叠 401 回滚。
 */
@Injectable()
export class CancelDeletionUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deletionCodeStore: DeletionCodeStore,
    // CROSS-CONTEXT-SYNC: auth → account 读账号生命周期判 eligible + 取 accountId (R2 只读)
    private readonly inspectAccountStatus: InspectAccountStatusUseCase,
    // CROSS-CONTEXT-SYNC: auth → account 解冻 FROZEN→ACTIVE (R2 写, 失败回滚整请求)
    private readonly commitAccountCancellation: CommitAccountCancellationUseCase,
    // CROSS-CONTEXT-SYNC: auth → security 签发即持久化新 refresh-token (R2 写, 同 tx)
    private readonly refreshTokenService: RefreshTokenService,
    private readonly jwtTokenService: JwtTokenService,
    @Inject(TIMING_DEFENSE_EXECUTOR) private readonly timingDefense: TimingDefenseExecutor,
    @Inject(OUTBOX_PUBLISHER) private readonly outboxPublisher: OutboxPublisher,
    @Inject(authConfig.KEY) private readonly authCfg: AuthConfig,
  ) {}

  async execute(
    phone: string,
    code: string,
    device: LoginDeviceContext = {},
  ): Promise<PhoneSmsAuthResult> {
    const now = new Date();
    const inspection = await this.inspectAccountStatus.execute(phone);

    // phone-class 反枚举: 仅 FROZEN-in-grace eligible; 其余 4 类 pad + 折叠 401。
    if (inspection.kind !== 'FROZEN' || !isWithinGrace(inspection.freezeUntil, now)) {
      return this.failAntiEnum();
    }
    const { accountId } = inspection;

    // 码校验 (tx 外, 同 delete-account): findActive 滤 expired+used → null 覆盖 3 类,
    // verifyDeletionCode 覆盖 hash-mismatch。code-class 失败也 pad (见类注释: 防泄漏)。
    const stored = await this.deletionCodeStore.findActive(
      accountId,
      SmsPurpose.CANCEL_DELETION,
      now,
    );
    if (!stored || !verifyDeletionCode(code, stored.codeHash, this.authCfg.smsCodeHmacSecret)) {
      return this.failAntiEnum();
    }

    // 预生成 tokens (纯, 不落库; 持久化在 tx 内一并提交 / 回滚)。
    const accessToken = this.jwtTokenService.signAccessToken({ accountId });
    const refreshToken = this.jwtTokenService.generateRefreshToken();

    await this.prisma.$transaction(
      async (tx) => {
        // exactly-once 闸 1: markUsed 行写锁串行化同码并发, 恰 1 won; 输者 count=0 → 401 回滚。
        const claimed = await this.deletionCodeStore.markUsed(stored.id, now, tx);
        if (!claimed) {
          throw new UnauthorizedException('INVALID_CREDENTIALS');
        }

        // exactly-once 闸 2 + 互斥: 解冻 (won=false → 已被并发撤销 / scheduler 抢先匿名化
        // / grace 刚过) → 折叠 401 回滚 (不重复解冻 / 不重复发事件)。
        const { won } = await this.commitAccountCancellation.execute(tx, accountId, now);
        if (!won) {
          throw new UnauthorizedException('INVALID_CREDENTIALS');
        }

        // 签发即持久化新 refresh-token (R2, 同 tx; 抛则整 tx 回滚 → 无 token)。
        await this.refreshTokenService.persist(
          accountId,
          refreshToken,
          {
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            deviceType: device.deviceType,
            clientIp: device.clientIp,
            loginMethod: 'PHONE_SMS',
          },
          tx,
        );

        // CROSS-CONTEXT-ASYNC: auth.account.deletion-cancelled (R3, 同 tx 落 outbox)
        const payload = buildAccountDeletionCancelledEvent(accountId, now);
        await this.outboxPublisher.publish(
          tx,
          ACCOUNT_DELETION_CANCELLED_EVENT_TYPE,
          payload as unknown as Record<string, unknown>,
        );
      },
      { isolationLevel: 'ReadCommitted' },
    );

    return { accountId, accessToken, refreshToken };
  }

  /** 反枚举失败: dummy bcrypt pad 对齐时延后折叠 401 (phone-class + code-class 共用)。 */
  private async failAntiEnum(): Promise<never> {
    await this.timingDefense.pad();
    throw new UnauthorizedException('INVALID_CREDENTIALS');
  }
}
