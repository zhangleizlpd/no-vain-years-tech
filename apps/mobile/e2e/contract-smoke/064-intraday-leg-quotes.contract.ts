/**
 * 064 盘中实时腿报价 —— 三个新出参的**序列化形态**契约冒烟（Constitution §V 两层验证之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的**真 server**（testcontainers PG），跑一条
 * happy path：**建锚 → 灌一期全链快照 → 拉选约表**，验 `priceKind`（腿级 + 链级）/ `quoteAsOf` /
 * `oiAsOf` / `realtimeDegrade` 能被客户端**正确解封**。
 *
 * 补的正是另两层各自盖不到的缝：
 *   ① hermetic e2e（T011）把响应 mock 掉了 —— 它验的是「拿到这形状后 UI 怎么画」，形状本身由
 *      **手写的** fixture 保证；server 把 `priceKind` 序列化成别的字面量、把 `quoteAsOf` 在收盘档
 *      也带上时分秒、或把 `realtimeDegrade` 发成 `undefined` 而不是 `null`，那边照样全绿。
 *   ② server IT（T003–T007a）打的是真 server，但断言写在**手写的期望**上，与 mobile 实际消费的
 *      那份**生成客户端类型**是两条独立的手抄链 —— orval 生成出别的形状不会有人红。
 *
 * 🚨 本片四条只有端到端才验得到的靶心：
 *   1. **`quoteAsOf` 的粒度即档位**（`FR-010`）：收盘档必须是**恰好 10 字符的 `YYYY-MM-DD`**、
 *      不含 `T`。档位本身不上屏，界面唯一的表达手段就是这个粒度差 —— 服务端哪天把它按时刻序列化，
 *      屏幕上只会安静地多出时分秒，被读成「此刻的盘口」，而没有任何 UI 断言会红。
 *   2. **`oiAsOf` 是独立出参，与 `quoteAsOf` 不是同一天**（`FR-014`）：本片的种子里 OI 归属
 *      `T−1`、快照归属 `T` ⇒ 两者必须不等。哪天有人「简化」成复用区块级 asOf，OI 那一列的
 *      **数字一个都不会变**，只有归属日悄悄变了。
 *   3. **`realtimeDegrade` 的两个分支都要能过线**（`FR-010` / T007a）：非 null 时是**四值之一的
 *      字面量**（不是裸 string、不是布尔），null 时是**真 `null`**（不是缺字段 —— `JSON.stringify`
 *      会把 `undefined` 整个键删掉，客户端读到 `undefined` 走的是「没接这根线」那条路）。
 *   4. **实时未生效时逐列等于库内收盘值**（`FR-016` / `SC-005`）：七列覆盖面一格都没动过。
 *
 * 📌 **本环境下实时档结构上取不到，这是正确行为，不是缺陷**：harness 恒钉 `MARKETDATA_PROVIDER=mock`
 *    （见 `real-backend-harness.ts`），而 `MARKET_STATE_PORT` 在 mock 档下是 054 的**拒绝壳**
 *    （一调即抛）⇒ 意图视角的窄召回落 `gate_unknown` 回落；**本文件打的 all 视角 068 起按
 *    Q1 裁决直落收盘档、闸没判 ⇒ 降级标恒 null**。⇒ 本片断言顺着它写（非 null 分支归 068 那份）。
 *    🚫 **MUST NOT** 为了「让实时档出现」去改 provider 档位或塞真 vendor 凭据 —— 那会让这条
 *    冒烟从「契约形状对不对」变成「真行情源通不通」，而后者归 `RUN_MARKETDATA_IT` 那道门。
 *
 * ⚠️ **如实登记一条覆盖不到的**：`realtime` 开关**不在 HTTP 面上**（两个读端都在调用点恒传 `true`，
 *    见 `optionsdesk.controller.ts`）⇒ 「关态」没有可打的入口，本片只能验它的**等价那一半**：
 *    实时未生效时七列逐字等于库内收盘值。开关本身的「关态零外呼」判据在 server IT
 *    （`optionsdesk-064.overlay.it.spec.ts` 的调用计数 = 0），那是它唯一的机器判据。
 *
 * 边界与幂等：用**专属 ticker** `us:NVYI`（有链）/ `us:NVYK`（有锚无链），避开 045 `NVYX`、
 * 046 `NVYQ..T`、047 `NVYL,NVYN,NVYP`、055 `NVYG,NVYH`、061 `NVYA,NVYB`。marketdata 三张事实表
 * 无公开写端点 ⇒ 靠 `ctx.execSql` 直插（schema=marketdata，列名 snake_case per `@map`），
 * 锚走公开写端点建 / 末尾 DELETE 自清理 —— 同一次 boot 内顺序跑多 spec 不互相污染。
 *
 * 🚨 **日期一律在运行时相对「交易所的今天」算**（同 047）：本片打的是真 server，`now` 就是请求
 * 时刻，硬编码日期一周后就全线过期。
 */
import assert from 'node:assert/strict';
import {
  LegResponsePriceKind,
  LegTableResponsePriceKind,
  optionsdeskControllerCreate,
  optionsdeskControllerLegs,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { LegTableResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-intraday-leg-quotes (064)';

type Cfg = { baseURL: string; headers: Record<string, string> };

const MARKET = 'us';
/** 有锚 + 全链快照 ⇒ `available`（本片主战场）。 */
const CODE_CHAIN = 'NVYI';
/** 有锚但**未注册进 marketdata** ⇒ `chain_not_ready` —— 三个新字段的**空壳形态**在这里验。 */
const CODE_NO_CHAIN = 'NVYK';

const CHAIN = `${MARKET}:${CODE_CHAIN}`;
const NO_CHAIN = `${MARKET}:${CODE_NO_CHAIN}`;

// ── 锚：V=100、confidence 8.0（映射档 L2）⇒ W=80、四区间 60 / 80 / 100 / 120 ────────────────
const V = '100.0000';
const CONFIDENCE = '8.0';
/** spot 落 `[0.6V, W)` ⇒ 区间 `buy`；全链一律虚值认沽（K < spot）⇒ 内在价值恒 0。 */
const SPOT = '70.0000';

/** 三条腿（DTE 跨建仓 / 收租两段，保证三个视角都有成员）。 */
const LEG_NEAR = 'US.NVYI.NEAR';
const LEG_MID = 'US.NVYI.MID';
const LEG_FAR = 'US.NVYI.FAR';

/**
 * 库内那批快照的**逐列真值** —— 靶心 4 的期望值直接读这里。
 *
 * 🚨 覆盖面是七列（`bid` / `ask` / 挂牌量 / `delta` / `iv` / `volume`）⇒ 期望值必须**逐列**写出，
 *    🚫 MUST NOT 只抽查 `bid`：只抽一列的话，「覆盖逻辑跑了但源没给数」这种把其余六列写成 null
 *    的形态照样过。
 * 🚨 `openInterest` 蓄意也在册里：它**结构上不在覆盖面上**（Guardrail 6），本片一并钉住
 *    ——「OI 恒收盘档」在契约层的证据。
 */
interface SeedQuote {
  readonly code: string;
  readonly strike: string;
  readonly dte: number;
  readonly bid: string;
  readonly ask: string;
  readonly bidSize: number;
  readonly askSize: number;
  readonly delta: string;
  readonly iv: string;
  readonly openInterest: number;
  readonly volume: number;
}

const SEED: readonly SeedQuote[] = [
  {
    code: LEG_NEAR,
    strike: '68.5000',
    dte: 10,
    bid: '0.9000',
    ask: '1.0500',
    bidSize: 12,
    askSize: 14,
    delta: '-0.45000000',
    iv: '0.31000000',
    openInterest: 50,
    volume: 3,
  },
  {
    code: LEG_MID,
    strike: '65.0000',
    dte: 120,
    bid: '6.0000',
    ask: '6.5000',
    bidSize: 25,
    askSize: 26,
    delta: '-0.35000000',
    iv: '0.28000000',
    openInterest: 1200,
    volume: 90,
  },
  {
    code: LEG_FAR,
    strike: '60.0000',
    dte: 200,
    bid: '5.0000',
    ask: '5.4000',
    bidSize: 31,
    askSize: 33,
    delta: '-0.10000000',
    iv: '0.26000000',
    openInterest: 5000,
    volume: 300,
  },
];

const QUOTE_TIME = 'T20:15:00.000Z';

/** `YYYY-MM-DD` —— 收盘档 asOf 的粒度判据（恰好 10 字符、无 `T`）。 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const today = exchangeToday(new Date());
  /** 🚨 OI 归属 `T−1`（美股期权 OI 盘前更新）—— 靶心 2 的判别源。 */
  const oiDay = plusDays(today, -1);

  await seed(ctx, today, oiDay);

  const anchorIds: string[] = [];
  try {
    anchorIds.push(await createAnchor(cfg, CHAIN));
    anchorIds.push(await createAnchor(cfg, NO_CHAIN));

    const view = await legs(cfg, CHAIN);
    assert.equal(view.state, 'available', `选约表应就绪, got ${view.state}`);
    assert.equal(view.legs.length, SEED.length, '三条腿都应进全腿视角');

    assertTierLiterals(view);
    assertAsOfGranularity(view, today, oiDay);
    assertDegradeNullableEnum(view);
    assertEodValuesUntouched(view);

    // ── 空壳形态：三个新字段在「链未就绪」时的序列化 ─────────────────────────────
    await assertNotReadyShell(cfg);
  } finally {
    for (const id of anchorIds) {
      const del = await optionsdeskControllerRemove(id, cfg);
      assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
    }
    await deleteSeed(ctx, today);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 断言
// ════════════════════════════════════════════════════════════════════════════

/**
 * 靶心 0 —— 两个 `priceKind` 都解封成**联合字面量**（不是裸 string）。
 *
 * 🚨 期望值取**生成的常量**而非手抄字面量：手抄的那份与契约漂移时 `assert.equal` 自己不会红
 *    （它比的是两个字符串），只有拿生成物当期望，orval 那边一改这里才立刻编译红。
 * 🚨 链级与腿级是**两个数**（契约逐字写明）—— 本片两处各断一次，🚫 不合并成一条。
 */
function assertTierLiterals(view: LegTableResponse): void {
  assert.equal(
    view.priceKind,
    LegTableResponsePriceKind.eod_close,
    `mock provider 下无实时源 ⇒ 链级恒收盘档, got ${view.priceKind}`,
  );
  for (const leg of view.legs) {
    assert.equal(
      leg.priceKind,
      LegResponsePriceKind.eod_close,
      `${leg.code} 行级档位应是收盘档, got ${leg.priceKind}`,
    );
  }
}

/**
 * 靶心 1 + 2 —— `quoteAsOf` 的**粒度即档位**，且 `oiAsOf` 是**另一个事实**。
 */
function assertAsOfGranularity(view: LegTableResponse, today: string, oiDay: string): void {
  assert.ok(
    view.quoteAsOf !== null && DATE_ONLY_RE.test(view.quoteAsOf),
    `收盘档 quoteAsOf 必须是 YYYY-MM-DD 粒度, got ${String(view.quoteAsOf)}`,
  );
  // 🚨 冗余但刻意：`DATE_ONLY_RE` 已排除 `T`，这一条说的是**为什么**要排除它。
  assert.ok(!view.quoteAsOf?.includes('T'), '收盘档带上了时分秒 ⇒ 会被读成此刻的盘口');
  assert.equal(view.quoteAsOf, today, '收盘档的时点就是那批快照归属的交易日');

  assert.equal(view.oiAsOf, oiDay, 'OI 归属日必须是 T−1（盘前更新，收盘后采的快照归属前一日）');
  assert.notEqual(
    view.oiAsOf,
    view.quoteAsOf,
    '🚨 oiAsOf 与 quoteAsOf 相等 —— 独立出参被折叠回区块级 asOf 了（OI 那列的数字一个都不会变）',
  );
  // 区块级 `asOf`（快照归属交易日）与 `quoteAsOf` 在收盘档下同值 —— 两者的分家只发生在实时档，
  // 那一档归 T013 真机实证（本环境结构上到不了）。
  assert.equal(view.asOf, today, '区块级 asOf = 快照归属交易日');
}

/**
 * 靶心 3 —— `realtimeDegrade` 是**可空的四值枚举**，非 null 分支在这里过线。
 *
 * 🚨 `gate_unknown` 在本环境是**结构决定**的，不是巧合：`MARKETDATA_PROVIDER=mock` ⇒
 *    `MARKET_STATE_PORT` 绑 054 的拒绝壳（一调即抛）⇒ 两闸判不出「此刻该不该外呼」⇒
 *    fail-closed 走收盘档并**如实标降级**。它与「非交易时段」（恒 `null`）刻意分得开 ——
 *    后者是常态，前者是「我们不知道」。
 */
function assertDegradeNullableEnum(view: LegTableResponse): void {
  // 068 Q1 起本文件的 all 视角**直落收盘档、闸根本没判** ⇒ 降级标恒真 null（键在、值 null，
  // 不是缺字段）。非 null 分支（gate_unknown 字面量取生成常量）随窄召回移到意图视角 ——
  // 判据在 `068-two-stage-recall.contract.ts` 的 rent 那一份。
  assert.ok('realtimeDegrade' in view, '降级标键不见了 —— undefined 被序列化吞掉');
  assert.equal(
    view.realtimeDegrade,
    null,
    '068 起全腿视角实时开态直落收盘档（Q1 裁决）⇒ 降级标 MUST 真 null',
  );
}

/**
 * 靶心 4 —— 实时未生效时，**七列覆盖面 + OI 三列**逐列等于库内那批收盘值。
 *
 * 🚨 逐列写出而非抽查一列：「覆盖逻辑跑了但源没给数」会把其余几列写成 null，抽查 `bid` 时
 *    那种形态照样过（`SC-004` 的同款病灶，只是换到了契约层）。
 */
function assertEodValuesUntouched(view: LegTableResponse): void {
  for (const want of SEED) {
    const got = view.legs.find((l) => l.code === want.code);
    assert.ok(got, `${want.code} 应在响应里`);
    assert.equal(Number(got.bid), Number(want.bid), `${want.code} bid`);
    assert.equal(Number(got.ask), Number(want.ask), `${want.code} ask`);
    assert.equal(got.bidSize, want.bidSize, `${want.code} bidSize`);
    assert.equal(got.askSize, want.askSize, `${want.code} askSize`);
    assert.equal(got.absDelta, Math.abs(Number(want.delta)), `${want.code} |Δ|`);
    assert.equal(got.volume, want.volume, `${want.code} volume`);
    // 🚨 OI **结构上不在覆盖面上**（Guardrail 6）—— 它与上面几列同表存在，正是「哪些列会被
    //    实时值改写、哪些永远不会」这条边界在契约层的证据。
    assert.equal(got.openInterest, want.openInterest, `${want.code} openInterest`);
    // 数值与 asOf 同生共死：有值就不许是 0（`SC-004` 的契约层回声）。
    assert.notEqual(Number(got.bid), 0, `${want.code} bid 被置 0`);
  }
}

/**
 * 链未就绪的**空壳形态** —— 三个新字段在这一支上的序列化。
 *
 * 🚨 `realtimeDegrade` 必须是**真 `null`** 而不是缺字段：`JSON.stringify` 会把 `undefined` 的键
 *    整个删掉，客户端读到 `undefined` 走的是「没接这根线」那条路，而屏上两者长得一模一样。
 * 🚨 空壳恒 `null` 是**语义**不是巧合：链都没就绪，连闸都没判过 ⇒ 说不出「本该外呼」。
 */
async function assertNotReadyShell(cfg: Cfg): Promise<void> {
  const view = await legs(cfg, NO_CHAIN);
  assert.equal(
    view.state,
    'chain_not_ready',
    `未注册进 marketdata ⇒ chain_not_ready, got ${view.state}`,
  );
  assert.equal(view.legs.length, 0);
  assert.equal(
    view.priceKind,
    LegTableResponsePriceKind.eod_close,
    '一个实时值都没取到 ⇒ 档位仍显式下发 eod_close（非 nullable 枚举，不许缺字段）',
  );
  assert.ok(
    'realtimeDegrade' in view,
    '🚨 realtimeDegrade 整个键不见了 —— undefined 被 JSON 序列化吃掉了，客户端会读成「没接这根线」',
  );
  assert.equal(view.realtimeDegrade, null, '链未就绪 ⇒ 连闸都没判过，说不出「本该外呼」');
  assert.equal(view.quoteAsOf, null, '无快照 ⇒ 时点与数值同生共死');
  assert.equal(view.oiAsOf, null);
}

// ════════════════════════════════════════════════════════════════════════════
// 种子 / 辅助
// ════════════════════════════════════════════════════════════════════════════

async function legs(cfg: Cfg, symbol: string): Promise<LegTableResponse> {
  const res = await optionsdeskControllerLegs(symbol, { perspective: 'all' }, cfg);
  assert.equal(res.status, 200, `legs ${symbol} expected 200, got ${res.status}`);
  return res.data;
}

async function seed(ctx: RealBackendCtx, today: string, oiDay: string): Promise<void> {
  await deleteSeed(ctx, today); // 防上轮异常退出未走 cleanup

  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status)
     VALUES ('${MARKET}', '${CODE_CHAIN}', '064 契约冒烟 盘中档位', 'stock', 'USD', 'listed')`,
  );
  const iid = `(SELECT id FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE_CHAIN}')`;

  // 🚨 交易日历必须**含未来日**：只种到 asOf 那天的话「最近一个已收盘交易日」恒等于 asOf，
  //    新鲜度档退化成恒 CURRENT 的平凡答案（同 047 的判据）。
  await ctx.execSql(
    `INSERT INTO marketdata.trading_day (market, date)
     SELECT '${MARKET}', g::date
     FROM generate_series(DATE '${plusDays(today, -10)}', DATE '${plusDays(today, 10)}', INTERVAL '1 day') AS g
     ON CONFLICT DO NOTHING`,
  );

  const contracts = SEED.map(
    (s) =>
      `('${MARKET}', '${s.code}', '${CODE_CHAIN}', ${iid}, DATE '${plusDays(today, s.dte)}', ` +
      `${s.strike}, 'PUT', true)`,
  ).join(',\n       ');
  await ctx.execSql(
    `INSERT INTO marketdata.option_contract
       (market, code, root, underlying_instrument_id, expiry_date, strike_price, option_type, is_standard)
     VALUES
       ${contracts}`,
  );
  const cid = (code: string): string =>
    `(SELECT id FROM marketdata.option_contract WHERE market = '${MARKET}' AND code = '${code}')`;

  const snapshots = SEED.map(
    (s) =>
      `(${cid(s.code)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${oiDay}', ` +
      `${s.bid}, ${s.ask}, ${s.bidSize}, ${s.askSize}, ${s.iv}, ${s.delta}, ` +
      `${s.openInterest}, ${s.volume}, ${SPOT}, true)`,
  ).join(',\n       ');
  await ctx.execSql(
    `INSERT INTO marketdata.option_daily_snapshot
       (contract_id, session_date, source, quote_as_of, oi_as_of, bid, ask, bid_size, ask_size,
        iv, delta, open_interest, volume, underlying_spot, greeks_complete)
     VALUES
       ${snapshots}`,
  );
}

async function deleteSeed(ctx: RealBackendCtx, today: string): Promise<void> {
  // instrument 删除 CASCADE 带走 option_contract → option_daily_snapshot。
  await ctx.execSql(
    `DELETE FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE_CHAIN}'`,
  );
  // 交易日历是全市场共享表 ⇒ 只删本片种的那一段。
  await ctx.execSql(
    `DELETE FROM marketdata.trading_day
     WHERE market = '${MARKET}' AND date BETWEEN DATE '${plusDays(today, -10)}' AND DATE '${plusDays(today, 10)}'`,
  );
}

async function createAnchor(cfg: Cfg, ticker: string): Promise<string> {
  const today = exchangeToday(new Date());
  const created = await optionsdeskControllerCreate(
    {
      ticker,
      v: V,
      asof: plusDays(today, -30),
      method: 'DCF · 064 契约冒烟',
      confidence: CONFIDENCE,
      nextReview: plusDays(today, 120),
    },
    cfg,
  );
  assert.equal(created.status, 201, `create ${ticker} expected 201, got ${created.status}`);
  return created.data.id;
}

/** 「交易所的今天」（`America/New_York`）—— 与 server 的 `marketDateFor(['us'], now)` 同口径。 */
function exchangeToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `YYYY-MM-DD` ± 整数日历日（UTC 午夜锚点，与 server 的 `daysToExpiry` 同口径）。 */
function plusDays(dateOnly: string, days: number): string {
  return new Date(Date.parse(`${dateOnly}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
