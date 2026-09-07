/**
 * 071 港股实时窄召回接线 —— **港股 symbol 下的选约表在契约层与美股零形状差异**（SC-007）的
 * 契约冒烟（Constitution §V 两层之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的真 server（testcontainers PG），跑一条
 * happy path：**建两只逐字段等值的锚（`us:NVYE` / `hk:NVYE`）→ 各灌一份等值的收盘快照 →
 * 分别拉收租 / 建仓两个视角**，再把两市的四份响应两两对形。
 *
 * 🚨 本片三条只有端到端才验得到的靶心：
 *   1. **港股 symbol 下的选约表在两个意图视角上真的走得通**（FR-015：该覆盖今天为零）——
 *      200 + 非空腿 + 两市落**同一个**降级标。降级标取 `gate_unknown`（mock 档下
 *      `MARKET_STATE_PORT` 是 054 拒绝壳 ⇒ 两闸自身故障），两市同值本身就是「港股没有被
 *      塞进某条自己的分支」的可序列化证据。
 *   2. **逐字段同形，且断言本身不分市场**（SC-007 的机器判据）：{@link shapeLines} 把响应压成
 *      「路径 → kind 集合」再 `deepEqual`，多一个键 / 少一个键 / 某字段只在港股上恒 `null`
 *      三种漂移一次全拦。其中「键被吞掉」只有真序列化才验得到 —— `JSON.stringify` 会把
 *      `undefined` 整键删掉，而客户端读到 `undefined` 走的是「没接这根线」那条路。
 *   3. **`march` / `marchMode` 由 {@link assertMarchGate} 单独钉，不进对形**：071 T007 放开
 *      门控（2026-09-05）之后两市在这两个字段上**已不再蓄意不同形**，门控 = 收租视角、两市一律；
 *      豁免留下的理由换成了「判决块的内部形状随三态判决而变」（详见该函数注释）。绊线也随之
 *      换了方向 —— 现在钉的是「港股**有**判决块」，谁把 `market` 维加回门控当场红。
 *
 * 🚨 **本环境验不到「港股接上了实时档」，如实登记**：mock 档下 `MARKET_STATE_PORT` 是 054 拒绝壳
 *    ⇒ 闸恒 `unknown`，而 `leg-retrieval.adapter.ts` 的 `retrieveRealtimeNarrow` 在**闸判之后
 *    立刻回落**（`gate === 'unknown'` 那行早于 #286 的市场 guard、早于定窗基准）⇒ 071 改的那三处
 *    （业务日基准换市场 / 窗白名单加 `hk` / bootstrap 下界 per-market）在这里**结构上执行不到**，
 *    两市的 `gate_unknown` 在 071 之前就是这个值。🚫 MUST NOT 把上面靶心 1 读成「实时接线的证据」，
 *    也 MUST NOT 塞真凭据来凑 —— 实时接线的判据在 server IT（`optionsdesk-071.hk-realtime.it.spec.ts`
 *    的 13 臂，DI 替身喂真闸态）与部署后真时段抽查（T010 / issue #314）。本文件守的是**契约面**：
 *    回落之后两市仍逐字段同形。
 *
 * 边界与幂等：专属 ticker `us:NVYE` / `hk:NVYE`（两市**同码**是刻意的 —— 唯一的变量就是市场段，
 * 避开既有 NVYA..NVYD / NVYG..NVYZ）；marketdata 三张事实表靠 `ctx.execSql` 直插，锚走公开写
 * 端点建 / 末尾 DELETE 自清理。
 */
import assert from 'node:assert/strict';
import {
  LegTableResponsePriceKind,
  LegTableResponseRealtimeDegrade,
  LegTableResponseState,
  optionsdeskControllerCreate,
  optionsdeskControllerLegs,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { LegTableResponse, OptionsdeskControllerLegsPerspective } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-hk-realtime (071)';

type Cfg = { baseURL: string; headers: Record<string, string> };

/** 两市**同码** —— 对形时唯一的自变量必须只有市场段。 */
const CODE = 'NVYE';
/**
 * 076 FR-012: 每张合约的股数 —— **两市蓄意取不同值**。它是本片唯一一处「两市不等值」的夹具:
 * 美股标准合约恒 100, 港股逐标的不同 (真锚里 150 / 200 / 400 / 500 / 1000 / 2000 都有,
 * 出处 `specs/076-option-contract-size/spec.md` 「取证」§1)。两市都播 100 的话,
 * 「单笔权利金按合约股数算」与「按 100 这个市场常量算」在契约面上恒等 ⇒ 那条断言什么都没验到。
 */
const US = { market: 'us', currency: 'USD', contractSize: 100 } as const;
const HK = { market: 'hk', currency: 'HKD', contractSize: 500 } as const;
const symbolOf = (market: string): string => `${market}:${CODE}`;

const V = '100.0000';
const CONFIDENCE = '8.0';
/** spot 70 ⇒ W = 80 ⇒ axis = min(70, 80) = 70 ⇒ 成色上界 72.1（下面三条 K 全在其下）。 */
const SPOT = '70.0000';
const QUOTE_TIME = 'T20:15:00.000Z';

interface SeedQuote {
  readonly suffix: string;
  readonly strike: string;
  readonly dte: number;
  readonly bid: string;
  readonly ask: string;
  readonly delta: string;
}

/**
 * 三条腿把**两个意图段各自铺满**（`BUILD_RECALL_DTE = [1,49]` / `RENT_RECALL_DTE = [30,365]`，
 * 两段不相交）：
 *
 * | 腿   | K  | DTE | 落哪个视角 |
 * | ---- | -- | --- | ---------- |
 * | `NEAR` | 65 |  24 | 建仓       |
 * | `MID`  | 65 |  60 | 收租       |
 * | `FAR`  | 60 | 120 | 收租       |
 *
 * 🚨 **两个视角都必须非空**：对形是逐字段比 kind，`legs` 空了那一半的 `legs[].*` 整片路径
 * 就不存在 —— 两市同时空的话对形照样绿，而那是一条什么都没验到的恒真断言。
 * 📌 DTE 基准是**每市各自的今天**（`toLegRows` 已按 `parsed.market` 参数化），港股与美股的
 * 折算日相差至多一天 ⇒ 上表三条离两段边界都还有 ≥ 6 天余量，不会因跑测时刻而换段。
 */
const SEED: readonly SeedQuote[] = [
  {
    suffix: 'NEAR',
    strike: '65.0000',
    dte: 24,
    bid: '1.0000',
    ask: '1.0500',
    delta: '-0.25000000',
  },
  { suffix: 'MID', strike: '65.0000', dte: 60, bid: '2.0000', ask: '2.1000', delta: '-0.20000000' },
  {
    suffix: 'FAR',
    strike: '60.0000',
    dte: 120,
    bid: '3.0000',
    ask: '3.2000',
    delta: '-0.15000000',
  },
];

/** T008-① 逐视角对形的两个意图视角（`all` 不走窄召回，归 068 那片）。 */
const PERSPECTIVES: readonly OptionsdeskControllerLegsPerspective[] = ['rent', 'build'];

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  // 🚨 两市共用**一个**基准日: 离线路径的业务日基准至今写死 `'us'`（#274 / 071 Guardrail 1，
  // 本片蓄意不动）⇒ 港股那份也按美股折算日落库, 夹具才真的逐字段等值。
  const today = exchangeToday(new Date());

  await seed(ctx, US, today);
  await seed(ctx, HK, today);

  const anchorIds: string[] = [];
  try {
    for (const market of [US.market, HK.market]) {
      anchorIds.push(await createAnchor(cfg, market, today));
    }

    for (const perspective of PERSPECTIVES) {
      // ── 靶心 1: 同一套断言换 market 即可跑, 零分支 (SC-007 的「无分支」半) ──────────
      const us = await legs(cfg, US.market, perspective);
      const hk = await legs(cfg, HK.market, perspective);
      assertTableInvariants(us, US.market, perspective);
      assertTableInvariants(hk, HK.market, perspective);

      // ── 靶心 2: 逐字段对形 ────────────────────────────────────────────────────
      const usShape = shapeLines(us);
      const hkShape = shapeLines(hk);
      assert.deepEqual(
        hkShape,
        usShape,
        `${perspective} 视角两市形状不同 (SC-007):\n` +
          `  仅美股有: ${usShape.filter((l) => !hkShape.includes(l)).join(' | ') || '—'}\n` +
          `  仅港股有: ${hkShape.filter((l) => !usShape.includes(l)).join(' | ') || '—'}`,
      );

      // ── 靶心 3: 仅有的两处蓄意差异, 单独钉 + 绊线 ────────────────────────────────
      assertMarchGate(us, hk, perspective);

      // ── 076: 单笔权利金按**该合约的股数**算, 两市各一臂 (FR-012 / SC-001) ────────
      assertContractPremiumPerShare(us, US.contractSize, perspective);
      assertContractPremiumPerShare(hk, HK.contractSize, perspective);
    }

    // ── T008-②: 降级值域仍是四值 (FR-010 值域不扩的机器判据) ─────────────────────
    assert.deepEqual(
      Object.values(LegTableResponseRealtimeDegrade).sort(),
      ['gate_unknown', 'source_unavailable', 'window_basis_stale', 'window_over_cap'],
      '降级值域不再是四值 —— 前端那份穷举 Record 会漏掉新值且不报错 (FR-010)',
    );
  } finally {
    for (const anchorId of anchorIds) {
      const del = await optionsdeskControllerRemove(anchorId, cfg);
      assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
    }
    await deleteSeed(ctx, US.market);
    await deleteSeed(ctx, HK.market);
  }
}

/**
 * **与市场无关**的逐份不变量 —— SC-007「同一套断言换 market 即可跑」的字面兑现:
 * 本函数体内没有任何 `market === …` 分支, 两市各调一次。
 */
function assertTableInvariants(
  table: LegTableResponse,
  market: string,
  perspective: OptionsdeskControllerLegsPerspective,
): void {
  const symbol = symbolOf(market);
  assert.equal(table.symbol, symbol);
  assert.equal(table.perspective, perspective, `${symbol} ${perspective} 视角回显不符`);
  assert.equal(
    table.state,
    LegTableResponseState.available,
    `${symbol} ${perspective} 应就绪, got ${table.state}`,
  );
  assert.ok(table.legs.length > 0, `${symbol} ${perspective} 零腿 —— 对形会退化成恒真断言`);
  assert.equal(
    table.priceKind,
    LegTableResponsePriceKind.eod_close,
    `${symbol} ${perspective} mock 档取不到实时, MUST 回落收盘档`,
  );
  // 🚨 靶心 1 的落点: 两市**同值**。`null` 意味着这个市场压根没走到闸那一步（意图视角本该
  // 走窄召回, 见 `retrieveCandidates` 的 dispatch）; `source_unavailable` 意味着它走到了闸后
  // 那道 #286 市场 guard 才回落。两个错值都渲染得出一张完整的收盘表, 只有钉住具体那一档才分得开。
  assert.equal(
    table.realtimeDegrade,
    LegTableResponseRealtimeDegrade.gate_unknown,
    `${symbol} ${perspective} 走窄召回、mock 档两闸自身故障 ⇒ MUST 标 gate_unknown, ` +
      `got ${table.realtimeDegrade}`,
  );
  for (const leg of table.legs) {
    // `undefined` 会被 JSON.stringify 整键删掉 ⇒ 客户端读到的是「没接这根线」而非「无带语义」。
    assert.ok('bandStatus' in leg, `${symbol} ${leg.code} 缺 bandStatus 键`);
    assert.equal(
      leg.priceKind,
      LegTableResponsePriceKind.eod_close,
      `${symbol} ${leg.code} 行级档`,
    );
  }
}

/**
 * `march` / `marchMode` 门控 = **收租视角**（069 FR / 070 FR-001 / 071 T007；实现单点在
 * `get-legs.usecase.ts` 的 `marchBlock`）。
 *
 * 🚨 **2026-09-05 翻面**（071 T007，user 裁决三条判据全过）：门控原为 `收租 ∧ us`，`market` 维
 * 挡的是「行军参数在港股适不适用」这个当时未判定的问题；判定完它就没有留下的理由了（判据与
 * 射程见 071 spec「行军参数适用性判定」节）。
 * 📌 **翻面后 {@link isMarchGated} 的豁免仍留着**，理由换了：不再是「两市蓄意不同形」，而是
 * `march` 的内部形状**随三态判决而变**（`recommendedDteDays` 只在 `recommended` 时是数字、
 * 其余两态恒 `null`；空候选时整个数组是 `[]` ⇒ 连 `march[]` 那一层路径都不存在）。把它塞进
 * 逐路径对形，会把「两市链数据不同」报成契约漂移。⇒ 形状与门控都由本函数钉。
 *
 * 🚨 **绊线换了方向, 不是撤了**: 现在 hk 那两条断言钉的是「港股**有**判决块」—— 谁把 market 维
 * 加回门控, 这里第三条当场红。🚫 MUST NOT 改成「两市都只断言键在」: 那样门控怎么改都绿。
 */
function assertMarchGate(
  us: LegTableResponse,
  hk: LegTableResponse,
  perspective: OptionsdeskControllerLegsPerspective,
): void {
  const hasMarch = perspective === 'rent';
  assert.equal(
    us.march === null,
    !hasMarch,
    `us ${perspective} 的 march 门控不符 (收租视角有值, 其余恒 null)`,
  );
  assert.equal(us.marchMode === null, us.march === null, 'us march 与 marchMode MUST 同生共死');
  assert.equal(
    hk.march === null,
    !hasMarch,
    `hk ${perspective} 的 march 门控不符 —— 071 T007 起港股与美股走同一道门控 ` +
      `(收租视角有值, 其余恒 null); 若这是把 market 维加回门控的结果, 请连同 070 臂④ 一起改回`,
  );
  assert.equal(hk.marchMode === null, hk.march === null, 'hk march 与 marchMode MUST 同生共死');
}

/**
 * 076 FR-012: `contractPremium ÷ bid` **恒等于该合约的股数**。
 *
 * 🚨 判别性来自两市播了不同的股数 (us 100 / hk 500): 改动前那两个派生值乘的是写死的市场常量
 * `US_OPTION_CONTRACT_MULTIPLIER = 100`, 港股这一臂于是会拿到 100 而不是 500 —— 这是整条链
 * (链发现落库 → 读端带出 → 派生 → 契约) 在契约面上**唯一**看得见的落点。
 * 🚫 MUST NOT 改成「两市都断言 = 100」或「只断言非 null」: 前者把病根写进判据, 后者恒真。
 *
 * 📌 用 `Number` 相除而不是比字符串: 序列化后的小数位数是 Decimal 的表示细节, 不是本条要钉的
 * 东西 (要钉的是那个倍数); 夹具三条腿的 bid 都是 1 / 2 / 3 的整数值, 除法在二进制里精确。
 */
function assertContractPremiumPerShare(
  table: LegTableResponse,
  contractSize: number,
  perspective: OptionsdeskControllerLegsPerspective,
): void {
  for (const leg of table.legs) {
    assert.ok(
      leg.bid !== null && leg.contractPremium !== null,
      `${table.symbol} ${perspective} ${leg.code}: 夹具三条腿都有 bid ⇒ 两列 MUST NOT 为 null ` +
        `(null 意味着合约股数没落库 / 判成了非标, 那是另一档结局)`,
    );
    assert.equal(
      Number(leg.contractPremium) / Number(leg.bid),
      contractSize,
      `${table.symbol} ${perspective} ${leg.code}: 单笔权利金 ÷ bid MUST = 该合约股数 ` +
        `${contractSize}, got ${leg.contractPremium} ÷ ${leg.bid}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 逐字段形状签名
// ─────────────────────────────────────────────────────────────────────────────

type Kind = 'null' | 'string' | 'number' | 'boolean' | 'array' | 'object';

function kindOf(value: unknown): Kind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const primitive = typeof value;
  if (primitive === 'string' || primitive === 'number' || primitive === 'boolean') return primitive;
  return 'object';
}

/**
 * 响应 → 「路径 → 该路径出现过的 kind 集合」。数组元素**并到同一条路径** `x[]` ⇒ 元素之间的
 * 字段差异（某一腿少一个键）也会落进签名, 不会因为只看 `legs[0]` 而漏掉。
 *
 * 复杂度 `O(n)`（n = 响应的标量节点数），递归深度 = 响应嵌套深度（当前 3 层）。
 */
function shapeSignature(
  value: unknown,
  path = '',
  into = new Map<string, Set<Kind>>(),
): Map<string, Set<Kind>> {
  const kind = kindOf(value);
  const kinds = into.get(path) ?? new Set<Kind>();
  kinds.add(kind);
  into.set(path, kinds);
  if (kind === 'array') {
    for (const item of value as readonly unknown[]) shapeSignature(item, `${path}[]`, into);
  } else if (kind === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      shapeSignature(child, path === '' ? key : `${path}.${key}`, into);
    }
  }
  return into;
}

/** 门控字段的路径（{@link assertMarchGate} 单独钉，不进对形）。 */
function isMarchGated(path: string): boolean {
  return path === 'marchMode' || path === 'march' || path.startsWith('march[');
}

function shapeLines(table: LegTableResponse): readonly string[] {
  return [...shapeSignature(table).entries()]
    .filter(([path]) => path !== '' && !isMarchGated(path))
    .map(([path, kinds]) => `${path}: ${[...kinds].sort().join('|')}`)
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

async function legs(
  cfg: Cfg,
  market: string,
  perspective: OptionsdeskControllerLegsPerspective,
): Promise<LegTableResponse> {
  const symbol = symbolOf(market);
  const res = await optionsdeskControllerLegs(symbol, { perspective }, cfg);
  assert.equal(res.status, 200, `legs ${symbol} ${perspective} expected 200, got ${res.status}`);
  return res.data;
}

async function seed(
  ctx: RealBackendCtx,
  { market, currency, contractSize }: { market: string; currency: string; contractSize: number },
  today: string,
): Promise<void> {
  await deleteSeed(ctx, market); // 防上轮异常退出未走 cleanup

  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status)
     VALUES ('${market}', '${CODE}', '071 契约冒烟 港股实时接线', 'stock', '${currency}', 'listed')`,
  );
  const iid = `(SELECT id FROM marketdata.instrument WHERE market = '${market}' AND code = '${CODE}')`;

  await ctx.execSql(
    `INSERT INTO marketdata.trading_day (market, date)
     SELECT '${market}', g::date
     FROM generate_series(DATE '${plusDays(today, -10)}', DATE '${plusDays(today, 10)}', INTERVAL '1 day') AS g
     ON CONFLICT DO NOTHING`,
  );

  const contracts = SEED.map(
    (s) =>
      `('${market}', '${contractCode(market, s.suffix)}', '${CODE}', ${iid}, ` +
      `DATE '${plusDays(today, s.dte)}', ${s.strike}, 'PUT', true, ${contractSize})`,
  ).join(',\n       ');
  await ctx.execSql(
    `INSERT INTO marketdata.option_contract
       (market, code, root, underlying_instrument_id, expiry_date, strike_price, option_type,
        is_standard, contract_size)
     VALUES
       ${contracts}`,
  );
  const cid = (code: string): string =>
    `(SELECT id FROM marketdata.option_contract WHERE market = '${market}' AND code = '${code}')`;

  const snapshots = SEED.map(
    (s) =>
      `(${cid(contractCode(market, s.suffix))}, DATE '${today}', 'eod', ` +
      `TIMESTAMPTZ '${today}${QUOTE_TIME}', DATE '${plusDays(today, -1)}', ` +
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

/** vendor 合约码体例同 068（`US.NVYW.M`）—— 市场段大写。 */
function contractCode(market: string, suffix: string): string {
  return `${market.toUpperCase()}.${CODE}.${suffix}`;
}

async function deleteSeed(ctx: RealBackendCtx, market: string): Promise<void> {
  // instrument 删除 CASCADE 带走 option_contract → option_daily_snapshot。
  await ctx.execSql(
    `DELETE FROM marketdata.instrument WHERE market = '${market}' AND code = '${CODE}'`,
  );
}

async function createAnchor(cfg: Cfg, market: string, today: string): Promise<string> {
  const symbol = symbolOf(market);
  const created = await optionsdeskControllerCreate(
    {
      ticker: symbol,
      v: V,
      asof: plusDays(today, -30),
      method: 'DCF · 071 契约冒烟',
      confidence: CONFIDENCE,
      nextReview: plusDays(today, 120),
    },
    cfg,
  );
  assert.equal(created.status, 201, `create ${symbol} expected 201, got ${created.status}`);
  return created.data.id;
}

/** 「交易所的今天」（`America/New_York`）—— 与离线读路径的 `exchangeCalendarDate('us', now)` 同口径。 */
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
