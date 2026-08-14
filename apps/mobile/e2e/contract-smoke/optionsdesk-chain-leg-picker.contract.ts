/**
 * 047 optionsdesk 意图 Tab 选约表 + 水位档手选 契约冒烟（Constitution §V 两层验证之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的**真 server**（testcontainers PG），验一读一写
 * 两个端点 `GET /optionsdesk/underlyings/{symbol}/legs` 与
 * `POST /optionsdesk/anchors/{id}/position-bucket` 的**契约对齐 + 真落库**。
 *
 * 补的是**另两层各自看不见的缝**：
 *   ① hermetic e2e（T035）把响应 mock 掉了 —— 它验的是「拿到这形状后 UI 怎么画」，且**蓄意不重算**
 *      成员归属与活跃度标（判据属 server 单点 `leg-tab.rules.ts`）⇒ fixture 里那两样是手写的，
 *      server 改判据它照样绿。本片这两样全部由**真 server 算出**，断言即钉在那上面。
 *   ② `get-legs.usecase.spec.ts` **整个 Prisma 是 vi.fn() mock**（`optionContract.findMany` 直接返数组）
 *      ⇒ 三条 SQL 侧判据 —— `option_type='PUT'` / `is_standard` / **到期日 `>` 当日** —— 以及
 *      「先定位最近一期 sessionDate 再整批取」的两步查询与同期多来源 dedupe，**从未跑过一次真 SQL**。
 *      本片是它们唯一的真库覆盖（server 侧无 legs 的 `*.it.spec.ts`）。
 *
 * 🚨 本片七条「只有端到端 + 真库才验得到」的靶心：
 *   1. **活跃度标是逐视角各排一次名**（D-SOT-5）—— 同一条腿在全腿那份响应里**不进前三**、在
 *      建仓那份里**进前三**。合成一次全链排名再复用在任何单侧断言里都看不出错。
 *   2. **成员归属随水位档整体改变**（047 语义；已随 050 反转，见下）—— 设 `gte_two_thirds` 后
 *      Δ 深度档从「三档并集」收到 `deep`，`|Δ|=0.35` 那条腿**掉出**收租视角。
 *   3. **两处量纲故意不同** —— 费率三列 `toFixed(6)` 是**小数比例**，`effectiveCostVsWPct`
 *      `toFixed(2)` 是**百分数**。统一成一个不会红，只会让人把 0.2 当成 0.2%。
 *   4. **三个时点互不相等** —— `asOf`(快照归属交易日) / `quoteAsOf`(采集时刻 ISO) /
 *      **`oiAsOf`(T−1 归属日)**，外加 T027a 的 `asOfFreshnessTier`：同一批数据只改 `session_date`
 *      一列即 `CURRENT → STALE`，而腿数据**一行不少**（陈旧 ≠ 减配）。
 *   5. **`greeksComplete=false` 的闸在 flag 不在 delta 列** —— 该腿库里**有** delta 值，响应仍须
 *      `absDelta/sigmaDistance/tier` 全 `null`。mock 数据永远看不到这个区别。
 *   6. **写端点无「清空」动作** —— body 只有 `positionBucket`，`null` / 非枚举 / 缺字段一律 400；
 *      重复设同一档也**推进** `positionBucketSetAt`（真时钟，注入时钟的单测证不了）。
 *   7. **响应键集封闭** —— `lastClosedSession` 在 `LegTableView` 里有、在 DTO 里**故意不下发**
 *      （它只是新鲜度档的中间量）。谁把它加进 `select` 这里立红。
 *
 * 🚨 **051 T012 扩容**：050 的六个字段 + 051 的 per-view 计数（共七个）此前只被 server IT
 *    （不经生成客户端）与手写 hermetic mock（不经真 server）验过 —— 「生成客户端 + 真 server」
 *    这条缝从未合过。落点 = {@link assertLegEngineContract}。
 * 🚨 **本文件的 047 语义已有三处随 050 反转**，各自就地写明「为什么该红」，🚫 MUST NOT 当成
 *    弱化断言：① 无 bid 的腿被权利金门槛整条移出响应（那条路径在本端点已不可达）；② 无 Δ 的腿
 *    照常按期限段进意图视角（Δ 退出召回判据）；③ 水位**不再**改变任何一腿的视角归属 —— 靶心 ②
 *    由「整体改变」反转为「一条都不变」，守的是更强的性质。
 *
 * 🚨 **053 T014：契约按视角收窄，本片改成「三次请求各取一份再对照」**（`FR-005`）。
 *    `perspective` **必填且决定返回哪个视角**（`FR-001`）；每腿 `tabs` / `tierByTab` /
 *    `activityByTab`、顶层 `tabOrder` / `basisByTab` / `criteriaByTab` / 分视角排除数**全部退出契约**。
 *    受影响的既有断言逐条**在原地**写明是「搬家」还是「结构性消失」（见 {@link assertLegEngineContract}
 *    的头注、{@link assertActivityIsPerPerspective}、{@link assertCriteriaOverrideRoundTrip}）——
 *    🚫 MUST NOT 机械套形状把判别力改没：改成一条恒真断言比删掉它更坏，它会冒充覆盖。
 *    📌 五个新字段（`displayLimit` / `matchedCount` / `memberCount` / `candidateCapDropped` /
 *       单笔权利金 · 相对价差）的**值往返归 T011** —— 本次只把既有镜像搬到新形状上，
 *       新字段止于 {@link assertBlockShape} 的键集断言。
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
import type {
  LegResponse,
  LegTableResponse,
  OptionsdeskControllerLegsParams,
  PerspectiveCriteriaResponse,
  RetrievalCriteriaResponse,
} from '@nvy/api-client';

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
/** 🚨 **050 起它整条不在响应里**：无 bid ⇒ 权利金门槛判 false ⇒ 移出响应并计入计数（见下）。 */
const NO_BID = 'US.NVYL.NOBID';
const NO_GREEKS = 'US.NVYL.NOGREEKS';
/**
 * 051 T012 新增 —— **落在 `[30,49]` 重叠区且被流动性门槛挡下**的腿。
 *
 * 它是本片计数不等式的唯一判别源：DTE 40 同时落建仓段 `[1,49]` 与收租段 `[30,365]`，报价宽
 * （`rel = 0.7/0.85 = 0.82 > 0.35`）⇒ 两个意图视角各少它一条、全表标量只记它一次
 * ⇒ `标量(1) < build(1) + rent(1)`。**取等号会在这条腿上红错方向**（051 SC-012）。
 * 📌 它**仍在响应里**（bid 0.50 过得了权利金门槛）—— 与 {@link NO_BID} 那条「真消失」正是
 *    两个计数语义不对称的实证：一条只是进不了意图视角，另一条整条没了。
 */
const LIQ_BLOCKED = 'US.NVYL.LIQBLOCK';
const EXPIRES_TODAY = 'US.NVYL.EXPTODAY';
const NON_STANDARD = 'US.NVYL.NONSTD';
const CALL_LEG = 'US.NVYL.CALL';

/**
 * 统一档位键排序（FR-019）+ 同档内到期日升序的**期望全序**。
 * 📌 `NO_BID` 已不在其中（050 权利金门槛把它整条移出响应）；`LIQ_BLOCKED` 判薄档、到期日
 *    晚于 `BUILD` ⇒ 落其后。
 */
const EXPECTED_ORDER = [RENT_DROP, RENT_STAY, BUILD, LIQ_BLOCKED, NO_GREEKS];

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

    // 🚨 **053 FR-005：一次请求只作答一个视角** —— 047/050/051 那批「同一份响应里三格互相
    //    对照」的断言随之改成**三次请求各取一份再对照**。守的性质一条没少（同一条腿在两个
    //    视角判不同档、口径映射、分视角排除数…），只是判据从「一份响应的三格」搬到了
    //    「三份响应的同一格」。
    const views = await readAllPerspectives(cfg, CHAIN);
    const before = views.all;

    assertBlockShape(before, today);
    assertSqlSideFilters(before, today);
    assertLegDerivations(views, today);
    assertLegEngineContract(views);
    assertRetrievalCriteriaShape(views);
    assertActivityIsPerPerspective(views);
    assertUnselectedBucket(views);

    await assertChainNotReady(cfg);
    await assertNoAnchorIs404(cfg);
    await assertBucketWriteRejectsNonEnum(cfg, anchorIds[0]);
    // 🚨 排在水位写入**之前** —— 水位改变会重算意图链，把它挪到之后就得先想清楚
    //    「这批断言里的成员集合是哪个意图下的」，那是白白多出来的一层耦合。
    await assertCriteriaOverrideRoundTrip(cfg, views);

    const setAt = await assertBucketWriteAndPersistence(cfg, anchorIds[0], views);
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
       ('${MARKET}', '${LIQ_BLOCKED}', '${CODE_CHAIN}', ${iid}, DATE '${d(40)}', 60.0000, 'PUT', true),
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
       -- 🚨 052 T014 订正：OI / 成交量不能再留 NULL。这条腿的用途是靶心 ⑤（greeks flag），
       --    与流动性无关；而 052 的活性条件（OI 过下限 或 当日成交过下限，缺失一侧按「没观测到
       --    活动」取 0）会把它整条挡在候选之外 —— 一条 fixture 腿同时承载两个互不相干的性质，
       --    另一个性质的判据一变就把这个靶心顺带带走了。给它真实的量即解耦。
       (${cid(NO_GREEKS)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        2.0000, 2.3000, -0.22000000, 800, 40, ${SPOT}, false),
       -- 🚨 报价宽（rel = 0.70/0.85 = 0.82 > 0.35）⇒ 被流动性门槛挡在两个意图视角之外，
       --    但 bid 0.50 ≥ 权利金门槛 0.20 ⇒ **仍在响应里**（两个计数语义不对称的实证）。
       (${cid(LIQ_BLOCKED)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        0.5000, 1.2000, -0.18000000, 300, 20, ${SPOT}, true),
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

/** 三视角各一份 —— 053 起它们是三次独立请求（`FR-005`）。 */
type PerspectiveViews = Readonly<Record<Perspective, LegTableResponse>>;
type Perspective = 'all' | 'build' | 'rent';
const PERSPECTIVES: readonly Perspective[] = ['all', 'build', 'rent'];

async function readLegs(
  cfg: Cfg,
  symbol: string,
  perspective: Perspective,
): Promise<LegTableResponse> {
  // 🚨 053 FR-001：`perspective` **必填**，且决定返回哪个视角。缺参 → 400（见 rejects 那组）。
  // 检索条件覆盖走 {@link readLegsWith} —— 参数序列化本身就是 052 T014 的靶心之一。
  const res = await optionsdeskControllerLegs(symbol, { perspective }, cfg);
  assert.equal(res.status, 200, `legs(${symbol}, ${perspective}) expected 200, got ${res.status}`);
  assert.equal(
    res.data.perspective,
    perspective,
    `legs(${perspective}): 响应 MUST 原样回显请求的视角 —— 靠调用点记忆的话, 覆盖错了照样渲染得出来一张表`,
  );
  return res.data;
}

/** 三次请求，各取一个视角。**顺序无关** —— 服务端对每次请求无条件作答，无跨请求状态。 */
async function readAllPerspectives(cfg: Cfg, symbol: string): Promise<PerspectiveViews> {
  const [all, build, rent] = await Promise.all(
    PERSPECTIVES.map((perspective) => readLegs(cfg, symbol, perspective)),
  );
  assert.ok(all !== undefined && build !== undefined && rent !== undefined);
  return { all, build, rent };
}

/**
 * 带检索条件覆盖的读取（052 T014）。
 *
 * 🚨 **参数由生成客户端序列化，不是手拼 query string** —— 这正是本层要合的缝：orval 把
 * `params` 展平进 query 的方式、与 server `@Query()` DTO 的字段名，中间任何一处对不上都会
 * 表现为「参数被**静默忽略**」：响应照样 200、腿照样有、只是那一刀没切下去。
 */
async function readLegsWith(
  cfg: Cfg,
  symbol: string,
  params: OptionsdeskControllerLegsParams,
): Promise<LegTableResponse> {
  const res = await optionsdeskControllerLegs(symbol, params, cfg);
  assert.equal(res.status, 200, `legs(${symbol}, ${JSON.stringify(params)}) expected 200`);
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
  // 🚨 **053 起本表是破坏性变更的账本**（`FR-005`）：`tabOrder` 整条删（数组顺序就是顺序）、
  //    `basisByTab` / `criteriaByTab` 收窄成标量 `basis` / `criteria`，另加五个新键。
  //    键集断言因此同时兼任 `SC-002` 的「by-tab 残留为零」—— 谁把它们加回来这里立红。
  //    📌 五个新键的**值**往返归 T011（本函数只钉键集，不预支那一面）。
  assert.deepEqual(
    Object.keys(table).sort(),
    [
      'asOf',
      'asOfFreshnessTier',
      // 050 的顶层增量（051 T012 起在此立账）；053 起收窄成标量。
      'basis',
      // 053 FR-019c：候选上限 K 的触及数（异常位，与截断计数不同款）。
      'candidateCapDropped',
      // 052 T011 的顶层增量（T014 起在此立账）；053 起只发本视角那一份。
      'criteria',
      // 053 FR-011/FR-015：本视角的截断阈值 —— **未触发截断时也照常下发**。
      'displayLimit',
      'gateCounts',
      'intent',
      'lLevel',
      'legs',
      // 053 FR-005/FR-015：截断之前的条数 / 无覆盖口径下的候选数。
      'matchedCount',
      'memberCount',
      'oiAsOf',
      // 053 FR-005：本次作答的视角，原样回显。
      'perspective',
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
    'legs: 响应键集封闭 —— 无 lastClosedSession 泄漏, 且 by-tab 结构确实不再出现（SC-002）',
  );
}

// ── 🎯 051 T012 —— 050 六字段 + 051 per-view 计数：生成客户端 + 真 server 下的形状与一致性 ────
/**
 * 这七个字段迄今只被 server IT（不经生成客户端）与手写 hermetic mock（不经真 server）验过 ——
 * 「生成客户端 + 真 server」这条缝**从未合过**。本函数是它唯一的覆盖点。
 *
 * 🚨 **053 T014 随 `FR-005` 收窄重排了判据来源**，逐条登记（🚫 不是弱化，是搬家或结构性消失）：
 *   ① 原「`tabOrder[t]` 的元素集合 == `{code | t ∈ leg.tabs}`」（050 plan 不变量 1）——
 *      **结构性消失**：两个表达都被删了。`tabOrder` 删的理由恰恰就是这条不变量存在的理由
 *      （同一个成员关系下发两份必 drift）；`FR-002` 起数组顺序**就是**顺序，只剩一份表达 ⇒
 *      没有第二份可以与之对照。留位：下面那条「非空自检」照常，它守的是顺序判据不退化。
 *   ② 原「`tierByTab[t]` 对非成员恒 `null`」—— **结构性消失**：不属于该视角的腿压根不在那份
 *      响应里，没有「非成员格」这个位置了。它守的「进得了视角 ≠ 判得出档」由
 *      {@link assertLegDerivations} 里 `NO_GREEKS` 在收租视角 `tier === null` 那条原样承担。
 *   ③ 原「同一条腿两个视角判不同档」—— **搬家**：从一份响应的两格搬到两份响应的同一格。
 *   ④ 原「`basisByTab` 取值域封闭 + `all` 恒年化」—— **搬家**：三份响应各自的标量 `basis`。
 *   ⑤ 原「计数 `标量 ≤ build + rent` 且严格小于」—— **结构性消失 + 搬家**：一次请求只判定
 *      一个视角 ⇒ 051 的「全表标量」与「分视角数」已是同一个数，不等式两侧塌成一侧。它守的
 *      **实质**（重叠区那条腿让 build 与 rent **各自**的计数都 +1）改由两份响应各断一次 —— 这
 *      与本片 T001 对同一条不等式的裁法同源。全腿那份恒 0（不受流动性门槛约束）。
 */
function assertLegEngineContract(views: PerspectiveViews): void {
  // ① 顺序判据的非空自检（成员关系的两处同源已随 tabOrder 一并退役，见上）。
  assert.ok(
    views.all.legs.length > 0 && views.rent.legs.length > 0,
    'legs: 本 fixture 的全腿 / 收租视角都该非空 —— 空了的话下面的顺序判据全部退化',
  );

  // ③ 建仓视角按**周化**档界判，全腿按年化 ⇒ 同一条腿两份响应不同档（051 SC-006 的服务端侧证据）。
  assert.equal(
    legOf(views.build, BUILD).tier,
    'thin',
    'legs: 周化 0.93% 落 [0.6%,1%) ⇒ 建仓视角判薄档',
  );
  assert.equal(
    legOf(views.all, BUILD).tier,
    'good',
    'legs: 同一条腿在全腿视角按**年化**判（0.93%×52 ≈ 48%）⇒ 好档 —— 两个视角判不同档是定义如此',
  );

  // ④ 口径映射：取值域封闭 + 全腿恒年化。
  for (const perspective of PERSPECTIVES) {
    assert.ok(
      ['weekly', 'annualized'].includes(views[perspective].basis),
      `legs(${perspective}).basis 取值超出客户端已知值域：${views[perspective].basis}`,
    );
  }
  assert.equal(views.all.basis, 'annualized', 'legs(all).basis 恒年化');
  assert.equal(views.build.basis, 'weekly', 'legs(build).basis = 周化');
  assert.equal(views.rent.basis, 'annualized', 'legs(rent).basis = 年化');

  // ⑤ 两个计数：语义不对称 + 重叠区（改由两份响应各断一次）。
  assert.equal(
    views.all.gateCounts.removedByPremiumFloor,
    1,
    `legs.gateCounts.removedByPremiumFloor: ${NO_BID} 无 bid ⇒ 被权利金门槛整条移出响应，计 1 条`,
  );
  for (const perspective of PERSPECTIVES) {
    assert.equal(
      views[perspective].legs.find((leg) => leg.code === NO_BID),
      undefined,
      `legs(${perspective}): 被权利金门槛挡下的腿**三个视角都看不到** —— 它不在 legs[] 里（与流动性那条的语义差别）`,
    );
  }
  assert.equal(
    views.build.gateCounts.excludedFromIntentTabs,
    1,
    `legs(build): ${LIQ_BLOCKED} 落建仓段却被挡下`,
  );
  assert.equal(
    views.rent.gateCounts.excludedFromIntentTabs,
    1,
    'legs(rent): 🚨 同一条腿也落收租段（重叠区）—— 重叠带的腿让**两份**请求的计数各 +1，' +
      '这就是 051 那条「标量 < build + rent」不等式的实质（拆请求后不等式两侧塌成同一个数）',
  );
  assert.equal(
    views.all.gateCounts.excludedFromIntentTabs,
    0,
    'legs(all): 全腿视角恒 0 —— 它不受流动性门槛约束（两个计数语义不对称的另一半）',
  );
  // 被流动性门槛挡下的腿**仍在响应里**，只是进不了意图视角 —— 与上面那条「真消失」成对照。
  assert.ok(
    views.all.legs.some((leg) => leg.code === LIQ_BLOCKED),
    `legs(all): ${LIQ_BLOCKED} 仍在全腿视角（腿没消失，这是两个计数不对称的全部含义）`,
  );
  for (const perspective of ['build', 'rent'] as const) {
    assert.equal(
      views[perspective].legs.find((leg) => leg.code === LIQ_BLOCKED),
      undefined,
      `legs(${perspective}): 被流动性门槛挡下 ⇒ 不进意图视角`,
    );
  }

  // ⑥ 两个标是 boolean 不是 nullable —— 客户端据此直接分支，null 会静默渲成「无标」。
  for (const leg of views.all.legs) {
    assert.equal(typeof leg.isRecommended, 'boolean', `legs[${leg.code}].isRecommended`);
    assert.equal(typeof leg.isMonthlyChain, 'boolean', `legs[${leg.code}].isMonthlyChain`);
  }
  assert.equal(
    legOf(views.all, NO_GREEKS).isRecommended,
    false,
    'legs: greeks 缺失恒不带推荐标（Δ 算不出来就没有「贴合当前意图」可言）',
  );
}

// ── 🎯 052 T014 —— 检索条件：默认值下发 / 覆盖生效 / 三态计数 的真 server 侧证据 ─────────────

/** 六个检索维度（= 契约 `outcomes` 的键集，逐个写出以便漏一维即编译红）。 */
const CRITERION_KEYS = [
  'strikeMax',
  'strikeMin',
  'dteBand',
  'premiumMin',
  'livenessMin',
  'relativeSpreadMax',
] as const;

/**
 * 052 的三组字段（`defaults` / `effective` / `outcomes` × 六维 × 三视角）此前只被 server IT
 * （不经生成客户端）与手写 hermetic mock（不经真 server）验过 —— 「生成客户端 + 真 server」
 * 这条缝从未合过。本函数 + {@link assertCriteriaOverrideRoundTrip} 是它唯一的覆盖点。
 *
 * 🚨 只有这一层才验得到的四条：
 *   ① **nullable 小数字段是 `string | null` 而不是 objectmap** —— `@ApiProperty` 漏写显式
 *      `type: 'string'` 时 orval 会生成 `{ [key: string]: unknown }`，而 hermetic mock 手写的
 *      fixture 永远是对的形状 ⇒ 那一层看不见这个错（012 踩过，已成仓内纪律）。
 *   ② **默认值真的依赖 spot** —— 收租的成色上界由链上行权价网格 ∧ `spot × (1+X)` 现算，
 *      mock 里它只是个常数；客户端自算那条禁令（FR-011）防的就是这个量。
 *   ③ **参数真的被吃进去了**（见 round-trip）—— 序列化对不上时参数被**静默忽略**：200、腿照样
 *      有、只是那一刀没切下去。
 *   ④ **成对维度的 400** —— 半个 DTE 段 / 半对活性是契约级拒绝，只有真 server 会拒。
 *
 * 🚫 **蓄意不断言任何阈值的具体取值**：兜底比例 X / 权利金下限 / 活性下限都是 T016 待标定的
 *    策略参数，抄进断言就是第二处硬编码 —— 标定那天这里会红，而红的原因与本片无关。
 *    ⇒ 一律断言**结构性质**（类型 / 相对 spot 的方向 / 三视角之间的异同）。
 */
function assertRetrievalCriteriaShape(views: PerspectiveViews): void {
  for (const perspective of PERSPECTIVES) {
    // 🚨 053 起「三视角的条件全景」不再是一份响应里的三格，而是**三份响应各自那一份**
    //    （`criteriaByTab` → `criteria`）—— 052 恒发三份的前提「本地切视角不发请求」已整条作废。
    const c: PerspectiveCriteriaResponse = views[perspective].criteria;
    // 未覆盖 ⇒ 生效值**逐字**等于系统默认值（客户端首屏据此把控件填成「当前就是这样召回的」）。
    assert.deepEqual(
      c.effective,
      c.defaults,
      `criteria(${perspective}): 未覆盖时 effective MUST 逐字等于 defaults`,
    );
    for (const key of CRITERION_KEYS) {
      assert.equal(
        c.outcomes[key].state,
        'default',
        `criteria(${perspective}).outcomes.${key}.state: 没动过 ⇒ default`,
      );
      assert.equal(
        c.outcomes[key].excludedCount,
        0,
        `criteria(${perspective}).outcomes.${key}.excludedCount: 非 narrowed 恒 0`,
      );
    }
  }

  const all = views.all.criteria.defaults;
  const build = views.build.criteria.defaults;
  const rent = views.rent.criteria.defaults;

  // ① 靶心：nullable 小数字段的**运行时类型**（orval objectmap 陷阱的唯一真实证据）。
  assert.equal(typeof rent.strikeMax, 'string', 'criteria(rent).defaults.strikeMax 是定标 string');
  assert.equal(
    typeof rent.premiumMin,
    'string',
    'criteria(rent).defaults.premiumMin 是定标 string',
  );
  assert.equal(
    typeof rent.relativeSpreadMax,
    'string',
    'criteria(rent).defaults.relativeSpreadMax 是定标 string',
  );
  assert.equal(typeof rent.livenessMin?.oi, 'number', 'livenessMin.oi 是张数（整数），不是 string');
  assert.equal(typeof rent.dteBand?.min, 'number', 'dteBand 两端是天数（整数）');

  // ② 靶心：成色上界由 spot 现算。本 fixture 的链上**没有 ≥ spot 的档**（全是虚值认沽）
  //    ⇒ 结构判据退化、由比例项接管 ⇒ 上界必**严格高于** spot。
  //    🚫 不断言具体数值（X 待 T016 标定）；断言方向即可证明「它是 spot 的函数」。
  assert.ok(
    Number(rent.strikeMax) > Number(views.rent.spot),
    `criteria(rent).defaults.strikeMax(${rent.strikeMax}) MUST > spot(${views.rent.spot}) —— ` +
      '否则每条虚值认沽都被自己的成色上界挡住',
  );

  // ③ 三视角的差**只在三个维度上**（其余三维一律相同）。
  assert.equal(all.strikeMax, null, 'criteria(all): 全腿是参照视角，不设成色上界（FR-006）');
  assert.equal(build.strikeMax, null, 'criteria(build): 建仓由有效成本硬门槛等价挡住（FR-007）');
  assert.equal(all.dteBand, null, 'criteria(all): 全腿不设期限段（FR-003）');
  assert.equal(all.relativeSpreadMax, null, 'criteria(all): 流动性门槛只作用意图视角（FR-010）');
  assert.notDeepEqual(
    build.dteBand,
    rent.dteBand,
    'criteria: 建仓与收租的期限段 MUST 不同（两个意图各自的召回段）',
  );
  for (const [label, a, b] of [
    ['premiumMin', all.premiumMin, rent.premiumMin],
    ['premiumMin(build)', build.premiumMin, rent.premiumMin],
  ] as const) {
    assert.deepEqual(a, b, `criteria: ${label} 三视角一律相同（FR-009 未改）`);
  }
  assert.deepEqual(all.livenessMin, rent.livenessMin, 'criteria: 活性下限三视角一律相同');
  assert.deepEqual(
    build.relativeSpreadMax,
    rent.relativeSpreadMax,
    'criteria: 两个意图视角同一道价差上界',
  );
}

/**
 * 覆盖的往返：请求参数 → 真 server 召回 → 三态与计数回到客户端。
 *
 * 🚨 **参数被静默忽略是本层最该抓的失败形态**：序列化对不上时响应仍是 200、腿仍在、
 *    `effective` 仍等于 `defaults` —— 屏幕上一切正常，只是「搜」这个动作什么也没做。
 *    ⇒ 每条断言都钉在「那一刀真的切下去了」的可观察后果上（成员集合 + 计数 + effective）。
 */
async function assertCriteriaOverrideRoundTrip(cfg: Cfg, views: PerspectiveViews): Promise<void> {
  // 收租视角的行权价：RENT_DROP 65 / RENT_STAY 60 / NO_GREEKS 55（见 seed）。
  // 把上界压到 60 ⇒ 只有 RENT_DROP 掉出去，且**恰等于上界**的 RENT_STAY MUST 留下（闭区间）。
  const narrowed = await readLegsWith(cfg, CHAIN, { perspective: 'rent', strikeMax: '60.0000' });
  const rc = narrowed.criteria;
  const narrowedCodes = narrowed.legs.map((leg) => leg.code);

  assert.equal(
    rc.effective.strikeMax,
    '60.0000',
    'legs?strikeMax: 生效值 = 请求值（定标到契约的 4 位）',
  );
  assert.notDeepEqual(
    rc.effective,
    rc.defaults,
    'legs?strikeMax: effective MUST 与 defaults 分叉 —— 相等即参数被静默忽略',
  );
  assert.equal(rc.outcomes.strikeMax.state, 'narrowed', 'legs?strikeMax: 产生排除 ⇒ narrowed');
  assert.equal(
    rc.outcomes.strikeMax.excludedCount,
    1,
    '边际口径：把这一维换回系统默认值能多看到 RENT_DROP 一条（其余维保持用户值）',
  );
  // 📌 「成员集合」的判据从 `tabOrder.rent` 换成响应的 `legs[]` 本身 —— 数组顺序就是顺序，
  //    那份并行的有序 code 列表已随 FR-005 退役（同一个信息的第二份表达必 drift）。
  assert.ok(!narrowedCodes.includes(RENT_DROP), `legs?strikeMax: ${RENT_DROP}(65) 掉出收租视角`);
  assert.ok(
    narrowedCodes.includes(RENT_STAY),
    `🚨 闭区间：${RENT_STAY} 行权价恰等于上界 60 ⇒ MUST 留下（取开区间会在这里红）`,
  );

  // 🚨 **052 那三条「覆盖不串味到另两个视角」随 FR-005 结构性消失** —— 一次请求只作答一个
  //    视角，本响应里压根没有另两个视角的格子可比；跨请求也无从串味：条件是 query 参数，服务端
  //    对每次请求无条件作答、零跨请求状态 ⇒ 断言恒真 = 假绿。本片 T005 对同型的 3 条已如此裁定，
  //    此处沿用。**留下的是它守的可观察后果**：被收租条件切掉的那条**仍在全腿视角**，而全腿那份
  //    是另一次不带条件的请求 —— 下面这条正是它。
  assert.ok(
    views.all.legs.some((leg) => leg.code === RENT_DROP),
    `legs?perspective=rent: 被收租条件切掉的 ${RENT_DROP} **仍在全腿视角那次请求里**`,
  );
  for (const key of CRITERION_KEYS) {
    if (key === 'strikeMax') continue;
    assert.equal(
      rc.outcomes[key].state,
      'default',
      `legs?strikeMax: 没动过的 ${key} MUST 仍是 default`,
    );
  }

  // 空串 = 覆盖为「不限」（缺键才是「没动过」）。本链无高于成色上界的腿 ⇒ 放宽后一条不多。
  const widened = await readLegsWith(cfg, CHAIN, { perspective: 'rent', strikeMax: '' });
  const wc = widened.criteria;
  assert.equal(
    wc.effective.strikeMax,
    null,
    'legs?strikeMax=（空串）：覆盖为「不限」而不是「没动过」',
  );
  assert.equal(
    wc.outcomes.strikeMax.state,
    'widened',
    '🚨 空串 MUST 判成覆盖（widened）而不是 default —— 真值判断会把它与缺键吞成同一种',
  );
  assert.equal(
    wc.outcomes.strikeMax.excludedCount,
    0,
    '放宽不产生排除 ⇒ 计数恒 0（客户端据此不显示）',
  );
  assert.deepEqual(
    widened.legs.map((leg) => leg.code),
    views.rent.legs.map((leg) => leg.code),
    'legs?strikeMax=（空串）：本链无高于默认上界的腿 ⇒ 放宽后成员集合与顺序逐条不变',
  );

  // 契约级拒绝三条 —— 只有真 server 会拒（hermetic mock 想拒也是自己编的）。
  const rejects: readonly (readonly [string, OptionsdeskControllerLegsParams])[] = [
    ['只给 DTE 段一端（半个闭区间不是合法维度值）', { perspective: 'rent', dteMin: '30' }],
    [
      '只给活性一支（半对不是合法维度值，OR 的另一支缺了整维就没定义）',
      { perspective: 'rent', oiMin: '10' },
    ],
    // 🚨 **053 FR-001 把这条从「给了条件才必填」升成「恒必填」** —— 它现在决定的是**返回哪个
    //    视角**，不只是覆盖落在谁身上。故用**只带条件、不带视角**的那组仍然 400，且缺参本身
    //    （连条件都不带）也 400：服务端 MUST NOT 替你挑一个默认视角。
    //    📌 参数类型上 `perspective` 已是必填 ⇒ 这里的断言只能造一个越过类型的入参。
    [
      '给了条件却没给 perspective（它决定返回哪个视角，不说是哪个就无从作答）',
      { strikeMax: '60.0000' } as unknown as OptionsdeskControllerLegsParams,
    ],
    [
      '连视角都不带的裸请求（🚫 服务端 MUST NOT 默认一个视角：腿数、名次、档位全都正常，只是答的不是问的那个）',
      {} as unknown as OptionsdeskControllerLegsParams,
    ],
  ];
  for (const [label, params] of rejects) {
    await assert.rejects(
      () => optionsdeskControllerLegs(CHAIN, params, cfg),
      (err: unknown) => {
        const e = err as { response?: { status?: number } };
        assert.equal(e.response?.status, 400, `legs 拒 ${label} ⇒ 400`);
        return true;
      },
    );
  }
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
function assertLegDerivations(views: PerspectiveViews, today: string): void {
  const table = views.all;
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
  assert.equal(legOf(table, LIQ_BLOCKED).dteDays, 40, 'legs: 40 天落 [30,49] 重叠区');
  assert.equal(legOf(table, NO_GREEKS).dteDays, 220);

  // ② 腿族口径按形态判（DTE ≤ 14 ∧ |Δ| ∈ [0.40,0.55] ⇒ 周化），其余年化。
  assert.equal(legOf(table, BUILD).basis, 'weekly', 'legs: 建仓形态的腿按周化口径');
  assert.equal(legOf(table, RENT_DROP).basis, 'annualized');

  // ③ 档位按 bid 口径 + **本次视角**的口径判（053 FR-041）；薄档**带出** ask 口径费率。
  //    🚨 053 起 `tier` 是视角级的：BUILD 这条腿在**建仓**那份响应里才判薄档（周化档界），
  //       在全腿那份按年化判好档 —— 故薄档相关的两条断言取自 `views.build`，🚫 MUST NOT 留在
  //       全腿那份上（那会在「档界跟视角走」正确实现时红错方向）。
  assert.equal(legOf(table, RENT_DROP).tier, 'good');
  assert.equal(legOf(table, RENT_STAY).tier, 'good');
  const buildInBuildView = legOf(views.build, BUILD);
  assert.equal(buildInBuildView.tier, 'thin', 'legs(build): 周化 0.93% 落 [0.6%,1%) ⇒ 薄档');
  assert.ok(buildInBuildView.askRate !== null, 'legs(build): 薄档 MUST 带出 ask 口径费率');
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
  // 🚨 **050 起 Δ 整个退出召回判据**（FR-009）⇒ 无 Δ 的腿照常按期限段进意图视角。047 这条断言
  //    写的是 `['all']`（那时 Tab 归属吃 Δ 深度档），换代后它**该红** —— 改判为 rent 段成员。
  // 📌 053：每腿 `tabs` 已删 ⇒ 判据从「这条腿自称属于哪些视角」改成「它在不在那个视角那次
  //    请求的 `legs[]` 里」—— 同一个成员关系，改由唯一那份表达作证。
  assert.ok(
    views.rent.legs.some((leg) => leg.code === NO_GREEKS),
    'legs(rent): 无 Δ 的腿照常按期限段进收租视角（050 起 Δ 不是召回判据）',
  );
  assert.equal(
    views.build.legs.find((leg) => leg.code === NO_GREEKS),
    undefined,
    'legs(build): DTE 220 不落建仓段 ⇒ 不在建仓那份里（成员关系仍分得开，不是「哪都在」）',
  );
  assert.equal(
    legOf(views.rent, NO_GREEKS).tier,
    null,
    'legs(rent): 进得了视角 ≠ 判得出档 —— 两件事各判各的（原 tierByTab.rent 那条的现役落点）',
  );
  assert.ok(noGreeks.periodRate !== null, 'legs: 不判档 ≠ 不算费率 —— 费率三列照常给');

  // ⑥ 🚨 **050 起「无 bid」这条路径在本端点已不可达**：权利金门槛先于建表施加，无 bid 判 false
  //    ⇒ 整条移出响应（计数覆盖见 assertLegEngineContract）。047 在此验的「无 bid ⇒ 费率 / 有效
  //    成本 / 成交额一律 null，禁拿 K−0 冒充」**不是被删掉，是没有输入能到达它了** —— 响应里
  //    每条腿的 bid 都 ≥ 门槛。该判据的现役覆盖点是 `leg-derive.rules.spec.ts`（纯函数层）。
  assert.ok(
    table.legs.every((leg) => leg.bid !== null),
    'legs: 响应内每条腿都过了权利金门槛 ⇒ 不存在 bid 为 null 的行（无 bid 那条路径已在门槛处终结）',
  );

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

// ── 🎯 靶心 ① 活跃度**逐视角**各排一次名（hermetic fixture 里这列是手写的，验不到）────────────
// 🚨 053 FR-005：`activityByTab` 收窄成每腿一份 `activity`（拆请求之后另两个视角结构上没有可判
//    的东西）⇒ 「逐视角各排一次名」的判据从「一份响应里的三格」搬到「三份响应的同一格」。
function assertActivityIsPerPerspective(views: PerspectiveViews): void {
  const build = legOf(views.all, BUILD);
  assert.ok(
    views.build.legs.some((leg) => leg.code === BUILD),
    'legs(build): DTE 10 + |Δ| 0.45 ⇒ 该腿在建仓那份里',
  );
  assert.equal(
    build.activity?.isTopRanked,
    false,
    'legs(all): 该腿在**全腿**候选集里 OI/Vol 排名之和第 4 ⇒ 不进前三',
  );
  // 🚨 **052 T009 起判据换了口径，本条随之改判**（不是弱化，是被换掉的那个量）：活跃标 =
  //    「**同到期日**组内 top-3」∧「活动量（OI + 当日成交）过绝对线」。本 fixture 每条腿**各占
  //    一个到期日** ⇒ 组内恒 top-1 ⇒ 绝对线成了唯一判据 ⇒ 活动量 50+3=53 的这条**两个视角都
  //    不发标**。判别性仍在：把绝对线拿掉，它在组内是第一名，这条当场红。
  assert.equal(
    legOf(views.build, BUILD).activity?.isTopRanked,
    false,
    '052 FR-024：活动量 53 够不着绝对线 ⇒ 不发标（只用相对判据会在死到期日里发标，Guardrail 4）',
  );
  // 对照组：同样独占一个到期日、但活动量 5300 的那条**发标** —— 两条一起才说明「线」真的在那儿。
  assert.equal(
    legOf(views.rent, RENT_STAY).activity?.isTopRanked,
    true,
    '052 FR-024：活动量过线 + 组内 top-3 ⇒ 发标',
  );
  // ⚠️ **原靶心「同一条腿在两个视角的候选集里排名不同」在本 fixture 上已不可达**：分组维度改成
  //    到期日之后，要造出排名差需要**同一到期日 ≥4 条腿**（N=3），而那要重造整册腿并连带改动
  //    计数与顺序的多条断言 ⇒ 登记为债，不在 T014 内做。per-tab **计算路径**仍被守着：
  //    非成员格恒 null（下一条）+ 每个视角各取自己那格。
  // 🚨 原「不属于某 Tab ⇒ 该 Tab 的活跃度标恒 null」**结构性消失**：不属于那个视角的腿压根不
  //    在那份响应里，没有「非成员格」这个位置了。它守的「per-视角各算各的」由上面两条
  //    （同一条腿的标取自各自那份响应）承担；成员关系本身由下面这条守。
  assert.equal(
    views.rent.legs.find((leg) => leg.code === BUILD),
    undefined,
    'legs(rent): DTE 10 不落收租段 ⇒ 该腿不在收租那份里',
  );
  assert.equal(build.activity?.isRoundStrike, false, 'legs: 68.5 非整数档');

  assert.equal(legOf(views.all, RENT_STAY).activity?.isRoundStrike, true, 'legs: 60 是整数档');
  assert.equal(legOf(views.all, RENT_STAY).activity?.label, 'round_strike', 'legs: 标签整数档优先');
  assert.ok(
    legOf(views.rent, RENT_STAY).activity !== null,
    'legs(rent): 收租视角的成员带**该视角**算出的活跃度标',
  );
}

// ── 未选态是常驻分支：意图「待定」，三个 Tab 照常可取数 ───────────────────────────────────────
function assertUnselectedBucket(views: PerspectiveViews): void {
  const table = views.all;
  assert.equal(table.positionBucket, null, 'legs: 新建锚天然未选水位档（**无默认值**）');
  assert.equal(table.positionBucketSource, null, 'legs: 档位与来源标严格成对，同时为 null');
  assert.equal(table.positionBucketSetAt, null);
  assert.equal(table.intent, 'pending', 'legs: 水位未选 ⇒ 待定（MUST NOT 静默取一档）');
  assert.equal(table.rentDepth, null);
  // 🚨 **050 起水位与成员集合无关**（Δ 退出召回）—— 这条断言从「三档并集所以在」改判为
  //    「按期限段所以在」，取值巧合相同、理由完全不同（下面 assertBucketWriteAndPersistence
  //    那条才是判别性所在：选完水位它**仍**在）。
  assert.ok(
    views.rent.legs.some((leg) => leg.code === RENT_DROP),
    'legs(rent): DTE 180 落收租段（原每腿 `tabs` 那条的现役落点 —— 成员关系只剩这一份表达）',
  );
}

// ── 未注册进 marketdata ⇒ chain_not_ready，锚派生那半边照常返回 ───────────────────────────────
async function assertChainNotReady(cfg: Cfg): Promise<void> {
  const table = await readLegs(cfg, NO_CHAIN, 'all');
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
    () => optionsdeskControllerLegs(NO_ANCHOR, { perspective: 'all' }, cfg),
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

/** 设档 → 复取，验真落库 + 意图链与成员归属**一条都不变**。返回写端点回的手选时刻。 */
async function assertBucketWriteAndPersistence(
  cfg: Cfg,
  anchorId: string,
  before: PerspectiveViews,
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

  // 🚨 **三个视角各复取一次** —— 收窄之后「成员集合不因水位而变」这条不变量本就分散在三份
  //    响应里；只复取一份的话，另两个视角的成员一旦跟着水位动，这里照样绿。
  const afterViews = await readAllPerspectives(cfg, CHAIN);
  const after = afterViews.all;

  // ① 三项档位字段**同步**变，且读端回的时刻与写端**逐字节相同**（两侧共用同一个投影函数）。
  assert.equal(after.positionBucket, 'gte_two_thirds', '真落库：复取拿到手选档');
  assert.equal(after.positionBucketSource, 'manual');
  assert.equal(after.positionBucketSetAt, setAt, '读端与写端的手选时刻逐字节相同');

  // ② 🎯 靶心 ② **已随 050 反转**：047 在此验的是「水位一改每腿 tabs 整体变」（Δ 深度档收窄
  //    ⇒ |Δ|=0.35 那条掉出收租 Tab）。050 把 Δ 整条移出召回判据（FR-009）后，**成员集合与水位
  //    彻底无关** ⇒ 那条断言该红，且反过来的「一条都不变」才是现在要钉住的不变量。
  //    🚨 这不是弱化断言：反转后它守的是一条**更强**的性质（水位只改意图链，不改任何一屏的
  //    成员），而这条性质坏掉时数字照样自洽 —— 只有把前后两份响应逐条比才看得出来。
  assert.equal(after.intent, 'rent', '水位选定 ⇒ 意图从「待定」落到收租');
  assert.equal(after.rentDepth, 'deep', '买区 + L2 + ≥2/3 ⇒ 收租深度档收到最深一档');
  // 📌 053：每腿 `tabs` 与那份 `tabOrder` 都已删 ⇒ 「成员集合不变」的唯一表达就是**每个视角
  //    那份 `legs[]` 逐条不变**（顺序也在内 —— 精排入参里没有水位）。原来的两条断言在此合成一条，
  //    覆盖面反而更全：它连「另两个视角的成员」也一并钉住了。
  for (const perspective of PERSPECTIVES) {
    assert.deepEqual(
      afterViews[perspective].legs.map((leg) => leg.code),
      before[perspective].legs.map((leg) => leg.code),
      `legs(${perspective}): 050 起成员集合与顺序 MUST NOT 因水位而变（Δ 已不在召回入参里）`,
    );
    assert.deepEqual(
      afterViews[perspective].gateCounts,
      before[perspective].gateCounts,
      `legs(${perspective}).gateCounts: 两道门槛都不吃水位 ⇒ 计数一个数都不动`,
    );
  }

  // ③ 零拦截语义：视角归属只影响某一屏出不出现，**腿一条都没少**，财报标亦不受牵动。
  assert.deepEqual(
    after.legs.map((leg) => leg.earningsMark?.mark ?? null),
    before.all.legs.map((leg) => leg.earningsMark?.mark ?? null),
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
  const table = await readLegs(cfg, CHAIN, 'all');
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

  const table = await readLegs(cfg, CHAIN, 'all');
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
