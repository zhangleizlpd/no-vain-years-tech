import { describe, it, expect, vi } from 'vitest';
import { CalendarSourceFallbackChain } from './calendar-source-fallback-chain.adapter.js';
import { FutuCalendarAdapter } from './futu-calendar.adapter.js';
import type { TradingCalendarSource } from './trading-calendar-source.port.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途 US 交易日历 adapter mock 单测 (sellput-viz Phase 1 #5)。
 *
 * **仿真端逐条复刻 2026-07-31 本机实测的真实边界行为**（7 个窗口, 见 adapter 类注释表）——
 * 关键点是这两个边界**都不报错、只静默截断**, 所以仿真端也必须静默截断, 否则测试就在测一个
 * 比真端友善的世界:
 * - 历史: 滚动 10 年上限, 早于上限的部分**静默截头**;
 * - 未来: 视野止于**当年 12-31**, 之后的部分**静默截尾**;
 * - 完全越界: 返 **0 行, 200**。
 *
 * 真端点 / 真隧道由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`,
 * `RUN_MARKETDATA_IT`) —— 此处仅解析 / 截断断言逻辑 (沿 015 全 adapter 范式)。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';
const DAY_MS = 86_400_000;

/** 仿真端持有的美股休市日 (2026/2027 主要节假日, 够覆盖本 spec 的窗口)。 */
const HOLIDAYS = new Set([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  '2027-01-01',
  '2027-01-18',
]);

/** 半日市 (实测: 2026-11-27 感恩节次日 = `MORNING`)。仍是**交易日**。 */
const HALF_DAYS = new Set(['2026-11-27']);

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parse(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** 闭区间内的真实交易日 (工作日 − 节假日)；`from > to` → 空。 */
function tradingDaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let ms = parse(from); ms <= parse(to); ms += DAY_MS) {
    const dow = new Date(ms).getUTCDay();
    const day = iso(ms);
    if (dow >= 1 && dow <= 5 && !HOLIDAYS.has(day)) out.push(day);
  }
  return out;
}

interface ShimCall {
  url: string;
  auth: string | undefined;
}

/**
 * 富途 shim 仿真端。`today` 决定历史上限 (`today − 10y`); `horizonCeil` 决定未来视野, 缺省
 * = `today` 所在年的 12-31 (实测口径)。**两条边界都静默夹取, 不报错。**
 *
 * `horizonCeil` 可显式传入, 是为了能构造「已跨年但次年日历尚未发布」这一未实测但完全可能的
 * 时刻 —— 我们只实证了「2026-07-31 时视野止于 2026-12-31」, **富途几时把视野推到次年是未知
 * 的**。断言按最坏假设写: 未知就当它可能晚。
 */
function makeShim(
  today = '2026-07-31',
  horizonCeil = `${today.slice(0, 4)}-12-31`,
): { http: VendorHttpClient; calls: ShimCall[] } {
  const calls: ShimCall[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    const params = new URL(req.url).searchParams;
    const start = params.get('start') ?? '';
    const end = params.get('end') ?? '';

    const historyFloor = iso(parse(today) - 3652 * DAY_MS); // ≈ today − 10y
    // 🚨 静默夹取 —— 真端就是这么干的: 不报错、不提示, 直接给一个更窄的答案。
    const effectiveFrom = start < historyFloor ? historyFloor : start;
    const effectiveTo = end > horizonCeil ? horizonCeil : end;

    const rows = tradingDaysBetween(effectiveFrom, effectiveTo).map((time) => ({
      time,
      trade_date_type: HALF_DAYS.has(time) ? 'MORNING' : 'WHOLE',
    }));
    return { as_of: `${today}T09:44:00+00:00`, count: rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

/** 定值 http (响应形态断言用)。 */
function makeHttp(payload: unknown): VendorHttpClient {
  return { request: vi.fn(async () => payload) } as unknown as VendorHttpClient;
}

function makeAdapter(http: VendorHttpClient): FutuCalendarAdapter {
  return new FutuCalendarAdapter(http, BASE, TOKEN);
}

describe('FutuCalendarAdapter', () => {
  describe('请求结构 + 市场映射', () => {
    it('GET <shim>/trading-days?market=US&start&end + Bearer 鉴权', async () => {
      const { http, calls } = makeShim();
      const out = await makeAdapter(http).fetchTradingDates('us', '2026-07-01', '2026-07-31');

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`${BASE}/trading-days?market=US&start=2026-07-01&end=2026-07-31`);
      // 🚨 token 逐请求注入 (profile 是静态常量, 凭证不进常量)。
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
      expect(out.servedBy).toBe('futu'); // 自报家门 (降级可观测, FR-014)
      expect(out.dates).toEqual(tradingDaysBetween('2026-07-01', '2026-07-31'));
      expect(out.dates).not.toContain('2026-07-03'); // 独立日 (顺延) 休市
    });

    it('半日市行照常计入交易日, 但 trade_date_type 不出现在返回里 (本 PR 不落库)', async () => {
      const { http } = makeShim();
      const out = await makeAdapter(http).fetchTradingDates('us', '2026-11-20', '2026-12-04');

      expect(out.dates).toContain('2026-11-27'); // MORNING 仍是交易日
      expect(out.dates).not.toContain('2026-11-26'); // 感恩节休市
      expect(Object.keys(out)).toEqual(['dates', 'servedBy']); // 契约面无第三个字段
    });

    it('非 us 市场 → 明确抛 (cn/hk 走腾讯主源, 不该路由到这里), 且零外呼', async () => {
      const { http, calls } = makeShim();
      await expect(
        makeAdapter(http).fetchTradingDates('cn', '2026-07-01', '2026-07-31'),
      ).rejects.toThrow(/不支持市场/);
      expect(calls).toHaveLength(0);
    });

    it('非法日期 / from > to → 抛, 且零外呼 (禁 NaN 静默退化成「零工作日 → 闸恒过」)', async () => {
      const { http, calls } = makeShim();
      await expect(
        makeAdapter(http).fetchTradingDates('us', '2026/07/01', '2026-07-31'),
      ).rejects.toThrow(/日期/);
      await expect(
        makeAdapter(http).fetchTradingDates('us', '2026-07-31', '2026-07-01'),
      ).rejects.toThrow(/区间非法/);
      expect(calls).toHaveLength(0);
    });
  });

  describe('响应 shape 判据', () => {
    it('缺 rows[] (契约变更) → throw 而非静默返空', async () => {
      await expect(
        makeAdapter(makeHttp({ as_of: 'x', count: 0 })).fetchTradingDates(
          'us',
          '2026-07-01',
          '2026-07-31',
        ),
      ).rejects.toThrow(/rows/);
    });

    it('🚨 行缺合法 time → throw 而非跳过 (静默丢一行 = 静默丢一个交易日)', async () => {
      const rows = [{ time: '2026-07-01' }, { trade_date_type: 'WHOLE' }];
      await expect(
        makeAdapter(makeHttp({ rows })).fetchTradingDates('us', '2026-07-01', '2026-07-31'),
      ).rejects.toThrow(/契约变更/);

      await expect(
        makeAdapter(makeHttp({ rows: [{ time: '2026/07/01' }] })).fetchTradingDates(
          'us',
          '2026-07-01',
          '2026-07-31',
        ),
      ).rejects.toThrow(/契约变更/);
    });

    it('乱序 / 重复行 → 升序去重后返回', async () => {
      const rows = [
        { time: '2026-07-02', trade_date_type: 'WHOLE' },
        { time: '2026-07-01', trade_date_type: 'WHOLE' },
        { time: '2026-07-02', trade_date_type: 'WHOLE' },
      ];
      const out = await makeAdapter(makeHttp({ rows })).fetchTradingDates(
        'us',
        '2026-07-01',
        '2026-07-02',
      );
      expect(out.dates).toEqual(['2026-07-01', '2026-07-02']);
    });
  });

  // 🚨🚨 本 adapter 的核心防线 —— 两条边界在真端都表现为「静默截断」。
  describe('首尾截断断言 (核心防线)', () => {
    it('🚨 截头: from 早于富途 10 年历史上限 → throw (实测 2016-01-01 请求返首日 2016-08-01)', async () => {
      const { http } = makeShim('2026-07-31');
      // seed CLI 的默认 --from 就是 2015-01-01 → 正是这条路径。
      await expect(
        makeAdapter(http).fetchTradingDates('us', '2015-01-01', '2026-07-31'),
      ).rejects.toThrow(/疑截头/);
    });

    it('🚨 截尾: 跨年窗 → throw (实测 2026-12-20..2027-01-20 只返到 2026-12-31)', async () => {
      const { http } = makeShim('2026-12-22');
      await expect(
        makeAdapter(http).fetchTradingDates('us', '2026-12-20', '2027-01-20'),
      ).rejects.toThrow(/疑截尾/);
    });

    it('🚨🚨 年初次年日历未发布 (最隐蔽的那个) → throw', async () => {
      // 2027-01-05 跑日常 populate: 窗 = [今天-30, 今天], 而 vendor 视野此刻仍停在 2026-12-31。
      const { http } = makeShim('2027-01-05', '2026-12-31');
      await expect(
        makeAdapter(http).fetchTradingDates('us', '2026-12-06', '2027-01-05'),
      ).rejects.toThrow(/疑截尾/);
    });

    it('次年日历已发布时同一个窗正常通过 (断言不是「跨年就报警」)', async () => {
      const { http } = makeShim('2027-01-05', '2027-12-31');
      const out = await makeAdapter(http).fetchTradingDates('us', '2026-12-06', '2027-01-05');
      expect(out.dates).toContain('2027-01-04');
      expect(out.dates).not.toContain('2027-01-01'); // 元旦休市
    });

    it('🚨 而同一份截尾结果能大摇大摆过链上的合理性闸 —— 这就是闸必须在 adapter 的理由', async () => {
      // 取「年初未发布」那一刻 vendor 真正会给的日期集, 塞进一个不做截断断言的节点。
      const truncated = tradingDaysBetween('2026-12-06', '2026-12-31');
      const naiveNode: TradingCalendarSource = {
        fetchTradingDates: async () => ({ dates: truncated, servedBy: 'naive' }),
      };
      const out = await new CalendarSourceFallbackChain([naiveNode]).fetchTradingDates(
        'us',
        '2026-12-06',
        '2027-01-05',
      );
      // 闸放行 (17 天 ≥ 下界 ⌈22 工作日 × 0.4⌉ = 9) → 缺 1 月初的日历会被原样写库。
      expect(out.dates).toEqual(truncated);
      expect(out.dates).not.toContain('2027-01-04');
    });

    it('🚨 完全越界返 0 行 (200) → throw, 禁当成「区间无交易日」写库', async () => {
      const { http } = makeShim('2026-07-31');
      await expect(
        makeAdapter(http).fetchTradingDates('us', '2006-01-01', '2010-12-31'),
      ).rejects.toThrow(/返 0 天/);
    });

    it('合法空窗 (纯周末) → 空 dates 且不 throw (port 契约: 区间确无交易日 = 合法)', async () => {
      const { http } = makeShim();
      expect(await makeAdapter(http).fetchTradingDates('us', '2026-07-04', '2026-07-05')).toEqual({
        dates: [],
        servedBy: 'futu',
      });
    });

    it('合法长周末端点 (to 落在假期后的周日) → 不误伤', async () => {
      const { http } = makeShim();
      // to=2026-07-05(周日): 末个交易日 2026-07-02(周四), 间隔工作日仅 7/3(独立日顺延休市) = 1。
      const out = await makeAdapter(http).fetchTradingDates('us', '2026-06-22', '2026-07-05');
      expect(out.dates[out.dates.length - 1]).toBe('2026-07-02');
    });

    it('合法起点在节假日 (from=元旦) → 不误判为截头', async () => {
      const { http } = makeShim();
      const out = await makeAdapter(http).fetchTradingDates('us', '2026-01-01', '2026-01-31');
      expect(out.dates[0]).toBe('2026-01-02');
    });

    it('日常 30 天 populate 窗 (最常跑的那条路) → 正常返回, 不触任何闸', async () => {
      const { http } = makeShim();
      const out = await makeAdapter(http).fetchTradingDates('us', '2026-07-01', '2026-07-31');
      expect(out.dates).toEqual(tradingDaysBetween('2026-07-01', '2026-07-31'));
    });
  });
});
