import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 021 US1/US5 — 批量删除预警 (EP5, intra 写)。
 *
 * `deleteMany where id in + accountId`：只删本账号命中项，他人 id / 不存在 id 静默
 * 不计入 (反枚举无杂音, FR-S08)。conditions 随 FK Cascade 删；触发流水独立保留
 * (alert_trigger.alert_id 无 FK, FR-S05)。返实删 count。
 */
@Injectable()
export class DeleteAlertsBatchUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, ids: readonly bigint[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.prisma.alert.deleteMany({
      where: { id: { in: [...ids] }, accountId },
    });
    return res.count;
  }
}
