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

  describe('🚨 美股行的 vendor 时间戳按**美东**解释 (p3b E21/E32)', () => {
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

// ---------------------------------------------------------------------------
// 066 T17 — vendor 时间戳按**行所属市场**解析 (FR-005a, plan §A13)
// ---------------------------------------------------------------------------
/**
 * 病灶: `update_time` 此前固定按美东解释, 而港股行给的是**港股当地时刻** ⇒ 港股这一列整体
 * 偏 12 小时。快照这条路上它是**纯证据零判据** (端口注释禁止拿它顶替采集时刻), 偏了不会有
 * 任何断言变红 —— 这正是它一直没被发现的原因; 但**同一个** `vendorTimeToDate` 被实时报价
 * adapter 复用, 那条路上 `intraday_at` 是 90 秒新鲜度闸的真判据。
 */
const ADAPTER_SRC = readFileSync(join(__dirname, 'futu-option-snapshot.adapter.ts'), 'utf8');
const SESSION_CLOCK_SRC = readFileSync(join(__dirname, 'session-clock.ts'), 'utf8');
/** 被引号括起来的 IANA 时区字面量 = 这个文件自己存了一份「market → 时区」表。 */
const QUOTED_IANA = /['"](?:Asia|America|Europe|Australia)\/[A-Za-z_]+['"]/;
/** 一个瞬间的 UTC 时刻部分 (`HH:mm:ss`) —— 日期各行不同, 要比的是「几点」。 */
const utcClock = (d: Date | null) => (d === null ? null : d.toISOString().slice(11, 19));
const utcMinutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

describe('066 T17 FutuOptionSnapshotAdapter — vendor 时间戳按行所属市场解析', () => {
  it('① 港股期权行 132/132 落在当地 09:30–16:00 (= 01:30Z–8:00Z), 按美东会整列偏 12 小时', async () => {
    const { batch } = await replayHkSnapshot();
    const options = batch.rows.filter((r) => r.isOption);
    expect(options).toHaveLength(132);
    // 港股恒 UTC+8 且无 DST ⇒ 当地盘中区间唯一对应 01:30Z–8:00Z;
    // 按美东 (8 月 = EDT, UTC-4) 解释会把整列推到 13:30Z–20:00Z —— 一行不剩地落在区间外。
    const outside = options.filter((r) => {
      const m = utcMinutes(r.vendorUpdateTime as Date);
      return m < 90 || m > 8 * 60;
    });
    expect(outside).toHaveLength(0);
    // 87 条今日未成交的腿时间戳停在开盘那一刻 (当地 09:30)。
    expect(options.filter((r) => utcClock(r.vendorUpdateTime) === '01:30:00')).toHaveLength(87);
  });

  it('① 港股标的行 16:07:49 当地 → 08:07:49Z (逐秒对齐, 不是偏 12 小时的 20:07:49Z)', async () => {
    const { batch } = await replayHkSnapshot();
    const underlying = batch.rows.find((r) => !r.isOption) as (typeof batch.rows)[number];
    expect(underlying.vendorUpdateTime).toEqual(new Date('2026-08-21T08:07:49Z'));
  });

  it('② 美股行逐点不变: 标的行与期权行同批, 16:00 ET 仍是 20:00Z', async () => {
    const { http } = makeShim([UNDERLYING_ROW, snapshotRow(LEG)]);
    const { rows } = await makeAdapter(http).getSnapshots(QUERY);
    expect(uniq(rows.map((r) => r.vendorUpdateTime?.toISOString()))).toEqual([
      '2026-08-04T20:00:00.000Z',
    ]);
  });

  it('③ 市场→时区**只有一份**: 表在 session-clock, adapter 零 IANA 字面量', () => {
    // 两份市场时区表一旦漂开, 表现是「某个市场的时间戳悄悄差几小时」, 不报错 ⇒ 只能机械断。
    expect(QUOTED_IANA.test(SESSION_CLOCK_SRC)).toBe(true);
    expect(QUOTED_IANA.test(ADAPTER_SRC)).toBe(false);
    expect(ADAPTER_SRC).toMatch(
      /import \{[^}]*exchangeTimeZone[^}]*\} from '\.\/session-clock\.js'/,
    );
  });
});

// ---------------------------------------------------------------------------
// 066 T09 (verify ④) — 希腊值缺失的港股行照常在库、带标注、不丢行
// (SC-010, `state_branches` 21; 2026-08-23 从 T15 挪来 —— T15 已改为 post-deploy 验收,
//  而这三件事在**纯函数层**就能断, 不该等到部署后才有覆盖)
// ---------------------------------------------------------------------------
/**
 * `state_branches` 21 原文: 供应方对某港股合约不返回希腊值 → 该行 MUST 照常落库并标注**档位
 * 不可定**, MUST NOT 丢行。
 *
 * 🚨 **缺失态是构造出来的, 不是实取的** —— 手上两份真实 fixture 里都没有:
 *   · 港股这份 132/132 `greeks_complete=true` (上一块已逐行断);
 *   · 美股那份是 7 列瘦投影, `delta` 的空值写成 **0** —— 拿它当缺失态等于拿 0 冒充 null,
 *     恰好是本块要禁的那件事。
 * 供应方**哪天**不下发 greeks 不由我们决定 (实值腿 bid 跌破内在价值 ⇒ IV 无解 ⇒ 六个字段
 * 一起没有, 美股实测 227/2150 行); 港股只是至今没在采样窗里撞上。撞上那天这条路必须**已经**
 * 是对的 ⇒ 取一条**实取行**、只把 greeks 块改造掉 (其余 142 列逐字原样), 这是「照实取形态
 * 动一个变量」, 不是凭空捏一行。
 *
 * 🚫 本块**不断**「标记为 true ⇒ 值可用」: 2026-08-07 真 vendor 实测 `US.PEP260807C75000`
 * `greeks_complete === true` 而五个数**全为 0** —— 那条判据归 `option-anomaly.rules.ts`
 * (它的入参**蓄意不收** `greeksComplete`), 在这里再判一次就是第二处判据, 且方向相反。
 * 本块只断**解析层**三件事: ⓐ 行不丢 ⓑ 标记带上 ⓒ 值落 `null`。
 *
 * 📌 丢行的后果: 「腿在但算不出档」与「这条腿今天整行没采到」变得不可区分 —— 前者是数学固有
 * 现象、后者是真缺口, 而 vendor 不提供历史交易日的期权快照, 丢一行就是永久缺席。
 */
/** 缺失形态: `blank` = 键在值为 null (shim 已判定并标记) / `absent` = 键整块缺席。 */
type GreeksMissingShape = 'blank' | 'absent';

/**
 * 捐赠行: 实取的一条真行, 五个 greeks 全非零 (删得掉才谈得上「缺失」), OI 非零,
 * 且 `bid_price` 实取就是 **0** —— 同一行里同时有「真实的 0」与「算不出」, 是 ⓒ 的对照面。
 */
const HK_GREEKS_DONOR_CODE = 'HK.TCH260828P230000';
const HK_GREEKS_DONOR = HK_OPTION_ROWS.find((r) => r.code === HK_GREEKS_DONOR_CODE) as Record<
  string,
  unknown
>;
/** 与 shim `mappers.GREEK_FIELDS` 同集合: IV 与五个 greeks **一起来、一起没**。 */
const SHIM_GREEK_FIELDS = [
  'option_implied_volatility',
  'option_delta',
  'option_gamma',
  'option_vega',
  'option_theta',
  'option_rho',
] as const;
/** 端口侧的五个希腊值 (IV 单列, 不算「希腊值」)。 */
const PARSED_GREEKS = ['delta', 'gamma', 'vega', 'theta', 'rho'] as const;

/** 实取行 → 「供应方不返回希腊值」的同一行 (只动 greeks 块与标记, 其余列原样)。 */
function withGreeksMissing(
  row: Record<string, unknown>,
  shape: GreeksMissingShape,
): Record<string, unknown> {
  const out = { ...row };
  for (const field of SHIM_GREEK_FIELDS) {
    if (shape === 'blank') out[field] = null;
    else delete out[field];
  }
  // `absent` 连标记一起拿掉: vendor 不下发且 shim 未加工时, 完整性由 adapter 兜底现算。
  if (shape === 'blank') out.greeks_complete = false;
  else delete out.greeks_complete;
  return out;
}

/** 整份实取响应里**只**把捐赠行换成缺失态 —— 「不丢行」只有在整批里量才有意义。 */
async function replayHkWithGreeksMissing(shape: GreeksMissingShape) {
  const rows = HK_SNAPSHOT_ROWS.map((r) =>
    r.code === HK_GREEKS_DONOR_CODE ? withGreeksMissing(r, shape) : r,
  );
  const { http } = makeShim(rows, { as_of: HK_SNAPSHOT.response.as_of });
  const batch = await makeAdapter(http).getSnapshots({
    underlyingSymbol: 'hk:00700',
    contractCodes: HK_CONTRACT_CODES,
  });
  const donor = batch.rows.find((r) => r.code === HK_GREEKS_DONOR_CODE);
  return { batch, donor };
}

describe('066 T09 (verify ④) 港股希腊值缺失: 照常在库 + 带标注 + 不丢行 (SC-010, 分支 21)', () => {
  it('构造前的对照面: 捐赠行实取时五个 greeks 全非零、标记为 true (缺失态确实是删出来的)', () => {
    expect(HK_GREEKS_DONOR).toBeDefined();
    expect(HK_GREEKS_DONOR.greeks_complete).toBe(true);
    for (const field of SHIM_GREEK_FIELDS) {
      expect(typeof HK_GREEKS_DONOR[field]).toBe('number');
      expect(HK_GREEKS_DONOR[field]).not.toBe(0);
    }
    // ⓒ 的对照面: 同一行的 bid 实取就是 0 —— 0 是**值**, 与「算不出」方向相反。
    expect(HK_GREEKS_DONOR.bid_price).toBe(0);
    expect(HK_GREEKS_DONOR.option_open_interest).toBe(121);
  });

  describe.each([
    ['shim 已判定并标记 (greeks_complete=false, 六个字段值为 null)', 'blank'],
    ['供应方连键都不下发 (整块缺席, shim 亦未加标记)', 'absent'],
  ] as [string, GreeksMissingShape][])('%s', (_label, shape) => {
    it('ⓐ 该行仍在结果集里: 133 行一行不丢, 其余 131 条腿的标记不受牵连', async () => {
      const { batch, donor } = await replayHkWithGreeksMissing(shape);

      expect(batch.rows).toHaveLength(133);
      expect(donor).toBeDefined();
      // 丢了这行 = 「腿在但算不出档」与「这条腿今天整行没采到」不可区分。
      expect(donor?.isOption).toBe(true);
      expect(donor?.underlyingCode).toBe('HK.00700');
      const others = batch.rows.filter((r) => r.isOption && r.code !== HK_GREEKS_DONOR_CODE);
      expect(others.filter((r) => r.greeksComplete === true)).toHaveLength(131);
    });

    it('ⓑ 标注档位不可定: greeksComplete=false (不是 null —— null 是「不适用」, 只归标的行)', async () => {
      const { batch, donor } = await replayHkWithGreeksMissing(shape);
      expect(donor?.greeksComplete).toBe(false);
      // 「不适用」与「缺失」是两个状态, 不能合流。
      const underlying = batch.rows.find((r) => !r.isOption);
      expect(underlying?.greeksComplete).toBeNull();
    });

    it('ⓒ 五个希腊值落 null 而**不是** 0 (0 在下游是有意义的值, 与「算不出」方向相反)', async () => {
      const { donor } = await replayHkWithGreeksMissing(shape);
      for (const greek of PARSED_GREEKS) {
        expect(donor?.[greek]).toBeNull();
      }
      // IV 与它们一起来、一起没。
      expect(donor?.iv).toBeNull();
    });

    it('🚨 ⓒ 的反面: 同一行 bid 实取就是 0 → 照常落 "0", OI 照常落库 (缺的只是 greeks, 不是整行)', async () => {
      const { donor } = await replayHkWithGreeksMissing(shape);
      expect(donor?.bid).toBe('0');
      expect(donor?.openInterest).toBe('121');
      expect(donor?.netOpenInterest).toBe('31');
      expect(donor?.vendorUpdateTime).not.toBeNull();
    });
  });
});
