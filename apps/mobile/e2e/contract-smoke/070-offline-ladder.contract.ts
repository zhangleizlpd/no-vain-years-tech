/**
 * 070 离线档收租阶梯 —— `march` / `marchMode` 在**收盘档**上真落的契约冒烟（Constitution §V 两层之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的真 server（testcontainers PG），跑一条
 * happy path：**建锚 → 灌一期收盘快照（同 K 三档）→ 拉三个视角的选约表**。
 *
 * 🚨 本片三条只有端到端才验得到的靶心：
 *   1. **us 收盘收租 `march` 真落**（FR-001/FR-002 的契约证据）：069 期这条路径恒 `null`，
 *      本片门控放宽后它必须长出判决 —— 判决 ∈ 三态、每条审计的类目 ∈ 13 类、且**至少一条
 *      带得出数值证据**（server 只下发结构化数值、文案在客户端，证据袋全空等于弹层无话可说）。
 *   2. **`marchMode` 有值且是真值不是缺字段**（FR-009）：`JSON.stringify` 会把 `undefined`
 *      整键删掉 ⇒ 客户端读到 `undefined` 走「没接这根线」，与「这一轮是 φ 模式」是两个状态。
 *      判据取 `'marchMode' in table`（缺字段当场红），同 069 对 `march` 的那条纪律。
 *   3. **建仓 / 全腿仍恒真 `null`**（FR-012 零改动的契约面半）——`march` 与 `marchMode` 同生共死。
 *
 * 📌 与 069 契约冒烟的分工：那一片验的是「13 类枚举经生成链传导 + 收盘档不长判决」，本片验
 *    的是同一条路径**点亮之后**的形态。069 ① 臂的语义随本片演进（收盘档恒缺省 → us 收租有值），
 *    在那个文件里就地改，🚫 不在这里重复一份。
 *
 * 边界与幂等：专属 ticker `us:NVYD`（避开 NVYA,B / NVYG,H / NVYI,K / NVYL,M,N,P / NVYQ..T /
 * NVYW,X）；marketdata 事实表靠 `ctx.execSql` 直插，锚走公开写端点建 / 末尾 DELETE 自清理。
 */
import assert from 'node:assert/strict';
import {
  LegMarchAuditResponseCategory,
  LegTableResponseMarchMode,
  optionsdeskControllerCreate,
  optionsdeskControllerLegs,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { LegTableResponse, MarchAuditEvidenceResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-offline-ladder (070)';

type Cfg = { baseURL: string; headers: Record<string, string> };

const MARKET = 'us';
const CODE = 'NVYD';
const SYMBOL = `${MARKET}:${CODE}`;

const V = '100.0000';
const CONFIDENCE = '8.0';
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
 * 同 K 三档（DTE 60/120/180，全在收租召回段 `[30, 365]` 内）。
 * 🚨 **三档而非两档**：FR-011「每个非推荐档恰一条原因」意味着 —— 只要梯上不止一档，
 *    `audits` 就结构性非空，靶心 1 的「至少一条带数值证据」才有落点。
 */
const SEED: readonly SeedQuote[] = [
  {
    code: 'US.NVYD.A',
    strike: '65.0000',
    dte: 60,
    bid: '2.0000',
    ask: '2.1000',
    delta: '-0.20000000',
  },
  {
    code: 'US.NVYD.B',
    strike: '65.0000',
    dte: 120,
    bid: '3.0000',
    ask: '3.2000',
    delta: '-0.17000000',
  },
  {
    code: 'US.NVYD.C',
    strike: '65.0000',
    dte: 180,
    bid: '3.4000',
    ask: '3.6000',
    delta: '-0.15000000',
  },
];

/** 证据袋里**任一**数值字段有值即算「带得出数」（13 类各用各的那几格，不指定是哪一格）。 */
function hasNumericEvidence(evidence: MarchAuditEvidenceResponse): boolean {
  return Object.values(evidence).some((value) => value !== null);
}

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const today = exchangeToday(new Date());

  await seed(ctx, today);
  let anchorId: string | null = null;
  try {
    anchorId = await createAnchor(cfg);

    // ── 靶心 1: us 收盘收租 march 真落（判决 + 带数值审计条目）────────────────
    const rent = await legs(cfg, 'rent');
    assert.ok(rent.legs.length > 0, '前提自检：收租视角应有腿，否则 march 无从判决');
    assert.ok('march' in rent, '收租缺 march 键 —— undefined 被序列化吞掉了');
    assert.notEqual(rent.march, null, 'us 收盘收租 march MUST 真落（070 门控放宽的契约证据）');
    const march = rent.march ?? [];
    assert.ok(march.length > 0, `march 应逐 K 各一条判决, got ${march.length}`);

    const verdicts = new Set(['recommended', 'no_qualified', 'untradable']);
    const categories = new Set<string>(Object.values(LegMarchAuditResponseCategory));
    let numericEvidenceSeen = 0;
    for (const strikeView of march) {
      assert.ok(verdicts.has(strikeView.verdict), `未知判决 ${strikeView.verdict}`);
      assert.ok(strikeView.audits.length > 0, `K ${strikeView.strike} 的非推荐档应各有一条原因`);
      for (const audit of strikeView.audits) {
        assert.ok(categories.has(audit.category), `未知审计类目 ${audit.category}`);
        if (hasNumericEvidence(audit.evidence)) numericEvidenceSeen += 1;
      }
    }
    assert.ok(
      numericEvidenceSeen > 0,
      '零条审计带得出数值 —— 证据袋全空则弹层只剩类目名（server 下发结构化数值是本片前提）',
    );

    // ── 靶心 2: marchMode 有值且是真值不是缺字段（FR-009 被动标示的契约载体）──
    assert.ok('marchMode' in rent, '收租缺 marchMode 键 —— undefined 被序列化吞掉了');
    assert.ok(
      rent.marchMode !== null &&
        (Object.values(LegTableResponseMarchMode) as string[]).includes(rent.marchMode),
      `marchMode 应为 phi / theta 之一, got ${String(rent.marchMode)}`,
    );

    // ── 靶心 3: 建仓 / 全腿仍恒真 null（FR-012 零改动；两字段同生共死）────────
    for (const perspective of ['build', 'all'] as const) {
      const table = await legs(cfg, perspective);
      assert.equal(table.state, 'available', `${perspective} 应就绪, got ${table.state}`);
      assert.ok('march' in table, `${perspective} 缺 march 键`);
      assert.equal(table.march, null, `${perspective} march MUST 真 null（本片零改动）`);
      assert.equal(table.marchMode, null, `${perspective} marchMode MUST 随 march 一并 null`);
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
     VALUES ('${MARKET}', '${CODE}', '070 契约冒烟 离线阶梯', 'stock', 'USD', 'listed')`,
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
      method: 'DCF · 070 契约冒烟',
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
