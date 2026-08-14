/**
 * 055 optionsdesk 标的链分析报表 契约冒烟（Constitution §V 两层验证之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的**真 server**（testcontainers PG），验新读端
 * `GET /optionsdesk/underlyings/{symbol}/chain-report` 的**契约对齐 + 真落库**。
 *
 * 补的是另两层各自看不见的缝：
 *   ① hermetic e2e（T018）把响应 mock 掉了 —— 它验的是「拿到这形状后 UI 怎么画」，形状本身由
 *      fixture 保证，server 换了字段名 / 序列化标度它照样绿；
 *   ② server IT（T007）打的是真 server，但断言写在**手写的 DTO 期望**上 —— 与 mobile 实际消费的
 *      那份**生成客户端类型**是两条独立的手抄链，orval 生成出别的形状不会有人红。
 *
 * 🚨 本片五条「只有端到端才验得到」的靶心：
 *   1. **nullable 小数字段落成 `string | null` 而不是 orval 的 objectmap**（Guardrail 10 / 012
 *      实证）—— 生成侧一旦退化，`typeof best === 'string'` 当场红，而 typecheck 与 hermetic
 *      e2e 都看不见（前者只看类型、后者的 fixture 本来就是字符串）。
 *   2. **响应里没有色阶档字段**（plan `D-BAND-1`：色阶住 client）—— 契约面核实。
 *      🚨 判据必须排除 `inRecallBand`（召回段覆盖，不是色阶档）：裸扫 `band` 会被它误伤，
 *      而它大小写恰好躲过 —— 靠大小写巧合成立的判据不算判据。
 *   3. **四种格值同一骨架**（`SC-002` 的服务端一半）—— 四张网格的维度逐格相等；
 *      而格态**必须**在某些格上不同（四种格值跑在不同召回集上，位置不变 ≠ 格态不变）。
 *   4. **三个互斥计数各自可达且求和 = 全量**（`SC-006`）—— fixture 专门为三条路径各种一条腿，
 *      三个数任一恒 0 就说明那条路在真库上根本走不到。
 *   5. **IV 分位块与详情端点逐字节同形**（`FR-031` 复用 046 那一份、不新造）—— 两个端点的
 *      `iv` 直接 `deepEqual`。各写各的投影会长出「报表说 missing、详情说 unavailable」。
 *
 * 边界与幂等：用**专属 ticker** `us:NVYG`（避开 045 `us:NVYX` / 046 `NVYQ..T` / 047 `NVYL,NVYP,NVYN`
 * 与 hermetic 的 `us:ACN`），marketdata 事实表无公开写端点 ⇒ 靠 `ctx.execSql` 直插（schema=marketdata，
 * 列名 snake_case per `@map`），锚走公开写端点建 / 末尾 DELETE 自清理。
 */
import assert from 'node:assert/strict';
import {
  optionsdeskControllerChainReport,
  optionsdeskControllerCreate,
  optionsdeskControllerRemove,
  optionsdeskControllerUnderlyingDetail,
} from '@nvy/api-client';
import type { ChainReportGridsResponse, ChainReportResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-chain-report (055)';

type Cfg = { baseURL: string; headers: Record<string, string> };

// ── 专属标的 ────────────────────────────────────────────────────────────────
const MARKET = 'us';
/** 有锚 + 全链快照 ⇒ 报表主战场。 */
const CODE_REPORT = 'NVYG';
/** 压根没建锚 ⇒ 404 `ANCHOR_NOT_FOUND_FOR_SYMBOL`（报表不可达，`FR-037a`）。 */
const CODE_NO_ANCHOR = 'NVYH';

const REPORT = `${MARKET}:${CODE_REPORT}`;
const NO_ANCHOR = `${MARKET}:${CODE_NO_ANCHOR}`;

// ── 锚：V=100、confidence 8.0 ⇒ W=80（与 046 / 047 契约冒烟同口径）───────────
const V = '100.0000';
const CONFIDENCE = '8.0';
/** 现价 —— 行轴（价外幅度）的分母，也是 ATM IV 插值的中心。 */
const SPOT = '100.0000';

// ── 合约代码（三条路径各一条 + 网格主体）─────────────────────────────────────
/** 价内 5%（K=105）—— 落**首行**（价内 0-10 档）：全腿年化下「口径不适用」的靶子。 */
const ITM = 'US.NVYG.ITM';
/** 价外 5%（K=95）· 中期 —— 网格主体，且是 ATM 插值的**上侧**那一档。 */
const NEAR = 'US.NVYG.NEAR';
/** 价外 15%（K=85）· 中期。 */
const MID = 'US.NVYG.MID';
/** 价外 25%（K=75）· 远期。 */
const FAR = 'US.NVYG.FAR';
/** 价外 5%（K=95）· 近期 —— 该到期日**只有这一侧**有档 ⇒ ATM IV 插值不可得（`FR-023` 断点）。 */
const SHORT = 'US.NVYG.SHORT';
/** 🚨 计数① 的靶子：bid 低于权利金门槛 ⇒ **整条移出骨架**。 */
const CHEAP = 'US.NVYG.CHEAP';
/** 🚨 计数② 的靶子：深价内 30% ⇒ 落在**行下界之外**（行轴下界 = 价内 10%）。 */
const DEEP_ITM = 'US.NVYG.DEEPITM';
/** 🚨 计数③ 的靶子：过了权利金门槛、也在行内，但 OI 与成交量双零 ⇒ **没人碰过**。 */
const DEAD = 'US.NVYG.DEAD';

const QUOTE_TIME = 'T20:15:00.000Z';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const today = exchangeToday(new Date());

  await seed(ctx, today);

  const anchorIds: string[] = [];
  try {
    anchorIds.push(await createAnchor(cfg, REPORT, today));

    const res = await optionsdeskControllerChainReport(encodeURIComponent(REPORT), cfg);
    assert.equal(res.status, 200, `chain-report expected 200, got ${res.status}`);
    const report = res.data;

    assertFourSections(report);
    assertOneSkeletonFourMetrics(report);
    assertGateCounts(report);
    assertNullableDecimalsAreStrings(report);
    assertNoBandFieldOnTheWire(report);
    assertAtmIvBreaksInsteadOfFallingBack(report);
    await assertIvBlockIsByteIdenticalToDetail(cfg, report);
    await assertNoAnchorIs404(cfg);
  } finally {
    for (const id of anchorIds) {
      const del = await optionsdeskControllerRemove(id, cfg);
      assert.equal(del.status, 204, `cleanup delete anchor ${id} expected 204, got ${del.status}`);
    }
    await deleteSeed(ctx, today);
  }
}

// ══════════════════════ 断言 ══════════════════════

/** spec `Key Entities` 的四段 —— 每格 / 每列 / 每行 / **链级读数**。第四段最容易漏。 */
function assertFourSections(report: ChainReportResponse): void {
  assert.equal(report.symbol, REPORT, '响应回的是请求的那只票');
  assert.equal(report.state, 'available', '有全链快照 ⇒ available');
  assert.ok(report.rows.length > 0, '行轴非空');
  assert.ok(report.columns.length >= 2, '列轴至少两个到期日（插值断点那条要靠它）');
  // 链级读数：现价 + 三个业务日时点 + 三计数 —— 它不属于任何一个格 / 列 / 行。
  assert.equal(typeof report.spot, 'string', 'spot 必须下发（页头显示 + 行轴的分母）');
  assert.equal(typeof report.marketDate, 'string', '交易所的今天');
  assert.equal(typeof report.asOf, 'string', '快照归属交易日');
  assert.equal(typeof report.oiAsOf, 'string', 'OI 归属交易日');
  assert.notEqual(report.oiAsOf, report.asOf, '🚨 OI 与报价蓄意不同日（fixture 如此种的）');
  assert.equal(typeof report.gateCounts.total, 'number', '页脚三计数所在的那一段');

  // 每行同时给价外档区间与**对应行权价区间**（`FR-027` 读数面板要）。
  const first = report.rows[0];
  assert.ok(first !== undefined, '首行存在');
  assert.equal(typeof first.otmFloor, 'string', '价外档下界');
  assert.equal(typeof first.strikeCeiling, 'string', '对应行权价上界');
  // 每列给到期日 / DTE / 月度标 / 各视角召回段覆盖 / 该列 ATM IV。
  const col = report.columns[0];
  assert.ok(col !== undefined, '首列存在');
  assert.equal(typeof col.expiryDate, 'string');
  assert.equal(typeof col.dteDays, 'number');
  assert.equal(typeof col.isMonthlyChain, 'boolean');
  assert.equal(typeof col.inRecallBand.rentAnnualized, 'boolean', '召回段覆盖逐格值下发');
}

const METRICS = [
  'buildQuality',
  'rentAnnualized',
  'allAnnualized',
  'activity',
] as const satisfies readonly (keyof ChainReportGridsResponse)[];

/**
 * 🚨 `SC-002` 的服务端一半：四张网格**同一个骨架**（维度逐格相等），
 * 而格态**必须**在某些格上不同 —— 位置不变 MUST NOT 被读成格态不变。
 */
function assertOneSkeletonFourMetrics(report: ChainReportResponse): void {
  const rows = report.rows.length;
  const cols = report.columns.length;
  for (const metric of METRICS) {
    const grid = report.cells[metric];
    assert.equal(grid.length, rows, `${metric} 行数 = 行轴长度`);
    for (const [r, line] of grid.entries()) {
      assert.equal(line.length, cols, `${metric} 第 ${r} 行列数 = 列轴长度`);
    }
  }
  const stateMap = (metric: (typeof METRICS)[number]): string =>
    report.cells[metric].map((line) => line.map((c) => c.state).join('')).join('|');
  const distinct = new Set(METRICS.map(stateMap));
  assert.ok(
    distinct.size > 1,
    '🚨 四种格值跑在不同召回集上 ⇒ 格态集合不可能四张全同；全同说明它被缓存成了格的静态属性',
  );
}

/**
 * 🚨 三个互斥计数各自可达 + 求和恒等式（`FR-034` / `SC-006`）。
 *
 * 📌 恒等式对「逐级 continue」那种实现是**结构性恒真**（T003 探针实证）⇒ 它是防未来重写的
 * 回归网，**不是**主判据。主判据是**三个数各自 > 0**：fixture 为三条路径各种了一条腿，
 * 任一恒 0 就说明那条路在真库上根本走不到（而三个数照样都印得出来）。
 */
function assertGateCounts(report: ChainReportResponse): void {
  const g = report.gateCounts;
  // 🚨 **逐条钉死而不是 `> 0`** —— fixture 为三条路径**各种一条**腿，八条腿的归属因此是
  //    一一对应的：CHEAP→① · DEEP_ITM→② · DEAD→③ · 其余五条→有值。写成 `> 0` 分不出
  //    「那条腿走对了路」与「另外七条里有一条误落进来」，而两种情况下三个数都印得出来。
  assert.deepEqual(
    {
      total: g.total,
      removedByPremium: g.removedByPremium,
      outsideRowFloor: g.outsideRowFloor,
      blockedByLiveness: g.blockedByLiveness,
      valued: g.valued,
    },
    { total: 8, removedByPremium: 1, outsideRowFloor: 1, blockedByLiveness: 1, valued: 5 },
    '🚨 八条腿的归属逐条对上：CHEAP→权利金 / DEEP_ITM→行下界外 / DEAD→无活动 / 其余五条有值',
  );
  assert.equal(
    g.removedByPremium + g.outsideRowFloor + g.blockedByLiveness + g.valued,
    g.total,
    '🚨 三者互斥且与有值相加 = 全链全量（SC-006）',
  );
  // 每条各带自己的分母 —— 分母不同正是它们不能相加成一个数的原因。
  assert.deepEqual(
    { skeleton: g.skeleton, withinRows: g.withinRows },
    { skeleton: 7, withinRows: 6 },
    '分母逐级收窄：全量 8 −权利金 1 = 骨架 7 −行下界外 1 = 行内 6',
  );
}

/**
 * 🚨 靶心 ①：nullable 小数字段在**运行时**是 `string`，不是 orval 的 `{ [k]: unknown }`
 * （Guardrail 10 / 012 实证）。typecheck 与 hermetic e2e 都看不见这一层。
 */
function assertNullableDecimalsAreStrings(report: ChainReportResponse): void {
  const valued = report.cells.allAnnualized.flat().find((c) => c.state === 'valued');
  assert.ok(valued !== undefined, 'fixture 至少造出一个有值格');
  assert.equal(typeof valued.best, 'string', '格值 best 是定标字符串');
  assert.equal(typeof valued.legCount, 'number', '腿数是数字');
  assert.ok(
    valued.runnerUp === null || typeof valued.runnerUp === 'string',
    '次优是字符串或 null，🚫 不是 objectmap',
  );
  for (const row of report.rows) {
    assert.equal(typeof row.otmFloor, 'string');
    assert.ok(row.otmCeiling === null || typeof row.otmCeiling === 'string');
    assert.ok(row.strikeFloor === null || typeof row.strikeFloor === 'string');
  }
  // 🚨 顶档 MUST 开口（`otmCeiling === null`）—— 极深价外腿掉出网格会让求和恒等式静默对不上账。
  const top = report.rows[report.rows.length - 1];
  assert.ok(top !== undefined && top.otmCeiling === null, '顶档开口吸收其上全部腿');
  assert.equal(top.strikeFloor, null, '顶档无行权价下界');
}

/**
 * 🚨 靶心 ②：响应里**没有色阶档字段**（plan `D-BAND-1`：色阶住 client）。
 * 判据按**独立键名**扫，🚫 不用裸 `includes('band')` —— 那会被 `inRecallBand` 误伤，
 * 而它只是靠大小写躲过；靠大小写巧合成立的判据不算判据。
 */
function assertNoBandFieldOnTheWire(report: ChainReportResponse): void {
  const wire = JSON.stringify(report);
  assert.ok(!/"bands?":/.test(wire), '🚨 响应内不得出现 `band` / `bands` 键（色阶住客户端）');
  // 正向控制：召回段覆盖这个**别的**字段确实在，说明上面那条扫的不是一张空网。
  assert.ok(/"inRecallBand":/.test(wire), 'inRecallBand 仍在（它是召回段覆盖，不是色阶档）');
}

/**
 * 🚨 `FR-022` / `FR-023`：跨现价两侧插值；**只有一侧有档 ⇒ `null`（曲线断开）**，
 * 🚫 MUST NOT 回落最近档。fixture 里近期那个到期日只种了 spot 下方一档。
 */
function assertAtmIvBreaksInsteadOfFallingBack(report: ChainReportResponse): void {
  // 🚨 **逐列钉死**：DTE 10 与 120 各自只有现价**一侧**有档 ⇒ 断点；DTE 45 两侧齐（K=105 iv 25
  //    与 K=95 iv 35），而现价 100 恰在两档正中 ⇒ 线性插值的精确解就是 **30**。
  //    「取最近档」那种实现在这里会给出 25 或 35 —— 一个精确值把它和插值分得开，
  //    而写成「落在 25–35 之间」的区间断言对它**恒真**（`FR-022` 明令禁止的正是回落最近档）。
  assert.deepEqual(
    report.columns.map((c) => [c.dteDays, c.atmIv]),
    [
      [10, null],
      [45, 30],
      [120, null],
    ],
    '🚨 单侧有档 ⇒ null（曲线断开，禁回落最近档）；两侧齐 ⇒ 线性插值精确解 30',
  );
  // 列轴按到期日升序，且**不分箱**（`FR-003`）—— 上面那张表同时钉住了序与条数。
  assert.equal(report.columns.length, 3, '链上三个实际到期日，一个不多一个不少');
}

/**
 * 🚨 靶心 ⑤：`FR-031` —— 报表的 IV 分位块**整份复用 046 那一份读端**，两个端点逐字节同形。
 * 各写各的投影会长出「报表说 missing、详情说 unavailable」这种两屏对不上的形态。
 */
async function assertIvBlockIsByteIdenticalToDetail(
  cfg: Cfg,
  report: ChainReportResponse,
): Promise<void> {
  const detail = await optionsdeskControllerUnderlyingDetail(encodeURIComponent(REPORT), cfg);
  assert.equal(detail.status, 200, `detail expected 200, got ${detail.status}`);
  assert.deepEqual(report.iv, detail.data.iv, '🚨 两个端点的 IV 读数逐字节同形（同一份投影）');
  assert.deepEqual(
    Object.keys(report.iv).sort(),
    ['aggregateIv', 'asOf', 'freshnessTier', 'ivPercentile', 'state'],
    '🚨 键集恰好五个 —— vendor 的 IVR（iv_rank）不得上屏（046 FR-013）',
  );
}

/** `FR-037a`：未建锚 ⇒ 报表不可达，且用**带机器可读 code 的 404** 表达（不是空报表）。 */
async function assertNoAnchorIs404(cfg: Cfg): Promise<void> {
  const res = await optionsdeskControllerChainReport(encodeURIComponent(NO_ANCHOR), {
    ...cfg,
    validateStatus: () => true,
  });
  assert.equal(res.status, 404, `未建锚的票 expected 404, got ${res.status}`);
  const body = res.data as unknown as { code?: string };
  assert.equal(body.code, 'ANCHOR_NOT_FOUND_FOR_SYMBOL', '404 带机器可读 code（客户端据此判别）');
}

// ══════════════════════ 种库 / 清理 ══════════════════════

async function seed(ctx: RealBackendCtx, today: string): Promise<void> {
  await deleteSeed(ctx, today); // 防上轮异常退出未走 cleanup
  const d = (offset: number): string => plusDays(today, offset);

  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status)
     VALUES ('${MARKET}', '${CODE_REPORT}', '055 契约冒烟 链分析报表', 'stock', 'USD', 'listed')`,
  );
  const iid = `(SELECT id FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE_REPORT}')`;

  // 交易日历含未来日 —— 新鲜度档两侧都可达（同 047 契约冒烟的理由）。
  await ctx.execSql(
    `INSERT INTO marketdata.trading_day (market, date)
     SELECT '${MARKET}', g::date
     FROM generate_series(DATE '${d(-10)}', DATE '${d(10)}', INTERVAL '1 day') AS g
     ON CONFLICT DO NOTHING`,
  );

  // 标的 IV 日线 —— 报表页头那块分位读数（复用 046 读端）。
  await ctx.execSql(
    `INSERT INTO marketdata.underlying_iv_daily (instrument_id, date, iv, iv_rank, iv_percentile)
     VALUES (${iid}, DATE '${d(-1)}', 26.00000000, 40.0000, 44.0000),
            (${iid}, DATE '${today}', 28.40000000, 88.0000, 58.0000)`,
  );

  // 合约集：中期（d+45）四条含跨现价两侧 ⇒ ATM 插得出；近期（d+10）只有下方一档 ⇒ 断点。
  await ctx.execSql(
    `INSERT INTO marketdata.option_contract
       (market, code, root, underlying_instrument_id, expiry_date, strike_price, option_type, is_standard)
     VALUES
       ('${MARKET}', '${ITM}', '${CODE_REPORT}', ${iid}, DATE '${d(45)}', 105.0000, 'PUT', true),
       ('${MARKET}', '${NEAR}', '${CODE_REPORT}', ${iid}, DATE '${d(45)}', 95.0000, 'PUT', true),
       ('${MARKET}', '${MID}', '${CODE_REPORT}', ${iid}, DATE '${d(45)}', 85.0000, 'PUT', true),
       ('${MARKET}', '${DEAD}', '${CODE_REPORT}', ${iid}, DATE '${d(45)}', 88.0000, 'PUT', true),
       ('${MARKET}', '${CHEAP}', '${CODE_REPORT}', ${iid}, DATE '${d(45)}', 60.0000, 'PUT', true),
       ('${MARKET}', '${DEEP_ITM}', '${CODE_REPORT}', ${iid}, DATE '${d(45)}', 130.0000, 'PUT', true),
       ('${MARKET}', '${FAR}', '${CODE_REPORT}', ${iid}, DATE '${d(120)}', 75.0000, 'PUT', true),
       ('${MARKET}', '${SHORT}', '${CODE_REPORT}', ${iid}, DATE '${d(10)}', 95.0000, 'PUT', true)`,
  );
  const cid = (code: string): string =>
    `(SELECT id FROM marketdata.option_contract WHERE market = '${MARKET}' AND code = '${code}')`;

  // 🚨 `oi_as_of` 蓄意比 `session_date` 早一天（美股期权 OI 盘前更新）——「活跃度那一格是哪天的」
  //    这条契约只有在两者不同日时才验得到。
  await ctx.execSql(
    `INSERT INTO marketdata.option_daily_snapshot
       (contract_id, session_date, source, quote_as_of, oi_as_of, bid, ask, iv, delta,
        open_interest, volume, underlying_spot, greeks_complete)
     VALUES
       -- 跨现价两侧各一档（IV 25 / 35）⇒ 中期那一列 ATM 插得出，且结果必落在两者之间。
       (${cid(ITM)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        8.0000, 8.6000, 25.00000000, -0.62000000, 1500, 120, ${SPOT}, true),
       (${cid(NEAR)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        2.0000, 2.2000, 35.00000000, -0.32000000, 4200, 300, ${SPOT}, true),
       (${cid(MID)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        1.0000, 1.2000, 38.00000000, -0.18000000, 900, 60, ${SPOT}, true),
       -- 🚨 计数③：过了权利金门槛、也在行内，但 OI 与成交量双零 ⇒「没人碰过」。
       (${cid(DEAD)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        0.9000, 1.1000, 37.00000000, -0.20000000, 0, 0, ${SPOT}, true),
       -- 🚨 计数①：bid 低于权利金门槛 ⇒ 整条移出骨架（连行轴都轮不到它）。
       (${cid(CHEAP)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        0.0500, 0.1000, 45.00000000, -0.04000000, 300, 20, ${SPOT}, true),
       -- 🚨 计数②：深价内 30% ⇒ 落在行轴下界（价内 10%）之外。ask > 内在价值 30，不触自洽硬门。
       (${cid(DEEP_ITM)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        30.5000, 31.5000, 22.00000000, -0.92000000, 700, 30, ${SPOT}, true),
       (${cid(FAR)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        1.4000, 1.7000, 30.00000000, -0.15000000, 1100, 45, ${SPOT}, true),
       -- 🚨 近期那一列**只有现价下方**这一档 ⇒ ATM IV 插值不可得（曲线断点，禁回落最近档）。
       (${cid(SHORT)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${d(-1)}',
        0.6000, 0.7500, 33.00000000, -0.28000000, 800, 55, ${SPOT}, true)`,
  );
}

async function deleteSeed(ctx: RealBackendCtx, today: string): Promise<void> {
  // instrument 删除 CASCADE 带走 option_contract → option_daily_snapshot 与 underlying_iv_daily。
  await ctx.execSql(
    `DELETE FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE_REPORT}'`,
  );
  await ctx.execSql(
    `DELETE FROM marketdata.trading_day
     WHERE market = '${MARKET}' AND date BETWEEN DATE '${plusDays(today, -10)}' AND DATE '${plusDays(today, 10)}'`,
  );
}

async function createAnchor(cfg: Cfg, ticker: string, today: string): Promise<string> {
  const created = await optionsdeskControllerCreate(
    {
      ticker,
      v: V,
      asof: plusDays(today, -30),
      method: 'DCF · 055 契约冒烟',
      confidence: CONFIDENCE,
      nextReview: plusDays(today, 120),
    },
    cfg,
  );
  assert.equal(created.status, 201, `create ${ticker} expected 201, got ${created.status}`);
  return created.data.id;
}

/** 交易所的今天（America/New_York）—— 与 server 的业务日口径同源。 */
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
