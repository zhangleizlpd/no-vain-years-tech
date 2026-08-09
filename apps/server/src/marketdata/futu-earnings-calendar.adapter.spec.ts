import { describe, it, expect, vi } from 'vitest';
import {
  EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS,
  EarningsCalendarBudgetExhaustedError,
  EarningsCalendarRejectedError,
} from './earnings-calendar.port.js';
import { FutuEarningsCalendarAdapter } from './futu-earnings-calendar.adapter.js';
import { TransientVendorError, VendorHttpError } from './vendor-http-client.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途财报日历 adapter mock 单测 (047 T018)。
 *
 * 仿真行**逐字段照 shim 的实测形态** (`services/futu-shim/tests/test_app.py` 的 `_earnings_row`,
 * 即 `dataframe_to_records` 直出的 SDK 列)。字段集与值域来自 p3b E8 实测: 7 日窗返 1559 条,
 * `pub_type ∈ {BEFORE, AFTER, REGULAR}` · `period_text` · `eps_actual` + `eps_predict`。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`, `RUN_MARKETDATA_IT`)
 * —— ⚠️ 那道门恒 skip, 本文件全绿**不**构成真契约的证据。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';

/** `/earnings-calendar` 一行 (SDK col_list, 照 shim pytest 的 `_earnings_row`)。 */
function earningsRow(security: string, day: string, extra: Record<string, unknown> = {}) {
  return {
    security,
    name: 'PepsiCo',
    earnings_date: day,
    earnings_timestamp: `${day} 07:00:00`,
    pub_type: 'BEFORE',
    period_text: 'Q3 2026',
    eps_actual: null,
    eps_predict: 2.31,
    revenue_actual: null,
    revenue_predict: 2.4e10,
    ...extra,
  };
}

function makeShim(rows: unknown[], countOverride?: number) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    return { as_of: '2026-08-04T20:19:48+00:00', count: countOverride ?? rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, calls, request };
}

/** 每次调用直接抛 `err` 的假 transport (错误映射用)。 */
function makeThrowingShim(err: unknown) {
  const request = vi.fn(async () => {
    throw err;
  });
  return { http: { request } as unknown as VendorHttpClient, request };
}

const makeAdapter = (http: VendorHttpClient) => new FutuEarningsCalendarAdapter(http, BASE, TOKEN);

/** `YYYY-MM-DD` 加 n 天 (UTC)。 */
function addUtcDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WINDOW_START = '2026-08-04';

/**
 * 合法窗 = **恰好顶到窗宽上限**。窗止**由常量派生**而不写死日期: 上限哪天再被真 vendor 校准
 * (2026-08-07 就校准过一次: 7 → 6), 本文件全部用例跟着走, 不用逐条改日期。
 */
const WINDOW = {
  market: 'us',
  start: WINDOW_START,
  end: addUtcDays(WINDOW_START, EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS),
} as const;

describe('FutuEarningsCalendarAdapter', () => {
  describe('单窗全市场 (getWindow)', () => {
    it('GET <shim>/earnings-calendar?market=US&start&end + Bearer, 无任何标的过滤参数', async () => {
      const { http, calls } = makeShim([earningsRow('US.PEP', '2026-08-06')]);
      await makeAdapter(http).getWindow(WINDOW);

      expect(calls).toHaveLength(1);
      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/earnings-calendar');
      expect(url.searchParams.get('market')).toBe('US');
      expect(url.searchParams.get('start')).toBe(WINDOW.start);
      expect(url.searchParams.get('end')).toBe(WINDOW.end);
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
      // 🚨 市场级接口: 请求里**不能**出现任何标的收窄参数 (Guardrail 2 / FR-035b)。
      // 在这里滤掉, PIT 三件套就只对当前白名单成立, 日后加票时它的改期史无从回补。
      expect([...url.searchParams.keys()].sort()).toEqual(['end', 'market', 'start']);
    });

    it('🚨 库外标的照常返回 —— 全市场落库的前提 (过滤是消费端的事)', async () => {
      const { http } = makeShim([
        earningsRow('US.PEP', '2026-08-06'),
        earningsRow('US.NOBODY', '2026-08-07'),
      ]);
      const out = await makeAdapter(http).getWindow(WINDOW);

      // 端口层滤掉「库里没有的票」= 后面就数不出「跳过了几条」这个监控信号 (plan D-DATA-8)。
      expect(out.map((e) => e.underlyingSymbol)).toEqual(['us:PEP', 'us:NOBODY']);
    });

    it('窗内该市场无财报 → 空数组且不报错 (淡季整周为空是常态)', async () => {
      const { http } = makeShim([]);
      expect(await makeAdapter(http).getWindow(WINDOW)).toEqual([]);
    });
  });

  describe('三态字段映射 (确认 / 预估; 「无」是行缺席, 不是字段值)', () => {
    it('只有 eps_predict ⇒ 预估态: epsActual 落 null 而非 0', async () => {
      const { http } = makeShim([earningsRow('US.PEP', '2026-08-06')]);
      const [event] = await makeAdapter(http).getWindow(WINDOW);

      expect(event).toEqual({
        underlyingSymbol: 'us:PEP',
        earningsDate: '2026-08-06',
        pubType: 'BEFORE',
        periodText: 'Q3 2026',
        // 0 是一个能被下游当真的业绩, 与「尚未公布」方向相反 —— 回落成 0 不会红, 但会造出
        // 一个「已公布且 EPS 为零」的假事实。
        epsActual: null,
        epsPredict: '2.31',
      });
    });

    it('eps_actual 有值 ⇒ 已确认公布态, 两个 eps 都带出且全程 string (禁 JS number 中转)', async () => {
      const { http } = makeShim([
        earningsRow('US.PEP', '2026-08-06', { eps_actual: 2.35, eps_predict: 2.31 }),
      ]);
      const [event] = await makeAdapter(http).getWindow(WINDOW);

      expect([event.epsActual, event.epsPredict]).toEqual(['2.35', '2.31']);
    });

    it('pub_type 三值 vendor 原样透传 (BEFORE / AFTER / REGULAR), 不归一成自造枚举', async () => {
      const { http } = makeShim([
        earningsRow('US.A', '2026-08-06', { pub_type: 'BEFORE' }),
        earningsRow('US.B', '2026-08-06', { pub_type: 'AFTER' }),
        earningsRow('US.C', '2026-08-06', { pub_type: 'REGULAR' }),
      ]);
      const out = await makeAdapter(http).getWindow(WINDOW);

      expect(out.map((e) => e.pubType)).toEqual(['BEFORE', 'AFTER', 'REGULAR']);
    });

    it('period_text 缺失 → null (禁默认值冒充)', async () => {
      const { http } = makeShim([earningsRow('US.PEP', '2026-08-06', { period_text: null })]);
      const [event] = await makeAdapter(http).getWindow(WINDOW);

      expect(event.periodText).toBeNull();
    });

    it('日期列带时间后缀照常截成 YYYY-MM-DD', async () => {
      const { http } = makeShim([earningsRow('US.PEP', '2026-08-06 07:00:00')]);
      const [event] = await makeAdapter(http).getWindow(WINDOW);

      expect(event.earningsDate).toBe('2026-08-06');
    });

    it('坏行 throw 不静默跳过 (缺 security / earnings_date / pub_type)', async () => {
      // 静默丢一行 = 那只票的这次财报从此不在库里, 而跨财报判定会照常渲染成「不跨」——
      // FR-026 明禁的「编造一个未知事实」, 且全程日志绿。
      for (const bad of [
        earningsRow('PEP', '2026-08-06'), // 缺市场前缀
        earningsRow('US.PEP', 'not-a-date'),
        earningsRow('US.PEP', '2026-08-06', { pub_type: null }),
      ]) {
        const { http } = makeShim([bad]);
        await expect(makeAdapter(http).getWindow(WINDOW)).rejects.toThrow(/不合契约/);
      }
    });
  });

  describe('窗越界前置拒绝 (零外呼)', () => {
    it(`端点差 > ${EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS} 天 → Rejected 且一次请求都不发`, async () => {
      const { http, request } = makeShim([]);
      // 判据本地已知 ⇒ 打出去只是白烧一次限频配额换同一个 400。
      await expect(
        makeAdapter(http).getWindow({
          ...WINDOW,
          end: addUtcDays(WINDOW_START, EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS + 1),
        }),
      ).rejects.toBeInstanceOf(EarningsCalendarRejectedError);
      expect(request).not.toHaveBeenCalled();
    });

    it(`端点差恰好 ${EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS} 天 → 放行 (顶到上限的合法窗)`, async () => {
      const { http, request } = makeShim([]);
      // 本侧严一天 = 白多付调用数; 本侧宽一天 = 切出的窗**真端直接 502** (2026-08-07 实测,
      // 且 502 会伪装成瞬时错误一路重试), 那一整窗全市场的财报当日无人再问。
      await makeAdapter(http).getWindow(WINDOW);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('窗止早于窗起 / 日期非 YYYY-MM-DD → Rejected 且零外呼', async () => {
      for (const window of [
        { market: 'us', start: WINDOW.end, end: WINDOW.start },
        { market: 'us', start: '08/04/2026', end: WINDOW.end },
      ]) {
        const { http, request } = makeShim([]);
        await expect(makeAdapter(http).getWindow(window)).rejects.toBeInstanceOf(
          EarningsCalendarRejectedError,
        );
        expect(request).not.toHaveBeenCalled();
      }
    });

    it('非 us market → 直接抛且零外呼 (静默返空会被记成「那个市场今天没有财报」)', async () => {
      const { http, request } = makeShim([]);
      await expect(makeAdapter(http).getWindow({ ...WINDOW, market: 'hk' })).rejects.toThrow(
        /仅承担 us/,
      );
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('vendor 错误映射 (与链 / 快照 adapter 同一对)', () => {
    it('429 → BudgetExhausted (顺延重入队, 不耗 attempts)', async () => {
      const { http } = makeThrowingShim(new TransientVendorError('futu-shim', 429));
      await expect(makeAdapter(http).getWindow(WINDOW)).rejects.toBeInstanceOf(
        EarningsCalendarBudgetExhaustedError,
      );
    });

    it('400 → Rejected (永久, 重试无意义)', async () => {
      const { http } = makeThrowingShim(new VendorHttpError('futu-shim', 400));
      await expect(makeAdapter(http).getWindow(WINDOW)).rejects.toBeInstanceOf(
        EarningsCalendarRejectedError,
      );
    });

    it('5xx / 401 原样上抛 —— 吞成上面任一类会把「vendor 坏了」说成「预算用完了」', async () => {
      for (const err of [
        new TransientVendorError('futu-shim', 503),
        new VendorHttpError('futu-shim', 401),
      ]) {
        const { http } = makeThrowingShim(err);
        const thrown = await makeAdapter(http)
          .getWindow(WINDOW)
          .catch((e: unknown) => e);
        expect(thrown).toBe(err);
      }
    });

    it('信封缺 rows[] / count 与实收不符 → throw, 不返回半份日历', async () => {
      const missingRows = {
        request: vi.fn(async () => ({ count: 0 })),
      } as unknown as VendorHttpClient;
      await expect(makeAdapter(missingRows).getWindow(WINDOW)).rejects.toThrow(/缺 rows/);

      // 半份日历在下游读作「那几天全市场没有财报」, 与真缺口无法区分。
      const { http } = makeShim([earningsRow('US.PEP', '2026-08-06')], 2);
      await expect(makeAdapter(http).getWindow(WINDOW)).rejects.toThrow(/疑截断/);
    });
  });
});
