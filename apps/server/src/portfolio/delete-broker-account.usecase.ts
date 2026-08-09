import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { DefaultAccountNotDeletableException } from './default-account-not-deletable.exception';

/**
 * 012 US3 — 删除券商账户 (intra 写, ADR-0043 直注 PrismaService 无 repository)。
 *
 * **先 scoped-delete 后判定** (D3): 默认账户读侧虚拟派生 (id=accountId), 其暴露 id 与
 * broker_account 自增 id 共享 BigInt 空间可能数值碰撞 → 不可先判 `id===accountId`
 * (会把恰好 id==accountId 的真实 broker 行误判默认)。
 *   deleteMany({ where:{id, accountId} }) →
 *     count===1                  → 204 (本账号真实行被删)
 *     count===0 && id===accountId → 400 DEFAULT_ACCOUNT_NOT_DELETABLE (删默认虚拟账户)
 *     count===0 && id!==accountId → 404 (字节级一致折叠: 不存在 / 属他人, 反枚举 FR-S05)
 *
 * **V1 归属回落 = 仅删行** (FR-S06/D7): import 未建无 position 数据, 删行即终态,
 * 不建空 reassignment seam (文档化语义, 避免过度设计)。
 */
@Injectable()
export class DeleteBrokerAccountUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, id: bigint): Promise<void> {
    const { count } = await this.prisma.brokerAccount.deleteMany({ where: { id, accountId } });
    if (count === 1) {
      return;
    }
    if (id === accountId) {
      throw new DefaultAccountNotDeletableException();
    }
    throw new NotFoundException();
  }
}
