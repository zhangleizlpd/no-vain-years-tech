import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { FutuOptionSnapshotAdapter } from './futu-option-snapshot.adapter.js';
import {
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  OptionSnapshotBudgetExhaustedError,
  OptionSnapshotRejectedError,
} from './option-snapshot.port.js';
import { TransientVendorError, VendorHttpError } from './vendor-http-client.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 富途期权快照 adapter mock 单测 (047 T016)。
 *
 * 仿真行**逐字段照 shim 的实测形态** (`services/futu-shim/tests/test_app.py` 的
 * `_option_snapshot_row`, 即 `dataframe_to_records` + `mark_greeks_completeness` 直出的列)。
 *
 * 真端点契约由 env-gated 真 vendor IT 校真 (`marketdata.futu-shim.vendor`,
 * `RUN_MARKETDATA_IT`) —— ⚠️ 那道门恒 skip, 本文件全绿**不**构成真契约的证据。
 */
const BASE = 'http://10.89.0.1:8811';
const TOKEN = 'test-shim-token';
const LEG = 'US.PEP260807P145000';

/** `/option-snapshot` 的一条期权行 (照 shim pytest 的 `_option_snapshot_row`)。 */
function snapshotRow(code: string, extra: Record<string, unknown> = {}) {
  return {
    code,
    update_time: '2026-08-04 16:00:00',
    last_price: 2.35,
    prev_close_price: 2.28,
    volume: 1204,
    turnover: 283940.0,
    bid_price: 2.3,
    ask_price: 2.4,
    bid_vol: 45,
    ask_vol: 60,
    suspension: false,
    option_valid: true,
    option_type: 'PUT',
    strike_time: '2026-08-07',
    option_strike_price: 145.0,
    option_contract_size: 100,
    option_open_interest: 3120,
    option_net_open_interest: -410,
    option_premium: 1.62,
    option_implied_volatility: 21.4,
    option_delta: -0.31,
    option_gamma: 0.041,
    option_vega: 0.092,
    option_theta: -0.058,
    option_rho: 0.011,
    stock_owner: 'US.PEP',
    greeks_complete: true,
    ...extra,
  };
}

/** 标的自身那行 (spot 的来源, 与期权行同批返回)。 */
const UNDERLYING_ROW = {
  code: 'US.PEP',
  update_time: '2026-08-04 16:00:00',
  last_price: 148.21,
  option_valid: false,
  greeks_complete: null,
};

function makeShim(rows: unknown[], envelope: Record<string, unknown> = {}) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push({ url: req.url, auth: req.headers?.Authorization });
    return { as_of: '2026-08-04T20:19:48+00:00', count: rows.length, rows, ...envelope };
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

const makeAdapter = (http: VendorHttpClient) => new FutuOptionSnapshotAdapter(http, BASE, TOKEN);

const QUERY = { underlyingSymbol: 'us:PEP', contractCodes: [LEG] };

describe('FutuOptionSnapshotAdapter', () => {
  describe('请求形态', () => {
    it('GET <shim>/option-snapshot?codes=… + Bearer, **标的自身在同一批首位**', async () => {
      const { http, calls } = makeShim([UNDERLYING_ROW, snapshotRow(LEG)]);
      await makeAdapter(http).getSnapshots(QUERY);

      expect(calls).toHaveLength(1); // spot 不另发一次调用
      const url = new URL(calls[0].url);
      expect(url.pathname).toBe('/option-snapshot');
      expect(url.searchParams.get('codes')).toBe(`US.PEP,${LEG}`);
      expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
    });

    it('未登记市场 → 直接抛且**零外呼** (静默返空会被记成「今天没有快照」)', async () => {
      const { http, request } = makeShim([]);
      await expect(
        makeAdapter(http).getSnapshots({ underlyingSymbol: 'cn:600519', contractCodes: [LEG] }),
      ).rejects.toThrow(/仅承担 us \/ hk/);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('🚨 批量上限前置拒绝 (shim > 400 codes 直接 400)', () => {
    it('超上限 → OptionSnapshotRejectedError 且零外呼 (不烧限频配额去换一个 400)', async () => {
      const { http, request } = makeShim([]);
      const contractCodes = Array.from(
        { length: OPTION_SNAPSHOT_MAX_CONTRACT_CODES + 1 },
        (_, i) => `US.PEP260807P${i}`,
      );

      await expect(
        makeAdapter(http).getSnapshots({ underlyingSymbol: 'us:PEP', contractCodes }),
      ).rejects.toBeInstanceOf(OptionSnapshotRejectedError);
      expect(request).not.toHaveBeenCalled();
    });

    it('恰好等于上限 → 照常发 (边界闭, 少发一个就是白丢一条腿)', async () => {
      const { http, request } = makeShim([UNDERLYING_ROW]);
      const contractCodes = Array.from(
        { length: OPTION_SNAPSHOT_MAX_CONTRACT_CODES },
        (_, i) => `US.PEP260807P${i}`,
      );

      await makeAdapter(http).getSnapshots({ underlyingSymbol: 'us:PEP', contractCodes });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('空批 → 永久拒绝 (工作集为空时本就不该调用)', async () => {
      const { http, request } = makeShim([]);
      await expect(
        makeAdapter(http).getSnapshots({ underlyingSymbol: 'us:PEP', contractCodes: [] }),
      ).rejects.toBeInstanceOf(OptionSnapshotRejectedError);
      expect(request).not.toHaveBeenCalled();
    });
  });

  describe('字段映射', () => {
    it('报价 / greeks / OI / Vol / 成交额逐列映射, 金融数值恒 string (Decimal-safe)', async () => {
      const { http } = makeShim([snapshotRow(LEG)]);
      const [row] = (await makeAdapter(http).getSnapshots(QUERY)).rows;

      expect(row).toMatchObject({
        code: LEG,
        isOption: true,
        underlyingCode: 'US.PEP',
        bid: '2.3',
        ask: '2.4',
        bidSize: '45',
        askSize: '60',
        last: '2.35',
        prevClose: '2.28',
        iv: '21.4',
        delta: '-0.31',
        gamma: '0.041',
        vega: '0.092',
        theta: '-0.058',
        rho: '0.011',
        openInterest: '3120',
        netOpenInterest: '-410',
        volume: '1204',
        turnover: '283940',
        greeksComplete: true,
      });
    });

    it('标的自身那行 → isOption=false + greeksComplete=null (不适用, 不是「缺失」)', async () => {
      const { http } = makeShim([UNDERLYING_ROW]);
      const [row] = (await makeAdapter(http).getSnapshots(QUERY)).rows;
      expect(row).toMatchObject({ code: 'US.PEP', isOption: false, last: '148.21' });
      expect(row.greeksComplete).toBeNull();
      expect(row.underlyingCode).toBeNull();
    });

    it('🚨 greeks 整块缺失的行照常返回 (一行不丢), 缺失落 null 不落 0', async () => {
      // 实值腿 bid 跌破内在价值 ⇒ IV 无解 ⇒ 六个字段一起没有 (实测 227/2150 行)。
      const { http } = makeShim([
        snapshotRow('US.PEP260807P190000', {
          greeks_complete: false,
          option_implied_volatility: null,
          option_delta: null,
          option_gamma: null,
          option_vega: null,
          option_theta: null,
          option_rho: null,
          bid_price: 41.3,
          ask_price: 43.1,
        }),
      ]);
      const [row] = (await makeAdapter(http).getSnapshots(QUERY)).rows;

      expect(row.greeksComplete).toBe(false);
      expect(row.delta).toBeNull();
      expect(row.iv).toBeNull();
      // 缺的只是 greeks, 不是整行 —— 报价侧照常可用。
      expect([row.bid, row.ask]).toEqual(['41.3', '43.1']);
    });

    it('shim 未下发 greeks_complete (旧版本未部署) → 按六个字段现算, 不默认 false', async () => {
      // Guardrail 15: /healthz 绿 ≠ 新端点在。整批标成 false 会让 greeks 缺失告警全面误报。
      const { http } = makeShim([snapshotRow(LEG, { greeks_complete: undefined })]);
      const [row] = (await makeAdapter(http).getSnapshots(QUERY)).rows;
      expect(row.greeksComplete).toBe(true);
    });

    it('code 缺失 → throw (静默丢行 = 那条腿当日快照永久缺席且缺口自我掩盖)', async () => {
      const { http } = makeShim([snapshotRow(LEG, { code: null })]);
      await expect(makeAdapter(http).getSnapshots(QUERY)).rejects.toThrow(/缺 code/);
    });
  });

  describe('🚨 vendor 时间戳按**美东**解释 (p3b E21/E32)', () => {
    it('夏令时 16:00 ET → 20:00Z', async () => {
      const { http } = makeShim([snapshotRow(LEG)]);
      const [row] = (await makeAdapter(http).getSnapshots(QUERY)).rows;
      // 当 UTC 读会把这一列整体推后 4 小时, 且**不会红** —— 故这条断言是唯一的守卫。
      expect(row.vendorUpdateTime).toEqual(new Date('2026-08-04T20:00:00Z'));
    });

    it('冬令时 16:00 ET → 21:00Z (DST 交给 Intl, 不手工分夏冬)', async () => {
      const { http } = makeShim([snapshotRow(LEG, { update_time: '2026-01-05 16:00:00' })]);
      const [row] = (await makeAdapter(http).getSnapshots(QUERY)).rows;
      expect(row.vendorUpdateTime).toEqual(new Date('2026-01-05T21:00:00Z'));
    });

    it('时间戳缺失 / 不合形态 → null (该列不参与任何判据, 不阻断落库)', async () => {
      const { http } = makeShim([snapshotRow(LEG, { update_time: 'N/A' })]);
      const [row] = (await makeAdapter(http).getSnapshots(QUERY)).rows;
      expect(row.vendorUpdateTime).toBeNull();
    });
  });

  describe('信封校验', () => {
    it('envelope 的 as_of = 本批采集时刻 (落 quote_as_of), 与行内 update_time 是两回事', async () => {
      const { http } = makeShim([snapshotRow(LEG)]);
      const batch = await makeAdapter(http).getSnapshots(QUERY);
      expect(batch.asOf).toEqual(new Date('2026-08-04T20:19:48+00:00'));
      expect(batch.rows[0].vendorUpdateTime).not.toEqual(batch.asOf);
    });

    it('as_of 不可解析 → throw (拿本机时钟顶替 = 把采集时刻换成代码跑到那一句的时刻)', async () => {
      const { http } = makeShim([snapshotRow(LEG)], { as_of: undefined });
      await expect(makeAdapter(http).getSnapshots(QUERY)).rejects.toThrow(/as_of/);
    });

    it('count 与实收行数不符 → throw (疑传输截断, 不返回半份数据)', async () => {
      const { http } = makeShim([snapshotRow(LEG)], { count: 7 });
      await expect(makeAdapter(http).getSnapshots(QUERY)).rejects.toThrow(/疑截断/);
    });

    it('缺 rows[] → throw (契约变更)', async () => {
      const { http } = makeShim([], { rows: undefined });
      await expect(makeAdapter(http).getSnapshots(QUERY)).rejects.toThrow(/rows/);
    });
  });

  describe('🚨 失败语义映射 (镜像链发现那一对)', () => {
    it('429 → OptionSnapshotBudgetExhaustedError (顺延信号, 不耗 attempts)', async () => {
      const { http } = makeThrowingShim(new TransientVendorError('rate limited', 429));
      await expect(makeAdapter(http).getSnapshots(QUERY)).rejects.toBeInstanceOf(
        OptionSnapshotBudgetExhaustedError,
      );
    });

    it('400 → OptionSnapshotRejectedError (永久, 重试只是把同一个 400 再要一遍)', async () => {
      const { http } = makeThrowingShim(new VendorHttpError('bad request', 400));
      await expect(makeAdapter(http).getSnapshots(QUERY)).rejects.toBeInstanceOf(
        OptionSnapshotRejectedError,
      );
    });

    it('5xx / 网络错原样上抛 (吞了会把「vendor 坏了」说成「预算用完了」)', async () => {
      const { http } = makeThrowingShim(new TransientVendorError('bad gateway', 502));
      const err = await makeAdapter(http)
        .getSnapshots(QUERY)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(TransientVendorError);
      expect(err).not.toBeInstanceOf(OptionSnapshotBudgetExhaustedError);
    });
  });
});

// ---------------------------------------------------------------------------
// 066 T01 — 港股 (hk) 接入 (FR-001 / FR-004 / FR-005, plan §A11)
// ---------------------------------------------------------------------------
/**
 * 真实响应回放: 直连港股侧行情网关实取 (2026-08-23, 同日链上 132 个合约 + 标的 `HK.00700`),
 * `__fixtures__/` 里放的是**原始信封** (as_of / count / rows 逐字未加工)。
 *
 * 🚨 **两层分开断**: 先量原始行形态 (vendor 给了什么), 再断解析结果。港股期权行与美股行的
 * **键集逐字相同** —— 这是实测结论, 一旦 vendor 改口径必须在这里红, 而不是在夜间采集里静默半份。
 */
interface SnapshotFixture {
  response: { as_of: string; count: number; rows: Record<string, unknown>[] };
}

const HK_SNAPSHOT = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'hk-option-snapshot-00700-2026-08-23.json'), 'utf8'),
) as SnapshotFixture;
const HK_SNAPSHOT_ROWS = HK_SNAPSHOT.response.rows;
const HK_OPTION_ROWS = HK_SNAPSHOT_ROWS.filter((r) => r.option_valid === true);
const HK_UNDERLYING_RAW = HK_SNAPSHOT_ROWS.find((r) => r.option_valid !== true) as Record<
  string,
  unknown
>;
const HK_CONTRACT_CODES = HK_OPTION_ROWS.map((r) => String(r.code));
/** 港股独有 (美股行同样在场但取值不同) —— 缺哪个都说明 vendor 换了口径。 */
const HK_ONLY_FIELDS = [
  'option_net_open_interest',
  'option_contract_nominal_value',
  'option_owner_lot_multiplier',
] as const;

const uniq = (values: unknown[]) => [...new Set(values)];

/** 把整份实取响应喂进 adapter (信封 as_of 用实取值)。 */
async function replayHkSnapshot() {
  const { http, calls } = makeShim(HK_SNAPSHOT_ROWS, { as_of: HK_SNAPSHOT.response.as_of });
  const batch = await makeAdapter(http).getSnapshots({
    underlyingSymbol: 'hk:00700',
    contractCodes: HK_CONTRACT_CODES,
  });
  return { batch, calls };
}

describe('066 T01 FutuOptionSnapshotAdapter — 港股 (hk) 接入', () => {
  describe('原始行形态 (先量 vendor 给了什么)', () => {
    it('实取 133 行 = 132 期权 + 1 标的; 两类行键集逐字相同 (143 列)', () => {
      expect(HK_SNAPSHOT.response.count).toBe(133);
      expect(HK_SNAPSHOT_ROWS).toHaveLength(133);
      expect(HK_OPTION_ROWS).toHaveLength(132);
      expect(HK_UNDERLYING_RAW.code).toBe('HK.00700');
      expect(Object.keys(HK_UNDERLYING_RAW).sort()).toEqual(Object.keys(HK_OPTION_ROWS[0]).sort());
    });

    it('🚨 期权行 stock_owner 132/132 = HK.00700, 标的行没有它 (plan §A11)', () => {
      expect(uniq(HK_OPTION_ROWS.map((r) => r.stock_owner))).toEqual(['HK.00700']);
      expect(HK_UNDERLYING_RAW.stock_owner).toBeNull();
      // 合约标识里没有 00700 —— 词根是交易所助记符 TCH, 反推不出标的。
      expect(HK_CONTRACT_CODES.every((c) => !c.includes('00700'))).toBe(true);
    });

    it('greeks_complete 132/132 为 true; 三个港股独有字段 132/132 有真值', () => {
      expect(uniq(HK_OPTION_ROWS.map((r) => r.greeks_complete))).toEqual([true]);
      for (const field of HK_ONLY_FIELDS) {
        expect(HK_OPTION_ROWS.filter((r) => typeof r[field] === 'number')).toHaveLength(132);
      }
    });
  });

  describe('解析结果', () => {
    it('hk symbol → 标的 HK.00700 拼进 codes 首位, 132 个合约同批 (不另发调用)', async () => {
      const { calls } = await replayHkSnapshot();
      expect(calls).toHaveLength(1);
      const codes = new URL(calls[0].url).searchParams.get('codes') as string;
      expect(codes.split(',')[0]).toBe('HK.00700');
      expect(codes.split(',')).toHaveLength(133);
    });

    it('133 行一行不丢: 132 行 isOption + 归属 HK.00700, 标的行 isOption=false', async () => {
      const { batch } = await replayHkSnapshot();

      expect(batch.asOf).toEqual(new Date('2026-08-23T00:48:11+00:00'));
      expect(batch.rows).toHaveLength(133);
      const options = batch.rows.filter((r) => r.isOption);
      expect(options).toHaveLength(132);
      // 🚨 归属只取 stock_owner —— 词根 TCH 反推不出 00700。
      expect(uniq(options.map((r) => r.underlyingCode))).toEqual(['HK.00700']);
      expect(uniq(options.map((r) => r.greeksComplete))).toEqual([true]);

      const underlying = batch.rows.find((r) => !r.isOption) as (typeof batch.rows)[number];
      expect(underlying.code).toBe('HK.00700');
      expect(underlying.underlyingCode).toBeNull();
      // 不适用 ≠ 缺失。
      expect(underlying.greeksComplete).toBeNull();
      expect(underlying.last).toBe('457');
    });

    it('港股独有的净持仓量列落 Decimal-safe string, 132/132 非 null', async () => {
      const { batch } = await replayHkSnapshot();
      const options = batch.rows.filter((r) => r.isOption);
      expect(options.filter((r) => r.netOpenInterest !== null)).toHaveLength(132);
      expect(options.filter((r) => r.openInterest !== null)).toHaveLength(132);
      expect(uniq(options.map((r) => typeof r.netOpenInterest))).toEqual(['string']);
    });
  });
});
