/**
 * 083 交易账户读接口契约冒烟（Constitution §V 两层验证之二；plan Gate 0.1）。
 *
 * 用**生成的** @nvy/api-client 打 harness boot 的**真 server**（testcontainers PG），验 hermetic
 * mock 与 server IT 都盖不到的两件事：
 *   ① **契约对齐** —— 4 个只读端点的 URL / 查询串 / 路径参数 / 响应解封 / 404 错误体，全走消费端
 *      真实代码路径（server IT 经 `app.inject` 直打、不经生成客户端；mobile e2e 的端点是 mock 的）；
 *   ② **真序列化** —— 种入的持仓穿过真 Prisma + 真 PG 读回：Decimal / BigInt 出边界为 string，
 *      连接标签取连接行的 `label`。
 *
 * 流程：① 账号无连接 ⇒ `hasConnection=false`、`groups=[]` ② 不存在的持仓 / 订单 id ⇒ 404，
 * 错误码在 ProblemDetail 的 `detail`（**没有** `code` 字段），键集与既有锚 not-found 一致
 * ③ 补齐状态查一个无记录的 ticker ⇒ `[]` ④ 种数读回：公开写端点建专属锚 → `ctx.execSql` 直插
 * 连接 + 正股持仓（券商镜像表由 082 同步写入，无公开写端点）→ 列表 / 详情读回。
 *
 * 边界与幂等：专属合成 ticker `us:ZQR`（避开 portfolio-holdings 的 ZQX 与其他 optionsdesk spec
 * 的 NVY*）+ 合成连接标签；持仓 / 连接 / 锚在 `finally` 里删除 —— 同一次 boot 内顺序跑多 spec
 * 不互相污染。① 依赖「本 spec 之前无人给该账号种连接」，run.ts 里排在它之前的 spec 均不碰
 * `optionsdesk.broker_connection`。
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  brokerAccountControllerBackfillRuns,
  brokerAccountControllerOrder,
  brokerAccountControllerPosition,
  brokerAccountControllerPositions,
  optionsdeskControllerCreate,
  optionsdeskControllerGetOne,
  optionsdeskControllerRemove,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-trading-account-positions (083)';

/** 专属合成 ticker（canonical `market:code`）与对应的券商正股代码。 */
const TICKER = 'us:ZQR';
const CODE = 'US.ZQR';
/** 合成连接标签（ASCII：经 `docker exec psql -c` 传参，不赌容器内客户端编码）。 */
const LABEL = 'smoke-083-conn';
/** 不存在的行 id（数字串，过路径参数的 BigInt 解析）。 */
const MISSING_ID = '9000000001';

/** 期望调用抛 axios 404，返回错误体。 */
async function expect404(
  call: () => Promise<unknown>,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    await call();
  } catch (e) {
    if (!axios.isAxiosError(e)) throw e;
    assert.equal(e.response?.status, 404, `${label} expected 404, got ${e.response?.status}`);
    return e.response?.data as Record<string, unknown>;
  }
  assert.fail(`${label} should have thrown 404`);
}

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  // accountId 直拼进 SQL ⇒ 先钉死是纯数字串。
  assert.match(ctx.accountId, /^\d+$/, 'accountId 为数字串');
  const accountId = ctx.accountId;

  // ── ① 无连接 ⇒ hasConnection=false、groups=[]（branch 1）──────────────────────────
  const empty = await brokerAccountControllerPositions({ market: 'us' }, cfg);
  assert.equal(empty.status, 200, `list expected 200, got ${empty.status}`);
  assert.equal(empty.data.hasConnection, false, '无连接 ⇒ hasConnection=false');
  assert.equal(empty.data.brokerCount, 0);
  assert.deepEqual(empty.data.groups, [], '无连接 ⇒ groups=[]');

  // ── ② 不存在的持仓 / 订单 id ⇒ 404，形态与既有锚 not-found 一致（branch 39）────────
  const anchor404 = await expect404(() => optionsdeskControllerGetOne(MISSING_ID, cfg), 'anchor');
  const position404 = await expect404(
    () => brokerAccountControllerPosition(MISSING_ID, cfg),
    'position',
  );
  const order404 = await expect404(() => brokerAccountControllerOrder(MISSING_ID, cfg), 'order');
  assert.equal(anchor404.detail, 'ANCHOR_NOT_FOUND', '对照组：锚 not-found 的错误码在 detail');
  assert.equal(position404.detail, 'BROKER_POSITION_NOT_FOUND', '持仓 404 错误码在 detail');
  assert.equal(order404.detail, 'BROKER_ORDER_NOT_FOUND', '订单 404 错误码在 detail');
  for (const [label, body] of [
    ['position', position404],
    ['order', order404],
  ] as const) {
    assert.equal(body.status, 404, `${label} 错误体 status=404`);
    assert.equal('code' in body, false, `${label} 错误体没有 code 字段（与锚 not-found 同体例）`);
    assert.deepEqual(
      Object.keys(body).sort(),
      Object.keys(anchor404).sort(),
      `${label} 错误体键集与锚 not-found 一致`,
    );
    assert.equal(body.type, anchor404.type, `${label} 错误体 type 与锚 not-found 一致`);
    assert.equal(body.title, anchor404.title, `${label} 错误体 title 与锚 not-found 一致`);
  }

  // ── ③ 补齐状态：无记录的 ticker ⇒ 裸数组 []（branch 42）──────────────────────────
  const runs = await brokerAccountControllerBackfillRuns({ tickers: TICKER }, cfg);
  assert.equal(runs.status, 200, `backfill-runs expected 200, got ${runs.status}`);
  assert.deepEqual(runs.data, [], '无补齐记录 ⇒ 空数组');

  // ── ④ 种数读回：锚（公开写端点）+ 连接 / 持仓（execSql 直插）→ 列表 / 详情 ─────────
  const created = await optionsdeskControllerCreate(
    {
      ticker: TICKER,
      v: '100.0000',
      asof: '2026-07-01',
      method: 'DCF · 契约冒烟',
      confidence: '8.0',
    },
    cfg,
  );
  assert.equal(created.status, 201, `create anchor expected 201, got ${created.status}`);
  const anchorId = created.data.id;

  try {
    await ctx.execSql(
      `INSERT INTO optionsdesk.broker_connection (account_id, broker_code, label, phone_last4)
       VALUES (${accountId}, 'futu', '${LABEL}', '0000')`,
    );
    await ctx.execSql(
      `INSERT INTO optionsdesk.broker_position
         (account_id, connection_id, market, code, underlying_ticker, qty, market_value,
          cost_price, average_cost, current_price, currency, first_seen_at, opened_at,
          opened_at_source, synced_at, raw)
       SELECT ${accountId}, id, 'us', '${CODE}', '${TICKER}', 100, 1234.5, 11.2, 11.2, 12.345,
              'USD', '2026-09-01T13:30:00Z', '2026-09-01T13:30:00Z', 'fallback',
              '2026-09-01T20:00:00Z', '{"unrealized_pl":"114.5","pl_ratio_avg_cost":"10.22"}'::jsonb
         FROM optionsdesk.broker_connection
        WHERE account_id = ${accountId} AND label = '${LABEL}'`,
    );

    const listed = await brokerAccountControllerPositions({ market: 'us' }, cfg);
    assert.equal(listed.status, 200);
    assert.equal(listed.data.hasConnection, true, '种入连接 ⇒ hasConnection=true');
    assert.equal(listed.data.brokerCount, 1);
    assert.equal(listed.data.syncedAt, null, '无成功同步记录 ⇒ syncedAt=null');
    const group = listed.data.groups.find((g) => g.underlyingTicker === TICKER);
    assert.ok(group, '锚集内的正股持仓成组返回（真 DB round-trip）');
    assert.equal(group.rows.length, 1);
    assert.equal(typeof group.groupMarketValue, 'string', '组市值出边界为 string');
    assert.equal(Number(group.groupMarketValue), 1234.5);

    const [row] = group.rows;
    assert.ok(row, '组内有且仅有种入的那一行');
    assert.match(row.id, /^\d+$/, 'BigInt id 出边界为数字串');
    assert.equal(row.market, 'us');
    assert.equal(row.kind, 'stock');
    assert.equal(row.code, CODE);
    assert.equal(row.option, null, '正股行 option=null');
    assert.equal(row.connectionLabel, LABEL, 'connectionLabel = 连接行 label（不是 brokerCode）');
    assert.equal(row.brokerCode, 'futu');
    for (const [field, value, expected] of [
      ['qty', row.qty, 100],
      ['marketValue', row.marketValue, 1234.5],
      ['currentPrice', row.currentPrice, 12.345],
      ['averageCost', row.averageCost, 11.2],
      ['unrealizedPl', row.unrealizedPl, 114.5],
      ['unrealizedPlRatio', row.unrealizedPlRatio, 10.22],
    ] as const) {
      assert.equal(typeof value, 'string', `${field} 出边界为 string`);
      assert.equal(Number(value), expected, `${field} 取值`);
    }
    assert.equal(row.expired, false, '正股行 expired 恒 false');

    // 正向路径参数：真实 id 读详情 ⇒ 200（② 只证了负向）。
    const detail = await brokerAccountControllerPosition(row.id, cfg);
    assert.equal(detail.status, 200, `position detail expected 200, got ${detail.status}`);
    assert.equal(detail.data.id, row.id);
    assert.equal(detail.data.connectionLabel, LABEL);
  } finally {
    // ── cleanup：先删持仓再删连接，最后删锚（同 boot 内幂等）。
    await ctx.execSql(
      `DELETE FROM optionsdesk.broker_position WHERE account_id = ${accountId} AND code = '${CODE}'`,
    );
    await ctx.execSql(
      `DELETE FROM optionsdesk.broker_connection WHERE account_id = ${accountId} AND label = '${LABEL}'`,
    );
    const del = await optionsdeskControllerRemove(anchorId, cfg);
    assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
  }
}
