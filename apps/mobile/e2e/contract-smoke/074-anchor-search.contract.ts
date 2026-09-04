/**
 * 074 雷达锚搜索 —— `GET /optionsdesk/anchors/search` 的契约冒烟（Constitution §V 两层之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的真 server（testcontainers PG）：
 * **种 instrument（含 pinyin_abbr）→ 建锚（既有公开端点）→ 中文名搜索 ⇒ 三字段逐字对拍
 * → `q=不存在` ⇒ 空 items**。
 *
 * 🚨 本片两条只有端到端才验得到的靶心：
 *   1. **提示行恰好三字段且逐字与种数一致**：`ticker` / `name`（`marketdata.instrument`
 *      单源，跨 ctx JOIN 真的把名字带回来了）/ `lLevelEffective`（与锚读面同源）——
 *      `deepEqual` 整对象对拍，多键少键都算契约漂移（FR-006 的「无行情数值」在这里就是
 *      「响应里压根没有那些键」）。hermetic mock 自己造数据，永远发现不了这类漂移。
 *   2. **零命中 = 空数组（200 非 404）**：空 items 是常态分支，客户端空态渲染吃这个形状。
 *
 * 边界与幂等：专属 ticker `us:NVYZ`（避开既有 NVYA..NVYY）+ 全库唯一的「零七四」名字词干
 * （子串搜索恰命中本行，不受其他 spec 种的数据影响）；末尾删锚自清理（instrument 与 072
 * 同体例留库，`ON CONFLICT DO NOTHING` 保重放幂等）。
 */
import assert from 'node:assert/strict';
import {
  optionsdeskControllerCreate,
  optionsdeskControllerRemove,
  optionsdeskControllerSearch,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-anchor-search (074)';

const MARKET = 'us';
const CODE = 'NVYZ';
const SYMBOL = `${MARKET}:${CODE}`;
/** 专属中文名 —— 「零七四」词干全库唯一 ⇒ 子串路恰好只命中本行。 */
const NAME = '零七四契约冒烟标的';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  await cleanup(ctx);
  await seedInstrument(ctx);

  let anchorId: string | null = null;
  try {
    // ── 建锚（写路径契约归 045 spec；这里它只是把标的送进搜索域 —— JOIN 即域判据）────
    const created = await optionsdeskControllerCreate(
      {
        ticker: SYMBOL,
        v: '88.0000',
        asof: '2026-07-01',
        method: 'DCF · 074 契约冒烟',
        confidence: '8.0',
        nextReview: '2026-12-31',
      },
      cfg,
    );
    assert.equal(created.status, 201, `create expected 201, got ${created.status}`);
    anchorId = created.data.id;
    assert.equal(
      created.data.lLevelEffective,
      'L2',
      'confidence 8.0 → 映射档 L2（对拍基准自身可信）',
    );

    // ── 靶心 1：中文名搜索 ⇒ 三字段逐字对拍 ────────────────────────────────────
    const hit = await optionsdeskControllerSearch({ q: '零七四' }, cfg);
    assert.equal(hit.status, 200, `search expected 200, got ${hit.status}`);
    const item = hit.data.items.find((i) => i.ticker === SYMBOL);
    assert.ok(item, '中文名子串应命中刚建锚的标的（JOIN 域判据 + name 子串路）');
    assert.deepEqual(
      item,
      { ticker: SYMBOL, name: NAME, lLevelEffective: created.data.lLevelEffective },
      '提示行恰好三字段且逐字与种数一致 —— 多键（行情数值 / excluded 标记）少键都算契约漂移',
    );

    // ── 靶心 2：q=不存在 ⇒ 空 items（200 非 404）───────────────────────────────
    const miss = await optionsdeskControllerSearch({ q: '不存在的名字零命中甲乙丙' }, cfg);
    assert.equal(miss.status, 200, `零命中 expected 200, got ${miss.status}`);
    assert.deepEqual(miss.data.items, [], '零命中 = 空数组，MUST NOT 404 / MUST NOT 缺 items 键');
  } finally {
    if (anchorId !== null) {
      const del = await optionsdeskControllerRemove(anchorId, cfg);
      assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
    }
    await cleanup(ctx);
  }
}

/**
 * 种标的（含 `pinyin_abbr` —— 搜索 SQL 的 coalesce 路真列真值，不靠全 NULL 侥幸绿）。
 * instrument 留库（与 072 同体例）：值恒定 + `ON CONFLICT DO NOTHING` ⇒ 重放幂等。
 */
async function seedInstrument(ctx: RealBackendCtx): Promise<void> {
  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status, pinyin_abbr, pinyin_full)
     VALUES ('${MARKET}', '${CODE}', '${NAME}', 'stock', 'USD', 'listed', 'lqsqymybd', 'lingqisiqiyuemaoyanbiaodi')
     ON CONFLICT DO NOTHING`,
  );
}

async function cleanup(ctx: RealBackendCtx): Promise<void> {
  await ctx.execSql(`DELETE FROM optionsdesk.anchor WHERE ticker = '${SYMBOL}'`);
}
