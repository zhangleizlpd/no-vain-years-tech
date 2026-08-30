/**
 * 068 两段式窄召回 —— `bandStatus` 序列化形态 + Q1 视角分派的契约冒烟（Constitution §V 两层之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的真 server（testcontainers PG），跑一条
 * happy path：**建锚 → 灌一期全链快照（含 Δ 面）→ 分别拉 rent / all 两份选约表**。
 *
 * 🚨 本片三条只有端到端才验得到的靶心：
 *   1. **`bandStatus` 收盘档恒 `null` 且是真 `null` 不是缺字段**：`JSON.stringify` 会把
 *      `undefined` 整个键删掉 —— 客户端读到 `undefined` 走的是「没接这根线」那条路，与
 *      「离线档无带语义」是两个状态。判据取 `'bandStatus' in leg`（缺字段当场红）。
 *   2. **Q1 分派在契约面可观察**（068 FR-008/FR-014）：controller 对两个读端恒传 `realtime=true`
 *      （064 起，开关不在 HTTP 面）⇒ mock 档下 **rent** 走窄召回 → 闸拒绝壳 → `gate_unknown`
 *      回落；**all** 按 Q1 裁决直落收盘档、闸根本没判 ⇒ 降级标恒 `null`。两份响应的降级标
 *      **必须不同** —— 这正是「窄召回只服务意图视角」的端到端证据，server IT 里它是调用计数，
 *      在这里它是可序列化的值差。
 *   3. **`bandStatus` 枚举在生成物上存在**（T007 regen 的机器证据）：期望值取生成的常量族
 *      （`LegResponseBandStatus`），orval 那边一改这里编译红。
 *
 * 📌 mock 档下实时档结构上取不到（`MARKET_STATE_PORT` = 054 拒绝壳，同 064 契约冒烟文件头
 *    的登记）⇒ 带内/带外的**非 null 分支**在本环境够不到，其判据在 server IT
 *    （`optionsdesk-068.two-stage.it.spec.ts` T005-②）—— 如实登记，🚫 MUST NOT 塞真凭据来凑。
 *
 * 边界与幂等：专属 ticker `us:NVYW`（避开 NVYX/NVYQ..T/NVYL,N,P/NVYG,H/NVYA,B/NVYI,K）；
 * marketdata 三张事实表靠 `ctx.execSql` 直插，锚走公开写端点建 / 末尾 DELETE 自清理。
 */
import assert from 'node:assert/strict';
import { LegResponseBandStatus, LegTableResponseRealtimeDegrade } from '@nvy/api-client';
import {
  optionsdeskControllerCreate,
  optionsdeskControllerLegs,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { LegTableResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-two-stage-recall (068)';

type Cfg = { baseURL: string; headers: Record<string, string> };

const MARKET = 'us';
const CODE = 'NVYW';
const SYMBOL = `${MARKET}:${CODE}`;

// 锚：V=100 ⇒ W=80；spot=70 落 spot<W 恒等域（closing 回落面数值与 067 前逐值相同）。
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

/** 两条腿都在收租段（DTE 60/120），Δ 面可读 —— 窄召回第一段的输入面齐全。 */
const SEED: readonly SeedQuote[] = [
  {
    code: 'US.NVYW.M',
    strike: '65.0000',
    dte: 60,
    bid: '2.0000',
    ask: '2.1000',
    delta: '-0.20000000',
  },
  {
    code: 'US.NVYW.F',
    strike: '60.0000',
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

    // ── 靶心 1+2a: rent（意图视角）⇒ 窄召回 → mock 档闸拒绝壳 → gate_unknown 回落收盘档 ──
    const rent = await legs(cfg, 'rent');
    assert.equal(rent.state, 'available', `rent 应就绪, got ${rent.state}`);
    assert.equal(
      rent.realtimeDegrade,
      LegTableResponseRealtimeDegrade.gate_unknown,
      'rent 走窄召回, mock 档闸自身故障 MUST 标 gate_unknown（值取生成常量）',
    );
    for (const leg of rent.legs) {
      assert.ok('bandStatus' in leg, `${leg.code} 缺 bandStatus 键 —— undefined 被序列化吞掉了`);
      assert.equal(leg.bandStatus, null, `${leg.code} 收盘档 bandStatus MUST 真 null`);
    }

    // ── 靶心 2b: all ⇒ Q1 裁决直落收盘档, 闸没判 ⇒ 降级标恒 null（与 rent 那份必须不同）──
    const all = await legs(cfg, 'all');
    assert.equal(all.state, 'available');
    assert.equal(all.realtimeDegrade, null, 'all 视角按 Q1 直落收盘档, 降级标 MUST null');
    assert.notEqual(
      all.realtimeDegrade,
      rent.realtimeDegrade,
      'rent 与 all 的降级标相同 —— Q1 分派（窄召回只服务意图视角）在契约面失去判别性',
    );

    // ── 靶心 3: 枚举在生成物上存在（值域 = in/out, 编译期已证; 这里证运行时可引用）──
    assert.deepEqual(Object.values(LegResponseBandStatus).sort(), ['in', 'out']);
  } finally {
    if (anchorId !== null) {
      const del = await optionsdeskControllerRemove(anchorId, cfg);
      assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
    }
    await deleteSeed(ctx);
  }
}

async function legs(cfg: Cfg, perspective: 'rent' | 'all'): Promise<LegTableResponse> {
  const res = await optionsdeskControllerLegs(SYMBOL, { perspective }, cfg);
  assert.equal(res.status, 200, `legs ${SYMBOL} ${perspective} expected 200, got ${res.status}`);
  return res.data;
}

async function seed(ctx: RealBackendCtx, today: string): Promise<void> {
  await deleteSeed(ctx); // 防上轮异常退出未走 cleanup

  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status)
     VALUES ('${MARKET}', '${CODE}', '068 契约冒烟 两段式', 'stock', 'USD', 'listed')`,
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
      method: 'DCF · 068 契约冒烟',
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
