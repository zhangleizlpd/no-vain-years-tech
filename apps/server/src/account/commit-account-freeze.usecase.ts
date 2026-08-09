import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { AccountStatus } from './account.rules';

type TxClient = Prisma.TransactionClient;

/**
 * CommitAccountFreeze — ACTIVE → FROZEN 状态转换写半段 (per ADR-0043 两段式委托
 * Saga mutate 段)。account context 独占 `account` 表写, 让 auth 编排 (delete-account)
 * 不碰 `prisma.account.*` (护城河, ADR-0043 §5)。
 *
 * **tx 参与**: 由 auth 的 delete-account.usecase 在自持 `$transaction` (READ COMMITTED)
 * 内调用并传入 `tx` —— 冻结、码 markUsed、撤 token、发事件同 1 原子事务 (FR-S03/S04)。
 * 本 use case **不开自己的 tx**。
 *
 * **并发裁决** (FR-S06, plan D2): 条件 UPDATE `WHERE id=? AND status='ACTIVE'` 的
 * 受影响行数即裁决 —— count===1 本次赢 (won); count===0 账号非 ACTIVE (已被并发
 * 冻结 / 不存在 / 已 ANONYMIZED) 本次输 (lost)。依赖 DB 行写锁串行化同行竞争,
 * 5 并发持同码恰 1 won (禁 FOR UPDATE / Serializable)。`account.rules` 谓词
 * `canFreeze` (= isActive) 是此 WHERE 的可单测真相源。
 */
@Injectable()
export class CommitAccountFreezeUseCase {
  async execute(tx: TxClient, accountId: bigint, freezeUntil: Date): Promise<{ won: boolean }> {
    const { count } = await tx.account.updateMany({
      where: { id: accountId, status: AccountStatus.ACTIVE },
      data: { status: AccountStatus.FROZEN, freezeUntil, updatedAt: new Date() },
    });
    return { won: count === 1 };
  }
}
