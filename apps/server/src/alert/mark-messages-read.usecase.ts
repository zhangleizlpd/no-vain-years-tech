import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { UnreadCountResponse } from './message.response';

/**
 * 021 US3 — 置已读 (EP8, intra 写)。
 *
 * 屏级水位线语义 (plan D6): 进入提醒 tab 即调, upsert AlertReadCursor.lastReadAt
 * = now → 全量置已读, 恒返 {unread: 0}。幂等 — 重复调仅推进水位线; 并发新触发
 * (triggeredAt > now) 自然保持未读, 无竞态窗口处理必要。
 */
@Injectable()
export class MarkMessagesReadUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<UnreadCountResponse> {
    const now = new Date();
    await this.prisma.alertReadCursor.upsert({
      where: { accountId },
      create: { accountId, lastReadAt: now },
      update: { lastReadAt: now },
    });
    return { unread: 0 };
  }
}
