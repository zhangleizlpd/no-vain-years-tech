/**
 * 046 optionsdesk 标的详情 + 波动温度计 契约冒烟（Constitution §V 两层验证之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的**真 server**（testcontainers PG），验两个新读端
 * `GET /optionsdesk/underlyings/{symbol}` 与 `GET /optionsdesk/thermometer` 的**契约对齐 + 真落库**。
 *
 * 补的是**另两层各自看不见的缝**：
 *   ① hermetic e2e（T024）把响应 mock 掉了 —— 它验的是「拿到这形状后 UI 怎么画」，形状本身由
 *      fixture 保证，server 换了字段名 / 序列化标度它照样绿；
 *   ② server IT（T016 / T018）打的是真 server，但断言写在**手写的 DTO 期望**上 —— 与 mobile 实际
 *      消费的那份**生成客户端类型**是两条独立的手抄链，orval 生成出别的形状不会有人红。
 *   本 spec 走的是消费端真实代码路径（生成 fn → axios → 真 server → 真 Prisma → 真 PG），两侧同时钉。
 *
 * 🚨 本片四条「只有端到端才验得到」的靶心（各自都是 server IT 的手写断言天然覆盖不到的）：
 *   1. **两个 asOf 相互独立**（FR-020）—— 同一响应里锚侧 `lastCloseDate` 为 null（未采行情）而
 *      IV 侧 `asOf` 有值。合成一个「页面 asOf」在任何单侧断言里都看不出错。
 *   2. **同一事实两个端点逐字节同形**（`toUnderlyingIvReadoutResponse` 单源）—— 详情的 `iv` 与温度计
 *      对应行的 `iv` 直接 `deepEqual`。各写各的投影会长出「详情说 missing、列表说 unavailable」。
 *   3. **`ivRank` 不得上屏**（FR-013）—— 库里**故意种了** `iv_rank`，断言响应 `iv` 的键集恰好四个。
 *      将来谁把 IVR 加进 `select`，这里立红。
 *   4. **VVIX/VIX 比在 server 算且带基准判定**（FR-016）—— 把 VVIX 推到比 VIX 新一天，比值必须
 *      **不计算**并回 `basis_mismatch`。这条纪律若漏到客户端，每个消费方都会各自悄悄算出跨日比值。
 *
 * 边界与幂等：用**专属 ticker** `us:NVYQ/R/S/T`（避开 045 的 `us:NVYX` 与 T024 hermetic 的
 * `us:AOS`/`us:PEP`，也避开 mock fixture），marketdata 事实表无公开写端点 ⇒ 靠 `ctx.execSql` 直插
 * （schema=marketdata，列名 snake_case per `@map`），锚走公开写端点建 / 末尾 DELETE 自清理 ——
 * 同一次 boot 内顺序跑多 spec 不互相污染。
 */
import assert from 'node:assert/strict';
import {
  optionsdeskControllerCreate,
  optionsdeskControllerRadar,
  optionsdeskControllerRemove,
  optionsdeskControllerThermometer,
  optionsdeskControllerUnderlyingDetail,
} from '@nvy/api-client';
import type {
  ThermometerResponse,
  UnderlyingIvReadoutResponse,
  UsIndexReadoutResponse,
  VvixVixRatioResponse,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-detail-thermometer (046)';

type Cfg = { baseURL: string; headers: Record<string, string> };

/** 表盘三块（与逐票列表正交的那一半）—— 抽出来供「建锚前后逐字节相同」对照。 */
interface Gauges {
  vix: UsIndexReadoutResponse;
  vvix: UsIndexReadoutResponse;
  vvixVixRatio: VvixVixRatioResponse;
}

// ── 专属标的（canonical `market:code`）——四只各自钉一条 IV 读数分支 ──────────────────────────
const MARKET = 'us';
/** 有锚 + 已注册 + 快照带分位 ⇒ `available`。 */
const CODE_AVAILABLE = 'NVYQ';
/** 有锚 + 已注册 + 快照分位为 NULL ⇒ `percentile_unavailable`；同时 `excluded=true`。 */
const CODE_NO_PCTL = 'NVYR';
/** 有锚但**未注册进 marketdata** ⇒ `missing`（事实，不是故障）。 */
const CODE_UNREGISTERED = 'NVYS';
/** 压根没建锚 ⇒ 404 `ANCHOR_NOT_FOUND_FOR_SYMBOL`。 */
const CODE_NO_ANCHOR = 'NVYT';

const AVAILABLE = `${MARKET}:${CODE_AVAILABLE}`;
const NO_PCTL = `${MARKET}:${CODE_NO_PCTL}`;
const UNREGISTERED = `${MARKET}:${CODE_UNREGISTERED}`;
const NO_ANCHOR = `${MARKET}:${CODE_NO_ANCHOR}`;
const SEEDED_CODES = `'${CODE_AVAILABLE}', '${CODE_NO_PCTL}'`;

// ── 业务日（美股业务日；三张表的 asOf 一律取**数据自身的日期**，不是采集日）──────────────────
const PREV_DAY = '2026-07-30';
/** VIX / VVIX / IV 快照共同的最新一期 ⇒ 比值同基准可算。 */
const BASIS_DAY = '2026-07-31';
/** 只推 VVIX 到这天 ⇒ 两侧不同基准，比值必须不计算。 */
const NEWER_DAY = '2026-08-03';

// 锚：V=100、confidence 8.0（映射档 L2）——派生链与 045 契约冒烟同口径。
const V = '100.0000';
const CONFIDENCE = '8.0';
const EXCLUDE_REASON = '契约冒烟：交易意愿排除';

// 指数（VIX 带全 OHLC；VVIX **只有 close**，其余列 NULL —— FR-025 禁填 0）。
const VIX_CLOSE = '20.0000';
const VVIX_CLOSE = '100.0000';
/** VVIX ÷ VIX = 100/20（`decimal4` 定标） */
const RATIO = '5.0000';

// IV 快照（vendor 原样存百分数，per schema 注释：25.5 = 25.5%）。
const IV_LATEST = '35.50000000';
const IVP_LATEST = '68.5000';
const IV_NO_PCTL = '42.00000000';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  await seed(ctx);
  // FR-027 的读端半边：**建锚之前**表盘就已经可读 —— 指数那条线一眼都不看锚表。
  const gaugesBeforeAnchors = await readGauges(cfg);
  assert.equal(gaugesBeforeAnchors.vix.state, 'available', '零本片锚时 VIX 表盘照常返回');
  assert.equal(gaugesBeforeAnchors.vvix.state, 'available', '零本片锚时 VVIX 表盘照常返回');

  const anchorIds: string[] = [];
  try {
    anchorIds.push(await createAnchor(cfg, AVAILABLE));
    anchorIds.push(await createAnchor(cfg, NO_PCTL, { excluded: true }));
    anchorIds.push(await createAnchor(cfg, UNREGISTERED));

    const ivOfAvailable = await assertDetailAvailable(cfg);
    await assertDetailPercentileUnavailable(cfg);
    await assertDetailMissing(cfg);
    await assertDetailNotFound(cfg);
    await assertThermometer(cfg, gaugesBeforeAnchors, ivOfAvailable);
    await assertExcludedStaysHereButNotOnRadar(cfg);
    await assertRatioBasisMismatch(ctx, cfg);
    await assertIndexMissingIsNullNotZero(ctx, cfg);
  } finally {
    for (const id of anchorIds) {
      const del = await optionsdeskControllerRemove(id, cfg);
      assert.equal(del.status, 204, `cleanup delete anchor ${id} expected 204, got ${del.status}`);
    }
    await deleteSeed(ctx);
  }
}

// ── 种库（marketdata 事实表无公开写端点 → execSql 直插；schema=marketdata，列名 snake_case）───
async function seed(ctx: RealBackendCtx): Promise<void> {
  // 先清残留（防上轮异常退出未走 cleanup），再插 —— instrument 删除 CASCADE 带走 IV 子表。
  await deleteSeed(ctx);

  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status)
     VALUES ('${MARKET}', '${CODE_AVAILABLE}', '046 契约冒烟 A', 'stock', 'USD', 'listed'),
            ('${MARKET}', '${CODE_NO_PCTL}', '046 契约冒烟 B', 'stock', 'USD', 'listed')`,
  );
  const iid = (code: string): string =>
    `(SELECT id FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${code}')`;

  // 两期快照 ⇒ 读端必须取**最近一期**（07-31），不是第一行也不是「今天那期」。
  // 🚨 `iv_rank` 故意种上：FR-013 要求 IVR 只落库不上屏，下面断言响应键集恰好四个来守它。
  await ctx.execSql(
    `INSERT INTO marketdata.underlying_iv_daily (instrument_id, date, iv, iv_rank, iv_percentile)
     VALUES (${iid(CODE_AVAILABLE)}, DATE '${PREV_DAY}', 30.00000000, 12.0000, 40.0000),
            (${iid(CODE_AVAILABLE)}, DATE '${BASIS_DAY}', ${IV_LATEST}, 99.0000, ${IVP_LATEST})`,
  );
  // 分位为 NULL = vendor 侧历史窗口不足 ⇒ 「分位不可算」，聚合 IV 与 asOf 照常出（禁 0 冒充）。
  await ctx.execSql(
    `INSERT INTO marketdata.underlying_iv_daily (instrument_id, date, iv, iv_rank, iv_percentile)
     VALUES (${iid(CODE_NO_PCTL)}, DATE '${BASIS_DAY}', ${IV_NO_PCTL}, 77.0000, NULL)`,
  );

  // VIX 两期（验取最新一期）；VVIX 单期同基准日。VVIX 的 open/high/low 存 NULL —— CBOE 那个文件
  // 只有 `DATE,VVIX` 两列，禁填 0（FR-025）；读端只 select close+date，两侧形状因此必须一致。
  await ctx.execSql(
    `INSERT INTO marketdata.us_index_daily (index_code, date, open, high, low, close)
     VALUES ('VIX', DATE '${PREV_DAY}', 18.2000, 19.0000, 18.0000, 18.5000),
            ('VIX', DATE '${BASIS_DAY}', 19.5000, 20.4000, 19.1000, ${VIX_CLOSE}),
            ('VVIX', DATE '${BASIS_DAY}', NULL, NULL, NULL, ${VVIX_CLOSE})`,
  );
}

async function deleteSeed(ctx: RealBackendCtx): Promise<void> {
  await ctx.execSql(
    `DELETE FROM marketdata.instrument WHERE market = '${MARKET}' AND code IN (${SEEDED_CODES})`,
  );
  await ctx.execSql(`DELETE FROM marketdata.us_index_daily WHERE index_code IN ('VIX', 'VVIX')`);
}

async function createAnchor(
  cfg: Cfg,
  ticker: string,
  opts?: { excluded: boolean },
): Promise<string> {
  const created = await optionsdeskControllerCreate(
    {
      ticker,
      v: V,
      asof: '2026-07-01',
      method: 'DCF · 046 契约冒烟',
      confidence: CONFIDENCE,
      nextReview: '2026-12-31',
      ...(opts?.excluded === true ? { excluded: true, excludeReason: EXCLUDE_REASON } : {}),
    },
    cfg,
  );
  assert.equal(created.status, 201, `create ${ticker} expected 201, got ${created.status}`);
  return created.data.id;
}

async function readGauges(cfg: Cfg): Promise<Gauges> {
  const res = await optionsdeskControllerThermometer(cfg);
  assert.equal(res.status, 200, `thermometer expected 200, got ${res.status}`);
  return gaugesOf(res.data);
}

function gaugesOf(data: ThermometerResponse): Gauges {
  return { vix: data.vix, vvix: data.vvix, vvixVixRatio: data.vvixVixRatio };
}

// ── 详情：available（靶心 ①「两个 asOf 相互独立」+ 靶心 ③「IVR 不上屏」）─────────────────────
async function assertDetailAvailable(cfg: Cfg): Promise<UnderlyingIvReadoutResponse> {
  const res = await optionsdeskControllerUnderlyingDetail(AVAILABLE, cfg);
  assert.equal(res.status, 200, `detail expected 200, got ${res.status}`);
  const d = res.data;

  assert.equal(d.symbol, AVAILABLE, 'detail: symbol 原样回显 canonical');

  // 锚侧 —— 与锚列表 / 雷达同一个投影，派生链走 045 的 anchor.rules 纯函数（FR-003）。
  assert.equal(d.anchor.ticker, AVAILABLE);
  assert.equal(Number(d.anchor.w), Number(V) * 0.8, 'detail.anchor: W = 0.8V');
  assert.equal(Number(d.anchor.zoneFloor), Number(V) * 0.6, 'detail.anchor: 四区间下界 = 0.6V');
  assert.equal(Number(d.anchor.zoneCeiling), Number(V) * 1.2, 'detail.anchor: 四区间上界 = 1.2V');
  assert.equal(d.anchor.lLevelEffective, 'L2', 'detail.anchor: confidence 8.0 → 映射档 L2');

  // 🎯 靶心 ①：两侧 asOf **相互独立**（FR-020）。未采行情 ⇒ 锚侧 lastCloseDate/lastClose 为 null
  // （且同生共死，禁裸数值），而 IV 侧照常带自己的业务日 —— 合成单一「页面 asOf」在这里立红。
  assert.equal(d.anchor.lastCloseDate, null, 'detail.anchor: 未采行情 ⇒ 行情 asOf null');
  assert.equal(d.anchor.lastClose, null, 'detail.anchor: 行情 asOf 缺 ⇒ lastClose 也必须 null');
  assert.equal(d.iv.asOf, BASIS_DAY, 'detail.iv: IV 侧带自己的业务日（与行情 asOf 独立）');

  // IV 侧 —— 取最近一期（07-31 而非 07-30），Decimal 全程 string 且保列自身 scale。
  assert.equal(d.iv.state, 'available', 'detail.iv: 快照齐备 ⇒ available');
  assert.equal(
    d.iv.aggregateIv,
    IV_LATEST,
    'detail.iv: 富途标的聚合 IV = Decimal(12,8) 定标 string',
  );
  assert.equal(d.iv.ivPercentile, IVP_LATEST, 'detail.iv: IVP = Decimal(8,4) 定标 string');

  // 🎯 靶心 ③：库里种了 iv_rank=99.0000，响应键集必须恰好这五个（FR-013 IVR 只落库不上屏）。
  // 📌 `freshnessTier` 是 047 T027a（#873「新鲜度档从客户端本地日期改为 server 判据」）新加的
  //    第五个键 —— 该 PR 未同步本断言，故本条自那时起一直红（contract-smoke 是 nightly 软信号、
  //    不拦 merge，所以没人看见）。这里补齐期望值，靶心本身（IVR 不上屏）不变。
  assert.deepEqual(
    Object.keys(d.iv).sort(),
    ['aggregateIv', 'asOf', 'freshnessTier', 'ivPercentile', 'state'],
    'detail.iv: 键集封闭 —— 无 ivRank / 无 hv_*（FR-013 / FR-034）',
  );

  return d.iv;
}

// ── 详情：percentile_unavailable —— 分位不可算 ≠ 分位是 0（FR-014）────────────────────────────
async function assertDetailPercentileUnavailable(cfg: Cfg): Promise<void> {
  const res = await optionsdeskControllerUnderlyingDetail(NO_PCTL, cfg);
  assert.equal(res.status, 200);
  assert.equal(res.data.iv.state, 'percentile_unavailable', 'detail.iv: 分位缺 ⇒ 显式不可算态');
  assert.equal(res.data.iv.aggregateIv, IV_NO_PCTL, 'detail.iv: 聚合 IV 照常出');
  assert.equal(res.data.iv.ivPercentile, null, 'detail.iv: 分位 null —— MUST NOT 回落成 0');
  assert.equal(res.data.iv.asOf, BASIS_DAY, 'detail.iv: asOf 照常出');
}

// ── 详情：missing —— 未注册进 marketdata 是事实（不是故障），锚卡照常 200 ─────────────────────
async function assertDetailMissing(cfg: Cfg): Promise<void> {
  const res = await optionsdeskControllerUnderlyingDetail(UNREGISTERED, cfg);
  assert.equal(res.status, 200, '跨 ctx 无数据 ⇒ 锚卡照常 200（不是 404 也不是 500）');
  assert.equal(res.data.anchor.ticker, UNREGISTERED, 'detail: 锚侧照常返回');
  assert.equal(res.data.iv.state, 'missing', 'detail.iv: 从未采到 ⇒ missing');
  assert.equal(res.data.iv.aggregateIv, null, 'detail.iv: missing ⇒ 值 null，禁 0');
  assert.equal(res.data.iv.ivPercentile, null);
  assert.equal(res.data.iv.asOf, null);
}

// ── 详情：无锚 → 404 + 机器可读 code（FR-011 前端据此渲染「建锚入口」而非错误页）──────────────
async function assertDetailNotFound(cfg: Cfg): Promise<void> {
  await assert.rejects(
    () => optionsdeskControllerUnderlyingDetail(NO_ANCHOR, cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number; data?: { code?: string } } };
      assert.equal(e.response?.status, 404, '无锚 symbol → 404');
      assert.equal(
        e.response?.data?.code,
        'ANCHOR_NOT_FOUND_FOR_SYMBOL',
        '404 body 带机器可读 code（ProblemDetail 白名单透传）',
      );
      return true;
    },
  );
}

// ── 温度计：表盘 + 逐票列表（靶心 ②「两端点同形」+ 无 regime 字段）────────────────────────────
async function assertThermometer(
  cfg: Cfg,
  gaugesBeforeAnchors: Gauges,
  ivFromDetail: UnderlyingIvReadoutResponse,
): Promise<void> {
  const res = await optionsdeskControllerThermometer(cfg);
  assert.equal(res.status, 200, `thermometer expected 200, got ${res.status}`);
  const t = res.data;

  // 表盘：各带各的 asOf（取自 CBOE 文件的 DATE 列，不是采集日），且取最新一期（07-31 而非 07-30）。
  assert.equal(t.vix.state, 'available');
  assert.equal(t.vix.close, VIX_CLOSE, 'thermometer.vix: 最新一期 close（Decimal string）');
  assert.equal(t.vix.asOf, BASIS_DAY, 'thermometer.vix: 指数自己的业务日');
  assert.equal(t.vvix.state, 'available');
  assert.equal(t.vvix.close, VVIX_CLOSE);
  assert.equal(t.vvix.asOf, BASIS_DAY);

  // 比值在 **server** 端算（每个消费方不再各实现一次），同基准 ⇒ available + 共同基准日。
  assert.equal(t.vvixVixRatio.state, 'available', 'ratio: 同基准 ⇒ 可算');
  assert.equal(t.vvixVixRatio.value, RATIO, 'ratio: VVIX ÷ VIX，server 端算好');
  assert.equal(t.vvixVixRatio.basisDate, BASIS_DAY, 'ratio: 共同基准日');

  // FR-027：建锚前后表盘三块**逐字节相同** —— 指数线不因锚表变化而变化。
  assert.deepEqual(gaugesOf(t), gaugesBeforeAnchors, 'FR-027: 表盘不依赖锚（建锚前后逐字节相同）');

  // 📌 FR-015：本响应**不含 regime 读数**（2026-08-03 拍板，mockup 帧⑦ 画过但不作数）。
  assert.ok(!('regime' in t), 'thermometer: 响应不得出现 regime 字段');

  // 逐票列表：三只锚都在（含 excluded 与「分位不可算」的），ticker 升序，total 自洽。
  assert.equal(t.total, t.underlyings.length, 'thermometer: total = 本次返回条数');
  const tickers = t.underlyings.map((u) => u.ticker);
  assert.deepEqual([...tickers].sort(), tickers, 'thermometer: ticker 升序');
  for (const ticker of [AVAILABLE, NO_PCTL, UNREGISTERED]) {
    assert.ok(tickers.includes(ticker), `thermometer: ${ticker} 在列`);
  }

  const rowAvailable = t.underlyings.find((u) => u.ticker === AVAILABLE);
  assert.ok(rowAvailable, 'thermometer: available 行存在');
  // 🎯 靶心 ②：同一事实经两个端点出来必须**逐字节同形**（共用 toUnderlyingIvReadoutResponse）。
  assert.deepEqual(
    rowAvailable.iv,
    ivFromDetail,
    '同一票的 IV 读数在详情与温度计两个端点上逐字段同形',
  );

  const rowNoPctl = t.underlyings.find((u) => u.ticker === NO_PCTL);
  assert.ok(rowNoPctl, 'thermometer: 分位不可算的行 MUST 保留在列表内（FR-018）');
  assert.equal(rowNoPctl.iv.state, 'percentile_unavailable');
  assert.equal(rowNoPctl.iv.ivPercentile, null, '禁 0 冒充');
  assert.equal(rowNoPctl.excluded, true, 'thermometer: excluded 行照常在列并带标记');
  assert.equal(rowNoPctl.excludeReason, EXCLUDE_REASON);

  const rowMissing = t.underlyings.find((u) => u.ticker === UNREGISTERED);
  assert.ok(rowMissing, 'thermometer: 未注册标的的锚也在列');
  assert.equal(rowMissing.iv.state, 'missing');
  assert.equal(rowMissing.iv.asOf, null);
}

// ── 跨端点语义对照：`excluded` 在温度计**在列**、在雷达**被排除**（045 语义，两屏相反）─────────
async function assertExcludedStaysHereButNotOnRadar(cfg: Cfg): Promise<void> {
  const radar = await optionsdeskControllerRadar(
    { limit: 50 },
    // `lLevels` 走重复键形态，本调用未传筛选，仍钉 indexes:null 与 mobile 消费端同构。
    { ...cfg, paramsSerializer: { indexes: null } },
  );
  assert.equal(radar.status, 200, `radar expected 200, got ${radar.status}`);
  assert.ok(
    !radar.data.items.some((a) => a.ticker === NO_PCTL),
    '雷达把 excluded 排除在外（交易意愿）',
  );
  assert.ok(
    radar.data.items.some((a) => a.ticker === AVAILABLE),
    '雷达照常显示未排除的锚（对照组，证明上一条不是因为雷达整体为空）',
  );
}

// ── 🎯 靶心 ④：两侧不同基准 ⇒ 比值**不计算**（FR-016，纪律留在 server 而非各消费方）────────────
async function assertRatioBasisMismatch(ctx: RealBackendCtx, cfg: Cfg): Promise<void> {
  // 把 VVIX 推到比 VIX 新一天（生产上两个独立 CBOE 文件真的会错开）。
  await ctx.execSql(
    `INSERT INTO marketdata.us_index_daily (index_code, date, close)
     VALUES ('VVIX', DATE '${NEWER_DAY}', 110.0000)`,
  );
  const res = await optionsdeskControllerThermometer(cfg);
  assert.equal(res.status, 200);
  // 两侧各自照常 available，且各带**各自的** asOf —— 这正是「基准可能不一致」的可观测形态。
  assert.equal(res.data.vix.state, 'available');
  assert.equal(res.data.vix.asOf, BASIS_DAY, 'VIX 停在自己的最新一期');
  assert.equal(res.data.vvix.state, 'available');
  assert.equal(res.data.vvix.asOf, NEWER_DAY, 'VVIX 走到了更新的一期');
  assert.equal(
    res.data.vvixVixRatio.state,
    'basis_mismatch',
    '不同基准 ⇒ 显式 basis_mismatch（既不是缺也不是故障）',
  );
  assert.equal(res.data.vvixVixRatio.value, null, '不同基准 ⇒ 不计算，MUST NOT 出一个跨日比值');
  assert.equal(res.data.vvixVixRatio.basisDate, null);
}

// ── 指数无数据 ⇒ 显式 missing + null，**禁 0**（FR-017：指针停在 0 = 错误信息而非缺失信息）────
async function assertIndexMissingIsNullNotZero(ctx: RealBackendCtx, cfg: Cfg): Promise<void> {
  await ctx.execSql(`DELETE FROM marketdata.us_index_daily WHERE index_code = 'VIX'`);
  const res = await optionsdeskControllerThermometer(cfg);
  assert.equal(res.status, 200, '一侧指数缺失 ⇒ 整页照常 200');
  assert.equal(res.data.vix.state, 'missing', 'VIX 无行 ⇒ 显式 missing');
  assert.equal(res.data.vix.close, null, 'VIX close null —— MUST NOT 回落成 0');
  assert.equal(res.data.vix.asOf, null);
  assert.equal(res.data.vvix.state, 'available', '另一侧不受连累');
  assert.equal(res.data.vvixVixRatio.state, 'missing', '缺一侧 ⇒ missing');
  assert.equal(res.data.vvixVixRatio.value, null, 'MUST NOT 拿单侧 VVIX 推算比值');
  // 逐票列表与指数线互不依赖：指数没了，锚行照常在。
  assert.ok(
    res.data.underlyings.some((u) => u.ticker === AVAILABLE),
    '指数线降级不连累逐票 IVP 列表',
  );
}
