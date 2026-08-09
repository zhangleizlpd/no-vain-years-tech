/**
 * 012 broker-account-binding 契约冒烟（首个 pilot）。
 *
 * 用**生成的** @nvy/api-client 函数（Orval，消费端真实代码路径）打**真 server**（harness
 * boot 的 testcontainers 后端）验：① bind 核心写 → 201 + item shape；② list 读回含新条且
 * clientNo 为 raw 明文（证真落库经真栈，非 mock 假设）；③ 重复 bind → 真 409
 * BROKER_ACCOUNT_DUPLICATE（验唯一索引 P2002 → 错误码经客户端契约对齐）。
 *
 * 这正是 hermetic Playwright（mock 即假设契约）与 server IT（不经生成客户端）都覆盖不到的缝。
 * 末尾删掉本 spec 落的行，保持同套件后续 spec 的 boot 内幂等。
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  brokerAccountsControllerBind,
  brokerAccountsControllerDelete,
  brokerAccountsControllerList,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'broker-account-binding (012)';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const BROKER = 'htzq';
  const CLIENT_NO = '31192800002466';

  // ① bind 核心写 → 201 + item shape（raw clientNo）。
  const bound = await brokerAccountsControllerBind(
    { brokerCode: BROKER, clientNo: CLIENT_NO },
    cfg,
  );
  assert.equal(bound.status, 201, `bind expected 201, got ${bound.status}`);
  assert.equal(bound.data.brokerCode, BROKER);
  assert.equal(bound.data.clientNo, CLIENT_NO, 'server returns raw clientNo (FR-S07)');
  assert.equal(bound.data.isDefault, false);
  assert.ok(bound.data.id, 'bound item carries id');

  // ② list 读回 → 默认置顶 + 含新条（raw 明文 = 真 DB round-trip 证落库）。
  const listed = await brokerAccountsControllerList(cfg);
  assert.equal(listed.status, 200);
  const accounts = listed.data.accounts;
  assert.equal(accounts[0]?.isDefault, true, 'default account pinned on top');
  // 必须按 !isDefault 收窄：fresh testcontainers DB 里 accountId=1 与首个 broker_account
  // 自增 id=1 数值碰撞（正是 feature D3 处理的场景），按裸 id 匹配会先命中默认账户行。
  const mine = accounts.find((a) => !a.isDefault && a.id === bound.data.id);
  assert.ok(mine, 'bound row present in list (persisted)');
  assert.equal(mine?.clientNo, CLIENT_NO, 'list returns raw clientNo (real DB round-trip)');

  // ③ 重复同 {brokerCode, clientNo} → 真 409 BROKER_ACCOUNT_DUPLICATE（P2002 经客户端契约）。
  try {
    await brokerAccountsControllerBind({ brokerCode: BROKER, clientNo: CLIENT_NO }, cfg);
    assert.fail('duplicate bind should have thrown 409');
  } catch (e) {
    if (!axios.isAxiosError(e)) throw e; // 非 axios 错误（如上面的 assert.fail）→ 透传 = 失败
    assert.equal(e.response?.status, 409, `dup expected 409, got ${e.response?.status}`);
    assert.equal(
      (e.response?.data as { code?: string } | undefined)?.code,
      'BROKER_ACCOUNT_DUPLICATE',
      'dup error code aligned through generated client',
    );
  }

  // ④ cleanup：删本 spec 落的行（保持 boot 内幂等，不污染后续 spec）。
  const del = await brokerAccountsControllerDelete(bound.data.id, cfg);
  assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
}
