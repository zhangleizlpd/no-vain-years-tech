import { Inject, Injectable } from '@nestjs/common';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import { PrismaService } from '../security/prisma.service';
import { buildAnchorChange, toAnchorSnapshot, type AnchorSnapshot } from './anchor-history';
import { shanghaiDateOnly } from './create-anchor.usecase';

/**
 * 建锚事件类型。与 `create-anchor.usecase.ts` 的同名常量**同一字面量** —— T008 结论: 两个订阅者
 * (冷启动 / 券商回补) 都不以 `anchorId` 去重, 对同一 ticker 二次投递幂等 ⇒ 迁锚复用本事件,
 * 让 marketdata 冷启动为新码补历史数据。相等由 086 remediate IT ④ 对订阅方导出常量钉住。
 */
const ANCHOR_CREATED_EVENT = 'optionsdesk.anchor-created';

/** 迁锚 / 撤销共用入参。两个 ticker 都是 canonical `market:code`, 同一 market。 */
export interface MigrateAnchorTickerInput {
  oldTicker: string;
  newTicker: string;
  /** 时钟注入点 (默认 `new Date()`): `next_review` 取的是**此刻的上海日**的昨天。 */
  now?: Date;
}

export type MigrateAnchorResult =
  | { kind: 'migrated'; anchorId: bigint; previousNextReview: Date | null; nextReview: Date }
  /** 旧码无锚 (含「已迁过」) ⇒ 编排判跳过。 */
  | { kind: 'no_anchor' }
  /** 新码已有锚 ⇒ 零写入, 编排停在这一步 (branch 17)。 */
  | { kind: 'conflict'; existingAnchorId: bigint };

export type RevertAnchorMigrationResult =
  | { kind: 'reverted'; anchorId: bigint; restoredNextReview: Date | null }
  /** 新码无锚 (含「已撤销过」) ⇒ 跳过。 */
  | { kind: 'no_anchor' }
  /** 旧码已有锚 ⇒ 零写入。 */
  | { kind: 'conflict'; existingAnchorId: bigint }
  /** 新码锚的最近一次 ticker 变更不是「从旧码迁来」(例如本就建在新码上) ⇒ 零写入。 */
  | { kind: 'not_migrated'; anchorId: bigint };

/** 迁移即清空的行情投影列: 那是旧码的价, 留着会让新码锚带着旧价进雷达排序 (Guardrail 4)。 */
const CLEARED_PRICE_COLUMNS = {
  lastClose: null,
  lastCloseDate: null,
  intradayPrice: null,
  intradayAt: null,
  intradayVendorUpdateTime: null,
} as const;

/** 上海日的昨天 (UTC 午夜表示, 与 `@db.Date` 同基准)。 */
function shanghaiYesterday(now: Date): Date {
  const today = shanghaiDateOnly(now);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
}

/**
 * 086 迁锚 (FR-014 / FR-017; plan D5 第 2 步): 代码变更后把锚从旧码挪到新码名下, 并让它进入
 * 复核逾期。`revert` 是撤销编排 (T012) 的逆操作。
 *
 * 同一个 tx 内四件事 (Guardrail 4), 任一失败全部回滚:
 * 1. conditional UPDATE (`where {id, ticker: old}` + affected-count) —— ticker 改新码、价格列清空、
 *    `next_review` 设为**上海日的昨天**。取上海日是为了与逾期判定同轴: 锚列表的 `today` 是
 *    `shanghaiDateOnly(new Date())` (`list-anchors.usecase.ts:110`), 判据 `isAnchorOverdue`
 *    (`review-anchor.usecase.ts:69`) 是 `next_review < today`。用交易所当地日不报错, 只是差一天。
 * 2. `anchor_change` 痕迹 (`changedFields: ['ticker', 'nextReview']`), before 值留原 `next_review`
 *    供 `revert` 取回。
 * 3. 发布建锚事件 (同 tx outbox)。
 *
 * 复杂度: 每次调用 O(1) 次查询 (按唯一键 ticker / 主键读写)。
 */
@Injectable()
export class MigrateAnchorTickerUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOX_PUBLISHER) private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(input: MigrateAnchorTickerInput): Promise<MigrateAnchorResult> {
    const { oldTicker, newTicker } = input;
    const nextReview = shanghaiYesterday(input.now ?? new Date());

    return this.prisma.$transaction(async (tx) => {
      // 先判旧码: 「旧码无锚 ∧ 新码有锚」正是已迁过的状态, 应判跳过而不是冲突。
      const existing = await tx.anchor.findUnique({ where: { ticker: oldTicker } });
      if (existing === null) return { kind: 'no_anchor' };
      const occupant = await tx.anchor.findUnique({
        where: { ticker: newTicker },
        select: { id: true },
      });
      if (occupant !== null) return { kind: 'conflict', existingAnchorId: occupant.id };

      const patch = { ticker: newTicker, nextReview };
      const res = await tx.anchor.updateMany({
        where: { id: existing.id, ticker: oldTicker },
        data: { ...patch, ...CLEARED_PRICE_COLUMNS },
      });
      if (res.count === 0) return { kind: 'no_anchor' };

      // ticker 必变 ⇒ change 非空; nextReview 原值恰为昨天时不进字段集, revert 视为「未改」。
      const change = buildAnchorChange(toAnchorSnapshot(existing), patch, 'manual')!;
      await tx.anchorChange.create({
        data: {
          anchorId: existing.id,
          changedFields: [...change.changedFields],
          beforeValues: change.beforeValues,
          source: change.source,
        },
      });
      // CROSS-CONTEXT-ASYNC: optionsdesk.anchor-created → marketdata 冷启动为新码补历史数据。
      // 同 tx: 迁锚回滚 ⇒ outbox 行一起没。payload 形状与 create-anchor 一致 (anchorId 十进制串)。
      await this.outboxPublisher.publish(
        tx,
        ANCHOR_CREATED_EVENT,
        { anchorId: String(existing.id), ticker: newTicker },
        'optionsdesk',
      );
      return {
        kind: 'migrated',
        anchorId: existing.id,
        previousNextReview: existing.nextReview,
        nextReview,
      };
    });
  }

  /**
   * 迁锚的逆操作: 新码 → 旧码, `next_review` 恢复为迁移痕迹里的 before 值。价格列同样清空
   * (那是新码的价)。不发事件: 旧码的历史数据本就在库 (T008 结论)。
   */
  async revert(input: MigrateAnchorTickerInput): Promise<RevertAnchorMigrationResult> {
    const { oldTicker, newTicker } = input;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.anchor.findUnique({ where: { ticker: newTicker } });
      if (existing === null) return { kind: 'no_anchor' };
      const occupant = await tx.anchor.findUnique({
        where: { ticker: oldTicker },
        select: { id: true },
      });
      if (occupant !== null) return { kind: 'conflict', existingAnchorId: occupant.id };

      const lastTickerChange = await tx.anchorChange.findFirst({
        where: { anchorId: existing.id, changedFields: { has: 'ticker' } },
        orderBy: { id: 'desc' },
      });
      const before = (lastTickerChange?.beforeValues ?? {}) as AnchorSnapshot;
      if (before.ticker !== oldTicker) return { kind: 'not_migrated', anchorId: existing.id };

      const restoredNextReview =
        'nextReview' in before
          ? before.nextReview === null
            ? null
            : new Date(String(before.nextReview))
          : existing.nextReview;
      const patch = { ticker: oldTicker, nextReview: restoredNextReview };
      const res = await tx.anchor.updateMany({
        where: { id: existing.id, ticker: newTicker },
        data: { ...patch, ...CLEARED_PRICE_COLUMNS },
      });
      if (res.count === 0) return { kind: 'no_anchor' };

      const change = buildAnchorChange(toAnchorSnapshot(existing), patch, 'manual')!;
      await tx.anchorChange.create({
        data: {
          anchorId: existing.id,
          changedFields: [...change.changedFields],
          beforeValues: change.beforeValues,
          source: change.source,
        },
      });
      return { kind: 'reverted', anchorId: existing.id, restoredNextReview };
    });
  }
}
