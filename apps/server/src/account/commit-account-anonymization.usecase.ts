import { Inject, Injectable } from '@nestjs/common';
import { authConfig, type AuthConfig } from '../config/auth.config';
import { PrismaService } from '../security/prisma.service';
import { RefreshTokenService } from '../security/refresh-token.service';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import { hashPhone } from '../security/phone-hasher';
import { AccountStatus, ANONYMIZED_DISPLAY_NAME } from './account.rules';
import {
  ACCOUNT_ANONYMIZED_EVENT_TYPE,
  buildAccountAnonymizedEvent,
} from './account-anonymized.event';

/**
 * CommitAccountAnonymization — FROZEN(grace 期满) → ANONYMIZED 终态转换 (FR-S13/S14/S15)。
 *
 * **account 持 tx** (与 freeze/cancellation 的「参与 caller tx」不同): scheduler 逐 id
 * 调用, 本 use case **自开** `$transaction` (READ COMMITTED) = 每行独立事务 (REQUIRES_NEW
 * 等价), 单行失败被隔离不影响同批 sibling (FR-S15)。
 *
 * 变更集 (FR-S14, 原子): 先 findUnique 取 phone 算 `previousPhoneHash` (HMAC, 见
 * phone-hasher) → 条件 UPDATE `WHERE status=FROZEN AND freezeUntil<=now`: status→ANONYMIZED
 * + phone=null + displayName=「已注销用户」+ previousPhoneHash + freezeUntil=null → 撤该账号
 * 全部 refresh-token → 发 AnonymizedEvent。任一步抛 → 整行 tx 回滚 (无部分匿名化 / 无事件)。
 *
 * 领域拒绝 → skip (返回 `{ won:false }`, scheduler 不计 failure): phone 已 null (重扫已
 * 匿名化行, 幂等) / 不存在 → 短路; 条件 UPDATE count=0 (grace 未满 / 已被 cancel 抢先 /
 * 已 anonymize) → skip。grace 边界 `<=now` 与 cancel 的 `>now` 互斥, 匿名化恒赢 (FR-S16)。
 */
@Injectable()
export class CommitAccountAnonymizationUseCase {
  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: account → security 撤该账号全部 refresh-token (R2 写, 同 tx)
    private readonly refreshTokenService: RefreshTokenService,
    @Inject(OUTBOX_PUBLISHER) private readonly outboxPublisher: OutboxPublisher,
    @Inject(authConfig.KEY) private readonly authCfg: AuthConfig,
  ) {}

  async execute(accountId: bigint, now: Date): Promise<{ won: boolean }> {
    return this.prisma.$transaction(
      async (tx) => {
        const account = await tx.account.findUnique({ where: { id: accountId } });
        // 领域拒绝 (幂等): 不存在 / phone 已 null (已匿名化) → skip, 不重复哈希 / 不发事件。
        if (!account || account.phone === null) {
          return { won: false };
        }

        // 清 phone 前捕获 previousPhoneHash (HMAC, 低熵防彩虹表; FR-S14)。
        const previousPhoneHash = hashPhone(account.phone, this.authCfg.smsCodeHmacSecret);

        // 条件 UPDATE: 仅 FROZEN ∧ grace 期满 (freezeUntil<=now) → 匿名化。count=0 → 状态
        // 漂移 (grace 未满 / 已 cancel / 已 anonymize) → skip (与 cancel `>now` 互斥)。
        const { count } = await tx.account.updateMany({
          where: { id: accountId, status: AccountStatus.FROZEN, freezeUntil: { lte: now } },
          data: {
            status: AccountStatus.ANONYMIZED,
            phone: null,
            displayName: ANONYMIZED_DISPLAY_NAME,
            previousPhoneHash,
            freezeUntil: null,
            updatedAt: new Date(),
          },
        });
        if (count === 0) {
          return { won: false };
        }

        // 撤该账号全部 refresh-token (R2, 同 tx; 抛则整行回滚)。
        await this.refreshTokenService.revokeAllForAccount(accountId, now, tx);

        // CROSS-CONTEXT-ASYNC: account.account.anonymized (R3, 同 tx, producerContext='account')
        const payload = buildAccountAnonymizedEvent(accountId, now);
        await this.outboxPublisher.publish(
          tx,
          ACCOUNT_ANONYMIZED_EVENT_TYPE,
          payload as unknown as Record<string, unknown>,
          'account',
        );

        return { won: true };
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }
}
