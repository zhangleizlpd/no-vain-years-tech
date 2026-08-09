/**
 * 024 alert-realtime 契约冒烟（PR-3 §V 第二层）。
 *
 * 021 alert.contract 验 8 端点全生命周期 / 023 alert-indicators.contract 验参数化条件契约;
 * 本薄片只补 024 扩出的**盘中 5min 2 新类型 + 到价类混合**的契约对齐——用生成的 @nvy/api-client
 * 打真 server（testcontainers）验 PRICE_RISE_5MIN_OVER（percent 阈值）与到价类 PRICE_RISE_TO
 * 同一预警内共存、写入→读回→改阈值→删除全链路的形状与值域校验:
 *   ① EP3 建混合预警（单标的; PRICE_RISE_5MIN_OVER threshold=3 盘中 5min + PRICE_RISE_TO
 *      threshold=1700 到价类——两者均 percent/price 阈值, 无 param）;
 *   ② EP1（按标的）/ EP2（全账号）读回对齐: param=0 sentinel + threshold Decimal string;
 *   ③ EP4 编辑改 threshold: 5min 阈值 3→5（percent 值域 (0,100] 内）, 到价类保留;
 *   ④ EP5 删除 → EP2 为空（自清理, 不污染同套件后续 spec）。
 */
import assert from 'node:assert/strict';
import {
  alertsControllerCreateBatch,
  alertsControllerDeleteBatch,
  alertsControllerListAll,
  alertsControllerListForInstrument,
  alertsControllerUpdate,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'alert-realtime (024)';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ① EP3 建混合预警：盘中 5min（PRICE_RISE_5MIN_OVER threshold=3）+ 到价类（PRICE_RISE_TO threshold=1700）。
  const created = await alertsControllerCreateBatch(
    {
      instruments: [{ market: 'cn', code: '600519' }],
      conditions: [
        { type: 'PRICE_RISE_5MIN_OVER', threshold: 3 },
        { type: 'PRICE_RISE_TO', threshold: 1700 },
      ],
      frequency: 'DAILY',
      note: '实时契约冒烟',
    },
    cfg,
  );
  assert.equal(created.status, 201, `create expected 201, got ${created.status}`);
  assert.equal(created.data.alerts.length, 1, '单标的 1 条 alert');
  const alert = created.data.alerts[0];
  assert.ok(alert, 'alert 落库');
  assert.equal(alert.conditions.length, 2, 'conditions 内联 2 条（5min + 到价）');

  // 5min 类形状对齐：percent 阈值, 无 param（param=0 sentinel）。
  const fivemin = alert.conditions.find((c) => c.type === 'PRICE_RISE_5MIN_OVER');
  assert.ok(fivemin, '回显 PRICE_RISE_5MIN_OVER');
  assert.equal(fivemin.param, 0, '5min: 无 param 类型 param=0 sentinel');
  assert.ok(
    fivemin.threshold != null && Number.parseFloat(fivemin.threshold) === 3,
    '5min: threshold Decimal→string=3',
  );
  // 到价类形状对齐：price 阈值, 无 param。
  const riseTo = alert.conditions.find((c) => c.type === 'PRICE_RISE_TO');
  assert.ok(riseTo, '回显 PRICE_RISE_TO');
  assert.equal(riseTo.param, 0, '到价: param=0 sentinel');
  assert.ok(
    riseTo.threshold != null && Number.parseFloat(riseTo.threshold) === 1700,
    '到价: threshold Decimal→string=1700',
  );

  // ② EP1 按标的 / EP2 全账号 读回对齐（真 DB 读回, 非 mutation 回声）。
  const ep1 = await alertsControllerListForInstrument('cn', '600519', cfg);
  assert.equal(ep1.status, 200, `EP1 expected 200, got ${ep1.status}`);
  assert.equal(ep1.data.alerts.length, 1, 'EP1: 600519 名下 1 条');
  const ep1Fivemin = ep1.data.alerts[0]?.conditions.find((c) => c.type === 'PRICE_RISE_5MIN_OVER');
  assert.ok(
    ep1Fivemin?.threshold != null && Number.parseFloat(ep1Fivemin.threshold) === 3,
    'EP1: 5min 阈值持久对齐=3',
  );

  const ep2 = await alertsControllerListAll(cfg);
  assert.ok(
    ep2.data.alerts.some((a) => a.id === alert.id),
    'EP2: 全账号含本 alert',
  );

  // ③ EP4 编辑改 threshold：5min 阈值 3→5（percent 值域内）, 到价类保留。
  const edited = await alertsControllerUpdate(
    alert.id,
    {
      conditions: [
        { type: 'PRICE_RISE_5MIN_OVER', threshold: 5 },
        { type: 'PRICE_RISE_TO', threshold: 1700 },
      ],
    },
    cfg,
  );
  assert.equal(edited.status, 200, `EP4 expected 200, got ${edited.status}`);
  assert.equal(edited.data.conditions.length, 2, 'EP4: 仍 2 条');
  const editedFivemin = edited.data.conditions.find((c) => c.type === 'PRICE_RISE_5MIN_OVER');
  assert.ok(
    editedFivemin?.threshold != null && Number.parseFloat(editedFivemin.threshold) === 5,
    'EP4: 5min 新阈值 5 持久',
  );
  const readBack = await alertsControllerListForInstrument('cn', '600519', cfg);
  const readBackFivemin = readBack.data.alerts[0]?.conditions.find(
    (c) => c.type === 'PRICE_RISE_5MIN_OVER',
  );
  assert.ok(
    readBackFivemin?.threshold != null && Number.parseFloat(readBackFivemin.threshold) === 5,
    'EP4: 改阈值持久（真 DB 读回=5）',
  );

  // ④ EP5 删除 → EP2 为空（自清理）。
  const deleted = await alertsControllerDeleteBatch({ ids: [alert.id] }, cfg);
  assert.equal(deleted.status, 200, `EP5 expected 200, got ${deleted.status}`);
  assert.equal(deleted.data.deleted, 1, 'EP5: 实删 1 条');
  const ep2After = await alertsControllerListAll(cfg);
  assert.equal(ep2After.data.alerts.length, 0, 'EP2: 删后为空');
}
