/**
 * 015 marketdata 契约冒烟（PR2 §V 第二层 / ADR-0048 数据正确性归位）。
 *
 * 014 stock-detail.contract 已按「014 server 零 marketdata 耦合」把 EP3/EP4 断言移除归位到本
 * feature——015 是详情/K线数据正确性的真正 owner。本 spec 用**生成的** @nvy/api-client 函数打
 * **真 server**（harness boot 的 testcontainers 后端，mock 模式）验 marketdata 4 读端点端到端 +
 * 真落库 + 契约对齐：
 *   ① 自种 marketdata 事实表（instrument + dailyBar×N(none) + adjustmentFactor + fundamentalSnapshot
 *      + financialMetric + corporateAction，镜像 marketdata.read-detail-bars.it.spec.ts seed 体例）；
 *   ② EP3 详情：断 quote header（前收算涨跌 + 52 周高低）+ valuation + financials + corporateActions
 *      字段集，Decimal 全程 string；缺失维度 null（另一未种数据 symbol）；
 *   ③ EP4 bars：period=day 全序列 vs period=week 聚合（首开/最高/最低/末收 + 量和）+ adjust=none vs
 *      backward 读时换算序列切换（种 1 个因子跃变 → backward ≠ none）；
 *   ④ EP1 search：走 LocalInstrumentSearchAdapter（pg_trgm over 已 seed Instrument），名/拼音/代码命中；
 *   ⑤ EP2 quote：contract-smoke server 恒 mock → QUOTE_PORT = MockMarketDataAdapter（fixture，不读
 *      PG），故此处仅验 provider-independent 契约信封（200 / 入参顺序 / 字段齐 / queried-but-no-data
 *      形状 FR-S07）；EOD-backed 真落库读路径（name 取自 Instrument、price=close、change/changePct/
 *      asOf 派生）已下沉 server IT eod-backed-quote.adapter.it.spec.ts（testcontainers 真 PG）。
 *
 * 边界与幂等：用专属测试 symbol `cn:600599`（避开 mock fixture cn:600519 与其他 spec），所有种行靠
 * 固定 symbol + DELETE 末尾自清理，保证单次 boot 内顺序跑多 spec 不互相污染。事实表无公开写端点，
 * 故用 harness `ctx.execSql(...)` 直插（schema=marketdata，列名 snake_case，per schema @map）。
 */
import assert from 'node:assert/strict';
import {
  marketdataControllerBars,
  marketdataControllerDetail,
  marketdataControllerQuote,
  marketdataControllerSearch,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'marketdata (015)';

// 专属测试标的（避开 mock fixture cn:600519 与其他 contract spec 落的行）。
const MARKET = 'cn';
const CODE = '600599';
const SYMBOL = `${MARKET}:${CODE}`;
const NAME = '契约冒烟标的';
const MISSING_SYMBOL = 'cn:600588'; // 不种任何事实数据，只种 Instrument（验缺失维度 null）。

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  await seed(ctx);
  try {
    await assertDetail(cfg);
    await assertDetailMissingDimensions(cfg);
    await assertDetailNotFound(cfg);
    await assertBars(cfg);
    await assertSearch(cfg);
    await assertQuote(cfg);
  } finally {
    await cleanup(ctx);
  }
}

// ── 种库（execSql 直插事实表，无公开写端点；schema=marketdata，列名 snake_case）─────────────
async function seed(ctx: RealBackendCtx): Promise<void> {
  // 先清残留（防上轮异常退出未走 cleanup），再插 —— Instrument ON DELETE CASCADE 带走子表。
  await deleteSeed(ctx);

  // Instrument（EP1 search 经 pg_trgm 命中需 name + pinyin；listDate 验详情身份段）。
  // deleteSeed 已先清残留，故无需 ON CONFLICT（固定 symbol，单次 boot 内幂等靠先删后插）。
  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, pinyin_abbr, pinyin_full, status, list_date)
     VALUES ('${MARKET}', '${CODE}', '${NAME}', 'stock', 'CNY', 'qyhgmd', 'qiyuehuagongmaodou', 'listed', DATE '2001-08-27'),
            ('${MARKET}', '600588', '缺维度标的', 'stock', 'CNY', 'qwddmd', 'queweidumeadou', 'listed', NULL)`,
  );
  // 用子查询拿 instrument_id（execSql 不回传值，全部内联 SELECT）。
  const iid = `(SELECT id FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE}')`;

  // DailyBar none 行：05-20 = 52 周高(1850)、05-25 = 52 周低(1500)、06-02..06-05 = 同 ISO 周
  // (周/聚合) 含 OHLC，06-05 带 prev_close (报价 header 前收算涨跌)。
  await ctx.execSql(
    `INSERT INTO marketdata.daily_bar (instrument_id, trade_date, adjust, open, high, low, close, prev_close, volume, amount, turnover_rate)
     VALUES
       (${iid}, DATE '2026-05-20', 'none', 1850.0000, 1850.0000, 1850.0000, 1850.0000, NULL, NULL, NULL, NULL),
       (${iid}, DATE '2026-05-25', 'none', 1500.0000, 1500.0000, 1500.0000, 1500.0000, NULL, NULL, NULL, NULL),
       (${iid}, DATE '2026-06-02', 'none', 1600.0000, 1620.0000, 1590.0000, 1610.0000, 1500.0000, 100, 160000.00, 0.1000),
       (${iid}, DATE '2026-06-03', 'none', 1610.0000, 1660.0000, 1605.0000, 1650.0000, 1610.0000, 200, 330000.00, 0.2000),
       (${iid}, DATE '2026-06-04', 'none', 1650.0000, 1680.0000, 1640.0000, 1670.0000, 1650.0000, 150, 250000.00, 0.1500),
       (${iid}, DATE '2026-06-05', 'none', 1680.0000, 1710.0000, 1670.0000, 1700.0000, 1690.0000, 120, 204000.00, 0.1200)`,
  );

  // 单个因子跃变 (exDate 2026-06-04, f=1.1) → backward 段 B: 1(06-02/06-03) / 1.1(06-04/06-05)。
  // 据此 adjust=backward 序列 ≠ none，验 adjust 切换。
  await ctx.execSql(
    `INSERT INTO marketdata.adjustment_factor (instrument_id, ex_date, factor_backward)
     VALUES (${iid}, DATE '2026-06-04', 1.1)`,
  );

  await ctx.execSql(
    `INSERT INTO marketdata.fundamental_snapshot (instrument_id, date, pe_ttm, pb, ps, pe_pctl_y3)
     VALUES (${iid}, DATE '2026-06-05', 25.5000, 9.2000, 12.4000, 0.4200)`,
  );
  await ctx.execSql(
    `INSERT INTO marketdata.financial_metric (instrument_id, report_period, roe, eps)
     VALUES (${iid}, '2026Q1', 0.3100, 18.5000)`,
  );
  await ctx.execSql(
    `INSERT INTO marketdata.corporate_action (instrument_id, ex_date, type, payload)
     VALUES (${iid}, DATE '2026-06-20', 'dividend', '{"perShare":"30.00","currency":"CNY"}'::jsonb)`,
  );
}

async function deleteSeed(ctx: RealBackendCtx): Promise<void> {
  // Instrument 删除 ON DELETE CASCADE 连带 daily_bar / adjustment_factor / fundamental_snapshot /
  // financial_metric / corporate_action，单条 DELETE 即幂等清理本 spec 全部种行。
  await ctx.execSql(
    `DELETE FROM marketdata.instrument WHERE market = '${MARKET}' AND code IN ('${CODE}', '600588')`,
  );
}

async function cleanup(ctx: RealBackendCtx): Promise<void> {
  await deleteSeed(ctx);
}

// ── EP3 详情：报价 header + 52 周高低 + 估值 + 财务 + 公司行动 + 身份, Decimal 为 string ──────
async function assertDetail(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  const res = await marketdataControllerDetail(SYMBOL, cfg);
  assert.equal(res.status, 200, `EP3 detail expected 200, got ${res.status}`);
  const d = res.data;

  assert.equal(d.symbol, SYMBOL, 'detail: symbol canonical');
  assert.equal(d.name, NAME, 'detail: 身份 name');
  assert.equal(d.market, MARKET, 'detail: market 段');
  assert.equal(d.code, CODE, 'detail: code 段');
  assert.equal(d.currency, 'CNY', 'detail: currency');
  assert.equal(d.listDate, '2001-08-27', 'detail: listDate YYYY-MM-DD');
  assert.equal(d.delistDate, null, 'detail: 在市 delistDate null');

  // 报价 header（最近 none 行 = 06-05；无 changePct → computeChange(close,prevClose)）。
  assert.equal(d.quote.price, '1700.0000', 'detail.quote: 最新价 = 最近 close (Decimal string)');
  assert.equal(d.quote.prevClose, '1690.0000', 'detail.quote: 昨收');
  assert.equal(d.quote.change, '10.0000', 'detail.quote: change = close - prevClose');
  assert.equal(d.quote.changePct, '0.5917', 'detail.quote: changePct = 10/1690*100');
  assert.equal(d.quote.asOf, '2026-06-05', 'detail.quote: asOf = 最近 tradeDate');
  assert.equal(d.quote.priceKind, 'eod_close', 'detail.quote: priceKind V1 恒 eod_close');
  assert.equal(d.quote.hasData, true, 'detail.quote: hasData');
  // 52 周高低（近 252 日 none close max/min；含 05-20=1850 / 05-25=1500）。
  assert.equal(d.quote.fiftyTwoWeekHigh, '1850.0000', 'detail.quote: 52 周高 (max close)');
  assert.equal(d.quote.fiftyTwoWeekLow, '1500.0000', 'detail.quote: 52 周低 (min close)');

  // 估值（最近 FundamentalSnapshot；未种字段 null，验缺失维度容忍）。
  assert.ok(d.valuation, 'detail: valuation 非空');
  assert.equal(d.valuation.date, '2026-06-05', 'valuation: 快照日');
  assert.equal(d.valuation.peTtm, '25.5000', 'valuation: peTtm string');
  assert.equal(d.valuation.pb, '9.2000', 'valuation: pb');
  assert.equal(d.valuation.ps, '12.4000', 'valuation: ps');
  assert.equal(d.valuation.pePctlY3, '0.4200', 'valuation: PE 近 3 年分位');
  assert.equal(d.valuation.peStatic, null, 'valuation: 未种字段 null');

  // 财务（最近 FinancialMetric）。
  assert.ok(d.financials, 'detail: financials 非空');
  assert.equal(d.financials.reportPeriod, '2026Q1', 'financials: 报告期');
  assert.equal(d.financials.roe, '0.3100', 'financials: ROE string');
  assert.equal(d.financials.eps, '18.5000', 'financials: EPS string');
  assert.equal(d.financials.bps, null, 'financials: 未种字段 null');

  // 公司行动（exDate 降序，payload 透传）。
  assert.equal(d.corporateActions.length, 1, 'detail: 1 条公司行动');
  assert.equal(d.corporateActions[0].exDate, '2026-06-20', 'corporateAction: exDate');
  assert.equal(d.corporateActions[0].type, 'dividend', 'corporateAction: type');
  assert.deepEqual(
    d.corporateActions[0].payload,
    { perShare: '30.00', currency: 'CNY' },
    'corporateAction: payload 透传',
  );
}

// 缺失维度：仅种 Instrument 身份, 无任何 DailyBar/估值/财报/公司行动 → 全 null/空, 200 不报错。
async function assertDetailMissingDimensions(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  const res = await marketdataControllerDetail(MISSING_SYMBOL, cfg);
  assert.equal(res.status, 200, `EP3 missing-dim expected 200, got ${res.status}`);
  const d = res.data;
  assert.equal(d.quote.price, null, 'missing-dim: price null');
  assert.equal(d.quote.hasData, false, 'missing-dim: hasData false');
  assert.equal(d.quote.fiftyTwoWeekHigh, null, 'missing-dim: 52 周高 null');
  assert.equal(d.quote.fiftyTwoWeekLow, null, 'missing-dim: 52 周低 null');
  assert.equal(d.valuation, null, 'missing-dim: valuation null');
  assert.equal(d.financials, null, 'missing-dim: financials null');
  assert.deepEqual(d.corporateActions, [], 'missing-dim: corporateActions 空数组');
}

// 未知 symbol → 404 INSTRUMENT_NOT_FOUND (axios 抛, 校验状态码 + body code)。
async function assertDetailNotFound(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  await assert.rejects(
    () => marketdataControllerDetail('cn:999999', cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number; data?: { code?: string } } };
      assert.equal(e.response?.status, 404, 'EP3 未知 symbol → 404');
      assert.equal(e.response?.data?.code, 'INSTRUMENT_NOT_FOUND', 'EP3 404 code');
      return true;
    },
  );
}

// ── EP4 bars：period 切换 (day 全序列 / week 聚合) + adjust 切换 (none / backward 读时换算) ──
async function assertBars(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  // adjust=none + period=day：直读物化行全序列 (6 根, tradeDate 升序)。
  const day = await marketdataControllerBars(SYMBOL, { adjust: 'none', period: 'day' }, cfg);
  assert.equal(day.status, 200, `EP4 day expected 200, got ${day.status}`);
  assert.equal(day.data.adjust, 'none', 'EP4 day: adjust 回显 none');
  assert.equal(day.data.period, 'day', 'EP4 day: period 回显 day');
  assert.equal(day.data.items.length, 6, 'EP4 day: 6 根全序列');
  assert.deepEqual(
    day.data.items.map((b) => b.tradeDate),
    ['2026-05-20', '2026-05-25', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'],
    'EP4 day: tradeDate 升序',
  );
  const last = day.data.items[day.data.items.length - 1];
  assert.equal(last.close, '1700.0000', 'EP4 day: 末根 close Decimal string');
  assert.equal(last.volume, '120', 'EP4 day: volume 整数原标度');

  // period=week：同 ISO 周 06-02..06-05 聚合为一桶 (首开/最高/最低/末收 + 量和)。
  const week = await marketdataControllerBars(SYMBOL, { adjust: 'none', period: 'week' }, cfg);
  assert.equal(week.data.period, 'week', 'EP4 week: period 回显 week');
  // 周桶数 < 日序列数 (05-20 周 / 05-25 周 / 06-02..06-05 周 = 3 桶)。
  assert.ok(
    week.data.items.length < day.data.items.length,
    `EP4 week: 聚合后桶数(${week.data.items.length}) < 日序列(${day.data.items.length})`,
  );
  const tradingWeek = week.data.items.find((b) => b.tradeDate === '2026-06-05');
  assert.ok(tradingWeek, 'EP4 week: 含 06-02..06-05 周桶 (末交易日 06-05)');
  assert.equal(tradingWeek.open, '1600.0000', 'EP4 week: 桶首开 (06-02 open)');
  assert.equal(tradingWeek.high, '1710.0000', 'EP4 week: 区间最高 (06-05 high)');
  assert.equal(tradingWeek.low, '1590.0000', 'EP4 week: 区间最低 (06-02 low)');
  assert.equal(tradingWeek.close, '1700.0000', 'EP4 week: 桶末收 (06-05 close)');
  assert.equal(tradingWeek.volume, '570', 'EP4 week: 量和 (100+200+150+120)');

  // adjust=backward：读时换算 (因子 06-04 f=1.1) → 06-04/06-05 段 ×1.1, 06-02/06-03 段 ×1。
  // 因 forward=backward÷B_latest，backward 系列 ≠ none 系列 (验 adjust 切换真生效)。
  const bwd = await marketdataControllerBars(SYMBOL, { adjust: 'backward', period: 'day' }, cfg);
  assert.equal(bwd.data.adjust, 'backward', 'EP4 backward: adjust 回显 backward');
  assert.equal(bwd.data.items.length, 6, 'EP4 backward: 同 6 根');
  const bwdCloses = bwd.data.items.map((b) => b.close);
  const noneCloses = day.data.items.map((b) => b.close);
  assert.notDeepEqual(bwdCloses, noneCloses, 'EP4 backward: 复权序列 ≠ none 序列 (因子换算生效)');
  // 06-05 在最新段 (B_latest=1.1) → backward close = 1700×1.1 = 1870.0000。
  const bwdLast = bwd.data.items[bwd.data.items.length - 1];
  assert.equal(bwdLast.tradeDate, '2026-06-05', 'EP4 backward: 末根 06-05');
  assert.equal(bwdLast.close, '1870.0000', 'EP4 backward: 末根 close = 1700×1.1');
  // 06-02 在前段 (B=1) → backward = none = 1610.0000。
  const bwdFirstTrading = bwd.data.items.find((b) => b.tradeDate === '2026-06-02');
  assert.ok(bwdFirstTrading, 'EP4 backward: 含 06-02');
  assert.equal(bwdFirstTrading.close, '1610.0000', 'EP4 backward: 06-02 前段 ×1 = none');

  // 空区间 → 空 items (200, 非 5xx)。
  const empty = await marketdataControllerBars(
    SYMBOL,
    { adjust: 'none', period: 'day', from: '2099-01-01' },
    cfg,
  );
  assert.equal(empty.status, 200, 'EP4 空区间 200');
  assert.deepEqual(empty.data.items, [], 'EP4 空区间: 空 items');
}

// ── EP1 search：mock 模式走 LocalInstrumentSearchAdapter (pg_trgm over seeded Instrument) ──────
async function assertSearch(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  // 拼音 abbr 命中 (LocalInstrumentSearchAdapter 查 pinyin_abbr/name/code)。
  const byPinyin = await marketdataControllerSearch({ q: 'qyhgmd' }, cfg);
  assert.equal(byPinyin.status, 200, `EP1 search expected 200, got ${byPinyin.status}`);
  assert.ok(
    byPinyin.data.items.some((it) => it.symbol === SYMBOL && it.name === NAME),
    'EP1 search: 拼音 abbr 命中已 seed Instrument',
  );

  // 代码命中。
  const byCode = await marketdataControllerSearch({ q: CODE }, cfg);
  assert.equal(byCode.status, 200, 'EP1 search by code 200');
  assert.ok(
    byCode.data.items.some((it) => it.symbol === SYMBOL),
    'EP1 search: 代码命中',
  );

  // 无命中 → 空 items (200, 非 5xx)。
  const none = await marketdataControllerSearch({ q: 'zzzznonexistentxyz' }, cfg);
  assert.equal(none.status, 200, 'EP1 search no-hit 200');
  assert.deepEqual(none.data.items, [], 'EP1 search: 无命中空 items');
}

// ── EP2 quote：EOD-backed 读 PG (真落库) — 种 symbol 正路报价；未种 symbol no-data 形状 ───────
async function assertQuote(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  // contract-smoke server 恒 mock → QUOTE_PORT = MockMarketDataAdapter (不读 PG)。故此处只验
  // provider-independent 契约信封: 200 / 入参顺序 / 信封字段齐 / queried-but-no-data 形状。
  // EOD-backed 真落库读路径 (name/price/change/changePct/asOf 派生) 已下沉 server IT
  // apps/server/src/marketdata/eod-backed-quote.adapter.it.spec.ts (testcontainers 真 PG)。
  const res = await marketdataControllerQuote({ symbols: `${SYMBOL},cn:999999` }, cfg);
  assert.equal(res.status, 200, `EP2 quote expected 200, got ${res.status}`);
  assert.equal(res.data.items.length, 2, 'EP2: 2 symbol 2 项 (按入参顺序)');

  // 入参顺序保持 + 报价信封字段齐 (契约形状, 不验 PG 派生值)。
  const first = res.data.items[0];
  assert.equal(first.symbol, SYMBOL, 'EP2: 首项符入参顺序');
  for (const k of [
    'symbol',
    'name',
    'price',
    'change',
    'changePct',
    'asOf',
    'priceKind',
    'hasData',
  ]) {
    assert.ok(k in first, `EP2: 报价信封含字段 ${k}`);
  }
  assert.equal(first.priceKind, 'eod_close', 'EP2: priceKind V1 恒 eod_close');

  // queried-but-no-data 形状 (provider-independent 契约): 价格维度全 null, hasData false。
  const noData = res.data.items[1];
  assert.equal(noData.symbol, 'cn:999999', 'EP2: 次项符入参顺序');
  assert.equal(noData.hasData, false, 'EP2: 无数据 hasData false');
  assert.equal(noData.price, null, 'EP2: no-data price null');
  assert.equal(noData.asOf, null, 'EP2: no-data asOf null');
  assert.equal(noData.priceKind, 'eod_close', 'EP2: no-data priceKind 仍 eod_close');
}
