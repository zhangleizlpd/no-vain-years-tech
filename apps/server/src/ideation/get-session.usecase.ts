import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';

/**
 * 取灵感会话详情 (032 T007, FR-008 / US1) —— ideation 叶子 ctx, 直注 PrismaService。
 *
 * 安全 (plan §Impl Guardrails): 会话按 accountId 归属, UC 层 scope —— 先校验会话归属
 * 本账号, 他人 / 不存在的 sessionId 一律 404 字节级一致 (反枚举, 与 chat get-messages
 * 同款; **非 403**)。归属本人 → 连带返 turns (按插入序 id asc) + brief (1:1, 可能无)。
 *
 * 数据 = 贫血 Prisma row (suggestion / briefJson 为 Json 列, 原样透传, 无 Entity Mapper);
 * null 穿透不 `!` (brief 可能不存在 → null)。
 */

/** 单轮附件投影 (036 FR-009; 贫血 row, 仅暴露重展示所需 ossKey)。 */
export interface SessionTurnAttachmentRow {
  ossKey: string;
}

/** 会话内单轮 (贫血 row 投影; suggestion = 本轮 chips Json 或 null)。 */
export interface SessionTurnRow {
  id: bigint;
  role: string;
  content: string;
  suggestion: Prisma.JsonValue | null;
  createdAt: Date;
  /** 036 FR-009: 本轮带图附件 (按 turnId 关联; 纯文本轮为空数组)。 */
  attachments: SessionTurnAttachmentRow[];
}

/** brief 投影 (1:1 会话, 可能不存在)。 */
export interface SessionBriefRow {
  briefJson: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

export interface GetSessionResult {
  id: bigint;
  title: string;
  status: string;
  repo: string | null;
  createdAt: Date;
  updatedAt: Date;
  turns: SessionTurnRow[];
  brief: SessionBriefRow | null;
}

@Injectable()
export class GetSessionUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, sessionId: bigint): Promise<GetSessionResult> {
    // scope 校验归属: 查不到本人会话即 404 (他人 / 不存在不可区分, 反枚举)。
    const session = await this.prisma.ideaSession.findFirst({
      where: { id: sessionId, accountId },
      select: { id: true, title: true, status: true, repo: true, createdAt: true, updatedAt: true },
    });
    if (!session) {
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    const [turns, attachments, brief] = await Promise.all([
      this.prisma.ideaTurn.findMany({
        where: { sessionId },
        orderBy: { id: 'asc' },
        select: { id: true, role: true, content: true, suggestion: true, createdAt: true },
      }),
      // 036 FR-009: 批量取本会话所有带图附件 (按 turnId 分组挂回各轮; ossKey 让重载可重展示)。
      // turnId 为 null 的历史附件 (T018 前落库) 自然不命中任何轮 → 不展示, 零回归。
      this.prisma.ideaAttachment.findMany({
        where: { sessionId, turnId: { not: null } },
        orderBy: { id: 'asc' },
        select: { turnId: true, ossKey: true },
      }),
      this.prisma.requirementsDraft.findUnique({
        where: { sessionId },
        select: { briefJson: true, createdAt: true, updatedAt: true },
      }),
    ]);

    // turnId → ossKey[] 分组 (插入序; 纯文本轮无命中 → 空数组)。
    const byTurn = new Map<bigint, SessionTurnAttachmentRow[]>();
    for (const a of attachments) {
      if (a.turnId === null) continue;
      const list = byTurn.get(a.turnId) ?? [];
      list.push({ ossKey: a.ossKey });
      byTurn.set(a.turnId, list);
    }
    const turnsWithAttachments: SessionTurnRow[] = turns.map((t) => ({
      ...t,
      attachments: byTurn.get(t.id) ?? [],
    }));

    return { ...session, turns: turnsWithAttachments, brief };
  }
}
