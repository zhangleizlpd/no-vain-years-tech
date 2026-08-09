import { Injectable } from '@nestjs/common';
import type { AccountSmsCode, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import type { SmsPurpose } from './deletion-code.rules';

type TxClient = Prisma.TransactionClient;

/**
 * DeletionCodeStore — `account_sms_code` 表读写 (PrismaService 直注, 无 repository,
 * per ADR-0043 §1; 贫血 Prisma row)。004 首个消费者 (login 码走 Redis 求速;
 * 注销/撤销码走 DB 求原子: markUsed 与状态写同 PG tx, plan D1)。
 *
 * 哈希在 use case 层用 `deletion-code.rules` 算后传入 `codeHash`; store 只做 DB I/O,
 * 不持 secret。`tx` 传入 → 操作入 caller 的 $transaction (delete/cancel 持 tx);
 * 缺省 → 自己的 PrismaService (发码 / 直测)。
 */
@Injectable()
export class DeletionCodeStore {
  constructor(private readonly prisma: PrismaService) {}

  /** 发码: insert 1 条 (usedAt 默认 null)。 */
  async issue(
    accountId: bigint,
    purpose: SmsPurpose,
    codeHash: string,
    expiresAt: Date,
    tx?: TxClient,
  ): Promise<void> {
    await (tx ?? this.prisma).accountSmsCode.create({
      data: { accountId, purpose, codeHash, expiresAt },
    });
  }

  /**
   * 查活码: `usedAt IS NULL ∧ expiresAt > now ∧ purpose` 命中偏索引
   * idx_account_sms_code_account_purpose_active。多条取最新 (createdAt desc) —
   * 重复发码时只认最近一条。miss → null。
   */
  async findActive(
    accountId: bigint,
    purpose: SmsPurpose,
    now: Date,
    tx?: TxClient,
  ): Promise<AccountSmsCode | null> {
    return (tx ?? this.prisma).accountSmsCode.findFirst({
      where: { accountId, purpose, usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 标记已用: 条件 `updateMany where {id, usedAt:null}` set usedAt=now → affected-count。
   * count===1 → 本次赢 (true); count===0 → 已被并发/先前请求标记 (false)。这是注销
   * 提交 exactly-once 的核心闸: 5 并发持同码 → 行写锁串行化, 恰 1 个 won=true。
   */
  async markUsed(codeId: bigint, now: Date, tx?: TxClient): Promise<boolean> {
    const { count } = await (tx ?? this.prisma).accountSmsCode.updateMany({
      where: { id: codeId, usedAt: null },
      data: { usedAt: now },
    });
    return count === 1;
  }
}
