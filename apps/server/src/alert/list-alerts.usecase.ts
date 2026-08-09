import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { AlertWithConditions } from './create-alerts-batch.usecase';

/**
 * 021 US4 — 全部预警列表 (EP2, intra 只读)。
 *
 * 全账号预警平铺 (market/code 排序稳定相邻, 组内创建序)；按标的分组归 client
 * (屏 5 组头行情走 015 EP2 client-side merge, alert 端点不内联行情, ADR-0048)。
 * V1 不分页 — 自用规模 (spec 假设), 常识性防护由限流桶承担。
 */
@Injectable()
export class ListAlertsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<AlertWithConditions[]> {
    return this.prisma.alert.findMany({
      where: { accountId },
      include: { conditions: true },
      orderBy: [{ market: 'asc' }, { code: 'asc' }, { id: 'asc' }],
    });
  }
}
