import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { buildDeletionChange, type AnchorChangeSource } from './anchor-history';
import type { AnchorRow } from './create-anchor.usecase';

/**
 * 045 US1 — 删锚 (FR-001 / FR-031, plan D2)。
 *
 * 🚨 **删锚本身也落一条痕迹**, 且痕迹**不随主行级联清除** —— `anchor_change.anchor_id` 是
 * 逻辑引用、无声明 FK (T005 已实证), 故删主行后痕迹行仍在, 已删的锚仍可按时点还原 (SC-011)。
 * 痕迹的 `before_values` 存**整行快照**: 删除后没有「当前行」可供倒放, 快照就是回放起点。
 *
 * 删主行与写痕迹**同一个 tx** (任一失败一起回滚) —— 否则会出现「行没了、痕迹也没了」的
 * 不可逆丢史。并发: `deleteMany` + affected-count, count === 0 ⇒ 已被并发删除 → 折叠 404。
 *
 * 采集侧的连带效果 (删锚 → 标的移出采集工作集、已落库历史数据不删) 由 marketdata 侧按锚表
 * 重算 `need_sync` 承担 (FR-028), 本 usecase 不跨 ctx 写。
 */
@Injectable()
export class DeleteAnchorUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(anchorId: bigint, source: AnchorChangeSource = 'manual'): Promise<void> {
    const existing = (await this.prisma.anchor.findUnique({
      where: { id: anchorId },
    })) as AnchorRow | null;
    if (existing === null) {
      throw new NotFoundException('ANCHOR_NOT_FOUND');
    }

    await this.prisma.$transaction(async (tx) => {
      const res = await tx.anchor.deleteMany({ where: { id: anchorId } });
      if (res.count === 0) {
        throw new NotFoundException('ANCHOR_NOT_FOUND');
      }
      const change = buildDeletionChange(existing, source);
      await tx.anchorChange.create({
        data: {
          anchorId,
          changedFields: [...change.changedFields],
          beforeValues: change.beforeValues,
          source: change.source,
        },
      });
    });
  }
}
