import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  computeW,
  computeWillingSellAnchors,
  computeZoneBoundaries,
  derivePositionCap,
  mapConfidenceToLLevel,
} from './anchor.rules';
import {
  ANCHOR_NOT_FOUND_FOR_SYMBOL,
  GetUnderlyingDetailUseCase,
  UNDERLYING_IV_STATES,
} from './get-underlying-detail.usecase';
import { toUnderlyingDetailResponse } from './optionsdesk.dto';
import type { PrismaService } from '../security/prisma.service';
import {
  stubTradingCalendar,
  type TradingCalendarStub,
} from '../../test/_support/trading-calendar-stub';

type Fn = ReturnType<typeof vi.fn>;

/**
 * 046 T015 — 详情读端单测 (FR-002/003/004/005/011/012/013/014/020/032/035)。
 *
 * 🚨 本文件住 `src/optionsdesk/` ⇒ 受 `check-optionsdesk-rule-constants.ts` 全扫: 档位系数
 * 一律由 rules 派生比较, **不写 `0.8` / `0.6` / `1.2` 任一字面量** (fixture 取值也避开这三个
 * 子串)。V=50 ⇒ W / 四区间 / 愿卖锚全部走 `anchor.rules` 单点口径。
 */
const V = new Prisma.Decimal('50');
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const anchorRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7n,
  ticker: 'us:PEP',
  v: V,
  asof: day('2026-06-30'),
  method: 'dcf',
  confidence: new Prisma.Decimal('8'), // → L2
  confidenceSource: 'manual',
  excluded: false,
  excludeReason: null,
  nextReview: day('2026-09-30'),
  lastReviewedOn: day('2026-06-30'),
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  lLevelEffective: 'L2',
  lastClose: new Prisma.Decimal('36'),
  lastCloseDate: day('2026-07-31'),
  // 061: 盘中两列空 = 还没经历过任何盘中采集 ⇒ 恒收盘档 (本文件验的是四态与新鲜度, 不验档位)。
  intradayPrice: null,
  intradayAt: null,
  breachStartedOn: null,
  createdAt: day('2026-05-01'),
  updatedAt: day('2026-07-31'),
  ...overrides,
});

/** vendor 直读的一行 IV 日快照 (只含读端 select 的三列 + date)。 */
const ivRow = (overrides: Record<string, unknown> = {}) => ({
  date: day('2026-07-31'),
  iv: new Prisma.Decimal('24.8'),
  ivPercentile: new Prisma.Decimal('58.4'),
  ...overrides,
});

interface PrismaMock {
  prisma: PrismaService;
  /** 062 T010: 陈旧度基准改走 `TRADING_CALENDAR_PORT`，不再是 `tradingDay.findFirst`。 */
  calendar: TradingCalendarStub;
  anchorFindUnique: Fn;
  instrumentFindUnique: Fn;
  ivFindFirst: Fn;
}

function buildPrismaMock(
  opts: {
    anchor?: unknown;
    instrument?: unknown;
    iv?: unknown;
  } = {},
): PrismaMock {
  // 🚨 一律用 `=== undefined` 判缺省, **不用 `??`** —— 本文件的每个 `null` 入参都是「该行不
  // 存在」这个被测语义本身, `??` 会把它悄悄换回 fixture, 让四态里的空态测试变成平凡绿。
  const anchorFindUnique = vi
    .fn()
    .mockResolvedValue(opts.anchor === undefined ? anchorRow() : opts.anchor);
  const instrumentFindUnique = vi
    .fn()
    .mockResolvedValue(opts.instrument === undefined ? { id: 42n } : opts.instrument);
  const ivFindFirst = vi.fn().mockResolvedValue(opts.iv === undefined ? ivRow() : opts.iv);
  // FR-020 新鲜度基准: 默认「交易日历无行」⇒ fail-open 判 CURRENT ——
  // 既有断言不受影响; 需要判 STALE 的用例自己 mockResolvedValue 一行。
  const calendar = stubTradingCalendar();
  const prisma = {
    anchor: { findUnique: anchorFindUnique },
    instrument: { findUnique: instrumentFindUnique },
    underlyingIvDaily: { findFirst: ivFindFirst },
  } as unknown as PrismaService;
  return { prisma, anchorFindUnique, instrumentFindUnique, ivFindFirst, calendar };
}

describe('GetUnderlyingDetailUseCase — 四态 (FR-011 / FR-014)', () => {
  let m: PrismaMock;
  let useCase: GetUnderlyingDetailUseCase;

  beforeEach(() => {
    m = buildPrismaMock();
    useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);
  });

  it('① 锚在 + IV 在 → 锚派生值全部走 rules 单点口径 + IV 读数带自己的 asOf', async () => {
    const detail = await useCase.execute('us:PEP');

    // 派生复用 045 的 anchor.rules (FR-003), 本片零重造
    expect(detail.anchor.w.equals(computeW(V))).toBe(true);
    expect(detail.anchor.zones.floor.equals(computeZoneBoundaries(V).floor)).toBe(true);
    expect(detail.anchor.zones.ceiling.equals(computeZoneBoundaries(V).ceiling)).toBe(true);
    expect(detail.anchor.zones.fairValue.equals(V)).toBe(true);
    expect(detail.anchor.willingSell.longHold.equals(computeWillingSellAnchors(V).longHold)).toBe(
      true,
    );
    expect(detail.anchor.effective.lLevel).toBe(mapConfidenceToLLevel('8'));
    expect(detail.anchor.effective.positionCap!.equals(derivePositionCap('L2')!)).toBe(true);

    // 两侧 asOf 各自独立 (FR-020): 行情 asOf = last_close_date, IV asOf = 快照日
    expect(detail.anchor.row.lastCloseDate).toEqual(day('2026-07-31'));
    expect(detail.iv).toEqual({
      state: 'available',
      iv: ivRow().iv,
      ivPercentile: ivRow().ivPercentile,
      asOf: day('2026-07-31'),
    });
  });

  it('② 锚在 + IV 从未采到 → missing, 三值 null 且不抛 (区块仍渲染, 禁 0 冒充)', async () => {
    m = buildPrismaMock({ iv: null });
    useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);

    const detail = await useCase.execute('us:PEP');

    expect(detail.iv).toEqual({ state: 'missing', iv: null, ivPercentile: null, asOf: null });
    expect(detail.anchor.row.ticker).toBe('us:PEP'); // 锚侧照常
  });

  it('②′ 标的未注册进 marketdata → 同样是 missing 而非报错 (跨 ctx 缺行不是故障)', async () => {
    m = buildPrismaMock({ instrument: null });
    useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);

    const detail = await useCase.execute('us:PEP');

    expect(detail.iv.state).toBe('missing');
    expect(m.ivFindFirst).not.toHaveBeenCalled();
  });

  it('③ 锚在 + IV 窗口不足 (分位为空) → percentile_unavailable, 聚合 IV 与 asOf 仍呈现', async () => {
    m = buildPrismaMock({ iv: ivRow({ ivPercentile: null }) });
    useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);

    const detail = await useCase.execute('us:PEP');

    expect(detail.iv.state).toBe('percentile_unavailable');
    expect(detail.iv.ivPercentile).toBeNull(); // 🚨 MUST NOT 回落成 0 (FR-014)
    expect(detail.iv.iv).not.toBeNull();
    expect(detail.iv.asOf).toEqual(day('2026-07-31'));
  });

  it('④ 无锚 → 404 且带机器可读 code (前端据此渲染「尚未建锚」而非报错页, FR-011)', async () => {
    m = buildPrismaMock({ anchor: null });
    useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);

    await expect(useCase.execute('us:NOPE')).rejects.toBeInstanceOf(NotFoundException);
    await expect(useCase.execute('us:NOPE')).rejects.toMatchObject({
      response: { code: ANCHOR_NOT_FOUND_FOR_SYMBOL },
    });
    // 无锚即无详情 ⇒ 不该再去打跨 ctx 的表
    expect(m.instrumentFindUnique).not.toHaveBeenCalled();
    expect(m.ivFindFirst).not.toHaveBeenCalled();
  });

  it('非 canonical `market:code` → 折叠成 404 (与「没建锚」不可区分, 无第二套校验面)', async () => {
    m = buildPrismaMock({ anchor: null });
    useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);
    await expect(useCase.execute('PEP')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GetUnderlyingDetailUseCase — 跨 ctx 只读直查纪律 (FR-032, Q7-B)', () => {
  it('🚨 跨 ctx 读失败 → 只降级不整体失败 (锚侧照常返回, 形态同 anchor-driven-sync-gate)', async () => {
    const m = buildPrismaMock();
    m.ivFindFirst.mockRejectedValue(new Error('connection reset'));
    const useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);

    const detail = await useCase.execute('us:PEP');

    expect(detail.iv).toEqual({ state: 'read_failed', iv: null, ivPercentile: null, asOf: null });
    expect(detail.anchor.w.equals(computeW(V))).toBe(true); // 锚卡不受牵连
  });

  it('IV 日快照取**最近一期** (date desc 首行) —— 当日未采到不等于没有数据', async () => {
    const m = buildPrismaMock();
    const useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);

    await useCase.execute('us:PEP');

    const args = m.ivFindFirst.mock.calls[0]![0] as {
      where: { instrumentId: bigint };
      orderBy: { date: string };
      select: Record<string, boolean>;
    };
    expect(args.where).toEqual({ instrumentId: 42n });
    expect(args.orderBy).toEqual({ date: 'desc' });
    // 🚨 FR-013 机械防线: `ivRank` 根本不进 select ⇒ IVR 不可能顺着任何投影漏上屏
    expect(Object.keys(args.select).sort()).toEqual(['date', 'iv', 'ivPercentile']);
  });

  it('读端零写: 三次调用全是 find*, 无任何 update / upsert / create', async () => {
    const m = buildPrismaMock();
    const useCase = new GetUnderlyingDetailUseCase(m.prisma, m.calendar);
    await useCase.execute('us:PEP');
    // mock 上只挂了 find* —— 若实现里出现任何写调用会立刻 TypeError
    expect(m.anchorFindUnique).toHaveBeenCalledTimes(1);
    expect(m.instrumentFindUnique).toHaveBeenCalledTimes(1);
    expect(m.ivFindFirst).toHaveBeenCalledTimes(1);
  });

  it('四个态是封闭枚举 (客户端可穷举 switch)', () => {
    expect([...UNDERLYING_IV_STATES]).toEqual([
      'available',
      'percentile_unavailable',
      'missing',
      'read_failed',
    ]);
  });
});

describe('toUnderlyingDetailResponse — 契约面禁字段 (FR-013 / FR-034 / FR-035)', () => {
  const detailOf = async (iv?: unknown) => {
    const m = buildPrismaMock(iv === undefined ? {} : { iv });
    return new GetUnderlyingDetailUseCase(m.prisma, m.calendar).execute('us:PEP');
  };

  it('IV 读数字段封闭 —— 不含 iv_rank、不含 T010 的双算自算值', async () => {
    const res = toUnderlyingDetailResponse(await detailOf());
    // 四字段 + FR-020 的新鲜度档 (2026-08-04 加, 判据在 server 侧, 见 marketdata/freshness-tier.ts)。
    expect(Object.keys(res.iv).sort()).toEqual([
      'aggregateIv',
      'asOf',
      'freshnessTier',
      'ivPercentile',
      'state',
    ]);
    const wire = JSON.stringify(res);
    // 🚨 FR-013: vendor 的 IVR 只落库不上屏
    expect(wire).not.toMatch(/ivRank|iv_rank/i);
    // 🚨 FR-034/T010: 自算分位只进采集侧告警面, MUST NOT 顺着 DTO 漏进 UI
    expect(wire).not.toMatch(/selfCalc|self_calc|computedPercentile|crossCheck/i);
  });

  it('🚨 FR-035: 字段名与文案里不出现 IV30d —— 一律「富途标的聚合 IV」', async () => {
    const res = toUnderlyingDetailResponse(await detailOf());
    expect(JSON.stringify(res)).not.toMatch(/iv30d/i);
  });

  /**
   * 🚨 **FR-020 判据在 server** —— 这几条是 046 那个「境内看美股恒显已过时」缺陷的回归防线。
   * 判别性在于: 行情 asOf 与 IV asOf **相对同一个基准分别判档**, 且档位来自交易日历而不是
   * 任何本地日期。基准写死在 mock 里 ⇒ 与跑测时的墙上时钟无关。
   */
  describe('FR-020 新鲜度档 (判据 = 最近一个已收盘交易日)', () => {
    const withSession = async (session: string, ivDate: string) => {
      const m = buildPrismaMock({ iv: ivRow({ date: day(ivDate) }) });
      m.calendar.setLastClosed(session);
      return toUnderlyingDetailResponse(
        await new GetUnderlyingDetailUseCase(m.prisma, m.calendar).execute('us:PEP'),
      );
    };

    it('asOf 等于最近已收盘交易日 ⇒ CURRENT (境内看美股的正常态, 不再恒判陈旧)', async () => {
      const res = await withSession('2026-07-31', '2026-07-31');
      expect(res.iv.freshnessTier).toBe('CURRENT');
      // 锚卡行情 asOf 同为 07-31 (fixture) ⇒ 同样 CURRENT。
      expect(res.anchor.quoteFreshnessTier).toBe('CURRENT');
    });

    it('IV 停在更早的交易日 ⇒ 只有 IV 侧 STALE, 行情侧不受牵连 (两个独立的新鲜度)', async () => {
      const res = await withSession('2026-07-31', '2026-07-29');
      expect(res.iv.freshnessTier).toBe('STALE');
      expect(res.anchor.quoteFreshnessTier).toBe('CURRENT');
    });

    it('两侧都落后 ⇒ 两侧都 STALE (基准前移即整体判陈旧)', async () => {
      const res = await withSession('2026-08-03', '2026-07-29');
      expect(res.iv.freshnessTier).toBe('STALE');
      expect(res.anchor.quoteFreshnessTier).toBe('STALE');
    });
  });

  it('金融数值一律定标 string, 缺失透传 null (禁伪造 0)', async () => {
    const ok = toUnderlyingDetailResponse(await detailOf());
    expect(ok.symbol).toBe('us:PEP');
    expect(ok.iv).toEqual({
      state: 'available',
      aggregateIv: '24.80000000',
      ivPercentile: '58.4000',
      asOf: '2026-07-31',
      freshnessTier: 'CURRENT', // 本 stub 的交易日历无行 ⇒ fail-open
    });
    expect(ok.anchor.w).toBe(computeW(V).toFixed(4));

    const missing = toUnderlyingDetailResponse(await detailOf(null));
    expect(missing.iv).toEqual({
      state: 'missing',
      aggregateIv: null,
      ivPercentile: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE',
    });
  });
});
