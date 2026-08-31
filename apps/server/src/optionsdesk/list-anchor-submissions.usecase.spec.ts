import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../security/prisma.service';
import type { TradingCalendarPort } from '../marketdata/trading-calendar.port';
import {
  ANCHOR_SUBMISSION_LIST_CAP,
  ListAnchorSubmissionsUseCase,
} from './list-anchor-submissions.usecase';

/**
 * 断言派生自 spec **FR-001 / FR-002** 与 state_branches 9–11：
 * 列表 MUST NOT 分页（硬上限 + truncated）；逐行给出 disposition / asofFlag；
 * 详情多给 fallbackPreview 与 willBeNoop。
 */
const D = (v: string) => new Prisma.Decimal(v);

function submission(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1n,
    submitter: 'friend2',
    ticker: 'us:CFG',
    v: D('49.34'),
    asof: new Date('2026-08-28T00:00:00Z'),
    method: 'weighted',
    confidence: D('6.00'),
    note: null,
    reviewNote: null,
    status: 'PENDING',
    consumedAnchorId: null,
    createdAt: new Date('2026-08-30T01:30:00Z'),
    updatedAt: new Date('2026-08-30T01:30:00Z'),
    ...over,
  };
}

function anchorRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 42n,
    ticker: 'us:CFG',
    v: D('49.34'),
    asof: new Date('2026-08-28T00:00:00Z'),
    method: 'weighted',
    confidence: D('6.00'),
    confidenceSource: 'model',
    vManual: null,
    lLevelManual: null,
    positionCapManual: null,
    ...over,
  };
}

function makeDeps(
  opts: {
    rows?: ReturnType<typeof submission>[];
    anchors?: ReturnType<typeof anchorRow>[];
    classify?: 'trading' | 'non-trading' | 'unknown';
  } = {},
) {
  const subFindMany = vi.fn(
    async (_args: { where: Record<string, unknown>; take: number }) => opts.rows ?? [submission()],
  );
  const subFindUnique = vi.fn(async () => (opts.rows ?? [submission()])[0] ?? null);
  const anchorFindMany = vi.fn(async () => opts.anchors ?? []);
  const anchorFindUnique = vi.fn(async () => (opts.anchors ?? [])[0] ?? null);
  const instrumentFindMany = vi.fn(async () => []);
  const prisma = {
    anchorSubmission: { findMany: subFindMany, findUnique: subFindUnique },
    anchor: { findMany: anchorFindMany, findUnique: anchorFindUnique },
    instrument: { findMany: instrumentFindMany },
  } as unknown as PrismaService;
  const calendar = {
    classify: vi.fn(async () => opts.classify ?? 'trading'),
    lastClosedSession: vi.fn(async () => null),
    previousTradingDay: vi.fn(async () => '2026-08-27'),
  } as unknown as TradingCalendarPort;
  return {
    uc: new ListAnchorSubmissionsUseCase(prisma, calendar),
    now: new Date('2026-08-31T20:00:00Z'),
    subFindMany,
    anchorFindMany,
  };
}

describe('ListAnchorSubmissionsUseCase — FR-001 不分页', () => {
  it('未触上限 → truncated=false', async () => {
    const d = makeDeps();
    expect((await d.uc.execute({}, d.now)).truncated).toBe(false);
  });

  // 硬上限是常识性防护而不是分页:命中时 MUST 显式告诉呈现层被截断了。
  it('超上限 → 截到 CAP 且 truncated=true', async () => {
    const rows = Array.from({ length: ANCHOR_SUBMISSION_LIST_CAP + 5 }, (_, i) =>
      submission({ id: BigInt(i + 1) }),
    );
    const d = makeDeps({ rows });
    const res = await d.uc.execute({}, d.now);
    expect(res.items).toHaveLength(ANCHOR_SUBMISSION_LIST_CAP);
    expect(res.truncated).toBe(true);
  });

  it('缺省只看 PENDING；market 按 ticker 前缀筛', async () => {
    const d = makeDeps();
    await d.uc.execute({ market: 'hk' }, d.now);
    const where = d.subFindMany.mock.calls[0]![0].where;
    expect(where.status).toBe('PENDING');
    expect(where.ticker).toEqual({ startsWith: 'hk:' });
  });

  // N+1 防线:锚按 distinct ticker **一次**批量取,与行数无关。
  it('多行同 ticker → 锚只批量查一次', async () => {
    const rows = [submission({ id: 1n }), submission({ id: 2n }), submission({ id: 3n })];
    const d = makeDeps({ rows });
    await d.uc.execute({}, d.now);
    expect(d.anchorFindMany).toHaveBeenCalledTimes(1);
  });
});

describe('ListAnchorSubmissionsUseCase — 富化字段', () => {
  it('锚表没有该 ticker → disposition=create', async () => {
    const d = makeDeps({ anchors: [] });
    expect((await d.uc.execute({}, d.now)).items[0]!.disposition).toBe('create');
  });

  it('锚表已有该 ticker → disposition=refresh', async () => {
    const d = makeDeps({ anchors: [anchorRow()] });
    expect((await d.uc.execute({}, d.now)).items[0]!.disposition).toBe('refresh');
  });

  // 🚨 asof 是 @db.Date：MUST 输出 YYYY-MM-DD，MUST NOT 带 T00:00:00.000Z
  //    （移动端 YMD 正则会拒，且非 UTC 渲染会差一天）。
  it('asof 序列化成 YYYY-MM-DD，不是 ISO 时刻串', async () => {
    const d = makeDeps();
    expect((await d.uc.execute({}, d.now)).items[0]!.asof).toBe('2026-08-28');
  });

  it('日历判非交易日 → asofFlag=NON_TRADING 且 asofNeedsAck=true', async () => {
    const d = makeDeps({ classify: 'non-trading' });
    const item = (await d.uc.execute({}, d.now)).items[0]!;
    expect(item.asofFlag).toBe('NON_TRADING');
    expect(item.asofNeedsAck).toBe(true);
    expect(item.asofSuggested).toBe('2026-08-27');
  });

  it('口径日正常 → 不去解建议日（省掉无谓查询）', async () => {
    const d = makeDeps({ classify: 'trading' });
    const item = (await d.uc.execute({}, d.now)).items[0]!;
    expect(item.asofFlag).toBe('OK');
    expect(item.asofSuggested).toBeNull();
  });
});

describe('ListAnchorSubmissionsUseCase — FR-002 采纳前预览', () => {
  it('无锚 → 空预览、willBeNoop=false', async () => {
    const d = makeDeps({ anchors: [] });
    const detail = await d.uc.getDetail(1n, d.now);
    expect(detail!.preview).toEqual({
      fallbackEntries: [],
      willBeNoop: false,
      existingConfidenceSource: null,
    });
  });

  it('已有锚且三处人工位有值 → 逐条列出会被冲掉的', async () => {
    const d = makeDeps({
      anchors: [
        anchorRow({
          v: D('58'),
          vManual: D('58'),
          lLevelManual: 'L2',
          positionCapManual: D('0.25'),
        }),
      ],
    });
    const detail = await d.uc.getDetail(1n, d.now);
    expect(detail!.preview.willBeNoop).toBe(false);
    expect(detail!.preview.fallbackEntries.map((e) => e.slot).sort()).toEqual(
      ['lLevel', 'positionCap', 'v'].sort(),
    );
  });

  // 🚨 逐值相同 ⇒ 什么都不会写 ⇒ 预览 MUST 为空。
  //    给一个零写入的操作配上「将清掉你的 3 处人工位」正是训练人闭眼点确认的机制。
  it('四事实全等且来源已是 model → willBeNoop=true 且预览为空', async () => {
    const d = makeDeps({ anchors: [anchorRow({ vManual: D('58'), lLevelManual: 'L2' })] });
    const detail = await d.uc.getDetail(1n, d.now);
    expect(detail!.preview.willBeNoop).toBe(true);
    expect(detail!.preview.fallbackEntries).toEqual([]);
  });

  it('条目不存在 → null（由 controller 折 404）', async () => {
    const d = makeDeps({ rows: [] });
    expect(await d.uc.getDetail(99n, d.now)).toBeNull();
  });
});
