/**
 * 022 alert-push 契约冒烟（PR-2 §V 第二层）。
 *
 * 用**生成的** @nvy/api-client 打**真 server**（harness boot 的 testcontainers 后端）验
 * EP9/EP10 绑定生命周期端到端 + 真落库 + 契约对齐，按 spec 闭环（转绑 = clarify Q1）：
 *   ① 账号 A PUT binding（EP9）→ 200 + 响应形态（registrationId 回声 / platform / boundAt ISO）；
 *   ② A 同 RegID 重报 → 幂等无 409（同形响应）；
 *   ③ 账号 B（第二程序化登录，黑盒 SMS 固定码）PUT **同 RegID** → 转绑（RegID 全局唯一，
 *      旧绑定整体改挂 B，幂等无 409）；
 *   ④ A DELETE（EP10）→ deleted:0（已转绑非己有 —— 反枚举无杂音，恰证 ③ 旧绑定已消失）；
 *   ⑤ B DELETE → deleted:1（真落库删除）→ B 再 DELETE → deleted:0（幂等）。
 * 末尾绑定已删净（boot 内幂等，不污染同套件后续 spec）；推送链路（fan-out/dispatch）
 * 属 PR-1 server IT 责任，本层只验绑定契约面。
 */
import assert from 'node:assert/strict';
import { pushBindingControllerDelete, pushBindingControllerUpsert } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'alert-push (022)';

const PHONE_B = '+8613800138998';
const DEV_FIXED_CODE = '999999'; // issueSmsCode() under NODE_ENV=development（harness 同款黑盒）
const REG_ID = 'contract-smoke-regid-022';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfgA = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ① EP9 账号 A 建绑：响应形态对齐（registrationId 回声 + platform + boundAt ISO）。
  const bound = await pushBindingControllerUpsert(
    { registrationId: REG_ID, platform: 'android' },
    cfgA,
  );
  assert.equal(bound.status, 200, `EP9 expected 200, got ${bound.status}`);
  assert.equal(bound.data.registrationId, REG_ID, 'EP9: registrationId 回声');
  assert.equal(bound.data.platform, 'android', 'EP9: platform');
  assert.ok(
    Number.isFinite(Date.parse(bound.data.boundAt)),
    `EP9: boundAt 是合法 ISO 时间（got ${bound.data.boundAt}）`,
  );

  // ② A 同 RegID 重报：幂等无 409，同形响应（刷新 boundAt，不新增行）。
  const rebound = await pushBindingControllerUpsert(
    { registrationId: REG_ID, platform: 'android' },
    cfgA,
  );
  assert.equal(rebound.status, 200, 'EP9 重报: 幂等 200 无 409');
  assert.equal(rebound.data.registrationId, REG_ID, 'EP9 重报: registrationId 不变');

  // ③ 账号 B 第二程序化登录（黑盒：首次 phone-sms-auth 自动注册）→ PUT 同 RegID 转绑。
  await ctx.postJson('/api/v1/accounts/sms-codes', { phone: PHONE_B });
  const authB = (await ctx.postJson('/api/v1/accounts/phone-sms-auth', {
    phone: PHONE_B,
    code: DEV_FIXED_CODE,
  })) as { accountId: string; accessToken: string };
  assert.notEqual(authB.accountId, ctx.accountId, '前置: B 是独立账号');
  const cfgB = { baseURL: ctx.api, headers: { authorization: `Bearer ${authB.accessToken}` } };

  const rebind = await pushBindingControllerUpsert(
    { registrationId: REG_ID, platform: 'android' },
    cfgB,
  );
  assert.equal(rebind.status, 200, 'EP9 转绑: RegID 全局唯一整体改挂 B，幂等无 409');
  assert.equal(rebind.data.registrationId, REG_ID, 'EP9 转绑: registrationId 不变');

  // ④ EP10 A 删：已转绑非己有 → deleted:0（反枚举无杂音；恰证 ③ A 名下绑定已消失）。
  const deleteByA = await pushBindingControllerDelete(REG_ID, cfgA);
  assert.equal(deleteByA.status, 200, `EP10 expected 200, got ${deleteByA.status}`);
  assert.equal(deleteByA.data.deleted, 0, 'EP10: A 删已转绑 RegID → deleted:0');

  // ⑤ EP10 B 删：真落库删除 → deleted:1；再删 → deleted:0（幂等）。
  const deleteByB = await pushBindingControllerDelete(REG_ID, cfgB);
  assert.equal(deleteByB.data.deleted, 1, 'EP10: B 删己有绑定 → deleted:1');
  const deleteAgain = await pushBindingControllerDelete(REG_ID, cfgB);
  assert.equal(deleteAgain.data.deleted, 0, 'EP10: 重删幂等 → deleted:0');
}
