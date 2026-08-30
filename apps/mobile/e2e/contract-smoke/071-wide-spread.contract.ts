/**
 * 071 宽价差机会标 —— `wideSpreadOpportunity` 在**收盘档收租视角**真落的契约冒烟
 * （Constitution §V 两层之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的真 server（testcontainers PG），跑一条
 * happy path：**建锚 → 灌一期收盘快照（三条判别腿）→ 拉收租 / 全腿两个视角**。
 *
 * 🚨 本片三条只有端到端才验得到的靶心：
 *   1. **机会腿真进收租视角且带标**（FR-001/FR-005）：071 之前 `rel > 0.35` 的腿在这个视角
 *      上压根不存在 —— 「它在不在」这件事跨了召回层、use case、DTO 三段，只有真响应答得了。
 *   2. **标可解释**（SC-005）：带标行 MUST 同时给得出 `bid` / `ask` / `relativeSpread`，
 *      且 `relativeSpread > 0.35` —— 标本身只说「怎么进来的」，证据要人能从屏幕上反推。
 *      三列任一为空，那枚标在界面上就是一个无从解释的记号。
 *   3. **判别性 + 零回归**（FR-003/US3）：同批里那条**年化同样达档但价差窄**的腿 MUST 标
 *      为 `false`（标不是「年化 ≥ 档」的同义词）；不达档的宽腿 MUST 不在收租视角里；
 *      全腿视角照常可达且全部无标（该视角不设点差上界 ⇒ 机会支恒不触发）。
 *
 * 📌 与 070 契约冒烟的分工：那一片验 `march` / `marchMode` 的形态，本片只验腿级这一个布尔
 *    与它的证据面；🚫 不在这里重复一份判决断言。
 *
 * 边界与幂等：专属 ticker `us:NVYY`（避开既有 NVYA..NVYX）；marketdata 事实表靠
 * `ctx.execSql` 直插，锚走公开写端点建 / 末尾 DELETE 自清理。
 */
import assert from 'node:assert/strict';
import {
  optionsdeskControllerCreate,
  optionsdeskControllerLegs,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { LegResponse, LegTableResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-wide-spread (071)';

type Cfg = { baseURL: string; headers: Record<string, string> };

const MARKET = 'us';
const CODE = 'NVYY';
const SYMBOL = `${MARKET}:${CODE}`;

const V = '100.0000';
const CONFIDENCE = '8.0';
/** spot 70 ⇒ W = 80 ⇒ axis = min(70, 80) = 70 ⇒ 成色上界 = 70 × 1.03 = 72.1（链上无 K ≥ 70）。 */
const SPOT = '70.0000';
const QUOTE_TIME = 'T20:15:00.000Z';

interface SeedQuote {
  readonly code: string;
  readonly strike: string;
  readonly dte: number;
  readonly bid: string;
  readonly ask: string;
  readonly delta: string;
}

/**
 * 三条腿一次铺齐判别面（`年化 = bid/(K−bid) × 365/DTE`，DTE 全落收租段 `[30,365]`）：
 *
 * | 腿   | K  | 相对价差 | bid 年化 | 期望                                        |
 * | ---- | -- | -------- | -------- | ------------------------------------------- |
 * | NARROW | 65 | 0.049 | 19.3% | 主支就过 ⇒ 在表内、**无标**（判别性关键腿）  |
 * | OPP    | 68 | 1.000 | 18.4% | 主支不过 + 机会支成立 ⇒ 放行**带标**         |
 * | THIN   | 64 | 1.692 |  4.8% | 两支都不过 ⇒ 不在收租视角                    |
 *
 * 🚨 `NARROW` 的年化同样达档 —— 把标的判据误写成只看年化，它会跟着带标而**表照样渲染得出来**。
 */
const SEED: readonly SeedQuote[] = [
  {
    code: 'US.NVYY.NARROW',
    strike: '65.0000',
    dte: 60,
    bid: '2.0000',
    ask: '2.1000',
    delta: '-0.20000000',
  },
  {
    code: 'US.NVYY.OPP',
    strike: '68.0000',
    dte: 60,
    bid: '2.0000',
    ask: '6.0000',
    delta: '-0.25000000',
  },
  {
    code: 'US.NVYY.THIN',
    strike: '64.0000',
    dte: 60,
    bid: '0.5000',
    ask: '6.0000',
    delta: '-0.15000000',
  },
];

const legOf = (table: LegTableResponse, code: string): LegResponse | undefined =>
  table.legs.find((l) => l.code === code);

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const today = exchangeToday(new Date());

  await seed(ctx, today);
  let anchorId: string | null = null;
  try {
    anchorId = await createAnchor(cfg);

    // ── 靶心 1: 机会腿真进收租视角且带标 ────────────────────────────────────
    const rent = await legs(cfg, 'rent');
    assert.equal(rent.state, 'available', `收租视角应就绪, got ${rent.state}`);
    const opp = legOf(rent, 'US.NVYY.OPP');
    assert.ok(opp, '机会腿不在收租视角 —— 071 放行没生效（071 之前它本就不在，别读成"没回归"）');
    assert.ok(
      'wideSpreadOpportunity' in opp,
      '腿缺 wideSpreadOpportunity 键 —— undefined 被序列化吞掉了',
    );
    assert.equal(opp.wideSpreadOpportunity, true, '机会腿 MUST 带标');

    // ── 靶心 2: 标可解释（SC-005）——三列证据齐全且价差真的宽 ────────────────
    assert.ok(opp.bid !== null, '带标行缺 bid —— 标说的正是"按 bid 卖出仍达档"');
    assert.ok(opp.ask !== null, '带标行缺 ask —— 没有它"市场很宽"这句话无从确认');
    assert.ok(opp.relativeSpread !== null, '带标行缺 relativeSpread —— 那枚标就没有证据面');
    assert.ok(
      Number(opp.relativeSpread) > 0.35,
      `带标行的相对价差应 > 系统默认上界, got ${opp.relativeSpread}`,
    );

    // ── 靶心 3: 判别性 + 零回归 ─────────────────────────────────────────────
    const narrow = legOf(rent, 'US.NVYY.NARROW');
    assert.ok(narrow, '窄价差腿应照常在收租视角');
    assert.equal(
      narrow.wideSpreadOpportunity,
      false,
      '窄价差腿年化同样达档但 MUST NOT 带标 —— 标不是"年化 ≥ 档"的同义词',
    );
    assert.equal(
      legOf(rent, 'US.NVYY.THIN'),
      undefined,
      '不达档的宽价差腿 MUST 维持出局（既有语义逐字不变）',
    );

    const all = await legs(cfg, 'all');
    assert.equal(all.state, 'available', `全腿视角应就绪, got ${all.state}`);
    for (const seedLeg of SEED) {
      const row = legOf(all, seedLeg.code);
      assert.ok(row, `全腿视角应逐条可达: ${seedLeg.code}`);
      assert.equal(
        row.wideSpreadOpportunity,
        false,
        `全腿视角不设点差上界 ⇒ 机会支恒不触发: ${seedLeg.code}`,
      );
    }
  } finally {
    if (anchorId !== null) {
      const del = await optionsdeskControllerRemove(anchorId, cfg);
      assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
    }
    await deleteSeed(ctx);
  }
}

async function legs(cfg: Cfg, perspective: 'rent' | 'build' | 'all'): Promise<LegTableResponse> {
  const res = await optionsdeskControllerLegs(SYMBOL, { perspective }, cfg);
  assert.equal(res.status, 200, `legs ${SYMBOL} ${perspective} expected 200, got ${res.status}`);
  return res.data;
}

async function seed(ctx: RealBackendCtx, today: string): Promise<void> {
  await deleteSeed(ctx); // 防上轮异常退出未走 cleanup

  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status)
     VALUES ('${MARKET}', '${CODE}', '071 契约冒烟 宽价差机会', 'stock', 'USD', 'listed')`,
  );
  const iid = `(SELECT id FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE}')`;

  await ctx.execSql(
    `INSERT INTO marketdata.trading_day (market, date)
     SELECT '${MARKET}', g::date
     FROM generate_series(DATE '${plusDays(today, -10)}', DATE '${plusDays(today, 200)}', INTERVAL '1 day') AS g
     ON CONFLICT DO NOTHING`,
  );

  const contracts = SEED.map(
    (s) =>
      `('${MARKET}', '${s.code}', '${CODE}', ${iid}, DATE '${plusDays(today, s.dte)}', ` +
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
      `(${cid(s.code)}, DATE '${today}', 'eod', TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${plusDays(today, -1)}', ` +
      `${s.bid}, ${s.ask}, 20, 21, 0.25000000, ${s.delta}, 900, 40, ${SPOT}, true)`,
  ).join(',\n       ');
  await ctx.execSql(
    `INSERT INTO marketdata.option_daily_snapshot
       (contract_id, session_date, source, quote_as_of, oi_as_of, bid, ask, bid_size, ask_size,
        iv, delta, open_interest, volume, underlying_spot, greeks_complete)
     VALUES
       ${snapshots}`,
  );
}

async function deleteSeed(ctx: RealBackendCtx): Promise<void> {
  // instrument 删除 CASCADE 带走 option_contract → option_daily_snapshot。
  await ctx.execSql(
    `DELETE FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE}'`,
  );
}

async function createAnchor(cfg: Cfg): Promise<string> {
  const today = exchangeToday(new Date());
  const created = await optionsdeskControllerCreate(
    {
      ticker: SYMBOL,
      v: V,
      asof: plusDays(today, -30),
      method: 'DCF · 071 契约冒烟',
      confidence: CONFIDENCE,
      nextReview: plusDays(today, 120),
    },
    cfg,
  );
  assert.equal(created.status, 201, `create ${SYMBOL} expected 201, got ${created.status}`);
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

function plusDays(dateOnly: string, days: number): string {
  return new Date(Date.parse(`${dateOnly}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
