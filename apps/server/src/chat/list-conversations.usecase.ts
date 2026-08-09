import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';

/**
 * 历史会话列表 (028 T001, plan D4 / FR-002 / FR-009 / FR-013) — chat 叶子 ctx,
 * 扁平 + 贫血 + 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 安全 (plan §Impl Guardrails): 会话按 accountId 归属, UC 层 scope —— `where.accountId`
 * 硬过滤, 只返本人会话 (跨账号不可见, 与 get-messages 同款归属语义)。
 *
 * 排序 (plan D4 / FR-002): `(updatedAt desc, id desc)` 复合稳定序, 命中既有索引
 * `ix_conversation_account_updated`。⚠️ `updatedAt` = **最近更新**语义 (analyze 决策 a):
 * 创建 / 首条标题派生 / 改名时刷新, **不随每条后续消息刷新** (继承 027 send-message,
 * 028 只读排序, 绝不改 027)。
 *
 * 分页 (FR-013): cursor 基于 `(updatedAt,id)` 复合游标 (base64 编码), `take=limit+1`
 * 探测下一页是否存在 → 切 `nextCursor`, 稳定不重不漏 (同 updatedAt 行靠 id 二级 desc
 * 区分)。非法 / 无法解码的游标 → 当作无 cursor 从首页起 (不暴露内部错误)。
 *
 * 搜索 (FR-009): 可选 `q` → `title { contains, mode: 'insensitive' }` (PG ILIKE 子串,
 * 大小写不敏感), 仅 title, 不搜 message 正文 (本期范围红线)。无命中 → 空列表 (不报错)。
 *
 * 复杂度: O(limit) 索引扫描 (复合游标 keyset 分页, 无 OFFSET 全表跳过)。
 */

/** 默认页大小 (plan D4「默认 20-30」取 20; DTO 范围 1..50)。 */
export const DEFAULT_LIST_LIMIT = 20;

/** 贫血 conversation 列表 row 投影 (UC 返回 Raw Prisma row 子集)。 */
export interface ConversationListRow {
  id: bigint;
  title: string;
  model: string;
  updatedAt: Date;
}

export interface ListConversationsParams {
  limit?: number;
  cursor?: string;
  q?: string;
}

export interface ListConversationsResult {
  items: ConversationListRow[];
  /** 下一页游标 (base64 编码 {updatedAt,id}); 无更多页则 undefined。 */
  nextCursor?: string;
}

/** 复合游标内部形态 (updatedAt ISO string + id 数字串)。 */
interface CursorPayload {
  u: string; // updatedAt ISO-8601
  i: string; // id (BigInt → 数字串, 避免 JSON 精度丢失)
}

/** base64 编码复合游标 (URL-safe 非必需 —— query 已 encode)。 */
function encodeCursor(row: ConversationListRow): string {
  const payload: CursorPayload = { u: row.updatedAt.toISOString(), i: row.id.toString() };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

/** 解码游标 → keyset 边界; 任何非法形态 (坏 base64 / 坏 JSON / 缺字段 / 坏数字) → null。 */
function decodeCursor(raw: string): { updatedAt: Date; id: bigint } | null {
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as Partial<CursorPayload>;
    if (typeof parsed.u !== 'string' || typeof parsed.i !== 'string') return null;
    const updatedAt = new Date(parsed.u);
    if (Number.isNaN(updatedAt.getTime())) return null;
    if (!/^\d+$/.test(parsed.i)) return null;
    return { updatedAt, id: BigInt(parsed.i) };
  } catch {
    return null;
  }
}

@Injectable()
export class ListConversationsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    accountId: bigint,
    params: ListConversationsParams = {},
  ): Promise<ListConversationsResult> {
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const cursor = params.cursor ? decodeCursor(params.cursor) : null;
    const q = params.q?.trim();

    // keyset 分页谓词: (updatedAt, id) < (cursorUpdatedAt, cursorId) — desc 序的「下一页」。
    // 同 updatedAt 行靠 id desc 区分; 复合 OR 表达词典序严格小于 (稳定不重不漏)。
    const cursorWhere: Prisma.ConversationWhereInput | undefined = cursor
      ? {
          OR: [
            { updatedAt: { lt: cursor.updatedAt } },
            { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
          ],
        }
      : undefined;

    const where: Prisma.ConversationWhereInput = {
      accountId,
      ...(q ? { title: { contains: q, mode: 'insensitive' } } : {}),
      ...(cursorWhere ?? {}),
    };

    const rows = await this.prisma.conversation.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1, // +1 探测下一页是否存在
      select: { id: true, title: true, model: true, updatedAt: true },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? encodeCursor(items[items.length - 1]!) : undefined;

    return { items, nextCursor };
  }
}
