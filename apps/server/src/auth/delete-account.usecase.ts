import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { authConfig, type AuthConfig } from '../config/auth.config';
import { PrismaService } from '../security/prisma.service';
import { RefreshTokenService } from '../security/refresh-token.service';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import { CommitAccountFreezeUseCase } from '../account/commit-account-freeze.usecase';
import { FREEZE_DURATION_DAYS } from '../account/account.rules';
import {
  ACCOUNT_DELETION_REQUESTED_EVENT_TYPE,
  buildAccountDeletionRequestedEvent,
} from '../account/account-deletion-requested.event';
import { DeletionCodeStore } from './deletion-code.store';
import { SmsPurpose, verifyDeletionCode } from './deletion-code.rules';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * DeleteAccount (auth 编排, authed) —— 提交注销码 → 冻结账号 (FR-S03/S04/S05/S06)。
 *
 * **auth 持 tx 跨 3 ctx** 首落地 (per plan; ADR-0032 编排层 + ADR-0043 两段式委托
 * 写半段): auth 自开 `$transaction`(READ COMMITTED), 在内顺序委托 account (冻结) +
 * security (撤 token) + outbox (发事件), 任一步失败整 tx 回滚 (FR-S04 原子性)。auth
 * 不碰 `prisma.account.*` / `prisma.refreshToken.*` —— 全经 Commit*UseCase / Service。
 *
 * 码校验 (findActive + HMAC compare) 在 **tx 外**做: 4 类失败 (未找到 / 哈希不符 /
 * 过期 / 已用) 折叠为字节级一致 401 `INVALID_DELETION_CODE` (FR-S05 反枚举, 不披露
 * 失败子类)。findActive 已滤 expired + used → `null` 覆盖 3 类, verifyDeletionCode
 * 覆盖 hash-mismatch 第 4 类。
 *
 * 并发裁决 (FR-S06 exactly-once, plan D2 affected-count): tx 内 `markUsed` 的
 * affected-count 是闸 —— 5 并发持同码恰 1 won (行写锁串行化同行), 其余 count=0 折叠
 * 401 回滚。`commitAccountFreeze` won=false (账号已非 ACTIVE, 如第 2 条 active 码后到)
 * 同折叠 401 回滚 (不双重冻结, MUST NOT 重复撤 token / 重复发事件)。
 */
@Injectable()
export class DeleteAccountUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deletionCodeStore: DeletionCodeStore,
    // CROSS-CONTEXT-SYNC: auth → account 冻结账号 ACTIVE→FROZEN (R2 写, 失败回滚整请求)
    private readonly commitAccountFreeze: CommitAccountFreezeUseCase,
    // CROSS-CONTEXT-SYNC: auth → security 撤该账号全部 refresh-token (R2 写, 同 tx)
    private readonly refreshTokenService: RefreshTokenService,
    @Inject(OUTBOX_PUBLISHER) private readonly outboxPublisher: OutboxPublisher,
    @Inject(authConfig.KEY) private readonly authCfg: AuthConfig,
  ) {}

  async execute(accountId: bigint, code: string): Promise<void> {
    const now = new Date();

    // 码校验 (tx 外): 4 类失败折叠 401 (findActive 滤 expired+used → null 覆盖 3 类;
    // verifyDeletionCode 覆盖 hash-mismatch)。
    const stored = await this.deletionCodeStore.findActive(
      accountId,
      SmsPurpose.DELETE_ACCOUNT,
      now,
    );
    if (!stored || !verifyDeletionCode(code, stored.codeHash, this.authCfg.smsCodeHmacSecret)) {
      throw new UnauthorizedException('INVALID_DELETION_CODE');
    }

    const freezeUntil = new Date(now.getTime() + FREEZE_DURATION_DAYS * DAY_MS);

    await this.prisma.$transaction(
      async (tx) => {
        // exactly-once 闸: 行写锁串行化同码并发, 恰 1 won; 输者 count=0 → 折叠 401 回滚。
        const claimed = await this.deletionCodeStore.markUsed(stored.id, now, tx);
        if (!claimed) {
          throw new UnauthorizedException('INVALID_DELETION_CODE');
        }

        // 冻结 (R2): won=false → 账号已非 ACTIVE (被并发 / 第 2 码抢先) → 折叠 401 回滚。
        const { won } = await this.commitAccountFreeze.execute(tx, accountId, freezeUntil);
        if (!won) {
          throw new UnauthorizedException('INVALID_DELETION_CODE');
        }

        // 撤该账号全部 refresh-token (R2, 同 tx; 抛则整 tx 回滚)。
        await this.refreshTokenService.revokeAllForAccount(accountId, now, tx);

        // CROSS-CONTEXT-ASYNC: auth.account.deletion-requested (R3, 同 tx 落 outbox)
        const payload = buildAccountDeletionRequestedEvent(accountId, freezeUntil, now);
        await this.outboxPublisher.publish(
          tx,
          ACCOUNT_DELETION_REQUESTED_EVENT_TYPE,
          payload as unknown as Record<string, unknown>,
        );
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }
}
