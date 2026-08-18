import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  GetThermometerUseCase,
  US_INDEX_CODES,
  US_INDEX_STATES,
  VVIX_VIX_RATIO_STATES,
  computeVvixVixRatio,
  type UsIndexReadout,
} from './get-thermometer.usecase';
import { UNDERLYING_IV_STATES } from './get-underlying-detail.usecase';
import { toThermometerResponse } from './optionsdesk.dto';
import type { PrismaService } from '../security/prisma.service';
import {
  stubTradingCalendar,
  type TradingCalendarStub,
} from '../../test/_support/trading-calendar-stub';

/**
 * 046 T017 — 温度计读端单测 (FR-015/FR-016/FR-017/FR-018/FR-027/FR-032/FR-035)。
 *
 * 🚨 本文件住 `src/optionsdesk/` ⇒ 受 `check-optionsdesk-rule-constants.ts` 全扫: fixture 取值
 * 一律避开 `0.8` / `0.6` / `1.2` 三个子串, 比值断言也**算**出来而不写死。
 *
 * prisma mock 是个**微型 fake 而非固定返回值**: `groupBy` 真按 `instrumentId` 求最大 date、
 * `findMany` 真按 (instrumentId, date) 取行 —— 否则「取最近一期」这条断言就是自证 (mock 返回
 * 什么它就是什么), 与 T015 单测那条同一纪律。
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const dec = (v: string) => new Prisma.Decimal(v);

interface AnchorLite {
  ticker: string;
  excluded: boolean;
  excludeReason: string | null;
}

interface IvRowLite {
  instrumentId: bigint;
  date: Date;
  iv: Prisma.Decimal | null;
  ivPercentile: Prisma.Decimal | null;
}

interface IndexRowLite {
  date: Date;
  close: Prisma.Decimal;
}

const PEP: AnchorLite = { ticker: 'us:PEP', excluded: false, excludeReason: null };
/** `excluded` 的锚**照常在列表里**并带标记 (045 语义: 锚 = 采集意愿, excluded = 交易意愿)。 */
const VICI: AnchorLite = { ticker: 'us:VICI', excluded: true, excludeReason: '暂不交易' };

const PEP_ID = 42n;
const VICI_ID = 43n;

const INSTRUMENTS = [
  { id: PEP_ID, market: 'us', code: 'PEP' },
  { id: VICI_ID, market: 'us', code: 'VICI' },
];

const IV_AS_OF = '2026-07-31';

/** PEP: 两期 (07-28 是更早的一期, 不该被取); VICI: 分位为空 ⇒ 「分位不可算」行。 */
const IV_ROWS: IvRowLite[] = [
  { instrumentId: PEP_ID, date: day('2026-07-28'), iv: dec('21.5'), ivPercentile: dec('44.1') },
  { instrumentId: PEP_ID, date: day(IV_AS_OF), iv: dec('24.9'), ivPercentile: dec('58.4') },
  { instrumentId: VICI_ID, date: day(IV_AS_OF), iv: dec('19.75'), ivPercentile: null },
];

const VIX_ROW: IndexRowLite = { date: day(IV_AS_OF), close: dec('18.45') };
const VVIX_ROW: IndexRowLite = { date: day(IV_AS_OF), close: dec('96.3') };

type Fn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  prisma: PrismaService;
  /** 062 T010: 陈旧度基准改走 `TRADING_CALENDAR_PORT`，不再是 `tradingDay.findFirst`。 */
  calendar: TradingCalendarStub;
  anchorFindMany: Fn;
  instrumentFindMany: Fn;
  ivGroupBy: Fn;
  ivFindMany: Fn;
  indexFindFirst: Fn;
}

/**
 * 🚨 一律用 `=== undefined` 判缺省, **不用 `??`** —— 每个 `null` / `[]` 入参都是「该行不存在」
 * 这个被测语义本身, `??` 会把它悄悄换回 fixture, 让降级态测试变成平凡绿 (同 T015)。
 */
function buildPrismaMock(
  opts: {
    anchors?: AnchorLite[];
    instruments?: { id: bigint; market: string; code: string }[];
    ivRows?: IvRowLite[];
    vix?: IndexRowLite | null;
    vvix?: IndexRowLite | null;
  } = {},
): PrismaMock {
  const anchors = opts.anchors === undefined ? [PEP, VICI] : opts.anchors;
  const instruments = opts.instruments === undefined ? INSTRUMENTS : opts.instruments;
  const ivRows = opts.ivRows === undefined ? IV_ROWS : opts.ivRows;
  const vix = opts.vix === undefined ? VIX_ROW : opts.vix;
  const vvix = opts.vvix === undefined ? VVIX_ROW : opts.vvix;

  const anchorFindMany = vi.fn().mockResolvedValue(anchors);

  const instrumentFindMany = vi.fn(async (args: { where: { OR: unknown[] } }) => {
    const pairs = args.where.OR as { market: string; code: string }[];
    return instruments.filter((i) => pairs.some((p) => p.market === i.market && p.code === i.code));
  });

  const ivGroupBy = vi.fn(async (args: { where: { instrumentId: { in: bigint[] } } }) => {
    const ids = args.where.instrumentId.in;
    const latest = new Map<bigint, Date>();
    for (const row of ivRows) {
      if (!ids.includes(row.instrumentId)) continue;
      const seen = latest.get(row.instrumentId);
      if (seen === undefined || row.date.getTime() > seen.getTime()) {
        latest.set(row.instrumentId, row.date);
      }
    }
    return [...latest].map(([instrumentId, date]) => ({ instrumentId, _max: { date } }));
  });

  const ivFindMany = vi.fn(async (args: { where: { OR: unknown[] } }) => {
    const keys = args.where.OR as { instrumentId: bigint; date: Date }[];
    return ivRows.filter((row) =>
      keys.some(
        (k) => k.instrumentId === row.instrumentId && k.date.getTime() === row.date.getTime(),
      ),
    );
  });

  const indexFindFirst = vi.fn(async (args: { where: { indexCode: string } }) =>
    args.where.indexCode === US_INDEX_CODES.vix ? vix : vvix,
  );

  // FR-020 新鲜度基准: 默认「交易日历无行」⇒ fail-open 判 CURRENT ——
  // 既有断言不受影响; 需要判 STALE 的用例自己 mockResolvedValue 一行。
  const calendar = stubTradingCalendar();
  const prisma = {
    anchor: { findMany: anchorFindMany },
    instrument: { findMany: instrumentFindMany },
    underlyingIvDaily: { groupBy: ivGroupBy, findMany: ivFindMany },
    usIndexDaily: { findFirst: indexFindFirst },
  } as unknown as PrismaService;

  return {
    prisma,
    anchorFindMany,
    instrumentFindMany,
    ivGroupBy,
    ivFindMany,
    indexFindFirst,
    calendar,
  };
}

const run = (opts: Parameters<typeof buildPrismaMock>[0] = {}) => {
  const m = buildPrismaMock(opts);
  return { m, exec: () => new GetThermometerUseCase(m.prisma, m.calendar).execute() };
};

describe('GetThermometerUseCase — 指数表盘 (FR-015 / FR-016 / FR-017)', () => {
  it('① VIX + VVIX 同基准 → 两侧各带自己的 asOf + 比值在 server 算并标基准日', async () => {
    const t = await run().exec();

    expect(t.vix).toEqual({ state: 'available', close: VIX_ROW.close, asOf: day(IV_AS_OF) });
    expect(t.vvix).toEqual({ state: 'available', close: VVIX_ROW.close, asOf: day(IV_AS_OF) });
    expect(t.vvixVixRatio.state).toBe('available');
    // 🚨 比值算在 server (FR-016): 放前端等于每个消费方各自重实现一次基准纪律
    expect(t.vvixVixRatio.value!.equals(VVIX_ROW.close.div(VIX_ROW.close))).toBe(true);
    expect(t.vvixVixRatio.basisDate).toEqual(day(IV_AS_OF));
  });

  it('② 两侧最新可得日**不同** → 比值不计算 + 显式 basis_mismatch, 两值照常各带 asOf', async () => {
    const t = await run({ vvix: { date: day('2026-07-30'), close: dec('96.3') } }).exec();

    expect(t.vix.asOf).toEqual(day(IV_AS_OF));
    expect(t.vvix.asOf).toEqual(day('2026-07-30'));
    expect(t.vvixVixRatio).toEqual({ state: 'basis_mismatch', value: null, basisDate: null });
  });

  it('③ VVIX 缺 → VVIX 与比值**各自**显式不可用, MUST NOT 拿 VIX 单独推算比值', async () => {
    const t = await run({ vvix: null }).exec();

    expect(t.vix.state).toBe('available'); // 表盘照常
    expect(t.vvix).toEqual({ state: 'missing', close: null, asOf: null });
    expect(t.vvixVixRatio).toEqual({ state: 'missing', value: null, basisDate: null });
  });

  it('④ VIX 缺 → 显式 missing 且 close 为 null (🚨 禁 0: 指针停 0 会被读成「极度平静」)', async () => {
    const t = await run({ vix: null }).exec();

    expect(t.vix).toEqual({ state: 'missing', close: null, asOf: null });
    expect(t.vix.close).not.toEqual(dec('0')); // FR-017 的反面写死一遍
    expect(t.vvix.state).toBe('available'); // 另一侧不受牵连
    expect(t.vvixVixRatio.state).toBe('missing');
  });

  it('⑤ 指数跨 ctx 读失败 → 两侧 + 比值 read_failed, **锚列表照常返回** (只降级不整体失败)', async () => {
    const { m, exec } = run();
    m.indexFindFirst.mockRejectedValue(new Error('connection reset'));

    const t = await exec();

    expect(t.vix.state).toBe('read_failed');
    expect(t.vvix.state).toBe('read_failed');
    expect(t.vvixVixRatio.state).toBe('read_failed');
    expect(t.underlyings.map((r) => r.ticker)).toEqual(['us:PEP', 'us:VICI']);
  });

  it('指数读**只取 close + date**: OHLC 不进 select ⇒ VVIX 的恒 NULL 列不可能被当 0 用', async () => {
    const { m, exec } = run();
    await exec();

    const args = m.indexFindFirst.mock.calls[0]![0] as {
      where: { indexCode: string };
      orderBy: { date: string };
      select: Record<string, boolean>;
    };
    expect(args.orderBy).toEqual({ date: 'desc' });
    expect(Object.keys(args.select).sort()).toEqual(['close', 'date']);
    expect(m.indexFindFirst.mock.calls.map((c) => (c[0] as typeof args).where.indexCode)).toEqual([
      US_INDEX_CODES.vix,
      US_INDEX_CODES.vvix,
    ]);
  });
});

describe('computeVvixVixRatio — 基准判定纯函数 (FR-016)', () => {
  const readout = (state: string, close: string | null, asOf: string | null): UsIndexReadout =>
    ({
      state,
      close: close === null ? null : dec(close),
      asOf: asOf === null ? null : day(asOf),
    }) as UsIndexReadout;

  it('同一交易日 → 算, 基准日 = 该日', () => {
    const r = computeVvixVixRatio(
      readout('available', '18.45', IV_AS_OF),
      readout('available', '96.3', IV_AS_OF),
    );
    expect(r.state).toBe('available');
    expect(r.value!.equals(dec('96.3').div(dec('18.45')))).toBe(true);
    expect(r.basisDate).toEqual(day(IV_AS_OF));
  });

  it('不同交易日 → basis_mismatch (VIX 与 VVIX 来自两个独立 CBOE 文件, 生产可达)', () => {
    const r = computeVvixVixRatio(
      readout('available', '18.45', IV_AS_OF),
      readout('available', '96.3', '2026-07-30'),
    );
    expect(r).toEqual({ state: 'basis_mismatch', value: null, basisDate: null });
  });

  it('任一侧 read_failed → 比值 read_failed (故障 ≠ 暂无数据, 两态蓄意分开)', () => {
    expect(
      computeVvixVixRatio(
        readout('read_failed', null, null),
        readout('available', '96.3', IV_AS_OF),
      ).state,
    ).toBe('read_failed');
  });

  it('分母非正 (脏数据) → 不可算, 折进 missing 而非造第五个态', () => {
    const r = computeVvixVixRatio(
      readout('available', '0', IV_AS_OF),
      readout('available', '96.3', IV_AS_OF),
    );
    expect(r).toEqual({ state: 'missing', value: null, basisDate: null });
  });
});

describe('GetThermometerUseCase — 逐票 IVP 列表 (FR-018 / FR-027)', () => {
  it('列表含全部锚: 分位不可算的行保留 + excluded 行照常在列并带标记', async () => {
    const t = await run().exec();

    expect(t.total).toBe(2);
    expect(t.underlyings[0]).toEqual({
      ticker: 'us:PEP',
      excluded: false,
      excludeReason: null,
      iv: {
        state: 'available',
        iv: dec('24.9'),
        ivPercentile: dec('58.4'),
        asOf: day(IV_AS_OF), // 🚨 取最近一期, 不是 07-28 那期
      },
      lastClosedSession: null, // 本 stub 的交易日历无行 ⇒ fail-open (档位判据的专属测在下面)
    });
    expect(t.underlyings[1]).toEqual({
      ticker: 'us:VICI',
      excluded: true,
      excludeReason: '暂不交易',
      iv: {
        state: 'percentile_unavailable', // 🚨 MUST NOT 回落成 0
        iv: dec('19.75'),
        ivPercentile: null,
        asOf: day(IV_AS_OF),
      },
      lastClosedSession: null,
    });
  });

  it('🚨 零锚: 列表空, 但**表盘部分照常返回** (指数不依赖锚, FR-027 的效果面)', async () => {
    const { m, exec } = run({ anchors: [] });

    const t = await exec();

    expect(t.underlyings).toEqual([]);
    expect(t.total).toBe(0);
    expect(t.vix.state).toBe('available');
    expect(t.vvix.state).toBe('available');
    expect(t.vvixVixRatio.state).toBe('available');
    // 零锚 ⇒ 跨 ctx 逐票读一次都不该发
    expect(m.instrumentFindMany).not.toHaveBeenCalled();
    expect(m.ivGroupBy).not.toHaveBeenCalled();
  });

  it('标的未注册进 marketdata / ticker 非 canonical → missing (跨 ctx 缺行不是故障)', async () => {
    const t = await run({
      anchors: [PEP, { ticker: 'PEP', excluded: false, excludeReason: null }],
      instruments: [],
    }).exec();

    expect(t.underlyings.map((r) => r.iv.state)).toEqual(['missing', 'missing']);
    expect(t.underlyings.every((r) => r.iv.iv === null && r.iv.ivPercentile === null)).toBe(true);
  });

  it('IV 跨 ctx 读失败 → 每行 read_failed (锚仍在列), **指数侧不受牵连**', async () => {
    const { m, exec } = run();
    m.ivFindMany.mockRejectedValue(new Error('connection reset'));

    const t = await exec();

    expect(t.underlyings.map((r) => r.iv.state)).toEqual(['read_failed', 'read_failed']);
    expect(t.underlyings.map((r) => r.excluded)).toEqual([false, true]);
    expect(t.vix.state).toBe('available');
  });

  it('逐票读是**批量**的: 锚数增长不改往返数 (3 次跨 ctx 查, 无 N+1)', async () => {
    const { m, exec } = run();
    await exec();

    expect(m.instrumentFindMany).toHaveBeenCalledTimes(1);
    expect(m.ivGroupBy).toHaveBeenCalledTimes(1);
    expect(m.ivFindMany).toHaveBeenCalledTimes(1);
    // 🚨 FR-013 机械防线: `ivRank` 根本不进 select ⇒ IVR 不可能顺着任何投影漏上屏
    const args = m.ivFindMany.mock.calls[0]![0] as { select: Record<string, boolean> };
    expect(Object.keys(args.select).sort()).toEqual(['date', 'instrumentId', 'iv', 'ivPercentile']);
  });

  it('读端零写: mock 上只挂 find* / groupBy, 出现任何写调用会立刻 TypeError', async () => {
    const { m, exec } = run();
    await exec();
    expect(m.anchorFindMany).toHaveBeenCalledTimes(1);
  });

  it('三组态都是封闭枚举 (客户端可穷举 switch), 且逐票列表复用 T015 的四态词汇', () => {
    expect([...US_INDEX_STATES]).toEqual(['available', 'missing', 'read_failed']);
    expect([...VVIX_VIX_RATIO_STATES]).toEqual([
      'available',
      'basis_mismatch',
      'missing',
      'read_failed',
    ]);
    expect([...UNDERLYING_IV_STATES]).toEqual([
      'available',
      'percentile_unavailable',
      'missing',
      'read_failed',
    ]);
  });
});

describe('toThermometerResponse — 契约面禁字段 (FR-013 / FR-015 📌 / FR-034 / FR-035)', () => {
  it('🚨 不含 regime 字段 (2026-08-03 拍板移除; mockup 帧⑦ 的 `regime N` 是历史留痕)', async () => {
    const res = toThermometerResponse(await run().exec());
    expect(JSON.stringify(res)).not.toMatch(/regime/i);
  });

  it('🚨 FR-035: 字段名与文案里不出现 IV30d —— 一律「富途标的聚合 IV」', async () => {
    const res = toThermometerResponse(await run().exec());
    expect(JSON.stringify(res)).not.toMatch(/iv30d/i);
  });

  it('不含 iv_rank、不含 T010 的双算自算值', async () => {
    const wire = JSON.stringify(toThermometerResponse(await run().exec()));
    expect(wire).not.toMatch(/ivRank|iv_rank/i);
    expect(wire).not.toMatch(/selfCalc|self_calc|computedPercentile|crossCheck/i);
  });

  it('金融数值一律定标 string; 降级态透传 null (禁伪造 0)', async () => {
    const ok = toThermometerResponse(await run().exec());
    expect(ok.vix).toEqual({
      state: 'available',
      close: '18.4500',
      asOf: IV_AS_OF,
      freshnessTier: 'CURRENT',
    });
    expect(ok.vvixVixRatio).toEqual({
      state: 'available',
      value: VVIX_ROW.close.div(VIX_ROW.close).toFixed(4),
      basisDate: IV_AS_OF,
    });
    expect(ok.underlyings[0]!.iv).toEqual({
      state: 'available',
      aggregateIv: '24.90000000',
      ivPercentile: '58.4000',
      asOf: IV_AS_OF,
      freshnessTier: 'CURRENT',
    });

    const down = toThermometerResponse(await run({ vix: null, vvix: null }).exec());
    expect(down.vix).toEqual({
      state: 'missing',
      close: null,
      asOf: null,
      freshnessTier: 'UNAVAILABLE',
    });
    expect(down.vvixVixRatio).toEqual({ state: 'missing', value: null, basisDate: null });
  });
});
