import { describe, it, expect, vi } from 'vitest';
import { FutuOptionChainAdapter } from './futu-option-chain.adapter.js';
import { OptionChainBudgetExhaustedError, OptionChainRejectedError } from './option-chain.port.js';
import { TransientVendorError, VendorHttpError } from './vendor-http-client.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途期权链 adapter mock 单测 (047 T014)。
 *
 * 仿真行**逐字段照 shim 的实测形态** (`services/futu-shim/tests/test_app.py` 的
 * `_expiry` / `_chain_row`, 即 `dataframe_to_records` 直出的 SDK 列)。非标行按 p3b E7/E20
 * 实测: VICI 2026-09-18 到期日下 `VICI1` 32 张 (`lot_size=90`, `NON_STANDARD`),
 * 来历是 GDEN 被 VICI 并购后 OCC 调整的期权遗骸。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`,
 * `RUN_MARKETDATA_IT`) —— ⚠️ 那道门恒 skip, 本文件全绿**不**构成真契约的证据。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';

/** `/option-expirations` 一行 (SDK col_list: strike_time / option_expiry_date_distance / expiration_cycle)。 */
function expiryRow(day: string, distance: number, cycle = 'WEEK') {
  return { strike_time: day, option_expiry_date_distance: distance, expiration_cycle: cycle };
}

/** `/option-chain` 一行 (SDK col_list, 照 shim pytest 的 `_chain_row`)。 */
function chainRow(code: string, strike: number, extra: Record<string, unknown> = {}) {
  return {
    code,
    name: 'PEP 260918 130.00 PUT',
    lot_size: 100,
    stock_type: 'DRVT',
    option_type: 'PUT',
    stock_owner: 'US.PEP',
    strike_time: '2026-09-18',
    strike_price: strike,
    suspension: false,
    stock_id: 9001,
    index_option_type: 'N/A',
    expiration_cycle: 'MONTH',
    option_standard_type: 'STANDARD',
    option_settlement_mode: 'PM',
    ...extra,
  };
}

function makeShim(rows: unknown[], countOverride?: number) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    return { as_of: '2026-08-04T20:19:48+00:00', count: countOverride ?? rows.length, rows };
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

/** 每次调用直接抛 `err` 的假 transport (错误映射用)。 */
function makeThrowingShim(err: unknown) {
  const request = vi.fn(async () => {
    throw err;
  });
  return { http: { request } as unknown as VendorHttpClient, request };
}

const makeAdapter = (http: VendorHttpClient) => new FutuOptionChainAdapter(http, BASE, TOKEN);

const WINDOW = { symbol: 'us:PEP', start: '2026-09-18', end: '2026-10-16' } as const;

describe('FutuOptionChainAdapter', () => {
  describe('到期日阶梯 (getExpiryDates)', () => {
    it('GET <shim>/option-expirations?code=US.PEP + Bearer, 行按到期日升序', async () => {
      const { http, calls } = makeShim([
        expiryRow('2028-01-21', 900, 'MONTH'),
        expiryRow('2026-08-07', 3),
      ]);
      const out = await makeAdapter(http).getExpiryDates('us:PEP');

      expect(calls).toHaveLength(1);
      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/option-expirations');
      expect(url.searchParams.get('code')).toBe('US.PEP');
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
      // vendor 未承诺有序; 端口契约是升序 —— 假设有序而实际不是, 分窗会静默漏到期日。
      expect(out.map((e) => e.expiryDate)).toEqual(['2026-08-07', '2028-01-21']);
      expect(out[1]).toEqual({
        expiryDate: '2028-01-21',
        expirationCycle: 'MONTH',
        daysToExpiry: 900,
      });
    });

    it('🚫 远月 LEAPS 不被裁剪 —— 900 天外的到期日照常返回', async () => {
      const { http } = makeShim([
        expiryRow('2026-08-07', 3),
        expiryRow('2028-01-21', 900, 'MONTH'),
      ]);
      // 截掉远端不会报错, 只会让那一整批腿永远采不到 (漏采即永久缺口, FR-032)。
      expect(await makeAdapter(http).getExpiryDates('us:PEP')).toHaveLength(2);
    });

    it('该票无期权链 → 空数组 (合法状态, 非错误)', async () => {
      const { http } = makeShim([]);
      expect(await makeAdapter(http).getExpiryDates('us:PEP')).toEqual([]);
    });

    it('DTE 缺失落 null 不回落 0 (0 = 今天到期, 与「没有值」方向相反)', async () => {
      const { http } = makeShim([{ strike_time: '2026-08-07', expiration_cycle: null }]);
      const out = await makeAdapter(http).getExpiryDates('us:PEP');
      expect(out[0]).toEqual({
        expiryDate: '2026-08-07',
        expirationCycle: null,
        daysToExpiry: null,
      });
    });
  });

  describe('单窗链 (getChainWindow)', () => {
    it('🚨 option_type 传的是 ALL (含 CALL) —— 采集端不滤边 (Guardrail 3)', async () => {
      const { http, calls } = makeShim([chainRow('US.PEP260918P130000', 130)]);
      await makeAdapter(http).getChainWindow(WINDOW);

      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/option-chain');
      expect(url.searchParams.get('code')).toBe('US.PEP');
      expect(url.searchParams.get('start')).toBe('2026-09-18');
      expect(url.searchParams.get('end')).toBe('2026-10-16');
      // 「本片只含认沽」是呈现面的话; 在这里滤成 PUT 一分钱不省 (链一次返双边、调用数不变),
      // 却会给 CALL 侧留下不可回补的永久缺口。
      expect(url.searchParams.get('option_type')).toBe('ALL');
    });

    it('CALL 与 PUT 双边行均照常返回', async () => {
      const { http } = makeShim([
        chainRow('US.PEP260918P130000', 130),
        chainRow('US.PEP260918C130000', 130, { option_type: 'CALL' }),
      ]);
      const out = await makeAdapter(http).getChainWindow(WINDOW);
      expect(out.map((c) => c.optionType)).toEqual(['PUT', 'CALL']);
    });

    it('行 → OptionContractStatic 逐字段映射 (含 root / 标的 canonical / vendor 原样列)', async () => {
      const { http } = makeShim([chainRow('US.PEP260918P130000', 130.5)]);
      const [contract] = await makeAdapter(http).getChainWindow(WINDOW);

      expect(contract).toEqual({
        market: 'us',
        // 原样含市场前缀 —— 这串正是喂回 /option-snapshot 的键。
        code: 'US.PEP260918P130000',
        root: 'PEP',
        underlyingSymbol: 'us:PEP',
        expiryDate: '2026-09-18',
        strikePrice: '130.5',
        optionType: 'PUT',
        expirationCycle: 'MONTH',
        settlementMode: 'PM',
        isStandard: true,
      });
    });

    it('🚨 非标 root 照常返回 —— VICI1 不被过滤, 只是 isStandard=false (Guardrail 4)', async () => {
      // p3b E7/E20: VICI 2026-09-18 下 `VICI` 44 张 + `VICI1` 32 张 (GDEN 并购遗骸)。
      // 在采集端滤掉 = 证据没了且不可回补; 排除只发生在下游选约层。
      const { http } = makeShim([
        chainRow('US.VICI260918P30000', 30, { stock_owner: 'US.VICI', option_type: 'PUT' }),
        chainRow('US.VICI1260918P30000', 30, {
          stock_owner: 'US.VICI',
          option_standard_type: 'NON_STANDARD',
          lot_size: 90,
        }),
      ]);
      const out = await makeAdapter(http).getChainWindow({ ...WINDOW, symbol: 'us:VICI' });

      expect(out).toHaveLength(2);
      expect(out.map((c) => c.root)).toEqual(['VICI', 'VICI1']);
      expect(out.map((c) => c.isStandard)).toEqual([true, false]);
      // 非标行的标的仍是 VICI —— root 与 underlying 是两件事。
      expect(out.every((c) => c.underlyingSymbol === 'us:VICI')).toBe(true);
    });

    it('root 带尾数字即判非标, 即便 vendor 说 STANDARD (US root 不以数字结尾)', async () => {
      const { http } = makeShim([
        chainRow('US.VICI1260918P30000', 30, {
          stock_owner: 'US.VICI',
          option_standard_type: 'STANDARD',
        }),
      ]);
      const [contract] = await makeAdapter(http).getChainWindow({ ...WINDOW, symbol: 'us:VICI' });
      expect(contract.isStandard).toBe(false);
    });

    it('option_standard_type 缺失 → 退回 root 尾数字判据, 不默认成 true', async () => {
      const { http } = makeShim([
        chainRow('US.PEP260918P130000', 130, { option_standard_type: null }),
      ]);
      const [contract] = await makeAdapter(http).getChainWindow(WINDOW);
      expect(contract.isStandard).toBe(true);
    });

    it('到期周期 / 结算方式缺失 → null (禁默认值冒充)', async () => {
      const { http } = makeShim([
        chainRow('US.PEP260918P130000', 130, {
          expiration_cycle: null,
          option_settlement_mode: null,
        }),
      ]);
      const [contract] = await makeAdapter(http).getChainWindow(WINDOW);
      expect(contract.expirationCycle).toBeNull();
      expect(contract.settlementMode).toBeNull();
    });

    it('窗内无合约 → 空数组 (非错误)', async () => {
      const { http } = makeShim([]);
      expect(await makeAdapter(http).getChainWindow(WINDOW)).toEqual([]);
    });
  });

  describe('失败语义 (T014 的承重设计)', () => {
    it('🚨 429 → OptionChainBudgetExhaustedError (顺延信号, 不是 failure)', async () => {
      // VendorHttpClient 退避重试耗尽后仍以 TransientVendorError(429) 上抛。
      const { http } = makeThrowingShim(new TransientVendorError('futu-shim', 429));
      await expect(makeAdapter(http).getChainWindow(WINDOW)).rejects.toBeInstanceOf(
        OptionChainBudgetExhaustedError,
      );
      const { http: http2 } = makeThrowingShim(new TransientVendorError('futu-shim', 429));
      await expect(makeAdapter(http2).getExpiryDates('us:PEP')).rejects.toBeInstanceOf(
        OptionChainBudgetExhaustedError,
      );
    });

    it('🚨 400 (窗越界) → OptionChainRejectedError, 不可重试', async () => {
      const { http } = makeThrowingShim(new VendorHttpError('futu-shim', 400));
      const err = await makeAdapter(http)
        .getChainWindow(WINDOW)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(OptionChainRejectedError);
      // 上下文必须点名窗 —— 「哪一只的哪一窗被拒」是排查的全部信息。
      expect(String(err)).toContain('2026-09-18');
      expect(String(err)).toContain('2026-10-16');
    });

    it('5xx / 网络错原样上抛, MUST NOT 吞成预算耗尽或永久拒绝', async () => {
      // 吞了会把「vendor 坏了」说成「预算用完了」→ 真故障静默顺延。
      for (const raw of [
        new TransientVendorError('futu-shim', 503),
        new TransientVendorError('futu-shim', 'network'),
      ]) {
        const { http } = makeThrowingShim(raw);
        const err = await makeAdapter(http)
          .getChainWindow(WINDOW)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err).toBe(raw);
      }
      const { http } = makeThrowingShim(new VendorHttpError('futu-shim', 401));
      await expect(makeAdapter(http).getChainWindow(WINDOW)).rejects.toBeInstanceOf(
        VendorHttpError,
      );
    });
  });

  describe('契约防御', () => {
    it('非 us symbol → throw 且零外呼 (静默返空会被记成「该票今天没有链」)', async () => {
      const { http, request } = makeThrowingShim(new Error('不该被调用'));
      await expect(makeAdapter(http).getExpiryDates('cn:600519')).rejects.toThrow(/仅承担 us/);
      await expect(
        makeAdapter(http).getChainWindow({ ...WINDOW, symbol: 'hk:00700' }),
      ).rejects.toThrow(/仅承担 us/);
      expect(request).not.toHaveBeenCalled();
    });

    it('信封 count 与实收行数不符 → throw (传输层截断闸)', async () => {
      const { http } = makeShim([chainRow('US.PEP260918P130000', 130)], 7);
      await expect(makeAdapter(http).getChainWindow(WINDOW)).rejects.toThrow(/疑截断/);
    });

    it('缺 rows[] → throw (契约变更)', async () => {
      const request = vi.fn(async () => ({ as_of: 'x', count: 0 }));
      const http = { request } as unknown as VendorHttpClient;
      await expect(makeAdapter(http).getChainWindow(WINDOW)).rejects.toThrow(/rows/);
    });

    it('坏行 throw 而不跳过 —— 静默丢一行 = 那一批腿永久缺口', async () => {
      const { http } = makeShim([chainRow('US.PEP260918P130000', 130, { strike_time: '' })]);
      await expect(makeAdapter(http).getChainWindow(WINDOW)).rejects.toThrow(/不合契约/);

      const { http: noStrike } = makeShim([
        chainRow('US.PEP260918P130000', 130, { strike_price: null }),
      ]);
      await expect(makeAdapter(noStrike).getChainWindow(WINDOW)).rejects.toThrow(/不合契约/);

      const { http: badType } = makeShim([
        chainRow('US.PEP260918P130000', 130, { option_type: 'STRADDLE' }),
      ]);
      await expect(makeAdapter(badType).getChainWindow(WINDOW)).rejects.toThrow(/不合契约/);

      const { http: badCode } = makeShim([chainRow('US.WAT-EVER', 130)]);
      await expect(makeAdapter(badCode).getChainWindow(WINDOW)).rejects.toThrow(/不合契约/);
    });
  });
});
