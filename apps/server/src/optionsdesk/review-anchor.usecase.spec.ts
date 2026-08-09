import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { classifyZone } from './anchor.rules';
import {
  ReviewAnchorUseCase,
  isAnchorOverdue,
  isAnchorReviewFlagOn,
} from './review-anchor.usecase';
import type { PrismaService } from '../security/prisma.service';

type Fn = ReturnType<typeof vi.fn>;

/** 今日 (固定) —— 复审回填 `last_reviewed_on` 取当日, 用假时钟锁死可断言。 */
const TODAY = new Date('2026-08-02T09:30:00Z');
const TODAY_DATE_ONLY = new Date('2026-08-02T00:00:00Z');

/** V=50 ⇒ W=40、内段下界 30 (系数见 anchor.rules) ⇒ spot 36 = 买区, spot 28 = 深买区。 */
const baseRow = {
  id: 7n,
  ticker: 'us:AOS',
  v: new Prisma.Decimal('50'),
  asof: new Date('2026-06-30T00:00:00Z'),
  method: 'dcf',
  confidence: new Prisma.Decimal('8'),
  confidenceSource: 'manual',
  excluded: false,
  excludeReason: null,
  // 已逾期 (早于 TODAY)
  nextReview: new Date('2026-07-15T00:00:00Z'),
  lastReviewedOn: new Date('2026-06-30T00:00:00Z'),
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  lLevelEffective: 'L2',
  lastClose: new Prisma.Decimal('36'),
  lastCloseDate: new Date('2026-08-01T00:00:00Z'),
  // 本轮跌破起点晚于最近复审 ⇒ 复审前复核锚红标亮
  breachStartedOn: new Date('2026-07-20T00:00:00Z'),
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-07-20T00:00:00Z'),
};

interface PrismaMock {
  prisma: PrismaService;
  tradingDayFindFirst: Fn;
  findUnique: Fn;
  updateMany: Fn;
  findUniqueOrThrow: Fn;
  changeCreate: Fn;
}

function buildPrismaMock(row: Record<string, unknown> = baseRow): PrismaMock {
  const findUnique = vi.fn().mockResolvedValue(row);
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const changeCreate = vi.fn().mockResolvedValue(undefined);
  // 回读行 = 原行叠上本次 update 的 data (贫血, 与 PG 行为等价)。
  const findUniqueOrThrow = vi.fn(() => ({
    ...row,
    ...(updateMany.mock.calls.at(-1)?.[0]?.data ?? {}),
  }));
  const tx = {
    anchor: { updateMany, findUniqueOrThrow },
    anchorChange: { create: changeCreate },
  };
  // FR-020 新鲜度基准: 默认「交易日历无行」⇒ fail-open 判 CURRENT ——
  // 既有断言不受影响; 需要判 STALE 的用例自己 mockResolvedValue 一行。
  const tradingDayFindFirst = vi.fn(async () => null as { date: Date } | null);
  const prisma = {
    tradingDay: { findFirst: tradingDayFindFirst },
    anchor: { findUnique },
    $transaction: vi.fn(async (cb: (client: unknown) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  return { prisma, findUnique, updateMany, findUniqueOrThrow, changeCreate, tradingDayFindFirst };
}

describe('isAnchorOverdue — FR-004 日历逾期判据', () => {
  it('next_review 早于今日 → 逾期', () => {
    expect(isAnchorOverdue(new Date('2026-07-15T00:00:00Z'), TODAY)).toBe(true);
  });

  it('next_review = 今日 → 未逾期 (当天到期还没过期)', () => {
    expect(isAnchorOverdue(new Date('2026-08-02T00:00:00Z'), TODAY)).toBe(false);
  });

  it('next_review 为 null (未设复审日) → 不逾期, 不报错', () => {
    expect(isAnchorOverdue(null, TODAY)).toBe(false);
  });
});

describe('isAnchorReviewFlagOn — FR-013 复核锚红标判据', () => {
  const v = new Prisma.Decimal('50'); // W = 40

  it('spot < W ∧ 最近复审早于本轮起点 → 红标亮', () => {
    expect(
      isAnchorReviewFlagOn({
        v,
        lastClose: new Prisma.Decimal('36'),
        lastReviewedOn: new Date('2026-06-30T00:00:00Z'),
        breachStartedOn: new Date('2026-07-20T00:00:00Z'),
      }),
    ).toBe(true);
  });

  it('spot < W ∧ 最近复审 ≥ 本轮起点 → 红标不亮 (本轮已复审过)', () => {
    expect(
      isAnchorReviewFlagOn({
        v,
        lastClose: new Prisma.Decimal('36'),
        lastReviewedOn: new Date('2026-07-20T00:00:00Z'),
        breachStartedOn: new Date('2026-07-20T00:00:00Z'),
      }),
    ).toBe(false);
  });

  it('不在跌破轮次内 (起点为 null) → 红标不亮', () => {
    expect(
      isAnchorReviewFlagOn({
        v,
        lastClose: new Prisma.Decimal('36'),
        lastReviewedOn: null,
        breachStartedOn: null,
      }),
    ).toBe(false);
  });

  it('spot 恰好 = W → 不算跌破, 红标不亮 (EC-11 与区间归属取同一侧)', () => {
    expect(
      isAnchorReviewFlagOn({
        v,
        lastClose: new Prisma.Decimal('40'),
        lastReviewedOn: new Date('2026-06-30T00:00:00Z'),
        breachStartedOn: new Date('2026-07-20T00:00:00Z'),
      }),
    ).toBe(false);
    expect(classifyZone(v, '40')).toBe('thin');
  });

  it('行情不可用 (lastClose = null) → 维持上一次可判定状态, 不因行情断供而灭标', () => {
    expect(
      isAnchorReviewFlagOn({
        v,
        lastClose: null,
        lastReviewedOn: new Date('2026-06-30T00:00:00Z'),
        breachStartedOn: new Date('2026-07-20T00:00:00Z'),
      }),
    ).toBe(true);
  });

  it('从未复审 (last_reviewed_on = null) ∧ 在跌破轮次内 → 红标亮', () => {
    expect(
      isAnchorReviewFlagOn({
        v,
        lastClose: new Prisma.Decimal('36'),
        lastReviewedOn: null,
        breachStartedOn: new Date('2026-07-20T00:00:00Z'),
      }),
    ).toBe(true);
  });
});

describe('ReviewAnchorUseCase — 复审动作 (FR-004 / FR-007 / FR-013)', () => {
  let m: PrismaMock;
  let useCase: ReviewAnchorUseCase;
  const nextReview = new Date('2026-11-02T00:00:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TODAY);
    m = buildPrismaMock();
    useCase = new ReviewAnchorUseCase(m.prisma);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('推进 next_review 并把 last_reviewed_on 回填当日 (UTC 日界)', async () => {
    const result = await useCase.execute(7n, nextReview);
    const data = m.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.nextReview).toEqual(nextReview);
    expect(data.lastReviewedOn).toEqual(TODAY_DATE_ONLY);
    expect(result.nextReview).toEqual(nextReview);
  });

  it('FR-004 逾期红标解除 (复审前逾期 → 复审后不逾期)', async () => {
    expect(isAnchorOverdue(baseRow.nextReview, TODAY)).toBe(true);
    const result = await useCase.execute(7n, nextReview);
    expect(isAnchorOverdue(result.nextReview, TODAY)).toBe(false);
  });

  it('复审后 spot 仍 < W → 复核锚红标不再亮 (最近复审 ≥ 本轮起点)', async () => {
    expect(isAnchorReviewFlagOn(baseRow)).toBe(true);
    const result = await useCase.execute(7n, nextReview);
    expect(
      isAnchorReviewFlagOn({
        v: result.v,
        lastClose: result.lastClose,
        lastReviewedOn: result.lastReviewedOn,
        breachStartedOn: result.breachStartedOn,
      }),
    ).toBe(false);
  });

  it('EC-12 复核锚红标解除但区间徽标照常 —— 买区仍是买区 (两者语义不同, 不得一起消失)', async () => {
    expect(classifyZone(baseRow.v, baseRow.lastClose)).toBe('buy');
    const result = await useCase.execute(7n, nextReview);
    expect(classifyZone(result.v, result.lastClose!)).toBe('buy');
  });

  it('EC-12 深买区同理 —— 复审不改 V / spot ⇒ 区间归属恒不变', async () => {
    m = buildPrismaMock({ ...baseRow, lastClose: new Prisma.Decimal('28') });
    useCase = new ReviewAnchorUseCase(m.prisma);
    const result = await useCase.execute(7n, nextReview);
    expect(classifyZone(result.v, result.lastClose!)).toBe('deep_buy');
  });

  it('🚨 FR-013 只有一个动作: update 键集恰好 {nextReview, lastReviewedOn}, 无第二确认状态位', async () => {
    await useCase.execute(7n, nextReview);
    const data = m.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['lastReviewedOn', 'nextReview']);
  });

  it('🚨 复审 MUST NOT 清空 breach_started_on (清了会被状态机按新一轮重置 → 红标立刻重亮)', async () => {
    const result = await useCase.execute(7n, nextReview);
    expect(result.breachStartedOn).toEqual(baseRow.breachStartedOn);
  });

  it('复审不改估值 (v / confidence / 人工位一概不碰, 要改值走 update 路径)', async () => {
    const result = await useCase.execute(7n, nextReview);
    expect(result.v).toEqual(baseRow.v);
    expect(result.confidence).toEqual(baseRow.confidence);
    expect(result.lLevelEffective).toBe('L2');
  });

  it('next_review 可显式置 null (本次不再排下次复审), 仍回填 last_reviewed_on', async () => {
    const result = await useCase.execute(7n, null);
    expect(result.nextReview).toBeNull();
    expect(result.lastReviewedOn).toEqual(TODAY_DATE_ONLY);
  });

  it('落恰好一条痕迹, source = manual 且含两列 (模型不能代人复审)', async () => {
    await useCase.execute(7n, nextReview);
    expect(m.changeCreate).toHaveBeenCalledTimes(1);
    const data = m.changeCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.source).toBe('manual');
    expect([...(data.changedFields as string[])].sort()).toEqual(['lastReviewedOn', 'nextReview']);
    expect((data.beforeValues as Record<string, unknown>).nextReview).toBe(
      baseRow.nextReview.toISOString(),
    );
  });

  it('主行与痕迹同一个 tx', async () => {
    await useCase.execute(7n, nextReview);
    expect((m.prisma as unknown as { $transaction: Fn }).$transaction).toHaveBeenCalledTimes(1);
  });

  it('同日重复复审且日期未动 → 无字段真变, 不落噪声痕迹行', async () => {
    m = buildPrismaMock({
      ...baseRow,
      nextReview,
      lastReviewedOn: TODAY_DATE_ONLY,
    });
    useCase = new ReviewAnchorUseCase(m.prisma);
    await useCase.execute(7n, nextReview);
    expect(m.changeCreate).not.toHaveBeenCalled();
  });

  it('锚不存在 → 404 ANCHOR_NOT_FOUND, 不写痕迹', async () => {
    m.findUnique.mockResolvedValue(null);
    await expect(useCase.execute(7n, nextReview)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.changeCreate).not.toHaveBeenCalled();
  });

  it('读写窗内被并发删除 (updateMany count = 0) → 折叠 404 且不写痕迹', async () => {
    m.updateMany.mockResolvedValue({ count: 0 });
    await expect(useCase.execute(7n, nextReview)).rejects.toBeInstanceOf(NotFoundException);
    expect(m.changeCreate).not.toHaveBeenCalled();
  });
});
