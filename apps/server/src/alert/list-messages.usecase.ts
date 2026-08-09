import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import { toMessageItem, type MessageListResponse } from './message.response';

export const DEFAULT_MESSAGE_PAGE_SIZE = 20;
export const MAX_MESSAGE_PAGE_SIZE = 100;

export interface ListMessagesQuery {
  /** keyset 游标 = 上页末条消息 id (数字串); 省略 = 首页。 */
  cursor?: string;
  /** 页大小, 默认 20, 上限 100 (越界夹取不报错 — 常识性防护)。 */
  limit?: number;
}

/**
 * 021 US3 — 消息列表 (EP6, intra 只读)。
 *
 * triggeredAt 倒序 + id 倒序决胜 (同毫秒稳定), keyset 分页 (Prisma cursor on @id,
 * ix_alert_trigger_account_triggered 命中)；take limit+1 探多页 → nextCursor =
 * 本页末条 id / null。unread = triggeredAt > 账号水位线 (无 cursor 行 = 全未读,
 * plan D6)；游标行已不存在 → 空页 (trigger V1 不删, 防御性可接受)。
 */
@Injectable()
export class ListMessagesUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, query: ListMessagesQuery = {}): Promise<MessageListResponse> {
    if (query.cursor !== undefined && !/^\d+$/.test(query.cursor)) {
      throw new FormValidationException([
        { field: 'cursor', messages: ['cursor 必须为数字串 (上页 nextCursor 原样回传)'] },
      ]);
    }
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? DEFAULT_MESSAGE_PAGE_SIZE), 1),
      MAX_MESSAGE_PAGE_SIZE,
    );

    const readCursor = await this.prisma.alertReadCursor.findUnique({ where: { accountId } });
    const rows = await this.prisma.alertTrigger.findMany({
      where: { accountId },
      orderBy: [{ triggeredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor !== undefined ? { cursor: { id: BigInt(query.cursor) }, skip: 1 } : {}),
    });

    const page = rows.slice(0, limit);
    const lastReadAt = readCursor?.lastReadAt ?? null;
    return {
      messages: page.map((row) => toMessageItem(row, lastReadAt)),
      nextCursor: rows.length > limit ? page[page.length - 1].id.toString() : null,
    };
  }
}
