/**
 * 021 alert 契约冒烟（PR-3 §V 第二层）。
 *
 * 用**生成的** @nvy/api-client 打**真 server**（harness boot 的 testcontainers 后端）验
 * alert 8 端点端到端 + 真落库 + 契约对齐，按 spec 闭环：
 *   ① EP3 批量建（2 标的 × 2 条件，D5 单 tx 每标的各 1 条独立 alert）；
 *   ② EP1（按标的）/ EP2（全账号）列表对齐（conditions 内联 + Decimal→string）；
 *   ③ EP4 编辑（conditions 全量替换 + frequency/note）+ toggle（enabled=false→读回持久）；
 *   ④ 直插 trigger 行（评估引擎产物形状——评估属 PR-2 server IT 责任，公开 API 无写口
 *      → ctx.execSql，per tasks T023「直插 trigger 行（或 CLI 评估）」）；
 *   ⑤ EP7 unread>0 → EP6 快照字段渲染源（instrumentName/conditionsSnapshot/unread）
 *      → EP8 mark-read → EP7=0（水位线闭环，plan D6）；
 *   ⑥ EP5 批量删（deleted 计数）→ EP2 空；trigger 流水独立于 Alert 生命周期仍可读。
 * 末尾删 trigger + read cursor（保持 boot 内幂等，不污染同套件后续 spec）。
 */
import assert from 'node:assert/strict';
import {
  alertMessagesControllerList,
  alertMessagesControllerMarkRead,
  alertMessagesControllerUnreadCount,
  alertsControllerCreateBatch,
  alertsControllerDeleteBatch,
  alertsControllerListAll,
  alertsControllerListForInstrument,
  alertsControllerUpdate,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'alert (021)';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ① EP3 批量建：2 标的 × 2 条件 → 每标的各 1 条（D5 单 tx 原子）。
  const created = await alertsControllerCreateBatch(
    {
      instruments: [
        { market: 'cn', code: '600519' },
        { market: 'cn', code: '000001' },
      ],
      conditions: [
        { type: 'PRICE_FALL_TO', threshold: 13 },
        { type: 'DAILY_LOSS_OVER', threshold: 7 },
      ],
      frequency: 'DAILY',
      note: '契约冒烟',
    },
    cfg,
  );
  assert.equal(created.status, 201, `create-batch expected 201, got ${created.status}`);
  assert.equal(created.data.alerts.length, 2, 'batch: 每标的各 1 条 alert');
  for (const a of created.data.alerts) {
    assert.equal(a.conditions.length, 2, 'batch: conditions 内联 2 条');
    assert.equal(a.frequency, 'DAILY');
    assert.equal(a.note, '契约冒烟');
    assert.equal(a.enabled, true);
  }
  const alertA = created.data.alerts.find((a) => a.code === '600519');
  const alertB = created.data.alerts.find((a) => a.code === '000001');
  assert.ok(alertA && alertB, 'batch: 两标的均落库');

  // ② EP1 按标的 / EP2 全账号 列表对齐（真 DB 读回，非 mutation 回声）。
  const ep1 = await alertsControllerListForInstrument('cn', '600519', cfg);
  assert.equal(ep1.status, 200, `EP1 expected 200, got ${ep1.status}`);
  assert.equal(ep1.data.alerts.length, 1, 'EP1: 600519 名下 1 条');
  assert.equal(ep1.data.alerts[0]?.id, alertA.id, 'EP1: id 对齐 EP3 落库');
  const fall = ep1.data.alerts[0]?.conditions.find((c) => c.type === 'PRICE_FALL_TO');
  assert.ok(fall, 'EP1: 条件类型对齐');
  assert.ok(fall.threshold, 'EP1: threshold 非空');
  assert.equal(Number.parseFloat(fall.threshold), 13, 'EP1: threshold Decimal→string 对齐');

  const ep2 = await alertsControllerListAll(cfg);
  assert.equal(ep2.data.alerts.length, 2, 'EP2: 全账号 2 条（market/code 平铺）');
  assert.deepEqual(
    ep2.data.alerts.map((a) => a.code).sort(),
    ['000001', '600519'],
    'EP2: 覆盖两标的',
  );

  // ③ EP4 编辑（conditions 全量替换 + frequency/note）→ toggle（enabled）→ 读回持久。
  const edited = await alertsControllerUpdate(
    alertA.id,
    {
      conditions: [{ type: 'PRICE_RISE_TO', threshold: 1850 }],
      frequency: 'ONCE_DISABLE',
      note: '改后备注',
    },
    cfg,
  );
  assert.equal(edited.status, 200, `EP4 expected 200, got ${edited.status}`);
  assert.equal(edited.data.conditions.length, 1, 'EP4: conditions 全量替换为 1 条');
  assert.equal(edited.data.conditions[0]?.type, 'PRICE_RISE_TO');
  assert.equal(edited.data.frequency, 'ONCE_DISABLE');
  assert.equal(edited.data.note, '改后备注');

  const toggled = await alertsControllerUpdate(alertA.id, { enabled: false }, cfg);
  assert.equal(toggled.data.enabled, false, 'EP4 toggle: enabled=false');
  const readBack = await alertsControllerListForInstrument('cn', '600519', cfg);
  assert.equal(readBack.data.alerts[0]?.enabled, false, 'toggle 持久（fresh GET）');
  assert.equal(readBack.data.alerts[0]?.conditions.length, 1, '替换持久（旧条件已删）');

  // ④ 直插 trigger 行（评估引擎产物形状；conditionsSnapshot = [{type,threshold,actual}]）。
  await ctx.execSql(
    `INSERT INTO alert.alert_trigger
       (alert_id, account_id, market, code, instrument_name, trade_date,
        conditions_snapshot, frequency_snapshot, note_snapshot)
     VALUES
       (${alertA.id}, ${ctx.accountId}, 'cn', '600519', '贵州茅台', '2026-06-05',
        '[{"type":"PRICE_RISE_TO","threshold":"1850.00","actual":"1862.00"}]'::jsonb,
        'ONCE_DISABLE', '改后备注')`,
  );

  // ⑤ 消息水位线闭环：EP7 unread>0 → EP6 快照字段 → EP8 mark-read → EP7=0。
  const unread1 = await alertMessagesControllerUnreadCount(cfg);
  assert.equal(unread1.data.unread, 1, 'EP7: 无 cursor 行 = 全未读');

  const messages = await alertMessagesControllerList(undefined, cfg);
  assert.equal(messages.data.messages.length, 1, 'EP6: 1 条消息');
  const msg = messages.data.messages[0];
  assert.ok(msg, 'EP6: 消息存在');
  assert.equal(msg.instrumentName, '贵州茅台', 'EP6: 名称快照');
  assert.equal(msg.code, '600519');
  assert.equal(msg.unread, true, 'EP6: unread 服务端派生');
  assert.equal(msg.conditions.length, 1, 'EP6: conditionsSnapshot 解包');
  assert.equal(msg.conditions[0]?.type, 'PRICE_RISE_TO');
  assert.equal(Number.parseFloat(msg.conditions[0].actual), 1862, 'EP6: actual 快照');
  assert.equal(messages.data.nextCursor, null, 'EP6: 单页无更多');

  const marked = await alertMessagesControllerMarkRead(cfg);
  assert.equal(marked.data.unread, 0, 'EP8: 置已读返 0');
  const unread2 = await alertMessagesControllerUnreadCount(cfg);
  assert.equal(unread2.data.unread, 0, 'EP7: mark-read 后归零（水位线持久）');

  // ⑥ EP5 批量删 → EP2 空；trigger 流水独立于 Alert 生命周期仍可读（FR-S05）。
  const deleted = await alertsControllerDeleteBatch({ ids: [alertA.id, alertB.id] }, cfg);
  assert.equal(deleted.status, 200, `EP5 expected 200, got ${deleted.status}`);
  assert.equal(deleted.data.deleted, 2, 'EP5: 实删 2 条');
  const ep2After = await alertsControllerListAll(cfg);
  assert.equal(ep2After.data.alerts.length, 0, 'EP2: 删后为空');
  const messagesAfter = await alertMessagesControllerList(undefined, cfg);
  assert.equal(messagesAfter.data.messages.length, 1, '消息流水不随 alert 删除消失');

  // ⑦ cleanup：删 trigger + read cursor（boot 内幂等）。
  await ctx.execSql(
    `DELETE FROM alert.alert_trigger WHERE account_id = ${ctx.accountId};
     DELETE FROM alert.alert_read_cursor WHERE account_id = ${ctx.accountId}`,
  );
}
