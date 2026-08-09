import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { AlertWithConditions } from './create-alerts-batch.usecase';

/**
 * 021 US1 — 个股预警列表 (EP1, intra 只读)。
 *
 * scope `where {accountId, market, code}` (ix_alert_account_market_code 命中)；
 * conditions 内联；创建序 (id asc) 稳定排列 — 屏 1 列表序。空命中 = 空数组
 * (标的存在性不查 marketdata — 不存在的标的天然空列表, 零跨 ctx 读)。
 */
@Injectable()
export class ListInstrumentAlertsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, market: string, code: string): Promise<AlertWithConditions[]> {
    return this.prisma.alert.findMany({
      where: { accountId, market, code },
      include: { conditions: true },
      orderBy: { id: 'asc' },
    });
  }
}
