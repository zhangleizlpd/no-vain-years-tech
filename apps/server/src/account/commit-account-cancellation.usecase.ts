import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { AccountStatus } from './account.rules';

type TxClient = Prisma.TransactionClient;

/**
 * CommitAccountCancellation — FROZEN-in-grace → ACTIVE 状态转换写半段 (撤销注销;
 * per ADR-0043 两段式委托 Saga mutate 段)。account context 独占 `account` 表写,
 * 让 auth 编排 (cancel-deletion) 不碰 `prisma.account.*` (护城河, ADR-0043 §5)。
 *
 * **tx 参与**: 由 auth 的 cancel-deletion.usecase 在自持 `$transaction` (READ COMMITTED)
 * 内调用并传入 `tx` —— 解冻、码 markUsed、重发 token、发事件同 1 原子事务 (FR-S09/S10)。
 * 本 use case **不开自己的 tx**。
 *
 * **并发裁决 + 互斥** (FR-S12/S16, plan D2): 条件 UPDATE
 * `WHERE id=? AND status='FROZEN' AND freezeUntil > now` 的受影响行数即裁决 ——
 * count===1 本次赢 (won); count===0 本次输 (lost: 账号非 FROZEN / grace 已过 /
 * 不存在 / 已 ANONYMIZED)。grace 谓词 `freezeUntil > now` **内嵌 WHERE**, 与匿名化
 * scheduler 的 `freezeUntil <= now` 互斥 (边界 freezeUntil===now 归匿名化, 恒赢) +
 * 防 scheduler 抢跑后撤销误成功。依赖 DB 行写锁串行化同行竞争 (禁 FOR UPDATE /
 * Serializable)。`account.rules.canCancelFromFrozen` (= isFrozenInGrace) 是此 WHERE
 * 的可单测真相源。
 */
@Injectable()
export class CommitAccountCancellationUseCase {
  async execute(tx: TxClient, accountId: bigint, now: Date): Promise<{ won: boolean }> {
    const { count } = await tx.account.updateMany({
      where: { id: accountId, status: AccountStatus.FROZEN, freezeUntil: { gt: now } },
      data: { status: AccountStatus.ACTIVE, freezeUntil: null, updatedAt: new Date() },
    });
    return { won: count === 1 };
  }
}
