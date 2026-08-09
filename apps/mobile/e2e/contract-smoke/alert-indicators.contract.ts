/**
 * 023 alert-eod-indicators 契约冒烟（PR-3 §V 第二层）。
 *
 * 021 alert.contract 已验 8 端点全生命周期；本薄片只补 023 扩出的**参数化条件契约对齐**——
 * 用生成的 @nvy/api-client 打真 server（testcontainers）验 param/threshold 在写入→读回→
 * 替换全链路的形状与值域校验：
 *   ① EP3 建混类预警（单标的，MA_CROSS_UP param=20 无阈值 + PE_BELOW threshold=10 无 param）；
 *   ② EP1（按标的）/ EP2（全账号）读回对齐：param number(0 sentinel) + threshold Decimal string|null；
 *   ③ EP4 编辑：conditions 全量替换为 RSI_OVERSOLD（带阈值 25，技术指标族 0<v<100）；
 *   ④ 重复键拒：同一 create 请求含两条相同 (MA_CROSS_UP, 20) → 400（FR-S07 键唯一）；
 *   ⑤ EP5 删除（deleted 计数）→ EP2 为空（自清理，不污染同套件后续 spec）。
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

export const name = 'alert-indicators (023)';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ① EP3 建混类预警：MA_CROSS_UP param=20（无阈值）+ PE_BELOW threshold=10（无 param）。
  const created = await alertsControllerCreateBatch(
    {
      instruments: [{ market: 'cn', code: '600519' }],
      conditions: [
        { type: 'MA_CROSS_UP', param: 20 },
        { type: 'PE_BELOW', threshold: 10 },
      ],
      frequency: 'DAILY',
      note: '指标契约冒烟',
    },
    cfg,
  );
  assert.equal(created.status, 201, `create expected 201, got ${created.status}`);
  assert.equal(created.data.alerts.length, 1, '单标的 1 条 alert');
  const alert = created.data.alerts[0];
  assert.ok(alert, 'alert 落库');
  assert.equal(alert.conditions.length, 2, 'conditions 内联 2 条');

  // param/threshold 形状对齐（带参类型附 param·无阈值；阈值类型附 threshold·param 为 0 sentinel）。
  const ma = alert.conditions.find((c) => c.type === 'MA_CROSS_UP');
  assert.ok(ma, '回显 MA_CROSS_UP');
  assert.equal(ma.param, 20, 'MA: param=20 回显');
  assert.equal(ma.threshold, null, 'MA: 无阈值类型 threshold=null');
  const pe = alert.conditions.find((c) => c.type === 'PE_BELOW');
  assert.ok(pe, '回显 PE_BELOW');
  assert.equal(pe.param, 0, 'PE: 无 param 类型 param=0 sentinel');
  assert.ok(
    pe.threshold != null && Number.parseFloat(pe.threshold) === 10,
    'PE: threshold Decimal→string=10',
  );

  // ② EP1 按标的 / EP2 全账号 读回对齐（真 DB 读回，非 mutation 回声）。
  const ep1 = await alertsControllerListForInstrument('cn', '600519', cfg);
  assert.equal(ep1.status, 200, `EP1 expected 200, got ${ep1.status}`);
  assert.equal(ep1.data.alerts.length, 1, 'EP1: 600519 名下 1 条');
  const ep1Ma = ep1.data.alerts[0]?.conditions.find((c) => c.type === 'MA_CROSS_UP');
  assert.equal(ep1Ma?.param, 20, 'EP1: param 持久对齐');
  assert.equal(ep1Ma?.threshold, null, 'EP1: 无阈值持久 null');

  const ep2 = await alertsControllerListAll(cfg);
  assert.ok(
    ep2.data.alerts.some((a) => a.id === alert.id),
    'EP2: 全账号含本 alert',
  );

  // ③ EP4 编辑：conditions 全量替换为 RSI_OVERSOLD（带阈值 25）。
  const edited = await alertsControllerUpdate(
    alert.id,
    { conditions: [{ type: 'RSI_OVERSOLD', threshold: 25 }] },
    cfg,
  );
  assert.equal(edited.status, 200, `EP4 expected 200, got ${edited.status}`);
  assert.equal(edited.data.conditions.length, 1, 'EP4: 全量替换为 1 条');
  const rsi = edited.data.conditions[0];
  assert.equal(rsi?.type, 'RSI_OVERSOLD', 'EP4: 类型替换为 RSI_OVERSOLD');
  assert.equal(rsi?.param, 0, 'EP4: RSI 无 param 类型 param=0');
  assert.ok(
    rsi?.threshold != null && Number.parseFloat(rsi.threshold) === 25,
    'EP4: 新阈值 25 持久',
  );
  const readBack = await alertsControllerListForInstrument('cn', '600519', cfg);
  assert.equal(readBack.data.alerts[0]?.conditions.length, 1, 'EP4: 替换持久（旧 2 条已删）');

  // ④ 重复键拒：同一 create 含两条相同 (MA_CROSS_UP, 20) → 400（FR-S07 键唯一，默认 axios 抛）。
  await assert.rejects(
    () =>
      alertsControllerCreateBatch(
        {
          instruments: [{ market: 'cn', code: '000001' }],
          conditions: [
            { type: 'MA_CROSS_UP', param: 20 },
            { type: 'MA_CROSS_UP', param: 20 },
          ],
          frequency: 'DAILY',
          note: null,
        },
        cfg,
      ),
    (e: unknown) => (e as { response?: { status?: number } })?.response?.status === 400,
    '同 (type,param) 重复键应 400 拒',
  );

  // ⑤ EP5 删除 → EP2 为空（自清理）。
  const deleted = await alertsControllerDeleteBatch({ ids: [alert.id] }, cfg);
  assert.equal(deleted.status, 200, `EP5 expected 200, got ${deleted.status}`);
  assert.equal(deleted.data.deleted, 1, 'EP5: 实删 1 条');
  const ep2After = await alertsControllerListAll(cfg);
  assert.equal(ep2After.data.alerts.length, 0, 'EP2: 删后为空');
}
