/**
 * 061 生效 spot 三元组 契约冒烟（Constitution §V 两层验证之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的**真 server**（testcontainers PG），跑一条雷达
 * happy path：**建锚 →（无行情）→ 灌收盘投影 → 灌新鲜实时价 → 推成陈旧 → 再刷新回新鲜**，验
 * `spot` / `priceKind` / `spotAsOf` 三个新字段的**序列化 / 反序列化对齐**。
 *
 * 补的正是另两层都盖不到的缝：
 *   ① hermetic e2e（T015）把响应 mock 掉了 —— 它验的是「拿到这形状后 UI 怎么画」，形状本身由
 *      fixture 保证；server 把 `priceKind` 序列化成别的字面量、或把 `spotAsOf` 在实时档也压成日期，
 *      它照样全绿；
 *   ② server IT（T009 / T010）打的是真 server，但断言写在**手写的 DTO 期望**上，与 mobile 实际
 *      消费的那份**生成客户端类型**是两条独立的手抄链 —— orval 生成出别的形状不会有人红。
 *
 * 🚨 本片五条只有端到端才验得到的靶心：
 *   1. **`spotAsOf` 的粒度即档位**（FR-009）：实时档必须是**带 `T` 的 ISO 时刻**、收盘档必须是
 *      **恰好 10 字符的 `YYYY-MM-DD`**。档位不上屏，界面唯一的表达手段就是这个粒度差 —— 服务端
 *      哪天把实时档的 asOf 也按 `@db.Date` 压平，屏幕上只会安静地少掉时分，没有任何 UI 断言会红。
 *   2. **`spot` 与 `lastClose` 不是同一个数**（FR-015 语义未变）：实时档下两者必须**不等** ——
 *      一旦有人把 `spot` 直接映到 `lastClose`「简化」掉，这条当场红。
 *   3. **两个读端对同一锚判出同一档**：`GET /radar`（SQL 里 COALESCE 排序 + TS 判档）与
 *      `GET /anchors`（纯 TS 判档）是**两条独立的解算路径**，本片逐字段对照它们的三元组。
 *      两处漂移的表现是「雷达说实时、锚列表说收盘」，屏幕上完全正常。
 *   4. **排序键真的跟着生效 spot 翻**：同一批锚，灌新鲜实时价前后次序**相反** —— 这条穿过真 PG 的
 *      `ORDER BY`，验的是 SQL 的 COALESCE 与 TS 的档位判定同源（不同源时排序与显示会分家）。
 *   5. **Guardrail 3 的端到端钉**：实时价跌破 W 而收盘价在 W 上方时，`breachStartedOn` **必须不变**
 *      —— 跌破状态机是日粒度、刻意只吃 `last_close`；有人「顺手」把它也换成生效 spot，红标会开始
 *      按分钟抖动，而单测之外没有第二处会发现。
 *
 * 边界与幂等：用**专属 ticker**（`us:NVYA` / `us:NVYB`，避开 045 `NVYX` / 046 `NVYQ..T` /
 * 047 `NVYL,NVYN,NVYP` / 055 `NVYG,NVYH`），锚走公开写端点建、末尾 DELETE 自清理；两个行情列
 * （`intraday_price` / `intraday_at` / `last_close`）**无公开写端点** ⇒ 靠 `ctx.execSql` 直插
 * （schema=optionsdesk，列名 snake_case per `@map`）。
 */
import assert from 'node:assert/strict';
import {
  AnchorResponsePriceKind,
  optionsdeskControllerCreate,
  optionsdeskControllerList,
  optionsdeskControllerRadar,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { AnchorResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-realtime-spot (061)';

type Cfg = { baseURL: string; headers: Record<string, string> };

/** 实时档主角。 */
const TICKER_FRESH = 'us:NVYA';
/** 恒收盘档的对照（不支持实时的市场 / 未被采集到的标的都长这样）。 */
const TICKER_EOD = 'us:NVYB';

/** V=100 ⇒ W=80（0.8V）。距 W% = (spot − W)/W × 100，下面三个期望值全由它算。 */
const V = '100.0000';
const CONFIDENCE = '8.0'; // → 映射档 L2

/** 收盘价：一个在 W 上方、一个在 W 下方 ⇒ 收盘档下的次序是 EOD 在前。 */
const LAST_CLOSE_FRESH = '95.0000'; // 距 W +18.75%
const LAST_CLOSE_EOD = '76.0000'; // 距 W −5.00%
/** 盘中实时价：把主角从「最贵的一只」翻成「跌得最深的一只」⇒ 次序整个反过来。 */
const INTRADAY_PRICE = '70.0000'; // 距 W −12.50%

/** `YYYY-MM-DD` —— 收盘档 asOf 的粒度判据（10 字符、无 `T`）。 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  const created = await Promise.all(
    [TICKER_FRESH, TICKER_EOD].map((ticker) =>
      optionsdeskControllerCreate(
        {
          ticker,
          v: V,
          asof: '2026-07-01',
          method: 'DCF · 061 契约冒烟',
          confidence: CONFIDENCE,
          nextReview: '2026-12-31',
        },
        cfg,
      ),
    ),
  );
  for (const res of created)
    assert.equal(res.status, 201, `create expected 201, got ${res.status}`);
  const ids = created.map((r) => r.data.id);

  try {
    // ── ① 未被任何采集覆盖 → 三元组显式为「无价」，且 `priceKind` **仍显式给出** ──────────
    // 非 nullable 枚举：无价时它落 `eod_close`（= 降级路径的落脚点），而不是 null / 缺字段。
    // 🚨 `spot` MUST 是 null 而**不是 0** —— 0 是一个有意义的距离值（正好在带上）。
    {
      const row = await radarRow(cfg, TICKER_FRESH);
      assert.equal(row.spot, null, '未采集 ⇒ spot = null（禁伪造 0）');
      assert.equal(row.spotAsOf, null, '无价 ⇒ 时间事实一起空（数值与 asOf 同生共死）');
      assert.equal(
        row.priceKind,
        AnchorResponsePriceKind.eod_close,
        '无价时档位仍显式下发 eod_close（非 nullable 枚举，不许缺字段）',
      );
      assert.equal(row.distanceToWPct, null, '无价 ⇒ 距 W% = null');
      assert.equal(row.zone, null, '无价 ⇒ 不伪造区间');
    }

    // ── ② 灌收盘投影 → 收盘档：asOf 是**交易日**，且与 `lastCloseDate` 是同一个事实 ────────
    await ctx.execSql(
      `UPDATE optionsdesk.anchor
          SET last_close = ${LAST_CLOSE_FRESH}, last_close_date = CURRENT_DATE
        WHERE ticker IN ('${TICKER_FRESH}', '${TICKER_EOD}')`,
    );
    await ctx.execSql(
      `UPDATE optionsdesk.anchor SET last_close = ${LAST_CLOSE_EOD} WHERE ticker = '${TICKER_EOD}'`,
    );
    {
      const row = await radarRow(cfg, TICKER_FRESH);
      assert.equal(row.priceKind, AnchorResponsePriceKind.eod_close);
      assert.equal(row.spot, LAST_CLOSE_FRESH, '收盘档 ⇒ 生效 spot = 收盘价');
      assert.ok(
        row.spotAsOf !== null && DATE_ONLY_RE.test(row.spotAsOf),
        `收盘档 asOf 必须是 YYYY-MM-DD 粒度, got ${String(row.spotAsOf)}`,
      );
      assert.equal(row.spotAsOf, row.lastCloseDate, '收盘档下 asOf 与 lastCloseDate 是同一个事实');
      assert.equal(row.distanceToWPct, '18.75', '距 W% 由生效 spot 算出 ((95−80)/80)');

      // 排序：收盘价口径下 EOD(−5.00) 在 FRESH(+18.75) 之前。
      const order = await radarOrder(cfg);
      assert.ok(
        order.indexOf(TICKER_EOD) < order.indexOf(TICKER_FRESH),
        `收盘档下应 EOD 在前, got ${order.join(' → ')}`,
      );
    }

    // ── ③ 灌**新鲜**实时价 → 实时档：asOf 变**时刻**，spot 与 lastClose 分家 ────────────
    // `now()` = 事务开始时刻 ⇒ 必落在新鲜度闸内（闸的秒数由 server 单点常量派生，此处不复写）。
    await ctx.execSql(
      `UPDATE optionsdesk.anchor
          SET intraday_price = ${INTRADAY_PRICE}, intraday_at = now()
        WHERE ticker = '${TICKER_FRESH}'`,
    );
    {
      const row = await radarRow(cfg, TICKER_FRESH);
      assert.equal(row.priceKind, AnchorResponsePriceKind.realtime, '闸内的实时价 ⇒ realtime 档');
      assert.equal(row.spot, INTRADAY_PRICE, '生效 spot 切到实时价');
      // 🚨 靶心 2：两个字段**不是同一个数**。`lastClose` 语义一字未变（当日收盘的权威值）。
      assert.equal(row.lastClose, LAST_CLOSE_FRESH, 'lastClose 保持收盘口径（FR-015 未变）');
      assert.notEqual(row.spot, row.lastClose, '实时档下生效 spot 与 lastClose 必须不等');
      // 🚨 靶心 1：粒度即档位 —— 时刻，不是日期。
      assert.ok(
        row.spotAsOf !== null && row.spotAsOf.includes('T'),
        `实时档 asOf 必须是 ISO 时刻, got ${String(row.spotAsOf)}`,
      );
      assert.ok(
        Number.isFinite(Date.parse(row.spotAsOf ?? '')),
        'ISO 时刻必须可被客户端解析（界面据此渲 HH:mm）',
      );
      assert.notEqual(row.spotAsOf, row.lastCloseDate, '实时档 asOf 与收盘 asOf 是两个事实');
      assert.equal(row.distanceToWPct, '-12.50', '距 W% 跟着实时价重算 ((70−80)/80)');

      // 🚨 靶心 5（Guardrail 3）：实时价 70 < W=80，而收盘价 95 > W ⇒ 跌破状态机**不动**。
      assert.equal(
        row.breachStartedOn,
        null,
        '跌破状态机只吃 last_close（日粒度），MUST NOT 被盘中价推动',
      );

      // 🚨 靶心 3：另一个读端（GET /anchors，纯 TS 判档）必须判出**同一档**。
      const listed = await listRow(cfg, TICKER_FRESH);
      assert.equal(listed.priceKind, row.priceKind, '两个读端的档位必须一致');
      assert.equal(listed.spot, row.spot, '两个读端的生效 spot 必须一致');
      assert.equal(listed.spotAsOf, row.spotAsOf, '两个读端的 asOf 必须一致');

      // 🚨 靶心 4：排序键跟着生效 spot 翻 —— 与 ② 的次序**相反**。
      const order = await radarOrder(cfg);
      assert.ok(
        order.indexOf(TICKER_FRESH) < order.indexOf(TICKER_EOD),
        `实时档下应 FRESH 在前（−12.50 < −5.00）, got ${order.join(' → ')}`,
      );
    }

    // ── ④ 把采集时刻推到闸外 → 自动回落收盘档，**且既有实时价不被清空** ──────────────────
    // 10 分钟远超新鲜度闸（90 秒）；此处刻意不复写闸的秒数，只取一个「怎么改都在闸外」的值。
    await ctx.execSql(
      `UPDATE optionsdesk.anchor
          SET intraday_at = now() - INTERVAL '10 minutes'
        WHERE ticker = '${TICKER_FRESH}'`,
    );
    {
      const row = await radarRow(cfg, TICKER_FRESH);
      assert.equal(row.priceKind, AnchorResponsePriceKind.eod_close, '陈旧实时价 ⇒ 回落收盘档');
      assert.equal(row.spot, LAST_CLOSE_FRESH, '回落到收盘价，MUST NOT 继续用陈旧实时价');
      assert.ok(
        row.spotAsOf !== null && DATE_ONLY_RE.test(row.spotAsOf),
        `回落后 asOf 必须变回交易日粒度, got ${String(row.spotAsOf)}`,
      );
      assert.equal(row.distanceToWPct, '18.75', '距 W% 一并回到收盘口径（不是 0、不是空）');
    }

    // ── ⑤ 只把采集时刻刷新回当下（**不重灌价**）→ 实时档自动回来 ────────────────────────
    // 这一步同时证两件事：熔断期间**既有实时价没被清空**（价还在库里，否则刷新时刻也变不回来），
    // 以及恢复**不需要任何人工介入**（读端一次查询就自己回到实时档）。
    await ctx.execSql(
      `UPDATE optionsdesk.anchor SET intraday_at = now() WHERE ticker = '${TICKER_FRESH}'`,
    );
    {
      const row = await radarRow(cfg, TICKER_FRESH);
      assert.equal(row.priceKind, AnchorResponsePriceKind.realtime, '闸内 ⇒ 自动回实时档');
      assert.equal(row.spot, INTRADAY_PRICE, '回来的还是原来那个价 ⇒ 降级期间未被清空');
    }

    // ── ⑥ 对照锚全程恒收盘档（不支持实时的市场 / 未被采集的标的不表现为故障）─────────────
    {
      const row = await radarRow(cfg, TICKER_EOD);
      assert.equal(row.priceKind, AnchorResponsePriceKind.eod_close);
      assert.equal(row.spot, LAST_CLOSE_EOD, '与其他锚并列可比，不是错误态');
      assert.equal(row.distanceToWPct, '-5.00');
    }
  } finally {
    for (const id of ids) {
      const del = await optionsdeskControllerRemove(id, cfg);
      assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
    }
  }
}

/** 雷达里的某一行（拿不到 = 断言失败，比后续 `?.` 一路吞掉强）。 */
async function radarRow(cfg: Cfg, ticker: string): Promise<AnchorResponse> {
  const radar = await optionsdeskControllerRadar({ limit: 50, market: 'us' }, cfg);
  assert.equal(radar.status, 200, `radar expected 200, got ${radar.status}`);
  const row = radar.data.items.find((a) => a.ticker === ticker);
  assert.ok(row, `${ticker} 应在雷达上`);
  return row;
}

/** 本 spec 两只锚在雷达上的相对次序（其他 spec 的锚已各自清理，但仍按 ticker 收窄）。 */
async function radarOrder(cfg: Cfg): Promise<string[]> {
  const radar = await optionsdeskControllerRadar({ limit: 50, market: 'us' }, cfg);
  assert.equal(radar.status, 200);
  return radar.data.items
    .map((a) => a.ticker)
    .filter((t) => t === TICKER_FRESH || t === TICKER_EOD);
}

/** 锚列表（另一个读端）里的某一行。 */
async function listRow(cfg: Cfg, ticker: string): Promise<AnchorResponse> {
  const listed = await optionsdeskControllerList(undefined, cfg);
  assert.equal(listed.status, 200, `list expected 200, got ${listed.status}`);
  const row = listed.data.items.find((a) => a.ticker === ticker);
  assert.ok(row, `${ticker} 应在锚列表里`);
  return row;
}
