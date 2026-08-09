/**
 * 025 portfolio-holdings 契约冒烟（PR-2 §V 第二层）。
 *
 * 用**生成的** @nvy/api-client 函数（Orval，消费端真实代码路径）打**真 server**（harness
 * boot 的 testcontainers 后端）验自有持仓核心链 + 真落库 + 契约对齐：
 *   ① EP1 导入脱敏真实样本 xlsx（**FormData 路径验真**：生成函数自建 FormData，File part
 *      携带 .xlsx 文件名过 server 扩展校验 + asOf 文本字段同请求）→ 摘要断言
 *      （2 持仓 + 1 汇总 skip + 1 已清仓 + 23 流水，锚同 server IT 样本基线）；
 *   ② EP2 回显：asOf 行级冗余 / current 2 行（字段形态 Decimal string / quotable boolean）
 *      / closed 1 行（日期区间 + 均价）；
 *   ③ EP3 等值 (market, code) 流水：603915 全量 9 条 + 时序倒序 + 未交易标的空 items（200 非 404）；
 *   ④ 重导幂等（FR-006 整体替换）：摘要相等 + EP2/EP3 回显不变（行 id 为替换批新发，剥离后比）。
 *
 * 这正是 hermetic Playwright（mock 即假设契约）与 server IT（不经生成客户端、不经真 multipart
 * over HTTP）都覆盖不到的缝——尤其 orval 生成的 FormData 编排（file part 在前 / asOf 字段在后）
 * 与 @fastify/multipart 字段提取的对接。
 *
 * fixture = server 端脱敏真实样本（fs **文件读取**而非跨 project import——mobile-app scope 禁
 * 依赖 server 代码，文件级 reach-across 沿 harness 解析 ../server 先例）。V1 无删除端点
 * （import-only），本 spec 不清理持仓表——注册于 SPECS 末位，不影响前序 spec。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  holdingsControllerList,
  holdingsImportControllerImport,
  tradesControllerList,
  type HoldingsListResponse,
  type TradeListResponse,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'portfolio-holdings (025)';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const AS_OF = '2026-06-05';
const MARKET = 'cn';
const CODE = '603915';

/** 重导幂等比对：行 id 为整体替换批新发（IT 同款剥离），其余字段须逐一相等。 */
function stripHoldingsIds(body: HoldingsListResponse) {
  const strip = <T extends { id: string }>({ id: _id, ...rest }: T) => rest;
  return {
    asOf: body.asOf,
    current: body.current.map(strip),
    closed: body.closed.map(strip),
  };
}

function stripTradeIds(body: TradeListResponse) {
  return body.items.map(({ id: _id, ...rest }) => rest);
}

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // cwd = apps/mobile（contract-smoke nx target 约定，同 harness 解析 SERVER_DIR）。
  const samplePath = resolve(
    process.cwd(),
    '..',
    'server',
    'src',
    'portfolio',
    '__fixtures__',
    'sample-holdings.xlsx',
  );
  const sample = await readFile(samplePath);
  // File（Blob 子类）携带 filename → FormData part 过 server `.xlsx` 扩展校验。
  const makeFile = () =>
    new File([new Uint8Array(sample)], 'holdings-20260605.xlsx', {
      type: XLSX_MIME,
    });

  // ① EP1 导入（multipart FormData 真路径）→ 摘要锚（样本基线同 server IT）。
  const imported = await holdingsImportControllerImport({ file: makeFile(), asOf: AS_OF }, cfg);
  assert.equal(imported.status, 200, `import expected 200, got ${imported.status}`);
  assert.equal(imported.data.asOf, AS_OF, 'asOf form field round-trips (orval FormData → fastify)');
  assert.equal(imported.data.holdings.imported, 2, 'sample: 2 holding rows imported');
  assert.equal(imported.data.holdings.skipped.length, 1, 'sample: 汇总 aggregate row skipped');
  assert.equal(imported.data.closed.imported, 1, 'sample: 1 closed position imported');
  assert.equal(imported.data.trades.imported, 23, 'sample: 23 trade rows imported');

  // ② EP2 回显：asOf / current / closed 字段形态（真 DB round-trip，非 mutation 回声）。
  const listed = await holdingsControllerList(cfg);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.asOf, AS_OF, 'EP2 asOf mirrors import batch (行级冗余, plan D6)');
  assert.equal(listed.data.current.length, 2, 'EP2 current = 2 rows');
  assert.equal(listed.data.closed.length, 1, 'EP2 closed = 1 row');
  const guomao = listed.data.current.find((h) => h.market === MARKET && h.code === CODE);
  assert.ok(guomao, '603915 present in current holdings');
  assert.equal(guomao.name, '国茂股份', 'name from file');
  assert.match(guomao.qty, /^\d+(\.\d+)?$/, 'qty is a Decimal string');
  assert.match(guomao.unitCost, /^\d+(\.\d+)?$/, 'unitCost is a Decimal string');
  assert.equal(typeof guomao.quotable, 'boolean', 'quotable derivation flag present');
  const closedRow = listed.data.closed[0];
  assert.ok(closedRow, 'closed row present');
  assert.match(closedRow.openDate, /^\d{4}-\d{2}-\d{2}$/, 'openDate YYYY-MM-DD');
  assert.match(closedRow.closeDate, /^\d{4}-\d{2}-\d{2}$/, 'closeDate YYYY-MM-DD');

  // ③ EP3 等值流水：603915 全量 9 条 + 倒序；未交易标的 → 空 items（200 非 404）。
  const trades = await tradesControllerList({ market: MARKET, code: CODE }, cfg);
  assert.equal(trades.status, 200);
  assert.equal(trades.data.items.length, 9, 'sample: 9 trades for 603915');
  trades.data.items.forEach((t) => {
    assert.equal(t.market, MARKET);
    assert.equal(t.code, CODE);
  });
  const keys = trades.data.items.map((t) => `${t.tradeDate} ${t.tradeTime ?? ''}`);
  const sortedDesc = [...keys].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  assert.deepEqual(keys, sortedDesc, 'trades newest-first (tradeDate desc, tradeTime desc)');
  const neverTraded = await tradesControllerList({ market: MARKET, code: '600519' }, cfg);
  assert.equal(neverTraded.status, 200, 'unknown instrument → 200 (not 404)');
  assert.deepEqual(neverTraded.data.items, [], 'unknown instrument → empty items');

  // ④ 重导幂等（FR-006 整体替换）：摘要相等 + EP2/EP3 回显不变（剥 id 比）。
  const reimported = await holdingsImportControllerImport({ file: makeFile(), asOf: AS_OF }, cfg);
  assert.equal(reimported.status, 200, `re-import expected 200, got ${reimported.status}`);
  assert.deepEqual(reimported.data, imported.data, 're-import summary identical (idempotent)');
  const relisted = await holdingsControllerList(cfg);
  assert.deepEqual(
    stripHoldingsIds(relisted.data),
    stripHoldingsIds(listed.data),
    'EP2 echo unchanged after re-import (whole-account replacement)',
  );
  const retrades = await tradesControllerList({ market: MARKET, code: CODE }, cfg);
  assert.deepEqual(
    stripTradeIds(retrades.data),
    stripTradeIds(trades.data),
    'EP3 echo unchanged after re-import',
  );
}
