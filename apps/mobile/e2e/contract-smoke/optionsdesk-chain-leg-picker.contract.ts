/**
 * 047 optionsdesk 意图 Tab 选约表 + 水位档手选 契约冒烟（Constitution §V 两层验证之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的**真 server**（testcontainers PG），验一读一写
 * 两个端点 `GET /optionsdesk/underlyings/{symbol}/legs` 与
 * `POST /optionsdesk/anchors/{id}/position-bucket` 的**契约对齐 + 真落库**。
 *
 * 补的是**另两层各自看不见的缝**：
 *   ① hermetic e2e（T035）把响应 mock 掉了 —— 它验的是「拿到这形状后 UI 怎么画」，且**蓄意不重算**
 *      `tabs` / `activityByTab`（成员判据属 server 单点 `leg-tab.rules.ts`）⇒ fixture 里那两列是手写的，
 *      server 改判据它照样绿。本片这两列全部由**真 server 算出**，断言即钉在那上面。
 *   ② `get-legs.usecase.spec.ts` **整个 Prisma 是 vi.fn() mock**（`optionContract.findMany` 直接返数组）
 *      ⇒ 三条 SQL 侧判据 —— `option_type='PUT'` / `is_standard` / **到期日 `>` 当日** —— 以及
 *      「先定位最近一期 sessionDate 再整批取」的两步查询与同期多来源 dedupe，**从未跑过一次真 SQL**。
 *      本片是它们唯一的真库覆盖（server 侧无 legs 的 `*.it.spec.ts`）。
 *
 * 🚨 本片七条「只有端到端 + 真库才验得到」的靶心：
 *   1. **`activityByTab` 是逐 Tab 各排一次名**（D-SOT-5）—— 同一条腿在 `all` 里**不进前三**、在
 *      `build` 里**进前三**。合成一次全链排名再复用在任何单侧断言里都看不出错。
 *   2. **`tabs` 随水位档整体改变**（正确行为，不是 bug）—— 设 `gte_two_thirds` 后 Δ 深度档从
 *      「三档并集」收到 `deep`，`|Δ|=0.35` 那条腿**掉出** `rent`，且其 `activityByTab.rent` 转 `null`。
 *   3. **两处量纲故意不同** —— 费率三列 `toFixed(6)` 是**小数比例**，`effectiveCostVsWPct`
 *      `toFixed(2)` 是**百分数**。统一成一个不会红，只会让人把 0.2 当成 0.2%。
 *   4. **三个时点互不相等** —— `asOf`(快照归属交易日) / `quoteAsOf`(采集时刻 ISO) /
 *      **`oiAsOf`(T−1 归属日)**，外加 T027a 的 `asOfFreshnessTier`：同一批数据只改 `session_date`
 *      一列即 `CURRENT → STALE`，而腿数据**一行不少**（陈旧 ≠ 减配）。
 *   5. **`greeksComplete=false` 的闸在 flag 不在 delta 列** —— 该腿库里**有** delta 值，响应仍须
 *      `absDelta/sigmaDistance/tier` 全 `null` 且只在 `all` 里。mock 数据永远看不到这个区别。
 *   6. **写端点无「清空」动作** —— body 只有 `positionBucket`，`null` / 非枚举 / 缺字段一律 400；
 *      重复设同一档也**推进** `positionBucketSetAt`（真时钟，注入时钟的单测证不了）。
 *   7. **响应键集封闭** —— `lastClosedSession` 在 `LegTableView` 里有、在 DTO 里**故意不下发**
 *      （它只是新鲜度档的中间量）。谁把它加进 `select` 这里立红。
 *
 * 边界与幂等：用**专属 ticker** `us:NVYL/P/N`（避开 045 的 `us:NVYX`、046 的 `us:NVYQ..T`、T035
 * hermetic 的 `us:PEP`/`us:AOS`），marketdata 三张事实表 + 交易日历无公开写端点 ⇒ 靠 `ctx.execSql`
 * 直插（schema=marketdata，列名 snake_case per `@map`），锚走公开写端点建 / 末尾 DELETE 自清理。
 *
 * 🚨 **日期一律在运行时相对「交易所的今天」算**：本片打的是真 server，`now` 就是请求时刻，无法像
 * 单测那样注入时钟 ⇒ 硬编码日期一周后就全线过期。`exchangeToday()` 与 server 的
 * `marketDateFor(['us'], now)` 同口径（`America/New_York`），故 `dteDays` 可逐条精确断言 ——
 * 这条断言本身即是「DTE 基准是交易所的今天而非宿主的今天」的证据（境内跑时两者常差一天）。
 */
import assert from 'node:assert/strict';
import {
  optionsdeskControllerCreate,
  optionsdeskControllerLegs,
  optionsdeskControllerPositionBucket,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { LegResponse, LegTableResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-chain-leg-picker (047)';

type Cfg = { baseURL: string; headers: Record<string, string> };

// ── 专属标的 ─────────────────────────────────────────────────────────────────────────────────
const MARKET = 'us';
/** 有锚 + 全链快照 ⇒ `available`（本片主战场）。 */
const CODE_CHAIN = 'NVYL';
/** 有锚但**未注册进 marketdata** ⇒ `chain_not_ready`，锚派生那半边照常返回。 */
const CODE_NO_CHAIN = 'NVYP';
/** 压根没建锚 ⇒ 404 `ANCHOR_NOT_FOUND_FOR_SYMBOL`。 */
const CODE_NO_ANCHOR = 'NVYN';

const CHAIN = `${MARKET}:${CODE_CHAIN}`;
const NO_CHAIN = `${MARKET}:${CODE_NO_CHAIN}`;
const NO_ANCHOR = `${MARKET}:${CODE_NO_ANCHOR}`;

// ── 锚：V=100、confidence 8.0（映射档 L2）⇒ W=80、四区间 60 / 80 / 100 / 120 ────────────────
const V = '100.0000';
const CONFIDENCE = '8.0';
const W = '80.0000';
/** spot 落 `[0.6V, W)` ⇒ 区间 `buy` —— **市场轴**（非锚轴），故 Tab 归属吃 Δ 深度档，水位一改即变。 */
const SPOT = '70.0000';

// ── 合约代码（行身份；断言排序时逐字比对）───────────────────────────────────────────────────
const RENT_DROP = 'US.NVYL.RENTDROP';
const RENT_STAY = 'US.NVYL.RENTSTAY';
const BUILD = 'US.NVYL.BUILD';
const NO_BID = 'US.NVYL.NOBID';
const NO_GREEKS = 'US.NVYL.NOGREEKS';
const EXPIRES_TODAY = 'US.NVYL.EXPTODAY';
const NON_STANDARD = 'US.NVYL.NONSTD';
const CALL_LEG = 'US.NVYL.CALL';

/** 统一档位键排序（FR-019）+ 同档内到期日升序的**期望全序**。 */
const EXPECTED_ORDER = [RENT_DROP, RENT_STAY, BUILD, NO_BID, NO_GREEKS];

/** 本批 eod 报价的采集时刻偏移（`RENT_STAY` 那条最新 ⇒ 区块级 quoteAsOf / source 取它）。 */
const QUOTE_TIME = 'T20:10:00.000Z';
const QUOTE_TIME_NEWEST = 'T20:15:00.000Z';

/** 末段把整批快照往回平移这么多天，逼出 `STALE` 档（见 `assertStaleTierKeepsEveryLeg`）。 */
const STALE_SHIFT_DAYS = 5;

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  // 整片共用一个「交易所的今天」—— 全部 fixture 日期与 DTE 期望都从它派生。
  const today = exchangeToday(new Date());

  await seed(ctx, today);

  const anchorIds: string[] = [];
  try {
    anchorIds.push(await createAnchor(cfg, CHAIN));
    anchorIds.push(await createAnchor(cfg, NO_CHAIN));

    const before = await readLegs(cfg, CHAIN);
    assertBlockShape(before, today);
    assertSqlSideFilters(before, today);
    assertLegDerivations(before, today);
    assertActivityIsPerTab(before);
    assertUnselectedBucket(before);

    await assertChainNotReady(cfg);
    await assertNoAnchorIs404(cfg);
    await assertBucketWriteRejectsNonEnum(cfg, anchorIds[0]);

    const setAt = await assertBucketWriteAndPersistence(cfg, anchorIds[0], before);
    await assertRepeatedPickAdvancesSetAt(cfg, anchorIds[0], setAt);
    await assertStaleTierKeepsEveryLeg(ctx, cfg, today);
  } finally {
    for (const id of anchorIds) {
      const del = await optionsdeskControllerRemove(id, cfg);
      assert.equal(del.status, 204, `cleanup delete anchor ${id} expected 204, got ${del.status}`);
    }
    await deleteSeed(ctx, today);
  }
}

// ── 种库（三张 marketdata 事实表 + 交易日历均无公开写端点 → execSql 直插）─────────────────────
async function seed(ctx: RealBackendCtx, today: string): Promise<void> {
  await deleteSeed(ctx, today); // 防上轮异常退出未走 cleanup
  const d = (offset: number): string => plusDays(today, offset);

  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status)
     VALUES ('${MARKET}', '${CODE_CHAIN}', '047 契约冒烟 选约表', 'stock', 'USD', 'listed')`,
  );
  const iid = `(SELECT id FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE_CHAIN}')`;

  // 🚨 交易日历必须**含未来日**：只种到 asOf 那天的话「最近一个已收盘交易日」恒等于 asOf，
  // 新鲜度档退化成恒 CURRENT 的平凡答案。种到 today+10 后，CURRENT/STALE 两侧才都可达 ——
  // 且它同时证明上界走的是 `≤ lastClosedSessionCutoff` 而不是「日历里最大的那天」。
  await ctx.execSql(
    `INSERT INTO marketdata.trading_day (market, date)
     SELECT '${MARKET}', g::date
     FROM generate_series(DATE '${d(-10)}', DATE '${d(10)}', INTERVAL '1 day') AS g
     ON CONFLICT DO NOTHING`,
  );

  // 合约集 —— 后三条是**读端 SQL 必须滤掉**的对照组（认购 / 非标 / 当日到期）。
  // 🚨 行权价一律取 spot(70) 下方的虚值认沽 ⇒ 内在价值恒 0，不触「内在价值 > ask」那类自洽硬门。
  await ctx.execSql(
    `INSERT INTO marketdata.option_contract
       (market, code, root, underlying_instrument_id, expiry_date, strike_price, option_type, is_standard)
     VALUES
       ('${MARKET}', '${RENT_DROP}', '${CODE_CHAIN}', ${iid}, DATE '${d(180)}', 65.0000, 'PUT', true),
       ('${MARKET}', '${RENT_STAY}', '${CODE_CHAIN}', ${iid}, DATE '${d(200)}', 60.0000, 'PUT', true),
       ('${MARKET}', '${BUILD}', '${CODE_CHAIN}', ${iid}, DATE '${d(10)}', 68.5000, 'PUT', true),
       ('${MARKET}', '${NO_BID}', '${CODE_CHAIN}', ${iid}, DATE '${d(160)}', 45.0000, 'PUT', true),
       ('${MARKET}', '${NO_GREEKS}', '${CODE_CHAIN}', ${iid}, DATE '${d(220)}', 55.0000, 'PUT', true),
       ('${MARKET}', '${EXPIRES_TODAY}', '${CODE_CHAIN}', ${iid}, DATE '${today}', 70.0000, 'PUT', true),
       ('${MARKET}', '${NON_STANDARD}', '${CODE_CHAIN}', ${iid}, DATE '${d(190)}', 62.0000, 'PUT', false),
       ('${MARKET}', '${CALL_LEG}', '${CODE_CHAIN}', ${iid}, DATE '${d(200)}', 75.0000, 'CALL', true)`,
  );
  const cid = (code: string): string =>
    `(SELECT id FROM marketdata.option_contract WHERE market = '${MARKET}' AND code = '${code}')`;

  // 最近一期快照（session = 交易所的今天）。
  // 🚨 `oi_as_of` 蓄意比 `session_date` 早一天（Guardrail 6：美股期权 OI 盘前更新 ⇒ 收盘后采的
  //    快照其 OI 归属 T−1）；`NOGREEKS` 那条**有 delta 值但 greeks_complete=false**（靶心 ⑤）。
  await ctx.execSql(
    `INSERT INTO marketdata.option_daily_snapshot
       (contract_id, session_date, source, quote_as_of, oi_as_of, bid, ask, delta,
        open_interest, volume, underlying_spot, greeks_complete)
     VALUES
       (${cid(RENT_DROP)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        6.0000, 6.5000, -0.35000000, 1200, 90, ${SPOT}, true),
       (${cid(RENT_STAY)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME_NEWEST}', DATE '${d(-1)}',
        5.0000, 5.4000, -0.10000000, 5000, 300, ${SPOT}, true),
       (${cid(BUILD)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        0.9000, 1.0500, -0.45000000, 50, 3, ${SPOT}, true),
       (${cid(NO_BID)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        NULL, 1.1000, -0.06000000, 100, 5, ${SPOT}, true),
       (${cid(NO_GREEKS)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        2.0000, 2.3000, -0.22000000, NULL, NULL, ${SPOT}, false),
       (${cid(EXPIRES_TODAY)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        1.0000, 1.2000, -0.50000000, 999999, 999999, ${SPOT}, true),
       (${cid(NON_STANDARD)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        4.0000, 4.3000, -0.20000000, 700, 40, ${SPOT}, true),
       (${cid(CALL_LEG)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        3.0000, 3.2000, 0.30000000, 600, 30, ${SPOT}, true)`,
  );

  // 同一合约同一交易日的**第二个来源**（幂等键第三段是来源，FR-040）⇒ 读端须按 quote_as_of 取新的
  // 那条：这里 premarket_backfill 的 bid 是 4.0000，若 dedupe 反了断言立红。
  await ctx.execSql(
    `INSERT INTO marketdata.option_daily_snapshot
       (contract_id, session_date, source, quote_as_of, oi_as_of, bid, ask, delta,
        open_interest, volume, underlying_spot, greeks_complete)
     VALUES (${cid(RENT_STAY)}, DATE '${today}', 'premarket_backfill',
             TIMESTAMPTZ '${today}T09:30:00.000Z', DATE '${d(-1)}',
             4.0000, 4.4000, -0.11000000, 4900, 10, ${SPOT}, true)`,
  );

  // 更早一期（session = today−3）—— 读端先定位**最近一期**再整批取，故这条永不该露面（bid 99）。
  await ctx.execSql(
    `INSERT INTO marketdata.option_daily_snapshot
       (contract_id, session_date, source, quote_as_of, oi_as_of, bid, ask, delta,
        open_interest, volume, underlying_spot, greeks_complete)
     VALUES (${cid(RENT_DROP)}, DATE '${d(-3)}', 'eod', TIMESTAMPTZ '${d(-3)}${QUOTE_TIME}', DATE '${d(-4)}',
             99.0000, 99.5000, -0.99000000, 1, 1, ${SPOT}, true)`,
  );

  // 财报日 today+5 —— 落在 rent_short 腿（DTE 10）的窗口内 ⇒ `crosses_earnings`；
  // rent_long 腿缓冲充足 ⇒ `covered`；超 vendor 前向视野（182 天）的远月腿 ⇒ `no_date`。
  await ctx.execSql(
    `INSERT INTO marketdata.earnings_event (instrument_id, earnings_date, pub_type)
     VALUES (${iid}, DATE '${plusDays(today, 5)}', 'AFTER')`,
  );
}

async function deleteSeed(ctx: RealBackendCtx, today: string): Promise<void> {
  // instrument 删除 CASCADE 带走 option_contract → option_daily_snapshot 与 earnings_event。
  await ctx.execSql(
    `DELETE FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE_CHAIN}'`,
  );
  // 交易日历是全市场共享表 ⇒ 只删本片种的那一段（其余 spec 不种它，容器内本就是空表）。
  await ctx.execSql(
    `DELETE FROM marketdata.trading_day
     WHERE market = '${MARKET}' AND date BETWEEN DATE '${plusDays(today, -10)}' AND DATE '${plusDays(today, 10)}'`,
  );
}

async function createAnchor(cfg: Cfg, ticker: string): Promise<string> {
  const created = await optionsdeskControllerCreate(
    {
      ticker,
      v: V,
      asof: plusDays(exchangeToday(new Date()), -30),
      method: 'DCF · 047 契约冒烟',
      confidence: CONFIDENCE,
      nextReview: plusDays(exchangeToday(new Date()), 120),
    },
    cfg,
  );
  assert.equal(created.status, 201, `create ${ticker} expected 201, got ${created.status}`);
  return created.data.id;
}

async function readLegs(cfg: Cfg, symbol: string): Promise<LegTableResponse> {
  const res = await optionsdeskControllerLegs(symbol, cfg);
  assert.equal(res.status, 200, `legs(${symbol}) expected 200, got ${res.status}`);
  return res.data;
}

// ── 区块级：三个时点 + 新鲜度档 + 键集封闭 ───────────────────────────────────────────────────
function assertBlockShape(table: LegTableResponse, today: string): void {
  assert.equal(table.symbol, CHAIN, 'legs: symbol 原样回显 canonical');
  assert.equal(table.state, 'available', 'legs: 拿到最近一期全链 ⇒ available');

  // 🎯 靶心 ④：三个时点是三件事，且 oiAsOf **不是** asOf 那天。
  assert.equal(table.asOf, today, 'legs.asOf = 快照归属交易日（YYYY-MM-DD）');
  assert.equal(
    table.quoteAsOf,
    `${today}${QUOTE_TIME_NEWEST}`,
    'legs.quoteAsOf = 本批最新一条报价的采集时刻（ISO-8601，非日期）',
  );
  assert.equal(table.oiAsOf, plusDays(today, -1), 'legs.oiAsOf 归属 T−1（Guardrail 6）');
  assert.notEqual(table.oiAsOf, table.asOf, 'legs: OI 归属日与区块 asOf MUST NOT 折成同一天');
  assert.equal(
    table.asOfFreshnessTier,
    'CURRENT',
    'legs.asOfFreshnessTier: asOf 不落后于最近一个已收盘交易日 ⇒ CURRENT（判据在 server，要查日历）',
  );

  // 来源取的是**最新那条**的 source（同期两来源共存时不得回落到先插入的那条）。
  assert.equal(table.source, 'eod', 'legs.source = 最新一条报价的来源');
  assert.equal(table.spot, SPOT, 'legs.spot = vendor 随链下发的标的价（未复权，Decimal string）');

  // 锚派生四项复用 045，本端点不重算。
  assert.equal(table.w, W, 'legs.w = 0.8V（045 派生）');
  assert.equal(table.zone, 'buy', 'legs.zone: spot=70 落 [0.6V, W) ⇒ buy（市场轴）');
  assert.equal(table.lLevel, 'L2', 'legs.lLevel: confidence 8.0 → L2');

  // 🎯 靶心 ⑦：键集封闭 —— `lastClosedSession` 是新鲜度档的中间量，**MUST NOT 下发**。
  assert.deepEqual(
    Object.keys(table).sort(),
    [
      'asOf',
      'asOfFreshnessTier',
      'intent',
      'lLevel',
      'legs',
      'oiAsOf',
      'positionBucket',
      'positionBucketSetAt',
      'positionBucketSource',
      'quoteAsOf',
      'rentDepth',
      'source',
      'spot',
      'state',
      'symbol',
      'w',
      'zone',
    ],
    'legs: 响应键集封闭 —— 无 lastClosedSession 泄漏',
  );
}

// ── SQL 侧三条判据 + 两步取数（真库唯一覆盖点）─────────────────────────────────────────────
function assertSqlSideFilters(table: LegTableResponse, today: string): void {
  const codes = table.legs.map((leg) => leg.code);
  assert.deepEqual(
    codes,
    EXPECTED_ORDER,
    'legs: 全量适格腿 + 统一档位键排序（死档沉底 / 未判档居后）',
  );

  for (const excluded of [CALL_LEG, NON_STANDARD, EXPIRES_TODAY]) {
    assert.ok(!codes.includes(excluded), `legs: ${excluded} MUST NOT 进选约表`);
  }
  // 「到期日 **>** 当日」是 Guardrail 7 那条与完整性分母（`≥`）故意不同的边界 —— 只有当日到期的
  // 合约存在时才看得出来，且只有真 SQL 跑得到。
  assert.equal(
    table.legs.find((leg) => leg.expiryDate === today),
    undefined,
    'legs: 当日到期的腿已不可交易 ⇒ 严格 > 当日（与完整性分母的 ≥ 故意不同）',
  );

  // 两步取数：最近一期（today）而非更早那期（today−3，bid 99）。
  const rentDrop = legOf(table, RENT_DROP);
  assert.equal(rentDrop.bid, '6.0000', 'legs: 取最近一期快照，更早那期 MUST NOT 露面');
  // 同期多来源 dedupe：按 quote_as_of 取新的那条（premarket_backfill 的 4.0000 不得胜出）。
  assert.equal(legOf(table, RENT_STAY).bid, '5.0000', 'legs: 同期两来源按 quoteAsOf 取新的那条');
}

// ── 逐腿派生：量纲 / nullable 真值 / greeks 闸 / 财报域 ───────────────────────────────────────
function assertLegDerivations(table: LegTableResponse, today: string): void {
  for (const leg of table.legs) {
    assertNullableStringShape(leg);
    // Guardrail 10：`|Δ|` 与 σ 距同源 —— 要么同时有值要么同时为空。
    assert.equal(
      leg.absDelta === null,
      leg.sigmaDistance === null,
      `legs[${leg.code}]: absDelta 与 sigmaDistance MUST 同生共死`,
    );
  }

  // ① DTE 基准 = **交易所的今天**（境内跑时宿主日期常比它早一天 ⇒ 拿宿主日期算会整列差 1）。
  assert.equal(legOf(table, RENT_DROP).dteDays, 180);
  assert.equal(legOf(table, RENT_STAY).dteDays, 200);
  assert.equal(legOf(table, BUILD).dteDays, 10);
  assert.equal(legOf(table, NO_BID).dteDays, 160);
  assert.equal(legOf(table, NO_GREEKS).dteDays, 220);

  // ② 腿族口径按形态判（DTE ≤ 14 ∧ |Δ| ∈ [0.40,0.55] ⇒ 周化），其余年化。
  assert.equal(legOf(table, BUILD).basis, 'weekly', 'legs: 建仓形态的腿按周化口径');
  assert.equal(legOf(table, RENT_DROP).basis, 'annualized');

  // ③ 档位按 bid 口径 + 本行口径判；薄档**带出** ask 口径费率，其余档恒 null。
  assert.equal(legOf(table, RENT_DROP).tier, 'good');
  assert.equal(legOf(table, RENT_STAY).tier, 'good');
  assert.equal(legOf(table, BUILD).tier, 'thin', 'legs: 周化 0.93% 落 [0.6%,1%) ⇒ 薄档');
  assert.ok(legOf(table, BUILD).askRate !== null, 'legs: 薄档 MUST 带出 ask 口径费率');
  assert.equal(legOf(table, RENT_DROP).askRate, null, 'legs: 非薄档 askRate 恒 null');

  // ④ 🎯 靶心 ③ —— 两处量纲故意不同，同一行上对照着验。
  const rentDrop = legOf(table, RENT_DROP);
  assertRatioScale(rentDrop.periodRate, 6 / 59, `legs[${RENT_DROP}].periodRate`);
  assertRatioScale(rentDrop.weeklyRate, ((6 / 59) * 7) / 180, `legs[${RENT_DROP}].weeklyRate`);
  assertRatioScale(
    rentDrop.annualizedRate,
    ((6 / 59) * 365) / 180,
    `legs[${RENT_DROP}].annualizedRate`,
  );
  assert.equal(
    rentDrop.effectiveCost,
    '59.0000',
    'legs.effectiveCost = K − P（Decimal(4) string）',
  );
  assert.equal(
    rentDrop.effectiveCostVsWPct,
    '-26.25',
    'legs.effectiveCostVsWPct 是**百分数**且 toFixed(2)（费率那三列是小数比例 —— 两者别统一）',
  );
  assert.equal(rentDrop.turnover, '54000.00', 'legs.turnover = Vol × 权利金 × 100');
  assert.equal(rentDrop.absDelta, 0.35, 'legs.absDelta: vendor 存负 Δ，响应给**绝对值**');
  assert.ok(
    rentDrop.sigmaDistance !== null && rentDrop.sigmaDistance > 0,
    'legs.sigmaDistance = −Φ⁻¹(|Δ|)，|Δ| < 0.5 ⇒ 正数',
  );

  // ⑤ 🎯 靶心 ⑤ —— 库里**有** delta 值，但 greeks_complete=false ⇒ 不判档不着色，且只进 all。
  const noGreeks = legOf(table, NO_GREEKS);
  assert.equal(noGreeks.greeksComplete, false);
  assert.equal(
    noGreeks.absDelta,
    null,
    'legs: greeks 不全 ⇒ Δ 列留空（闸在 flag，不在 delta 列有没有值）',
  );
  assert.equal(noGreeks.sigmaDistance, null);
  assert.equal(noGreeks.tier, null, 'legs: greeks 不全恒不判档（费率算得出来但会骗人）');
  assert.deepEqual(
    noGreeks.tabs,
    ['all'],
    'legs: 无 Δ 的腿两个意图 Tab 都进不去，但**照常在表内**',
  );
  assert.ok(noGreeks.periodRate !== null, 'legs: 不判档 ≠ 不算费率 —— 费率三列照常给');

  // ⑥ 无 bid ⇒ 费率 / 有效成本 / 成交额一律 null，**禁拿 K−0 冒充**。
  const noBid = legOf(table, NO_BID);
  assert.equal(noBid.bid, null);
  assert.equal(noBid.periodRate, null);
  assert.equal(noBid.weeklyRate, null);
  assert.equal(noBid.annualizedRate, null);
  assert.equal(noBid.tier, null, 'legs: 没有判定值就没有档');
  assert.equal(noBid.effectiveCost, null, 'legs: 无 bid ⇒ 有效成本无定义（MUST NOT 用 K−0）');
  assert.equal(noBid.effectiveCostVsWPct, null);
  assert.equal(noBid.turnover, null, 'legs: 0 成交与「不知道成交多少」是两件事');
  assert.ok(noBid.absDelta !== null, 'legs: 无 bid 不连累 greeks 列（两条链互不依赖）');

  // ⑦ 财报标按**意图分域**打；同一到期日的腿共用同一个判定。
  assert.deepEqual(
    legOf(table, RENT_DROP).earningsMark,
    { mark: 'covered', bufferShortfallDays: null, lastEarningsDate: plusDays(today, 5) },
    'legs: 收租长腿缓冲充足 ⇒ covered',
  );
  assert.deepEqual(
    legOf(table, BUILD).earningsMark,
    { mark: 'crosses_earnings', bufferShortfallDays: null, lastEarningsDate: plusDays(today, 5) },
    'legs: 收租短腿只看跨不跨，不进缓冲算式',
  );
  assert.equal(
    legOf(table, RENT_STAY).earningsMark?.mark,
    'no_date',
    'legs: 超 vendor 前向视野的远月腿 ⇒ no_date（MUST NOT 渲成「已确认不跨」）',
  );
}

// ── 🎯 靶心 ① 活跃度逐 Tab 各排一次名（hermetic fixture 里这两列是手写的，验不到）──────────────
function assertActivityIsPerTab(table: LegTableResponse): void {
  const build = legOf(table, BUILD);
  assert.deepEqual(build.tabs, ['all', 'build'], 'legs: DTE 10 + |Δ| 0.45 ⇒ 全腿 + 建仓两个 Tab');
  assert.equal(
    build.activityByTab.all?.isTopRanked,
    false,
    'legs: 该腿在**全腿**候选集里 OI/Vol 排名之和第 4 ⇒ 不进前三',
  );
  assert.equal(
    build.activityByTab.build?.isTopRanked,
    true,
    '🎯 同一条腿在**建仓**候选集里进前三 —— 排名是候选集内的相对量，合成一次全链排名即在此立红',
  );
  assert.equal(build.activityByTab.rent, null, 'legs: 不属于某 Tab ⇒ 该 Tab 的活跃度标恒 null');
  assert.equal(build.activityByTab.all?.isRoundStrike, false, 'legs: 68.5 非整数档');

  const rentStay = legOf(table, RENT_STAY);
  assert.equal(rentStay.activityByTab.all?.isRoundStrike, true, 'legs: 60 是整数档');
  assert.equal(rentStay.activityByTab.all?.label, 'round_strike', 'legs: 标签整数档优先');
  assert.ok(rentStay.activityByTab.rent !== null, 'legs: 收租 Tab 成员带该 Tab 的活跃度标');
}

// ── 未选态是常驻分支：意图「待定」，三个 Tab 照常可取数 ───────────────────────────────────────
function assertUnselectedBucket(table: LegTableResponse): void {
  assert.equal(table.positionBucket, null, 'legs: 新建锚天然未选水位档（**无默认值**）');
  assert.equal(table.positionBucketSource, null, 'legs: 档位与来源标严格成对，同时为 null');
  assert.equal(table.positionBucketSetAt, null);
  assert.equal(table.intent, 'pending', 'legs: 水位未选 ⇒ 待定（MUST NOT 静默取一档）');
  assert.equal(table.rentDepth, null);
  // 待定 ⇒ Δ 深度取三档并集 ⇒ |Δ|=0.35 那条**在**收租 Tab 里。
  assert.deepEqual(legOf(table, RENT_DROP).tabs, ['all', 'rent']);
}

// ── 未注册进 marketdata ⇒ chain_not_ready，锚派生那半边照常返回 ───────────────────────────────
async function assertChainNotReady(cfg: Cfg): Promise<void> {
  const table = await readLegs(cfg, NO_CHAIN);
  assert.equal(
    table.state,
    'chain_not_ready',
    '跨 ctx 无链数据是**事实**，不是故障（read_failed 另算）',
  );
  assert.deepEqual(table.legs, []);
  assert.equal(table.asOf, null);
  assert.equal(
    table.asOfFreshnessTier,
    'UNAVAILABLE',
    '无 asOf ⇒ UNAVAILABLE（不编造日期，也不回落成 CURRENT）',
  );
  assert.equal(table.quoteAsOf, null);
  assert.equal(table.oiAsOf, null);
  assert.equal(table.spot, null);
  assert.equal(table.zone, null, '无 spot ⇒ 无区间');
  assert.equal(table.intent, 'pending', '无区间 ⇒ 无意图（MUST NOT 猜一个档）');
  // 锚派生照常出 —— 「链没数据」不该让整屏塌掉。
  assert.equal(table.w, W);
  assert.equal(table.lLevel, 'L2');
}

async function assertNoAnchorIs404(cfg: Cfg): Promise<void> {
  await assert.rejects(
    () => optionsdeskControllerLegs(NO_ANCHOR, cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number; data?: { code?: string } } };
      assert.equal(
        e.response?.status,
        404,
        '无锚 symbol → 404（回 200 空壳会让两种「空」不可区分）',
      );
      assert.equal(
        e.response?.data?.code,
        'ANCHOR_NOT_FOUND_FOR_SYMBOL',
        '404 body 带机器可读 code',
      );
      return true;
    },
  );
}

// ── 🎯 靶心 ⑥ 写端点：三值必填、不收 null、无「清空」动作 ────────────────────────────────────
async function assertBucketWriteRejectsNonEnum(cfg: Cfg, anchorId: string): Promise<void> {
  for (const [label, body] of [
    ['null（「清空」不是可达动作 —— 未选是初始态）', { positionBucket: null }],
    ['缺字段（服务端不自造默认档）', {}],
    ['非枚举值', { positionBucket: 'half' }],
  ] as const) {
    await assert.rejects(
      () =>
        optionsdeskControllerPositionBucket(
          anchorId,
          body as unknown as { positionBucket: 'lt_one_third' },
          cfg,
        ),
      (err: unknown) => {
        const e = err as { response?: { status?: number } };
        assert.equal(e.response?.status, 400, `position-bucket 拒 ${label} ⇒ 400`);
        return true;
      },
    );
  }
}

/** 设档 → 复取，验真落库 + 意图链与 Tab 归属整体改变。返回写端点回的手选时刻。 */
async function assertBucketWriteAndPersistence(
  cfg: Cfg,
  anchorId: string,
  before: LegTableResponse,
): Promise<string> {
  const res = await optionsdeskControllerPositionBucket(
    anchorId,
    { positionBucket: 'gte_two_thirds' },
    cfg,
  );
  assert.equal(res.status, 200, `position-bucket expected 200, got ${res.status}`);
  assert.equal(res.data.anchorId, anchorId);
  assert.equal(res.data.ticker, CHAIN, '写端回 ticker —— 客户端据此让选约表那一屏失效重取');
  assert.equal(res.data.positionBucket, 'gte_two_thirds');
  assert.equal(
    res.data.positionBucketSource,
    'manual',
    '「这是人填的」写在契约层，不靠前端记得（M3 真实水位接入后靠它分辨）',
  );
  const setAt = res.data.positionBucketSetAt;
  assert.ok(typeof setAt === 'string' && !Number.isNaN(Date.parse(setAt)), '写端回 ISO 手选时刻');

  const after = await readLegs(cfg, CHAIN);

  // ① 三项档位字段**同步**变，且读端回的时刻与写端**逐字节相同**（两侧共用同一个投影函数）。
  assert.equal(after.positionBucket, 'gte_two_thirds', '真落库：复取拿到手选档');
  assert.equal(after.positionBucketSource, 'manual');
  assert.equal(after.positionBucketSetAt, setAt, '读端与写端的手选时刻逐字节相同');

  // ② 🎯 靶心 ②：意图链与**每腿 tabs** 整体改变 —— 这是正确行为。
  assert.equal(after.intent, 'rent', '水位选定 ⇒ 意图从「待定」落到收租');
  assert.equal(after.rentDepth, 'deep', '买区 + L2 + ≥2/3 ⇒ Δ 深度档收到最深一档');
  assert.deepEqual(
    legOf(after, RENT_DROP).tabs,
    ['all'],
    '🎯 |Δ|=0.35 落在三档并集内、却落在 deep 带外 ⇒ 掉出收租 Tab（水位一改 Tab 归属整体变）',
  );
  assert.equal(
    legOf(after, RENT_DROP).activityByTab.rent,
    null,
    '掉出 Tab 后该 Tab 的活跃度标随之转 null（排名是候选集内的相对量）',
  );
  assert.deepEqual(legOf(after, RENT_STAY).tabs, ['all', 'rent'], '|Δ|=0.10 仍在 deep 带内');
  assert.deepEqual(legOf(after, BUILD).tabs, ['all', 'build'], '建仓 Tab 判形态不判水位，零变化');

  // ③ 零拦截语义：Tab 归属只影响某一屏出不出现，**腿一条都没少**，排序与财报标亦不受牵动。
  assert.deepEqual(
    after.legs.map((leg) => leg.code),
    before.legs.map((leg) => leg.code),
    '水位改的是 Tab 归属，MUST NOT 筛掉任何腿（FR-005 全量呈现）',
  );
  assert.deepEqual(
    after.legs.map((leg) => leg.earningsMark?.mark ?? null),
    before.legs.map((leg) => leg.earningsMark?.mark ?? null),
    '财报标按意图**域**打，收租两态之间切换不改域 ⇒ 整列不动',
  );

  return setAt;
}

/** 重复选同一档 ⇒ 时刻**前进**（它记的是「人最后一次确认水位」，不是「值最后一次变化」）。 */
async function assertRepeatedPickAdvancesSetAt(
  cfg: Cfg,
  anchorId: string,
  previousSetAt: string,
): Promise<void> {
  const res = await optionsdeskControllerPositionBucket(
    anchorId,
    { positionBucket: 'gte_two_thirds' },
    cfg,
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.positionBucket, 'gte_two_thirds', '值没变');
  const setAt = res.data.positionBucketSetAt;
  assert.ok(setAt !== null);
  assert.ok(
    Date.parse(setAt) > Date.parse(previousSetAt),
    '重复设同一档 MUST 推进手选时刻 —— 时刻不前进等于把 M3 要用的新鲜度判据变成谎话',
  );
  const table = await readLegs(cfg, CHAIN);
  assert.equal(table.positionBucketSetAt, setAt, '推进后的时刻真落库');
}

// ── 🎯 靶心 ④ 下半：只改 session_date 一列 ⇒ CURRENT → STALE，而腿数据一行不少 ────────────────
async function assertStaleTierKeepsEveryLeg(
  ctx: RealBackendCtx,
  cfg: Cfg,
  today: string,
): Promise<void> {
  const staleSession = plusDays(today, -STALE_SHIFT_DAYS);
  // 🚨 蓄意**只**改 `session_date` 一列（quote_as_of / oi_as_of 原样不动）—— 新鲜度档的判据只吃
  // 区块级 asOf，单列变更让「档位翻转」可归因；顺带证明三个时点确实互相独立。
  // 🚨 **整体平移而非赋绝对值**：幂等键是 `(contract_id, session_date, source)`，赋绝对值会把
  // 「更早一期」那条与本期同来源的行撞成同一个键（真库实撞，唯一约束直接拒整条 UPDATE）。
  await ctx.execSql(
    `UPDATE marketdata.option_daily_snapshot SET session_date = session_date - ${STALE_SHIFT_DAYS}
     WHERE contract_id IN (
       SELECT c.id FROM marketdata.option_contract c
       JOIN marketdata.instrument i ON i.id = c.underlying_instrument_id
       WHERE i.market = '${MARKET}' AND i.code = '${CODE_CHAIN}'
     )`,
  );

  const table = await readLegs(cfg, CHAIN);
  assert.equal(table.asOf, staleSession, 'legs.asOf 跟着快照归属日走');
  assert.equal(
    table.asOfFreshnessTier,
    'STALE',
    'asOf 停在更早的交易日 ⇒ STALE（判据查交易日历，客户端拿设备本地日期比对美股会恒判陈旧）',
  );
  assert.equal(table.state, 'available', 'legs: 陈旧 ≠ 不可用，区块状态照常 available');
  assert.deepEqual(
    table.legs.map((leg) => leg.code),
    EXPECTED_ORDER,
    'legs: 陈旧 ≠ 减配 —— 全表照常渲染，一行不少',
  );
  assert.notEqual(table.quoteAsOf, null, 'legs: 只动 asOf 一列，报价采集时刻不受牵动');
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

function legOf(table: LegTableResponse, code: string): LegResponse {
  const leg = table.legs.find((row) => row.code === code);
  assert.ok(leg !== undefined, `legs: 期望包含合约 ${code}`);
  return leg;
}

/**
 * 生成的类型把 nullable 金额列声明成 `string | null`（而非 orval 误生的 objectmap）——
 * T030 验的是生成物，这里验**运行时真值**：任何一列变成 `{}` 立红。
 */
function assertNullableStringShape(leg: LegResponse): void {
  const nullableStrings: readonly (keyof LegResponse)[] = [
    'bid',
    'ask',
    'periodRate',
    'weeklyRate',
    'annualizedRate',
    'askRate',
    'effectiveCost',
    'effectiveCostVsWPct',
    'turnover',
  ];
  for (const key of nullableStrings) {
    const value = leg[key];
    assert.ok(
      value === null || typeof value === 'string',
      `legs[${leg.code}].${String(key)} 必须是 string | null，实得 ${typeof value}`,
    );
  }
}

/**
 * 费率列的**量纲断言**：`toFixed(6)` 的小数比例（不是百分数）。
 * 逐位比对期望字符串会把断言绑死在 Decimal.js 的末位舍入上，故拆成「标度」+「数值」两条。
 */
function assertRatioScale(actual: string | null, expected: number, label: string): void {
  assert.ok(actual !== null, `${label} 期望有值`);
  assert.match(actual, /^-?\d+\.\d{6}$/, `${label}: MUST 为 toFixed(6) 的 Decimal string`);
  assert.ok(
    Math.abs(Number(actual) - expected) < 5e-7,
    `${label}: 期望小数比例 ≈ ${expected}，实得 ${actual}（若差 100 倍 = 有人把量纲统一成百分数了）`,
  );
}

/**
 * 「交易所的今天」—— 与 server 的 `marketDateFor(['us'], now)` 同口径（`America/New_York`）。
 * 🚫 MUST NOT 换成宿主本地日期：境内跑时两者常差一天，整片 DTE 与到期日期望会集体偏移。
 */
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
