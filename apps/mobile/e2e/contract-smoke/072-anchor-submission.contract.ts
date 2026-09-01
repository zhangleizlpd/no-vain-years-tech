/**
 * 072 锚待审箱审批线上化 —— 四个审批端点的契约冒烟（Constitution §V 两层之二）。
 *
 * 用**生成的** `@nvy/api-client` 打 harness boot 的真 server（testcontainers PG），跑一条
 * 全链路：**准入 403 → 提权 → 列表 → 详情 → 采纳（真落锚）→ 驳回 → 冷启动读面**。
 *
 * 🚨 本片四条只有端到端才验得到的靶心：
 *   1. **admin-only 是真的**（FR-010）：同一个 token，`is_admin=false` 时四个端点全 403，
 *      翻 true 后才通。客户端那一位只管渲不渲染，真闸在这里 —— hermetic e2e 永远验不到它。
 *   2. **屏上解构的每个字段真的在响应里**：`disposition` / `asofFlag` / `asofSuggested` /
 *      `instrumentName` / `fallbackPreview` / `willBeNoop` —— 少一个键，屏上就是一处
 *      `undefined`，而 mock e2e 因为自己造数据永远发现不了。
 *   3. **采纳真落锚且状态真翻**（FR-003/FR-004）：回执的 `anchorId` 能在锚表读回来，
 *      待审行进 CONSUMED 且 `consumedAnchorId` 指向它（FR-013 那条孤儿检出的前提）。
 *   4. **驳回的 skipped 是真的**（FR-007）：一条 PENDING + 一条已 CONSUMED 一起提交，
 *      服务端 MUST 分开回，而不是折成一句 ok。
 *
 * 边界与幂等：专属 ticker `us:NVYS`（避开既有 NVYA..NVYY）；待审行无公开写端点（投递口在
 * guest 通道，另一套鉴权）⇒ 走 `ctx.execSql` 直插；末尾删锚 + 删待审行 + 复位 `is_admin`。
 */
import assert from 'node:assert/strict';
import {
  anchorSubmissionControllerApprove,
  anchorSubmissionControllerGetOne,
  anchorSubmissionControllerList,
  anchorSubmissionControllerReject,
  marketdataControllerAnchorColdStart,
  optionsdeskControllerGetOne,
  optionsdeskControllerRemove,
} from '@nvy/api-client';
import type { AnchorSubmissionReviewResponse } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-anchor-submission (072)';

type Cfg = { baseURL: string; headers: Record<string, string> };

const MARKET = 'us';
const CODE = 'NVYS';
const SYMBOL = `${MARKET}:${CODE}`;
const SUBMITTER = 'contract-smoke';

/**
 * 倒数第 `n` 个**工作日**（UTC 轴，`YYYY-MM-DD`），`n` 从 1 起。
 *
 * 🚨 **数的是工作日，不是日历天**。口径日闸的判官是 `MockMarketDataAdapter.classify()`
 * —— harness 恒钉 `MARKETDATA_PROVIDER=mock`，而 `marketdata.module.ts` 的
 * `TRADING_CALENDAR_PORT` 在 mock 下绑 Mock 单例（**不读 `marketdata.trading_day` 表**），
 * 判据只是对日期串取 `getUTCDay()` 看落不落在周一~周五。日历天回退有 2/7 概率落到周末
 * ⇒ `asofFlag=NON_TRADING` ⇒ 采纳被 fail-closed 闸挡成 409 `ASOF_SUSPECT`
 * （2026-09-01 夜跑实撞：那天 UTC 是周二，D-3 = 08-29 周六）。本函数与 mock 同源判周一~
 * 周五，逐点等价。
 *
 * 🚨 **不能写成「日历天回退后再 snap 回最近工作日」**：周三跑时 D-3(周日) 与 D-4(周六) 会
 * snap 成同一个周五，两条待审的 `asof` 撞车 —— 而第二条正是靠 `asof` 从列表里认出来的。
 *
 * `n ≥ 1` 恒早于 UTC 今天，交易所当地今天又不早于 UTC 昨天 ⇒ `FUTURE` / `TODAY` 两档够不着
 * （本片验的不是日闸，那归 server 单测）。复杂度 O(n)。
 */
function nthWeekdayBack(n: number): string {
  const d = new Date();
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const day = d.getUTCDay();
    if (day >= 1 && day <= 5) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

const ASOF_MAIN = nthWeekdayBack(3);
const ASOF_SECOND = nthWeekdayBack(4);

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg: Cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  await cleanup(ctx);
  await seedInstrument(ctx);

  let anchorId: string | null = null;
  try {
    // ── 靶心 1: admin-only（FR-010）——同一个 token，提权前后两副面孔 ──────────
    await assertForbidden(cfg);
    await ctx.execSql(`UPDATE account.account SET is_admin = true WHERE id = ${ctx.accountId}`);

    // ── 靶心 2: 列表 —— 屏上解构的每个字段都在 ────────────────────────────────
    await insertSubmission(ctx, ASOF_MAIN, '55.0000', 'contract-smoke 主用例');
    const list = await anchorSubmissionControllerList({}, cfg);
    assert.equal(list.status, 200, `list expected 200, got ${list.status}`);
    const row = list.data.items.find((i) => i.ticker === SYMBOL);
    assert.ok(row, '刚插入的待审行应在默认 PENDING 列表里');
    assertRowShape(row);
    assert.equal(row.disposition, 'create', '锚表里还没有这只票 ⇒ disposition 应为 create');
    assert.equal(typeof list.data.total, 'number', 'total 缺失 —— 计数条会渲成 undefined');
    assert.equal(typeof list.data.truncated, 'boolean', 'truncated 缺失 —— 截断提示无从判定');

    // ── 详情：比列表多的两样（采纳前预览）─────────────────────────────────────
    const detail = await anchorSubmissionControllerGetOne(row.id, cfg);
    assert.equal(detail.status, 200, `detail expected 200, got ${detail.status}`);
    assert.ok(
      Array.isArray(detail.data.fallbackPreview),
      'fallbackPreview 缺失 —— 「采纳会冲掉哪些人工位」整块渲不出来',
    );
    assert.equal(
      typeof detail.data.willBeNoop,
      'boolean',
      'willBeNoop 缺失 —— 少了它，逐值相同的提交会被预览成「将清掉你的 3 处人工位」',
    );
    assert.equal(detail.data.willBeNoop, false, '新建锚不可能是 noop');

    // ── 靶心 3: 采纳真落锚 + 状态真翻（FR-003 / FR-004）───────────────────────
    const approved = await anchorSubmissionControllerApprove(row.id, {}, cfg);
    // 200 而不是 201：采纳是「处置一条已存在的待审」，不是造一个新资源 URI。
    assert.equal(approved.status, 200, `approve expected 200, got ${approved.status}`);
    const receipt = approved.data;
    assert.equal(receipt.action, 'create', `首次采纳应 create, got ${receipt.action}`);
    assert.equal(receipt.ticker, SYMBOL);
    assert.equal(receipt.appliedAsof, ASOF_MAIN, '没改口径日 ⇒ 落库日应与提交行一致');
    assert.equal(receipt.statusFlipped, true, '无并发 ⇒ 状态应翻成 CONSUMED');
    assert.equal(receipt.coldStartExpected, true, 'create ⇒ 应排一个冷启动');
    assert.ok(Array.isArray(receipt.fallbackEntries), 'fallbackEntries 缺失（为空是正常的）');
    anchorId = receipt.anchorId;

    const anchor = await optionsdeskControllerGetOne(anchorId, cfg);
    assert.equal(anchor.status, 200, '回执里的 anchorId 应能在锚表读回来');
    assert.equal(anchor.data.ticker, SYMBOL);
    assert.equal(anchor.data.v, '55.0000', 'V 应原样重放（永不经 JS number）');

    const consumed = await anchorSubmissionControllerList({ status: 'CONSUMED' }, cfg);
    const consumedRow = consumed.data.items.find((i) => i.id === row.id);
    assert.ok(consumedRow, '采纳后的行应能按 status=CONSUMED 查回');
    assert.equal(
      consumedRow.consumedAnchorId,
      anchorId,
      'consumedAnchorId MUST 指向落成的锚 —— 「有锚但没有 submission 指向它」那条孤儿检出全靠它',
    );

    // ── 靶心 4: 驳回把 rejected 与 skipped 分开回（FR-007）────────────────────
    await insertSubmission(ctx, ASOF_SECOND, '56.0000', 'contract-smoke 待驳回');
    const pending = await anchorSubmissionControllerList({}, cfg);
    const toReject = pending.data.items.find((i) => i.ticker === SYMBOL && i.asof === ASOF_SECOND);
    assert.ok(toReject, '第二条待审应在 PENDING 列表里');

    const rejected = await anchorSubmissionControllerReject(
      // 一条 PENDING + 一条**已被采纳**的 —— 服务端必须分开回。
      { ids: [toReject.id, row.id], reviewNote: 'contract smoke' },
      cfg,
    );
    assert.equal(rejected.status, 200, `reject expected 200, got ${rejected.status}`);
    assert.equal(rejected.data.rejected, 1, '只有那条 PENDING 该被驳回');
    assert.deepEqual(
      rejected.data.skipped,
      [row.id],
      'MUST NOT 折成一句 ok —— 已被处置过的那条要点名回来',
    );

    // ── 冷启动读面：缺席是正常的，且这有语义（FR-009 / sb-18）────────────────
    const runs = await marketdataControllerAnchorColdStart({ anchorIds: anchorId }, cfg);
    assert.equal(runs.status, 200, `cold-start expected 200, got ${runs.status}`);
    assert.ok(Array.isArray(runs.data.items), 'items 缺失 —— 面板的进度与分档都从它派生');
    // 🚨 worker 没跑 ⇒ 查不到该 anchorId ⇒ **不返回该行**（MUST NOT 编一个占位结局）。
    assert.equal(
      runs.data.items.length,
      0,
      '还没出行的锚 MUST NOT 被服务端补一个占位结局 —— 缺席本身就是「排队中」',
    );
  } finally {
    if (anchorId !== null) {
      const del = await optionsdeskControllerRemove(anchorId, cfg);
      assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
    }
    await ctx.execSql(`UPDATE account.account SET is_admin = false WHERE id = ${ctx.accountId}`);
    await cleanup(ctx);
  }
}

/**
 * 提权前端点全 403 —— 客户端那一位只管渲染，真闸在服务端（FR-010）。
 *
 * 🚨 **必须在提权之前调**：提权后再断 403 是恒假，会被读成「断言写错了」而不是「闸没了」。
 */
async function assertForbidden(cfg: Cfg): Promise<void> {
  const list = await anchorSubmissionControllerList({}, { ...cfg, validateStatus: () => true });
  assert.equal(list.status, 403, `非 admin 拉待审箱应 403, got ${list.status}`);

  const reject = await anchorSubmissionControllerReject(
    { ids: ['1'] },
    { ...cfg, validateStatus: () => true },
  );
  assert.equal(reject.status, 403, `非 admin 批量驳回应 403, got ${reject.status}`);
}

function assertRowShape(row: AnchorSubmissionReviewResponse): void {
  for (const key of [
    'id',
    'submitter',
    'ticker',
    'market',
    'v',
    'asof',
    'method',
    'confidence',
    'status',
    'disposition',
    'asofFlag',
    'asofNeedsAck',
    'createdAt',
    'updatedAt',
  ] as const) {
    assert.ok(row[key] !== undefined, `列表行缺 ${key} —— 屏上会渲成 undefined`);
  }
  // 这三个**可以为 null，但键必须在**（null 是「没有名字 / 无建议日 / 无附言」，
  // undefined 是「字段没下发」——屏上处置完全不同）。
  for (const key of ['instrumentName', 'asofSuggested', 'note'] as const) {
    assert.ok(key in row, `列表行缺键 ${key}（null 与 undefined 不是一回事）`);
  }
  assert.equal(row.submitter, SUBMITTER, 'submitter 应原样回显（归属，不作授权）');
}

/**
 * 只铺标的。`instrumentName` 由列表读它回填（缺行则该字段为 null，屏上少一行名字）。
 *
 * 🚨 **蓄意不铺 `marketdata.trading_day`**：harness 下日历口走 Mock 单例，那张表**没有任何
 * 读者**（判据见 {@link nthWeekdayBack}）—— 铺了也只是往一次性库里写三行死数据。而且它铺的
 * 是「D-3/D-4/D-5 一律算交易日」，撞上周末就等于宣布周六开市，会让本片绿在一个现实中不存在
 * 的日历上；那正是 mock 拒绝建模节假日的同一条理由。要让口径日落在交易日，靠上面那个函数
 * 挑对日子，不靠给日历塞答案。
 */
async function seedInstrument(ctx: RealBackendCtx): Promise<void> {
  await ctx.execSql(
    `INSERT INTO marketdata.instrument (market, code, name, type, currency, status)
     VALUES ('${MARKET}', '${CODE}', '072 契约冒烟 待审箱', 'stock', 'USD', 'listed')
     ON CONFLICT DO NOTHING`,
  );
}

async function insertSubmission(
  ctx: RealBackendCtx,
  asof: string,
  v: string,
  note: string,
): Promise<void> {
  await ctx.execSql(
    `INSERT INTO optionsdesk.anchor_submission
       (submitter, ticker, v, asof, method, confidence, note, status)
     VALUES ('${SUBMITTER}', '${SYMBOL}', ${v}, DATE '${asof}', 'dcf', 7.50, '${note}', 'PENDING')`,
  );
}

async function cleanup(ctx: RealBackendCtx): Promise<void> {
  await ctx.execSql(`DELETE FROM optionsdesk.anchor_submission WHERE ticker = '${SYMBOL}'`);
  await ctx.execSql(`DELETE FROM optionsdesk.anchor WHERE ticker = '${SYMBOL}'`);
}
