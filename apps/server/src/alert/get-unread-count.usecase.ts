import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { UnreadCountResponse } from './message.response';

/**
 * 021 US3 — 未读计数 (EP7, intra 只读)。
 *
 * unread = count(trigger WHERE accountId AND triggeredAt > lastReadAt)；
 * 无水位线行 = 全未读 (plan D6)。服务端单一真相 → 多设备一致 (SC-005)。
 * 角标消费: mobile focus refetch, 不轮询。
 */
@Injectable()
export class GetUnreadCountUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<UnreadCountResponse> {
    const readCursor = await this.prisma.alertReadCursor.findUnique({ where: { accountId } });
    const unread = await this.prisma.alertTrigger.count({
      where: {
        accountId,
        ...(readCursor ? { triggeredAt: { gt: readCursor.lastReadAt } } : {}),
      },
    });
    return { unread };
  }
}
