/**
 * 037 ideation mockup 交付链路 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，全 boot
 * node dist/main.js）验 037 worker-token 交付 + account-token 读列表的契约对齐 + 真落库 + 反枚举。
 * 聚焦三处缝（server IT〔T008，DI override 注 agentBridgeConfig/ossConfig〕与 hermetic mock〔T013〕
 * 都假设契约对齐、各自覆盖不到的）：
 *   ① 生成的 typed client 对凭证签发 fn `mockupCredentialControllerIssue`
 *      （`POST /ideation/mockups/credential`）、写记录 fn `mockupRecordControllerRecord`
 *      （`POST /ideation/mockups`）、读列表 fn `mockupListControllerList`
 *      （`GET /ideation/sessions/{id}/mockups`）的 URL/method/请求体序列化/响应解封与真 server
 *      装饰器派生的 openapi 契约**对齐**；
 *   ② 三端点端到端 + **真落库**：worker 签凭证（scope 派生）→ 用合法 key 写记录 → account-token
 *      读列表读回该 session 记录（screens + createdAt 倒序 + versionRank latest=1）；
 *   ③ 反枚举（他人 session 读 → 404）。
 *
 * **模拟 worker**（channel = agent-platform 仓、仓外）：worker-token 端点经 `WorkerAuthGuard` 鉴权
 * （harness serverEnv 注入 `AGENT_WORKER_TOKEN`，ctx.workerToken 暴露；guard fail-closed 默认拒一切
 * 故必须注入）。归属 scope (accountId, sessionId) **永远** server 据 claimed `agent_queue_event` 行
 * 派生（body 只带 eventId、channel 不自报）—— 故种子一条 claimed event（无公开写端点 → ctx.execSql
 * 直插 `public.agent_queue_event`；bizType='ideation.requirement' / bizId=String(sessionId) /
 * status='claimed' / account_id；id 用确定性 uuid 供端点引用）。session 本身走**公开 API** 建
 * （`sessionControllerCreate`，拿真 sessionId 给 claimed event 的 bizId 与读列表入参）。
 *
 * 分层职责（spec.md L34 SoT）：本契约冒烟**只验契约对齐 + 真落库 + 反枚举**。worker 鉴权
 * fail-closed（401）/ 谎报他 session prefix（403）/ 派生失败 404 / OSS 未配 503 等错误分支由
 * **T008 server IT**（DI override 注 worker token + 参数化 OSS + 种 agentQueueEvent）兜底——本就是
 * 分层设计：契约冒烟跑 `node dist/main.js` 真 boot **无 DI override**，只担「契约对齐 + 真落库」。
 * 渲染（隔离 / 降级）= mobile 职责，走 T013 hermetic e2e。
 *
 * 凭证签发 OSS 出口：harness 设确定性 fake-aliyun `OSS_*`（region/bucket/ak/sk 占位，非真 bucket）
 * → ossConfig kind='aliyun' → 凭证 EP 签 V4 表单返 200 + 读列表 mockupUrl 经 ossPublicBaseUrl 派生
 * （regional 默认 host，OSS_PUBLIC_BASE_URL 未配）。本 spec 验签发**契约 scope**（keyPrefix=
 * `ideation-mockup/<accountId>/<sessionId>/` + content-type 限 text/html + size 上限），不打真直传。
 *
 * 边界与幂等：mockup / session / agent_queue_event 均按 accountId 归属，本 spec 全程新建独立会话 +
 * 独立 claimed event（不碰其他 spec）；下次 boot 全新 PG 容器，故无 cleanup。他人-session 反枚举的
 * 第二 account 经公开 API 注册（不污染其他 spec 的单 account 范式）。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mockupCredentialControllerIssue,
  mockupListControllerList,
  mockupRecordControllerRecord,
  sessionControllerCreate,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'ideation-mockup (037)';

/** harness fake-aliyun OSS 派生的 public-read host（OSS_BUCKET.OSS_REGION.aliyuncs.com）。 */
const OSS_HOST = 'https://mbw-test-images.oss-cn-shanghai.aliyuncs.com';

/** 第二 account（他人 session 反枚举）登录用固定 phone（与 harness 主 account PHONE 不同号段）。 */
const OTHER_PHONE = '+8613800138037';
const DEV_FIXED_CODE = '999999';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const accountCfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const workerCfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.workerToken}` } };
  const accountId = ctx.accountId;

  // ── 建独立 open 会话（公开 API，typed client）→ 拿真 sessionId（claimed event bizId / 读列表入参）─
  const created = await sessionControllerCreate({ title: 'mockup 交付契约' }, accountCfg);
  assert.equal(created.status, 201, `建会话 expected 201, got ${created.status}`);
  const sessionId = created.data.id;
  assert.match(sessionId, /^\d+$/, '建会话: id 为数字串 (BigInt 序列化)');

  // 种一条 claimed agent_queue_event（无公开写端点 → execSql 直插 public schema；id 用确定性 uuid
  // 供 worker 端点 body.eventId 引用）。归属 (account_id, biz_id=sessionId) = worker scope 派生源。
  const eventId = randomUUID();
  // updated_at = Prisma `@updatedAt`（app 级、非 DB default）→ 裸 SQL INSERT 须显式给（NOT NULL）。
  await ctx.execSql(
    `INSERT INTO public.agent_queue_event (id, account_id, biz_type, biz_id, status, created_at, updated_at)
     VALUES ('${eventId}', ${accountId}, 'ideation.requirement', '${sessionId}', 'claimed', now(), now())`,
  );

  // ── ① 凭证签发（typed client）→ 200 + scope 对齐（keyPrefix / content-type text/html / size 上限）─
  const cred = await mockupCredentialControllerIssue({ eventId }, workerCfg);
  assert.equal(cred.status, 200, `凭证签发 expected 200, got ${cred.status}`);
  const { host, objectKey, expiresAt, fields } = cred.data;

  assert.equal(host, OSS_HOST, '凭证: host = OSS public-read 端点 (fake-aliyun 派生)');
  assert.equal(typeof objectKey, 'string', '凭证: objectKey 为 string');
  assert.equal(
    expiresAt,
    new Date(expiresAt).toISOString(),
    '凭证: expiresAt 为规范 ISO-8601 (TTL round-trip)',
  );

  // objectKey 严格落在 server 据 event 派生的 scope 前缀内（accountId/sessionId 来自 event 非自报）。
  const expectedPrefix = `ideation-mockup/${accountId}/${sessionId}/`;
  assert.ok(
    objectKey.startsWith(expectedPrefix),
    `凭证: objectKey 前缀 = '${expectedPrefix}' (event 派生 scope, got '${objectKey}')`,
  );
  assert.equal(fields.key, objectKey, '凭证: fields.key === objectKey (表单 key 与预分配键一致)');
  assert.equal(
    fields['x-oss-signature-version'],
    'OSS4-HMAC-SHA256',
    '凭证: x-oss-signature-version = OSS4-HMAC-SHA256',
  );

  // policy(base64 JSON) 内嵌三道 scope 闸（key 前缀 / content-type text/html 白名单 / size 上限）。
  const policy = JSON.parse(Buffer.from(fields.policy, 'base64').toString('utf8')) as {
    conditions: unknown[];
  };
  const conds = policy.conditions;
  assert.ok(
    conds.some(
      (c) =>
        Array.isArray(c) && c[0] === 'starts-with' && c[1] === '$key' && c[2] === expectedPrefix,
    ),
    `凭证 scope: policy 含 key 前缀闸 starts-with $key '${expectedPrefix}'`,
  );
  assert.ok(
    conds.some(
      (c) =>
        Array.isArray(c) &&
        c[0] === 'in' &&
        c[1] === '$content-type' &&
        Array.isArray(c[2]) &&
        (c[2] as string[]).length === 1 &&
        (c[2] as string[])[0] === 'text/html',
    ),
    '凭证 scope: policy 含 content-type 白名单闸 (仅 text/html，mockup 单自包含 HTML)',
  );
  assert.ok(
    conds.some((c) => Array.isArray(c) && c[0] === 'content-length-range'),
    '凭证 scope: policy 含 size 上限闸 (content-length-range)',
  );

  // ── ② 用合法 key 写记录（typed client，screens + note）→ 201 void（path/method/body 序列化对齐）─
  // objectKey 取签发凭证的 scope 前缀下一确定性 key（归属本 session/account，不越界）。
  const recordKey = `${expectedPrefix}${randomUUID()}/index.html`;
  const rec = await mockupRecordControllerRecord(
    { eventId, objectKey: recordKey, screens: ['空态', '加载', '成功'], note: '自检通过' },
    workerCfg,
  );
  assert.equal(rec.status, 201, `写记录 expected 201, got ${rec.status}`);

  // ── ③ account-token 读列表（typed client）→ 真落库读回该 session 记录 + screens + 倒序 + rank ──
  // 这是契约冒烟唯一能验、server IT 不经生成 client、hermetic mock 假设契约对齐都覆盖不到的缝。
  const list = await mockupListControllerList(sessionId, accountCfg);
  assert.equal(list.status, 200, `读列表 expected 200, got ${list.status}`);
  const items = list.data.items;
  assert.equal(items.length, 1, '读列表: 该 session 一条交付记录 (真落库读回)');

  const item = items[0];
  assert.equal(item.objectKey, recordKey, '读列表: objectKey 与写记录一致 (真落库)');
  assert.deepEqual(item.screens, ['空态', '加载', '成功'], '读列表: screens 逐屏标签对齐');
  assert.equal(item.versionRank, 1, '读列表: 单版 versionRank = 1 (最新)');
  assert.match(item.id, /^\d+$/, '读列表: id 为数字串 (BigInt 序列化)');
  assert.equal(
    item.createdAt,
    new Date(item.createdAt).toISOString(),
    '读列表: createdAt 为规范 ISO-8601',
  );
  // mockupUrl 经 ossPublicBaseUrl 派生（fake-aliyun regional host + objectKey；OSS_PUBLIC_BASE_URL 未配）。
  assert.equal(
    item.mockupUrl,
    `${OSS_HOST}/${recordKey}`,
    '读列表: mockupUrl = 备案展示域 (OSS host) + objectKey 派生',
  );

  // 同 session 再写一版 → 读列表 createdAt 倒序 + versionRank 重排（append-only 多版，最新 = 1）。
  const recordKey2 = `${expectedPrefix}${randomUUID()}/index.html`;
  const rec2 = await mockupRecordControllerRecord(
    { eventId, objectKey: recordKey2, screens: ['v2'] },
    workerCfg,
  );
  assert.equal(rec2.status, 201, `写记录 v2 expected 201, got ${rec2.status}`);

  const list2 = await mockupListControllerList(sessionId, accountCfg);
  assert.equal(list2.status, 200, `读列表 v2 expected 200, got ${list2.status}`);
  const items2 = list2.data.items;
  assert.equal(items2.length, 2, '读列表: append-only 多版 → 两行');
  // createdAt 倒序：v2 (最新) 在前，versionRank latest=1。
  assert.deepEqual(
    items2.map((x) => x.objectKey),
    [recordKey2, recordKey],
    '读列表: createdAt 倒序 (最新 v2 在前)',
  );
  assert.deepEqual(
    items2.map((x) => x.versionRank),
    [1, 2],
    '读列表: versionRank latest=1',
  );

  // ── ④ 反枚举: 他人 session 读 → 404 (account A 读 account B 的 session) ─────────────────────────
  await assertOtherSessionNotFound(ctx, accountCfg);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * 他人 session 读 → 404（反枚举，沿 036 FR-013）：经公开 API 注册第二 account（不污染单 account
 * 范式），建其 session，用 account A 的 token 读 → server usecase 归属-存在校验失败 → 404。
 */
async function assertOtherSessionNotFound(
  ctx: RealBackendCtx,
  ownerCfg: { baseURL: string; headers: Record<string, string> },
): Promise<void> {
  // 第二 account 经公开 phone-sms-auth 黑盒登录（首次自动注册；dev 固定码 999999）。
  await ctx.postJson('/api/v1/accounts/sms-codes', { phone: OTHER_PHONE });
  const otherAuth = (await ctx.postJson('/api/v1/accounts/phone-sms-auth', {
    phone: OTHER_PHONE,
    code: DEV_FIXED_CODE,
  })) as { accountId: string; accessToken: string };
  const otherCfg = {
    baseURL: ctx.api,
    headers: { authorization: `Bearer ${otherAuth.accessToken}` },
  };

  // account B 建自己的 session。
  const otherSession = await sessionControllerCreate({ title: '他人 session' }, otherCfg);
  assert.equal(otherSession.status, 201, '第二 account 建会话 → 201');
  const otherSessionId = otherSession.data.id;

  // account A token 读 account B 的 session → 404（归属校验失败，反枚举折叠）。
  await assert.rejects(
    () => mockupListControllerList(otherSessionId, ownerCfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 404, '他人 session 读列表 → 404 (反枚举)');
      return true;
    },
  );

  // 不存在的 numeric session 也 → 404（与他人 session 折叠不可区分，反枚举核心）。
  await assert.rejects(
    () => mockupListControllerList('99999999999', ownerCfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 404, '不存在 session 读列表 → 404 (反枚举)');
      return true;
    },
  );
}
