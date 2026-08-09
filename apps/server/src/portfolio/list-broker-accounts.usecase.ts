import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { buildBrokerAccountList, type BrokerAccountListItem } from './portfolio.rules';

export interface BrokerAccountListResult {
  accounts: BrokerAccountListItem[];
}

/**
 * 012 US1 — 列出券商账户 (intra query, ADR-0043 直注 PrismaService 无 repository)。
 *
 * 读侧虚拟派生 (OQ3): 系统「默认账户」不落库, 由 buildBrokerAccountList 合成置顶 (id=accountId)。
 * findMany 仅本账号行 (accountId 谓词 → 跨账号隔离), createdAt asc 序; clientNo 返 **raw 明文**
 * (FR-S07 脱敏在客户端)。纯读零写库副作用。
 */
@Injectable()
export class ListBrokerAccountsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<BrokerAccountListResult> {
    const rows = await this.prisma.brokerAccount.findMany({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
    });
    return { accounts: buildBrokerAccountList(rows, accountId) };
  }
}
