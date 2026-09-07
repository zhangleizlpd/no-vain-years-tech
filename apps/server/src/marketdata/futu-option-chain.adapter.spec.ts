import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
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

    it('🚨 066 T11 链请求参数**恰为** code/start/end/option_type —— 不传 option_cond_type / data_filter (FR-015)', async () => {
      // 采集端一旦筛就**丢证据且不可回补**: vendor 不提供历史交易日的链快照, 出处见
      // `option-chain.port.ts`, 今天没取到的
      // 那些腿明天补不回来。筛是**读取面**的事 (shim 支持这两个参数, 采集面刻意不用)。
      const { http, calls } = makeShim([chainRow('US.PEP260918P130000', 130)]);
      await makeAdapter(http).getChainWindow({
        symbol: 'us:PEP',
        start: '2026-09-01',
        end: '2026-09-30',
      });

      const keys = [...new URL(calls[0].url).searchParams.keys()].sort();
      expect(keys).toEqual(['code', 'end', 'option_type', 'start']);
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
        contractSize: 100,
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

    // #179: vendor 在美股方向按词根解析标的、忽略市场前缀。2026-08-25 打真 shim 实测
    // US.ALB 136 行里 56 行 stock_owner=HK.09988 (阿里港股, 助记符恰好也是 ALB);
    // 反方向 HK.09988 干净, 对照 US.PDD 干净 ⇒ 是 vendor 行为, 不是我们参数错。
    const ALB = { symbol: 'us:ALB', start: '2026-08-28', end: '2026-08-28' } as const;

    it('🚨 跨市场行被丢弃 —— 请求 us:ALB 收到 HK.09988 的合约 (#179)', async () => {
      const { http } = makeShim([
        chainRow('US.ALB260828P75000', 75, { stock_owner: 'US.ALB' }),
        chainRow('HK.ALB260828C75000', 75, { stock_owner: 'HK.09988', option_type: 'CALL' }),
        chainRow('US.ALB260828C80000', 80, { stock_owner: 'US.ALB', option_type: 'CALL' }),
      ]);

      const out = await makeAdapter(http).getChainWindow(ALB);

      expect(out.map((c) => c.code)).toEqual(['US.ALB260828P75000', 'US.ALB260828C80000']);
      expect(out.every((c) => c.underlyingSymbol === 'us:ALB')).toBe(true);
    });

    it('🚫 同市场 owner 不符**不**在本层吞 —— 那是「归属真的变了」, 归 usecase 的护城河 throw', async () => {
      const { http } = makeShim([chainRow('US.ALB260828P75000', 75, { stock_owner: 'US.OTHER' })]);

      const out = await makeAdapter(http).getChainWindow(ALB);

      expect(out).toHaveLength(1);
      expect(out[0]?.underlyingSymbol).toBe('us:OTHER');
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
    it('未登记市场 → throw 且零外呼 (静默返空会被记成「该票今天没有链」)', async () => {
      const { http, request } = makeThrowingShim(new Error('不该被调用'));
      await expect(makeAdapter(http).getExpiryDates('cn:600519')).rejects.toThrow(
        /仅承担 us \/ hk/,
      );
      await expect(
        makeAdapter(http).getChainWindow({ ...WINDOW, symbol: 'cn:600519' }),
      ).rejects.toThrow(/仅承担 us \/ hk/);
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

// ---------------------------------------------------------------------------
// 066 T01 — 港股 (hk) 接入 + `'N/A'` 规范化 (FR-001 / FR-004 / FR-005, plan §A8 / §A11)
// ---------------------------------------------------------------------------
/**
 * 真实响应回放: 直连港股侧行情网关实取 (2026-08-23, `HK.00700` 2026-08-22..09-20 单窗),
 * `__fixtures__/` 里放的是**原始信封** (as_of / count / rows 逐字未加工)。
 *
 * 🚨 **两层分开断**: 先量**原始行形态** (vendor 到底给了什么), 再断**解析结果**。少了前一层,
 * 「settlementMode 落 null」这条可以在 vendor 根本没返 `'N/A'` 的情况下照样绿 —— 那时它守的
 * 是一条不存在的路径。
 */
interface ChainFixture {
  requested: { code: string; start: string; end: string; option_type: string };
  response: { as_of: string; count: number; rows: Record<string, unknown>[] };
}

const HK_CHAIN = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'hk-option-chain-00700-2026-08-23.json'), 'utf8'),
) as ChainFixture;
const HK_ROWS = HK_CHAIN.response.rows;
const HK_WINDOW = { symbol: 'hk:00700', start: '2026-08-22', end: '2026-09-20' } as const;

/** 去重后的取值集合 (断「132/132 全是同一个值」用)。 */
const uniq = (values: unknown[]) => [...new Set(values)];

/** 把整份实取响应喂进 adapter, 返回解析结果 + 出站调用记录。 */
async function replayHkChain(rows: unknown[] = HK_ROWS) {
  const { http, calls } = makeShim(rows);
  const out = await makeAdapter(http).getChainWindow(HK_WINDOW);
  return { out, calls };
}

describe('066 T01 FutuOptionChainAdapter — 港股 (hk) 接入', () => {
  describe('原始行形态 (先量 vendor 给了什么)', () => {
    it('实取 132 行 / 单到期日 2026-08-28 / 66 档行权价 220–790 / CALL 66 + PUT 66', () => {
      expect(HK_CHAIN.requested).toMatchObject({ code: 'HK.00700', option_type: 'ALL' });
      expect(HK_CHAIN.response.count).toBe(132);
      expect(HK_ROWS).toHaveLength(132);
      expect(uniq(HK_ROWS.map((r) => r.strike_time))).toEqual(['2026-08-28']);

      const strikes = uniq(HK_ROWS.map((r) => r.strike_price)) as number[];
      expect(strikes).toHaveLength(66);
      expect([Math.min(...strikes), Math.max(...strikes)]).toEqual([220, 790]);
      expect(HK_ROWS.filter((r) => r.option_type === 'CALL')).toHaveLength(66);
      expect(HK_ROWS.filter((r) => r.option_type === 'PUT')).toHaveLength(66);
      // 字段集 14 列 —— 与美股逐字相同, 这条一旦红就是 vendor 改了口径。
      expect(Object.keys(HK_ROWS[0]).sort()).toEqual([
        'code',
        'expiration_cycle',
        'index_option_type',
        'lot_size',
        'name',
        'option_settlement_mode',
        'option_standard_type',
        'option_type',
        'stock_id',
        'stock_owner',
        'stock_type',
        'strike_price',
        'strike_time',
        'suspension',
      ]);
    });

    it('🚨 option_settlement_mode 132/132 是字面量 N/A (美股返 AM/PM, 永远撞不到)', () => {
      expect(uniq(HK_ROWS.map((r) => r.option_settlement_mode))).toEqual(['N/A']);
      // 同形态第二处: 本 adapter 未映射该列, 但它证明 'N/A' 是 vendor 的空值哨兵而非孤例。
      expect(uniq(HK_ROWS.map((r) => r.index_option_type))).toEqual(['N/A']);
    });

    it('🚨 合约标识里根本没有标的代码 —— 词根是交易所助记符 TCH (plan §A11)', () => {
      // 从 `HK.TCH260828C220000` 反推不出 `00700`, 所以关联只能走 stock_owner。
      expect(HK_ROWS.every((r) => !String(r.code).includes('00700'))).toBe(true);
      expect(uniq(HK_ROWS.map((r) => r.stock_owner))).toEqual(['HK.00700']);
    });
  });

  describe('解析结果', () => {
    it('hk symbol → 前缀 HK. (option_type 仍恒 ALL)', async () => {
      const { calls } = await replayHkChain();
      const url = new URL(calls[0].url);
      expect(url.searchParams.get('code')).toBe('HK.00700');
      expect(url.searchParams.get('option_type')).toBe('ALL');
    });

    it('132 行全部解析出 hk 市场 / hk:00700 标的 / TCH 词根 / 66 档行权价', async () => {
      const { out } = await replayHkChain();

      expect(out).toHaveLength(132);
      expect(uniq(out.map((c) => c.market))).toEqual(['hk']);
      // 🚨 标的取自 stock_owner, **不是**从词根反推 —— 词根是 TCH, 标的是 00700。
      expect(uniq(out.map((c) => c.underlyingSymbol))).toEqual(['hk:00700']);
      expect(uniq(out.map((c) => c.root))).toEqual(['TCH']);
      expect(uniq(out.map((c) => c.expiryDate))).toEqual(['2026-08-28']);
      expect(uniq(out.map((c) => c.strikePrice))).toHaveLength(66);
      expect(out.filter((c) => c.optionType === 'CALL')).toHaveLength(66);
      expect(out.filter((c) => c.optionType === 'PUT')).toHaveLength(66);
      // 非标判据在港股上不误伤: 助记符不以数字结尾 + vendor 说 STANDARD。
      expect(uniq(out.map((c) => c.isStandard))).toEqual([true]);
    });

    it('🚨 核心回归钉: settlementMode 132/132 落 null, 不是字符串 "N/A"', async () => {
      const { out } = await replayHkChain();
      // 原样透传 = 把「没有结算方式」写成一个看起来有效的结算方式存进库, 且没有任何既有断言会红。
      expect(uniq(out.map((c) => c.settlementMode))).toEqual([null]);
      expect(out.some((c) => c.settlementMode === 'N/A')).toBe(false);
    });

    it('首行逐字段映射 (code 原样含前缀 —— 这串正是喂回 /option-snapshot 的键)', async () => {
      const { out } = await replayHkChain();
      expect(out[0]).toEqual({
        market: 'hk',
        code: 'HK.TCH260828C220000',
        root: 'TCH',
        underlyingSymbol: 'hk:00700',
        expiryDate: '2026-08-28',
        strikePrice: '220',
        optionType: 'CALL',
        expirationCycle: 'MONTH',
        settlementMode: null,
        isStandard: true,
        contractSize: 100,
      });
    });

    it('stock_owner 缺失 / 为 N/A → throw (MUST NOT 拿词根反推标的)', async () => {
      const noOwner = { ...HK_ROWS[0] };
      delete noOwner.stock_owner;
      await expect(replayHkChain([noOwner])).rejects.toThrow(/不合契约/);
      await expect(replayHkChain([{ ...HK_ROWS[0], stock_owner: 'N/A' }])).rejects.toThrow(
        /不合契约/,
      );
    });
  });

  describe("'N/A' 规范化对其余字符串列同样生效", () => {
    it('expiration_cycle=N/A → null (禁把哨兵当成一个到期周期)', async () => {
      const { out } = await replayHkChain([{ ...HK_ROWS[0], expiration_cycle: 'N/A' }]);
      expect(out[0].expirationCycle).toBeNull();
    });

    it('option_standard_type=N/A → 退回 root 判据, 不被当成「非 STANDARD」', async () => {
      // 修前: 'N/A'.toUpperCase() !== 'STANDARD' ⇒ 整只票被静默标成非标, 下游选约层全量排除。
      const { out } = await replayHkChain([{ ...HK_ROWS[0], option_standard_type: 'N/A' }]);
      expect(out[0].isStandard).toBe(true);
    });

    it('到期日阶梯的 expiration_cycle=N/A 同样落 null (同一个 strOrNull)', async () => {
      const { http } = makeShim([
        { strike_time: '2026-08-28', option_expiry_date_distance: 5, expiration_cycle: 'N/A' },
      ]);
      const [expiry] = await makeAdapter(http).getExpiryDates('hk:00700');
      expect(expiry).toEqual({
        expiryDate: '2026-08-28',
        expirationCycle: null,
        daysToExpiry: 5,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 076 T002 — 合约每张股数 (contractSize; FR-001 / FR-002 / FR-004 / FR-005)
// ---------------------------------------------------------------------------
/**
 * 病根: 读端此前把「一张合约 = 100 股」当**市场常量**, 而每张合约的正股股数是**合约属性** ——
 * 港股逐标的不同 (取证 §1 实测 100 / 150 / 200 / 400 / 500 / 1000 / 2000)。取值单点就是本
 * adapter 的一行映射, 所以判据也全落在这里。
 *
 * 两份真夹具各钉一半, 缺一不可:
 * - `hk-option-chain-00700` (132 行): `lot_size` 全 100 —— 港股也有 100 的, 「港股 ≠ 100」
 *   这句话本身不能当判据。
 * - `hk-option-chain-09988` (354 行): 282 行 500 + **混进 72 行 `US.ALB`** (词根撞名的美国
 *   Albemarle 期权, 其 `lot_size` 是 100) —— 一份夹具同时钉「标准合约落供应方值」与
 *   「跨市场混入行不进返回集」。混入行若漏进来, 这只港股票会有 72 行被写成 100。
 */
const HK_9988_CHAIN = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'hk-option-chain-09988-2026-09-07.json'), 'utf8'),
) as ChainFixture;
const HK_9988_ROWS = HK_9988_CHAIN.response.rows;
const HK_9988_WINDOW = { symbol: 'hk:09988', start: '2026-09-07', end: '2026-10-06' } as const;

describe('076 T002 FutuOptionChainAdapter — 合约每张股数 (contractSize)', () => {
  describe('真夹具回放', () => {
    it('① 00700 实取 132 行 ⇒ contractSize 全 100 (原始行 lot_size 也全 100)', async () => {
      // 两层分开断: 先量 vendor 给了什么, 再断解析结果 —— 少了前一层, 「全 100」可以在
      // adapter 根本没读这一列的情况下照样绿 (它守的会是一条不存在的路径)。
      expect(uniq(HK_ROWS.map((r) => r.lot_size))).toEqual([100]);

      const { out } = await replayHkChain();

      expect(out).toHaveLength(132);
      expect(uniq(out.map((c) => c.contractSize))).toEqual([100]);
    });

    it('② 09988 实取 354 行 ⇒ 返回 282 行全 500, 且一行 US. 前缀都不剩 (FR-004)', async () => {
      expect(HK_9988_CHAIN.requested).toMatchObject({ code: 'HK.09988', option_type: 'ALL' });
      expect(HK_9988_CHAIN.response.count).toBe(354);
      expect(HK_9988_ROWS).toHaveLength(354);
      // vendor 按词根串市场: 72 行是美国 Albemarle 的期权, 它们的 lot_size 是 100。
      expect(HK_9988_ROWS.filter((r) => !String(r.code).startsWith('HK.'))).toHaveLength(72);
      expect([...new Set(HK_9988_ROWS.map((r) => r.lot_size))].sort()).toEqual([100, 500]);

      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { http } = makeShim(HK_9988_ROWS);
      const out = await makeAdapter(http).getChainWindow(HK_9988_WINDOW);
      warn.mockRestore();

      // 🚨 混入行由既有的 `dropForeignMarketRows` 在到达写路径之前剔除, FR-004 是**结构保证**;
      // 本臂只钉「混入行不出现在返回集」, 🚫 不在取值处造第二道过滤 (同一个问题写两遍必漂移)。
      expect(out).toHaveLength(282);
      expect(out.some((c) => c.code.startsWith('US.'))).toBe(false);
      expect(uniq(out.map((c) => c.underlyingSymbol))).toEqual(['hk:09988']);
      // 500 而不是 100 —— 屏上这只票每一行的单笔权利金此前都少算 5 倍, 且每行错得一样齐。
      expect(uniq(out.map((c) => c.contractSize))).toEqual([500]);
      expect(uniq(out.map((c) => c.isStandard))).toEqual([true]);
    });
  });

  describe('构造行 (真夹具里造不出的形态)', () => {
    it('③ 非标 ∧ vendor 照报 lot_size 100 ⇒ null (FR-002: 非标一律不信供应方)', async () => {
      // EVIDENCE: `specs/076-option-contract-size/spec.md`「取证」§2 PoC-A —— 非标 APTV1 的
      // `lot_size` / `option_contract_multiplier` 都是 100, 与 OCC 调整后交割物不符。落一个
      // 100 就是把「表达不了」写成一个看起来正常的错数, 而它会被读端直接乘进单笔权利金。
      const { http } = makeShim([
        chainRow('US.VICI1260918P30000', 30, {
          stock_owner: 'US.VICI',
          option_standard_type: 'NON_STANDARD',
          lot_size: 100,
        }),
      ]);
      const [contract] = await makeAdapter(http).getChainWindow({ ...WINDOW, symbol: 'us:VICI' });

      expect(contract.isStandard).toBe(false);
      expect(contract.contractSize).toBeNull();
    });

    it.each([
      ['字段缺失', undefined],
      ["字符串哨兵 'N/A'", 'N/A'],
      ['非整数 5.5', 5.5],
    ])(
      '④ 标准 ∧ lot_size %s ⇒ null + WARN 一条, 整行照常返回 (FR-005)',
      async (_label, lotSize) => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const row: Record<string, unknown> = { ...chainRow('US.PEP260918P130000', 130) };
        if (lotSize === undefined) delete row.lot_size;
        else row.lot_size = lotSize;

        const { http } = makeShim([row]);
        const out = await makeAdapter(http).getChainWindow(WINDOW);

        // 🚨 采集 MUST NOT 因一列缺值丢整行 —— 丢了这条腿的快照就永久缺席。
        expect(out).toHaveLength(1);
        expect(out[0].code).toBe('US.PEP260918P130000');
        expect(out[0].contractSize).toBeNull();
        // 留痕是 adapter logger 一条 warn (此层无采集轮上下文, 不进 findings)。
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('US.PEP260918P130000');
        warn.mockRestore();
      },
    );

    it('⑤ 美股标准行 lot_size 100 ⇒ 100, 且不抬 WARN (报警器不刷屏)', async () => {
      // 美股的 100 自此**来自供应方**而不是代码常量 (FR-010 的逐值零变化是数据保证)。
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { http } = makeShim([chainRow('US.PEP260918P130000', 130)]);

      const [contract] = await makeAdapter(http).getChainWindow(WINDOW);

      expect(contract.contractSize).toBe(100);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
