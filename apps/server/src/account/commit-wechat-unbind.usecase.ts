import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

type TxClient = Prisma.TransactionClient;

const WECHAT_PROVIDER = 'WECHAT';

/**
 * CommitWechatUnbind — 删微信绑定写半段 (010 FR-S04, 镜像 CommitAccountFreeze)。
 * account context 独占 `wechat_binding` 表写, auth 编排 (unbind-wechat) 在自持
 * `$transaction` (READ COMMITTED) 内传 `tx` 调用 —— 码 markUsed + 删绑定同 1 原子
 * 事务, 任一失败回滚。本 use case **不开自己的 tx**。
 *
 * **并发裁决** (禁 FOR UPDATE/Serializable): 条件 `deleteMany WHERE accountId AND
 * provider='WECHAT'` 的受影响行数即裁决 —— count===1 本次赢 (won) / count===0
 * 无绑定 (已被并发解绑 / 从未绑) 本次输 (lost)。依赖 DB 行写锁串行化同行竞争,
 * 5 并发持同码恰 1 won。跨 provider 不误删 (provider 谓词隔离)。
 */
@Injectable()
export class CommitWechatUnbindUseCase {
  async execute(tx: TxClient, accountId: bigint): Promise<{ won: boolean }> {
    const { count } = await tx.wechatBinding.deleteMany({
      where: { accountId, provider: WECHAT_PROVIDER },
    });
    return { won: count === 1 };
  }
}
