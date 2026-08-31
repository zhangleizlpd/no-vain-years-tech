import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { UpdateAnchorUseCase } from './update-anchor.usecase';
import type { PrismaService } from '../security/prisma.service';
import {
  stubTradingCalendar,
  type TradingCalendarStub,
} from '../../test/_support/trading-calendar-stub';

type Fn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  prisma: PrismaService;
  /** 062 T010: 陈旧度基准改走 `TRADING_CALENDAR_PORT`，不再是 `tradingDay.findFirst`。 */
  calendar: TradingCalendarStub;
  findUnique: Fn;
  updateMany: Fn;
  findUniqueOrThrow: Fn;
  changeCreate: Fn;
}

const ASOF = new Date('2026-06-30T00:00:00Z');

function anchorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7n,
    ticker: 'us:AOS',
    v: new Prisma.Decimal('50'),
    asof: ASOF,
    method: 'dcf',
    confidence: new Prisma.Decimal('8'),
    confidenceSource: 'manual',
    excluded: false,
    excludeReason: null,
    nextReview: new Date('2026-09-30T00:00:00Z'),
    lastReviewedOn: new Date('2026-06-30T00:00:00Z'),
    vManual: null,
    lLevelManual: null,
    positionCapManual: null,
    lLevelEffective: 'L2',
    lastClose: null,
    lastCloseDate: null,
    breachStartedOn: null,
    createdAt: new Date('2026-08-02T01:00:00Z'),
    updatedAt: new Date('2026-08-02T01:00:00Z'),
    ...overrides,
  };
}

function buildPrismaMock(): PrismaMock {
  const findUnique = vi.fn();
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUniqueOrThrow = vi.fn().mockResolvedValue(anchorRow());
  const changeCreate = vi.fn().mockResolvedValue(undefined);
  const tx = {
    anchor: { updateMany, findUniqueOrThrow },
    anchorChange: { create: changeCreate },
  };
  // FR-020 新鲜度基准: 默认「交易日历无行」⇒ fail-open 判 CURRENT ——
  // 既有断言不受影响; 需要判 STALE 的用例自己 mockResolvedValue 一行。
  const calendar = stubTradingCalendar();
  const prisma = {
    anchor: { findUnique, updateMany, findUniqueOrThrow },
    anchorChange: { create: changeCreate },
    // D13 标的名: 本文件断言与它无关 ⇒ 默认「未注册」(null), 不影响既有用例。
    instrument: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async (cb: (client: unknown) => unknown) => cb(tx)),
  } as unknown as PrismaService;
  return { prisma, findUnique, updateMany, findUniqueOrThrow, changeCreate, calendar };
}

function writtenData(m: PrismaMock): Record<string, unknown> {
  return m.updateMany.mock.calls[0]![0].data as Record<string, unknown>;
}

describe('UpdateAnchorUseCase — 锚不存在', () => {
  let m: PrismaMock;
  let useCase: UpdateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new UpdateAnchorUseCase(m.prisma, m.calendar);
  });

  it('findUnique 无命中 → NotFoundException ANCHOR_NOT_FOUND', async () => {
    m.findUnique.mockResolvedValue(null);
    await expect(useCase.execute(7n, { method: 'dcf2' })).rejects.toBeInstanceOf(NotFoundException);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('读写窗内被并发删除 (updateMany count = 0) → 同折叠 404', async () => {
    m.findUnique.mockResolvedValue(anchorRow());
    m.updateMany.mockResolvedValue({ count: 0 });
    await expect(useCase.execute(7n, { method: 'dcf2' })).rejects.toMatchObject({
      message: expect.stringContaining('ANCHOR_NOT_FOUND'),
    });
  });
});

// FR-001: confidence 按来源门控 —— model 来源写侧拒改, manual 来源可改 (EC-8)。
describe('UpdateAnchorUseCase — FR-001 confidence 来源门控', () => {
  let m: PrismaMock;
  let useCase: UpdateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new UpdateAnchorUseCase(m.prisma, m.calendar);
  });

  it('confidence_source = model 时改 confidence → 400 ANCHOR_CONFIDENCE_READONLY', async () => {
    m.findUnique.mockResolvedValue(anchorRow({ confidenceSource: 'model' }));
    await expect(useCase.execute(7n, { confidence: '9' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('model 来源被拒时不写库 (既有 confidence 不变)', async () => {
    m.findUnique.mockResolvedValue(anchorRow({ confidenceSource: 'model' }));
    await expect(useCase.execute(7n, { confidence: '9' })).rejects.toThrow();
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('model 来源改其它字段照常放行 (只读只针对 confidence)', async () => {
    m.findUnique.mockResolvedValue(anchorRow({ confidenceSource: 'model' }));
    await useCase.execute(7n, { method: 'comps' });
    expect(writtenData(m).method).toBe('comps');
  });

  it('confidence_source = manual 时改 confidence 放行 (EC-8 手工锚可改)', async () => {
    m.findUnique.mockResolvedValue(anchorRow({ confidenceSource: 'manual' }));
    await useCase.execute(7n, { confidence: '9.5' });
    expect(writtenData(m).confidence).toBe('9.5');
  });
});

// plan D3: 所有影响生效 L 层的写入路径都在写入时求值。
describe('UpdateAnchorUseCase — 生效 L 层写入求值', () => {
  let m: PrismaMock;
  let useCase: UpdateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new UpdateAnchorUseCase(m.prisma, m.calendar);
    m.findUnique.mockResolvedValue(anchorRow());
  });

  it('改 confidence 8 → 9.5 时生效 L 层随之落 L1', async () => {
    await useCase.execute(7n, { confidence: '9.5' });
    expect(writtenData(m).lLevelEffective).toBe('L1');
  });

  it('未改 confidence 的写入也重算生效 L 层 (自愈, 值不变)', async () => {
    await useCase.execute(7n, { method: 'comps' });
    expect(writtenData(m).lLevelEffective).toBe('L2');
  });

  it('L 层处于人工态且本次未改 confidence → 生效值取人工值', async () => {
    m.findUnique.mockResolvedValue(anchorRow({ lLevelManual: 'L3' }));
    await useCase.execute(7n, { method: 'comps' });
    expect(writtenData(m).lLevelEffective).toBe('L3');
  });

  it('任一时刻只有一个生效值: update data 里 lLevel* 键恰为 lLevelEffective 一个', async () => {
    await useCase.execute(7n, { confidence: '9.5' });
    expect(Object.keys(writtenData(m)).filter((k) => k.startsWith('lLevel'))).toEqual([
      'lLevelEffective',
    ]);
  });

  it('单票上限无生效列 (请求时派生, FR-003a ①): data 无 positionCapEffective 类键', async () => {
    await useCase.execute(7n, { confidence: '9.5' });
    expect(
      Object.keys(writtenData(m)).filter((k) => k.toLowerCase().includes('positioncap')),
    ).toEqual([]);
  });
});

describe('UpdateAnchorUseCase — 字段 patch 语义与 EC-3', () => {
  let m: PrismaMock;
  let useCase: UpdateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new UpdateAnchorUseCase(m.prisma, m.calendar);
    m.findUnique.mockResolvedValue(anchorRow());
  });

  it('未提供的字段不进 data (patch 语义, 不整行覆盖)', async () => {
    await useCase.execute(7n, { method: 'comps' });
    const data = writtenData(m);
    expect(Object.keys(data).sort()).toEqual(['lLevelEffective', 'method']);
  });

  it('excludeReason 显式传 null → 清空 (与 undefined 区分)', async () => {
    await useCase.execute(7n, { excluded: false, excludeReason: null });
    expect(writtenData(m)).toMatchObject({ excluded: false, excludeReason: null });
  });

  it('EC-3 patch V ≤ 0 → 400 INVALID_ANCHOR_V 且不写库', async () => {
    await expect(useCase.execute(7n, { v: '0' })).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_ANCHOR_V'),
    });
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('conditional update 走 updateMany + affected-count (禁 FOR UPDATE)', async () => {
    await useCase.execute(7n, { method: 'comps' });
    expect(m.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7n } }));
  });

  it('返回写后的最新行投影 (含 EC-10 overdueAgainstAsof)', async () => {
    m.findUniqueOrThrow.mockResolvedValue(
      anchorRow({ nextReview: new Date('2026-05-01T00:00:00Z') }),
    );
    const result = await useCase.execute(7n, { method: 'comps' });
    expect(result.overdueAgainstAsof).toBe(true);
    expect(result.lLevelEffective).toBe('L2');
  });
});

// T007: 两级链回落接进写侧 (FR-006 / FR-032 / FR-035, plan D9)。语义本身在
// anchor-cascade.spec.ts 纯函数验, 这里只验「写侧确实照它写库」。
describe('UpdateAnchorUseCase — 两级链回落接线 (T007)', () => {
  let m: PrismaMock;
  let useCase: UpdateAnchorUseCase;

  /** L 层与单票上限同时处于人工态。 */
  const bothManual = {
    lLevelManual: 'L3',
    positionCapManual: new Prisma.Decimal('0.10'),
  };

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new UpdateAnchorUseCase(m.prisma, m.calendar);
  });

  it('路径 ③ 手工锚改 confidence → L 层与上限人工值一并落 null, 生效 L 层取新映射档', async () => {
    m.findUnique.mockResolvedValue(anchorRow(bothManual));
    await useCase.execute(7n, { confidence: '9.5' });
    expect(writtenData(m)).toMatchObject({
      lLevelManual: null,
      positionCapManual: null,
      lLevelEffective: 'L1',
    });
  });

  it('路径 ② 人工改 L 层 → 上限人工值回落, 生效 L 层取人工档', async () => {
    m.findUnique.mockResolvedValue(anchorRow(bothManual));
    await useCase.execute(7n, { lLevelManual: 'L1' });
    expect(writtenData(m)).toMatchObject({
      lLevelManual: 'L1',
      positionCapManual: null,
      lLevelEffective: 'L1',
    });
  });

  it('EC-5 人工 L 层恰好等于映射档 → 仍写入人工位 (不因值相等而静默视为未调整)', async () => {
    m.findUnique.mockResolvedValue(anchorRow());
    await useCase.execute(7n, { lLevelManual: 'L2' });
    expect(writtenData(m).lLevelManual).toBe('L2');
  });

  it('撤销 L 层人工位 (传 null) → 自身与下游上限一并回落, 生效值回到映射档', async () => {
    m.findUnique.mockResolvedValue(anchorRow(bothManual));
    await useCase.execute(7n, { lLevelManual: null });
    expect(writtenData(m)).toMatchObject({
      lLevelManual: null,
      positionCapManual: null,
      lLevelEffective: 'L2',
    });
  });

  it('撤销单票上限 → 只回落自身, L 层人工位保留', async () => {
    m.findUnique.mockResolvedValue(anchorRow(bothManual));
    await useCase.execute(7n, { positionCapManual: null });
    const data = writtenData(m);
    expect(data.positionCapManual).toBeNull();
    expect(Object.keys(data)).not.toContain('lLevelManual');
    expect(data.lLevelEffective).toBe('L3');
  });

  it('设 V 人工位 → 落 v_manual (生效 V = COALESCE(v_manual, v))', async () => {
    m.findUnique.mockResolvedValue(anchorRow());
    await useCase.execute(7n, { vManual: '55' });
    expect(String(writtenData(m).vManual)).toBe('55');
  });

  it('EC-3 V 人工位 ≤ 0 同样拒绝 (生效 V 也要 > 0)', async () => {
    m.findUnique.mockResolvedValue(anchorRow());
    await expect(useCase.execute(7n, { vManual: '0' })).rejects.toMatchObject({
      message: expect.stringContaining('INVALID_ANCHOR_V'),
    });
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it('未触发回落的 patch 不写人工位三列 (无噪声写入)', async () => {
    m.findUnique.mockResolvedValue(anchorRow());
    await useCase.execute(7n, { method: 'comps' });
    const keys = Object.keys(writtenData(m));
    expect(keys).not.toContain('vManual');
    expect(keys).not.toContain('lLevelManual');
    expect(keys).not.toContain('positionCapManual');
  });
});

// T008 FR-031: 一次变更 = 一行痕迹 (含字段集 + 改前值 + source), 与主行写同一个 tx。
describe('UpdateAnchorUseCase — 变更痕迹 (FR-031)', () => {
  let m: PrismaMock;
  let useCase: UpdateAnchorUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new UpdateAnchorUseCase(m.prisma, m.calendar);
    m.findUnique.mockResolvedValue(
      anchorRow({
        lLevelManual: 'L3',
        lLevelEffective: 'L3',
        positionCapManual: new Prisma.Decimal('0.10'),
      }),
    );
  });

  it('一次改动 (含回落) 落**恰好一条**痕迹, 不是一字段一行', async () => {
    await useCase.execute(7n, { confidence: '9.5' });
    expect(m.changeCreate).toHaveBeenCalledTimes(1);
  });

  it('痕迹带本次变更的字段集 + 改前值', async () => {
    await useCase.execute(7n, { confidence: '9.5' });
    const data = m.changeCreate.mock.calls[0]![0].data as Record<string, unknown>;
    expect([...(data.changedFields as string[])].sort()).toEqual([
      'confidence',
      'lLevelEffective',
      'lLevelManual',
      'positionCapManual',
    ]);
    expect(data.beforeValues).toEqual({
      confidence: '8',
      lLevelEffective: 'L3',
      lLevelManual: 'L3',
      positionCapManual: '0.1',
    });
  });

  it('source 默认 manual, 可显式传 model (import 路径)', async () => {
    await useCase.execute(7n, { confidence: '9.5' });
    expect(m.changeCreate.mock.calls[0]![0].data.source).toBe('manual');

    await useCase.execute(7n, { confidence: '9.5' }, 'model');
    expect(m.changeCreate.mock.calls[1]![0].data.source).toBe('model');
  });

  it('值没真变的写入 → 零痕迹 (幂等重写不刷噪声行)', async () => {
    m.findUnique.mockResolvedValue(anchorRow());
    await useCase.execute(7n, { method: 'dcf' });
    expect(m.changeCreate).not.toHaveBeenCalled();
  });

  it('痕迹与主行写在同一个 tx (任一失败一起回滚)', async () => {
    await useCase.execute(7n, { confidence: '9.5' });
    expect((m.prisma as unknown as { $transaction: Fn }).$transaction).toHaveBeenCalledTimes(1);
    expect(m.updateMany).toHaveBeenCalledTimes(1);
    expect(m.changeCreate).toHaveBeenCalledTimes(1);
  });

  it('被拒的写入 (model 来源改 confidence) → 零痕迹', async () => {
    m.findUnique.mockResolvedValue(anchorRow({ confidenceSource: 'model' }));
    await expect(useCase.execute(7n, { confidence: '9.5' })).rejects.toThrow();
    expect(m.changeCreate).not.toHaveBeenCalled();
  });
});
