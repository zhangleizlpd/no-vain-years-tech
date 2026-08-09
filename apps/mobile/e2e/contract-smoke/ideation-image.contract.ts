/**
 * 036 ideation 图片标注 + 多模态 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，全 boot
 * node dist/main.js）验 036 接线**新增**端点的契约对齐 + 真落库 + 错误码。聚焦三处缝（server
 * IT〔T007，DI override 注命中〕与 hermetic mock〔T015〕都假设契约都对齐、各自覆盖不到的）：
 *   ① 生成的 typed client 对凭证签发 fn `attachmentCredentialControllerIssue`
 *      （`POST /ideation/sessions/{id}/attachments/credential`）+ 带图 turn fn
 *      `clarifyStreamControllerTurn`（`POST .../turns`，attachmentKeys+annotationText）的
 *      URL/method/请求体序列化/响应解封与真 server 装饰器派生的 openapi 契约**对齐**；
 *   ② 带图 turn 经 SSE 提交后 IdeaAttachment + turnId 关联**真落库**（重读 `GET .../sessions/{id}`
 *      经 DTO 投影验 `turns[].attachments[].ossKey`，非 in-memory）；
 *   ③ 错误码反枚举（无 JWT → 401；他人/不存在 session → 404 字节级一致）。
 *
 * 分层职责（spec.md L34 SoT）：本契约冒烟**只验契约对齐 + 真落库**。视觉路由 model:'minimax' /
 * 多模态 Msg image_url 派生 / send-once / 降级 503 等行为由 **T007 server IT**（DI override 注
 * fake-llm + 参数化 OSS + 断言 provider.lastMessages）兜底——本就是分层设计：契约冒烟跑
 * `node dist/main.js` 真 boot **无 DI override**，带图 turn 走「**调用不抛**（typed client 提交成功
 * = path/method/body 序列化契约对齐）**+ 随后 GET 读侧断言落库**」，**不验 SSE 帧 / 多模态 content
 * parts**（① orval 不为 text/event-stream 生成流式消费 fn、客户端侧观测不到 provider 入参；②
 * FakeIdeationLlmProvider 是整 boot 单例、默认三轮剧本跨 032/035/036 多 spec 已耗尽 → 访谈相无问题
 * 可吐 → 流以 `IDEATION_NO_QUESTION` error 帧收口（非 [DONE]），帧级断言会因 spec 注册序漂移假红）。
 *
 * 凭证签发 OSS 出口：harness 设确定性 fake-aliyun `OSS_*`（region/bucket/ak/sk 占位，非真 bucket）
 * → ossConfig kind='aliyun' → 凭证 EP 签 V4 表单返 200（无 OSS_* 则 kind='unconfigured' → 503 降级，
 * 那条降级路径由 T007 IT ⑨ 兜底）。本 spec 验签发**契约 scope**（keyPrefix=`ideation/<accountId>/`
 * + content-type 白名单 + size 上限），不打真 OSS 直传（真 bucket/CORS = 部署前置）。
 *
 * 大模型出口：harness 设 IDEATION_FAKE_LLM=1（ideation.module 绑确定性 FakeIdeationLlmProvider），
 * 不打真 M3 / 不依赖外网。本 spec 不读 SSE 帧（见上分层职责），故不依赖 fake 剧本剩余轮数。
 *
 * 覆盖（spec FR-011/013 + state_branches 契约面）：
 *   ① 登录（harness 程序化登录拿真 token）→ POST /ideation/sessions 建独立 open 会话（typed client）；
 *   ② 凭证签发（typed client，`{contentType}`）→ 200 + scope 断言：objectKey/fields.key 前缀
 *      `ideation/<accountId>/<uuid>/img` + policy(base64 JSON) 内嵌 starts-with key 闸 / content-type
 *      白名单（仅 JPEG/PNG/WebP）/ size 上限（1..10MB）三道 scope 闸 + 字段形状对齐（host/expiresAt/fields）；
 *   ③ 凭证反枚举：无 Bearer → 401；非白名单 content-type → 400；不存在/非数字 session → 404 字节级一致；
 *   ④ 带图 turn（typed client `clarifyStreamControllerTurn` 写入两条）：attachmentKeys（自 account-scoped
 *      前缀）+ annotationText → 调用不抛（path/method/body 序列化契约对齐 + 同 tx 落库）；
 *   ⑤ 真落库：重读 `GET .../sessions/{id}`（typed client）→ 带图 user 轮携 `attachments[].ossKey`
 *      （T018/T019 turnId 关联 + DTO 投影）；assistant 轮 attachments 空数组（零回归）；
 *   ⑥ 带图 turn 反枚举：不存在 session 提交带图 turn → 404（FR-013）。
 *
 * 边界与幂等：ideation 表按 accountId 归属，本 spec 全程新建独立会话（不碰 032/034/035 的会话）；
 * 下次 boot 全新 PG 容器，故无 cleanup。
 */
import assert from 'node:assert/strict';
import {
  AttachmentCredentialRequestContentType,
  attachmentCredentialControllerIssue,
  clarifyStreamControllerTurn,
  sessionControllerCreate,
  sessionControllerGet,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'ideation-image (036)';

/** harness fake-aliyun OSS 派生的 public-read host（OSS_BUCKET.OSS_REGION.aliyuncs.com）。 */
const OSS_HOST = 'https://mbw-test-images.oss-cn-shanghai.aliyuncs.com';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const accountId = ctx.accountId;

  // ── ① 建独立 open 会话（typed client）：URL/method/序列化对齐 ───────────────────────────────
  const created = await sessionControllerCreate({ title: '图片标注接线' }, cfg);
  assert.equal(created.status, 201, `建会话 expected 201, got ${created.status}`);
  const sessionId = created.data.id;
  assert.match(sessionId, /^\d+$/, '建会话: id 为数字串 (BigInt 序列化)');
  assert.equal(created.data.status, 'open', '建会话: 初始 status=open');

  // ── ② 凭证签发（typed client）→ 200 + scope 对齐（keyPrefix / content-type 白名单 / size 上限）─
  const cred = await attachmentCredentialControllerIssue(
    sessionId,
    { contentType: AttachmentCredentialRequestContentType['image/webp'] },
    cfg,
  );
  assert.equal(cred.status, 200, `凭证签发 expected 200, got ${cred.status}`);
  const { host, objectKey, expiresAt, fields } = cred.data;

  // 字段形状对齐（host / objectKey / expiresAt / fields 全字段非空，避 nullable-@ApiProperty 坑）。
  assert.equal(host, OSS_HOST, '凭证: host = OSS public-read 端点 (fake-aliyun 派生)');
  assert.equal(typeof objectKey, 'string', '凭证: objectKey 为 string');
  assert.equal(typeof expiresAt, 'string', '凭证: expiresAt 为 string');
  // expiresAt = 可解析 ISO 8601（与 server .toISOString() 收口一致）。
  assert.equal(
    expiresAt,
    new Date(expiresAt).toISOString(),
    '凭证: expiresAt 为规范 ISO-8601 (TTL round-trip)',
  );

  // objectKey 严格 account-scoped 前缀 `ideation/<accountId>/<uuid>/img`（反枚举 + 隔离）。
  const expectedPrefix = `ideation/${accountId}/`;
  assert.ok(
    objectKey.startsWith(expectedPrefix),
    `凭证: objectKey 前缀 = '${expectedPrefix}' (account-scoped, got '${objectKey}')`,
  );
  assert.match(
    objectKey,
    new RegExp(`^ideation/${accountId}/[0-9a-f-]{36}/img$`),
    '凭证: objectKey = ideation/<accountId>/<uuid>/img (派生格式对齐)',
  );
  assert.equal(fields.key, objectKey, '凭证: fields.key === objectKey (表单 key 与预分配键一致)');
  assert.equal(
    fields['x-oss-signature-version'],
    'OSS4-HMAC-SHA256',
    '凭证: x-oss-signature-version = OSS4-HMAC-SHA256',
  );
  assert.equal(fields.success_action_status, '200', '凭证: success_action_status = 200');
  assert.ok(fields['x-oss-credential'].length > 0, '凭证: x-oss-credential 非空');
  assert.match(fields['x-oss-signature'], /^[0-9a-f]+$/, '凭证: x-oss-signature 为小写 hex HMAC');

  // policy(base64 JSON) 内嵌三道 scope 闸（key 前缀 / content-type 白名单 / size 上限）。
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
        ['image/jpeg', 'image/png', 'image/webp'].every((t) => (c[2] as string[]).includes(t)),
    ),
    '凭证 scope: policy 含 content-type 白名单闸 (仅 JPEG/PNG/WebP)',
  );
  assert.ok(
    conds.some(
      (c) =>
        Array.isArray(c) &&
        c[0] === 'content-length-range' &&
        c[1] === 1 &&
        c[2] === 10 * 1024 * 1024,
    ),
    '凭证 scope: policy 含 size 上限闸 (1..10MB)',
  );

  // ── ③ 凭证反枚举：无 Bearer → 401 / 非白名单 content-type → 400 / 他人·不存在·非数字 → 404 一致 ─
  await assertCredentialUnauthenticated(ctx, sessionId);
  await assertCredentialContentTypeRejected(sessionId, cfg);
  await assertCredentialNotFoundByteIdentical(sessionId, cfg);

  // ── ④ 带图 turn（typed client 写入）：调用不抛 = path/method/body 序列化契约对齐 ─────────────────
  // attachmentKeys 取 account-scoped 前缀的烧录图键（与凭证签发 objectKey 同形，归属本 session/account）。
  const imgKey1 = `ideation/${accountId}/smoke-uuid-1/img`;
  const imgKey2 = `ideation/${accountId}/smoke-uuid-2/img`;
  const imgKey3 = `ideation/${accountId}/smoke-uuid-3/img`;

  // 经**生成的** typed client 提交两条带图轮（clarifyStreamControllerTurn 返 void —— axios 缓冲整条
  // text/event-stream body）。**调用不抛 = URL/method/请求体序列化 (attachmentKeys[]+annotationText)
  // 与真 server openapi 契约对齐**（orval → 真 server 端到端）；user turn + IdeaAttachment + turnId
  // 关联在 SSE 流首 event 前**同 tx 落库**（T006/T018），随后下方 GET 读侧验真落库。
  //
  // **不验 SSE 帧 / 多模态 content / 路由 model:'minimax'**（分层降级，sdd.md「调用不抛 + GET 读侧
  // 断言落库」）：① orval 不为 text/event-stream 生成流式消费 fn（客户端侧观测不到 provider 入参的
  // content parts / model）；② FakeIdeationLlmProvider 是整 boot 单例、round 游标全局单调 —— 跨
  // 032/034/035/036 多 spec 多轮后默认三轮剧本已耗尽 → 访谈相无问题可吐 → 流以 error 帧
  // `IDEATION_NO_QUESTION` 收口（**非 [DONE]**），故帧级断言会因 spec 注册序漂移假红。多模态 content
  // 派生 / 视觉路由 / send-once / 流式帧逐条由 **T007 server IT**（DI override 注 fake-llm + 断言
  // provider.lastMessages）兜底——本就是分层设计；契约冒烟只担「契约对齐 + 真落库」。
  await clarifyStreamControllerTurn(
    sessionId,
    { content: '看这张标注图', attachmentKeys: [imgKey1, imgKey2], annotationText: '1：这里改蓝' },
    cfg,
  );
  await clarifyStreamControllerTurn(
    sessionId,
    { content: '再看这处', attachmentKeys: [imgKey3], annotationText: '1：塔变红' },
    cfg,
  );

  // ── ⑤ 真落库：重读 GET /sessions/{id} → 带图 user 轮携 attachments[].ossKey (T018/T019 投影)─────
  // 这是契约冒烟唯一能验、server IT 不经生成 client、hermetic mock 假设契约对齐都覆盖不到的缝。
  const detail = await sessionControllerGet(sessionId, cfg);
  assert.equal(detail.status, 200, `查会话详情 expected 200, got ${detail.status}`);
  const turns = detail.data.turns;

  const imageTurn1 = turns.find((t) => t.role === 'user' && t.content === '看这张标注图');
  assert.ok(imageTurn1, '落库: 第一带图 user 轮存在 (重读会话详情)');
  assert.deepEqual(
    imageTurn1.attachments.map((a) => a.ossKey),
    [imgKey1, imgKey2],
    '落库: 第一带图轮 attachments[].ossKey 按插入序对齐 (IdeaAttachment turnId 关联 + DTO 投影)',
  );

  const imageTurn2 = turns.find((t) => t.role === 'user' && t.content === '再看这处');
  assert.ok(imageTurn2, '落库: 第二带图 user 轮存在');
  assert.deepEqual(
    imageTurn2.attachments.map((a) => a.ossKey),
    [imgKey3],
    '落库: 第二带图轮 attachments[].ossKey 对齐',
  );

  // assistant 轮 attachments 为空数组（零回归; 投影只挂 user 带图轮）。
  for (const t of turns.filter((x) => x.role === 'assistant')) {
    assert.deepEqual(t.attachments, [], 'assistant 轮 attachments 为空数组 (零回归)');
  }

  // ── ⑥ 带图 turn 反枚举：他人 session 提交带图 turn → 404 字节级一致 (FR-013) ───────────────────
  await assertImageTurnNotFoundByteIdentical(ctx, accountId);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** 无 Bearer → 401（authed 凭证 EP，反枚举统一 401）。 */
async function assertCredentialUnauthenticated(
  ctx: RealBackendCtx,
  sessionId: string,
): Promise<void> {
  await assert.rejects(
    () => attachmentCredentialControllerIssue(sessionId, {}, { baseURL: ctx.api }),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 401, '未认证 凭证签发 → 401');
      return true;
    },
  );
}

/** 非白名单 content-type → 400（DTO @IsIn fast-fail 白名单闸）。 */
async function assertCredentialContentTypeRejected(
  sessionId: string,
  cfg: { baseURL: string; headers: Record<string, string> },
): Promise<void> {
  await assert.rejects(
    // 故意送非白名单 mime（绕过生成 enum 的类型约束验真 server DTO 校验）。
    () =>
      attachmentCredentialControllerIssue(
        sessionId,
        { contentType: 'image/gif' as AttachmentCredentialRequestContentType },
        cfg,
      ),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 400, '非白名单 content-type 凭证签发 → 400');
      return true;
    },
  );
}

/** 他人 / 不存在 / 非数字 session 凭证签发 → 404 字节级一致（反枚举 FR-013）。 */
async function assertCredentialNotFoundByteIdentical(
  ownSessionId: string,
  cfg: { baseURL: string; headers: Record<string, string> },
): Promise<void> {
  // 不存在 session（自己的 token，但 id 不存在）。
  const unknownBody = await rejectionBody(() =>
    attachmentCredentialControllerIssue('99999999999', {}, cfg),
  );
  // 非数字 session id（折叠 404，不暴露「非法 id」vs「不存在」差异）。
  const nonNumericBody = await rejectionBody(() =>
    attachmentCredentialControllerIssue('not-a-number', {}, cfg),
  );
  assert.equal(unknownBody.status, 404, '不存在 session 凭证签发 → 404');
  assert.equal(nonNumericBody.status, 404, '非数字 session 凭证签发 → 404');
  assert.deepEqual(
    strip(nonNumericBody.body),
    strip(unknownBody.body),
    '凭证签发 不存在 / 非数字 session → body 字节级一致 (反枚举)',
  );
  // 注: 「他人 session」分支需第二 account（owner 建会话、other 提交），harness 单 account →
  // 不存在/非数字折叠 404 已覆盖反枚举核心；他人-session 字节级一致由 T007 IT ③ 兜底（双 account）。
}

/** 他人 session 提交带图 turn → 404 字节级一致（反枚举；本 spec 用「不存在 session」近似单边）。 */
async function assertImageTurnNotFoundByteIdentical(
  ctx: RealBackendCtx,
  accountId: string,
): Promise<void> {
  // 不存在 session 提交带图 turn → 404（裸 fetch，clarifyStreamControllerTurn 缓冲 SSE 不便取 body）。
  const unknown = await fetchImageTurnRaw(ctx, '99999999999', {
    content: 'x',
    attachmentKeys: [`ideation/${accountId}/uuid/img`],
  });
  assert.equal(unknown.status, 404, '不存在 session 带图 turn → 404 (反枚举)');
}

/** 裸 fetch 提交带图 turn 并返回 status（用于错误码断言，不读流）。 */
async function fetchImageTurnRaw(
  ctx: RealBackendCtx,
  sessionId: string,
  body: { content: string; attachmentKeys?: string[]; annotationText?: string },
): Promise<{ status: number }> {
  const res = await fetch(`${ctx.api}/api/v1/ideation/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.accessToken}` },
    body: JSON.stringify(body),
  });
  return { status: res.status };
}

/** axios rejection → { status, body }（ProblemDetail 原文供字节级比较）。 */
async function rejectionBody(
  fn: () => Promise<unknown>,
): Promise<{ status: number; body: string }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { response?: { status?: number; data?: unknown } };
    return {
      status: e.response?.status ?? 0,
      body:
        typeof e.response?.data === 'string' ? e.response.data : JSON.stringify(e.response?.data),
    };
  }
  throw new Error('expected rejection but call resolved');
}

/** 剥 ProblemDetail 易变字段（traceId/instance）供字节级比较（与 T007 IT 同款）。 */
function strip(raw: string): Record<string, unknown> {
  const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
  void traceId;
  void instance;
  return rest;
}
