/**
 * 069 清链与行军选档 —— `march` 序列化形态 + 13 类枚举传导的契约冒烟（Constitution §V 两层之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的真 server（testcontainers PG），跑一条
 * happy path：**建锚 → 灌一期收盘快照 → 拉三个视角的选约表**。
 *
 * 🚨 本片两条只有端到端才验得到的靶心：
 *   1. **`march` 是真值不是缺字段**（`JSON.stringify` 会把 `undefined` 整键删掉 —— 客户端读到
 *      `undefined` 走「没接这根线」，与「这个视角没有判决语义」是两个状态；判据取
 *      `'march' in table`，缺字段当场红）。⚠️ **值面语义随 070 演进**：069 期三视角在收盘档
 *      恒 `null`；070 把门控从「实时开态 ∧ 收租」放宽为「us 市场锚 ∧ 收租」后，**收租视角
 *      收盘档有值**（那正是 070 要修的病根），建仓 / 全腿仍恒 `null`（FR-012 零改动）。
 *      🚫 这不是基线造假：判据本身没松，只是它现在断言的是**放宽后的**那份契约（070 tasks
 *      Guardrail 3 唯一例外条款，PR 描述记录）。判决形态面归 `070-offline-ladder.contract.ts`。
 *   2. **13 类枚举在生成物上逐字存在**（T007 regen 的机器证据；FR-015 前后端一致经生成链传导）：
 *      期望清单按 spec FR-015 表逐条写死 —— server 单点改类目而 regen 没跑，这里当场红。
 *
 * 📌 mock 档下实时档结构上取不到（闸 = 054 拒绝壳）⇒ `march` 的**非 null 分支**（判决/审计
 *    真值面）在本环境够不到，其判据在 server IT（optionsdesk-069.chain-march.it.spec.ts 九臂）
 *    —— 如实登记，🚫 MUST NOT 塞真凭据来凑。
 *
 * 红绿时序（tasks.md T010）：断言先落 —— T007 regen 之前旧契约无 `march` / 无枚举 ⇒ typecheck
 * 红；regen 后转绿（本文件落盘时 regen 已 ship，红态由 T007 先红臂留档代位）。
 *
 * 边界与幂等：专属 ticker `us:NVYM`（避开 NVYW/NVYX/NVYQ..T/NVYL,N,P/NVYG,H/NVYA,B/NVYI,K）；
 * marketdata 事实表靠 `ctx.execSql` 直插，锚走公开写端点建 / 末尾 DELETE 自清理。
 */
import assert from 'node:assert/strict';
import { LegMarchAuditResponseCategory, LegMarchStrikeResponseVerdict } from '@nvy/api-client';
import {
  optionsdeskControllerCreate,
  optionsdeskControllerLegs,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { LegTableResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-chain-march (069)';

type Cfg = { baseURL: string; headers: Record<string, string> };

const MARKET = 'us';
const CODE = 'NVYM';
const SYMBOL = `${MARKET}:${CODE}`;

const V = '100.0000';
const CONFIDENCE = '8.0';
const SPOT = '70.0000';
const QUOTE_TIME = 'T20:15:00.000Z';

/** spec FR-015 表逐条（#1–#13 次序即家族序）—— 与生成枚举逐字对账的期望清单。 */
const EXPECTED_CATEGORIES = [
  'crossed_quote',
  'concave_dominated',
  'absolute_dominated',
  'collinear_merged',
  'fwd_below_phi',
  'decay_rebound_above_beta',
  'decay_above_gamma_cap',
  'tier_floor_failed',
  'qualified_not_stop',
  'stop_oi_below_min',
  'ladder_oi_all_below_min',
  'band_out',
  'quote_missing',
] as const;

interface SeedQuote {
  readonly code: string;
  readonly strike: string;
  readonly dte: number;
  readonly bid: string;
  readonly ask: string;
  readonly delta: string;
}

/** 同 K 两档（DTE 60/120, 收租段）—— K 梯形态齐全, 供收租视角判决 / 另两视角守恒。 */
const SEED: readonly SeedQuote[] = [
  {
    code: 'US.NVYM.M',
    strike: '65.0000',
    dte: 60,
    bid: '2.0000',
    ask: '2.1000',
    delta: '-0.20000000',
  },
  {
    code: 'US.NVYM.F',
    strike: '65.0000',
    dte: 120,
    bid: '3.0000',
    ask: '3.2000',
    delta: '-0.15000000',
  },
];

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const today = exchangeToday(new Date());

  await seed(ctx, today);
  let anchorId: string | null = null;
  try {
    anchorId = await createAnchor(cfg);

    // ── 靶心 1: march 键恒在；值面按 070 放宽后的门控分视角（收租有值 / 另两恒 null）──
    for (const perspective of ['rent', 'build', 'all'] as const) {
      const table = await legs(cfg, perspective);
      assert.equal(table.state, 'available', `${perspective} 应就绪, got ${table.state}`);
      assert.ok('march' in table, `${perspective} 缺 march 键 —— undefined 被序列化吞掉了`);
      if (perspective === 'rent') {
        // 070 FR-001: us 锚收租在收盘档也点亮 —— 这一臂从「恒缺省」翻面成「MUST 有值」。
        assert.notEqual(table.march, null, 'us 收盘收租 march MUST 真落（070 门控放宽）');
      } else {
        assert.equal(table.march, null, `${perspective} march MUST 真 null（建仓/全腿零改动）`);
      }
    }

    // ── 靶心 2: 13 类枚举与三态判决在生成物上逐字存在（生成链传导的机器证据）──
    assert.deepEqual(
      Object.values(LegMarchAuditResponseCategory),
      [...EXPECTED_CATEGORIES],
      '13 类枚举与 FR-015 表逐字不一致 —— server 单点改了类目而 api-client 没 regen？',
    );
    assert.deepEqual(Object.values(LegMarchStrikeResponseVerdict).sort(), [
      'no_qualified',
      'recommended',
      'untradable',
    ]);
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
     VALUES ('${MARKET}', '${CODE}', '069 契约冒烟 清链行军', 'stock', 'USD', 'listed')`,
  );
  const iid = `(SELECT id FROM marketdata.instrument WHERE market = '${MARKET}' AND code = '${CODE}')`;

  await ctx.execSql(
    `INSERT INTO marketdata.trading_day (market, date)
     SELECT '${MARKET}', g::date
     FROM generate_series(DATE '${plusDays(today, -10)}', DATE '${plusDays(today, 10)}', INTERVAL '1 day') AS g
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
      method: 'DCF · 069 契约冒烟',
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
