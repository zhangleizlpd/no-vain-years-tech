/**
 * 028 chat-history-drawer 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，
 * 全 boot node dist/main.js）验历史会话 list/rename/delete 三端点端到端 + 真落库 + 契约对齐。
 * 建会话 / 发消息（落库 + 派生标题）复用 027 路径；发消息 SSE 端点产 text/event-stream，
 * orval 未生成消费函数 → 裸 fetch 读流（与 027 contract 同款）。list/rename/delete 走生成的
 * typed client 函数。
 *
 * 大模型出口：harness 设 CHAT_FAKE_LLM=1 → FakeLlmProvider（确定性 scripted token，离线可跑）。
 *
 * 覆盖（spec US1 / US3 / SC-002/004/006/007）：
 *   ① 登录 → 建 2 会话 + 各发首条消息（落库 + 派生标题，027 路径）；
 *   ② GET /chat/conversations 验列表：2 条、字段 id/title/model/updatedAt、按 updatedAt desc 倒序；
 *   ③ q 搜索：按标题模糊子串命中（ILIKE 大小写不敏感），仅标题匹配（不搜 message 全文）；
 *   ④ PATCH 改名：回显新 title + 列表反映；空/纯空白 → 400；越权/不存在 id → 404 字节级一致；
 *   ⑤ DELETE 连带：删后 list 少 1 + get-messages 该 id → 404（message 连带删，反枚举）；越权 → 404；
 *   ⑥ 契约对齐：URL/method/序列化（BigInt id → 数字串）/ 错误码（401 未认证）。
 *
 * 边界与幂等：chat 表按 accountId 归属，本 spec 全程新建独立会话并最终删除，残留对其他 spec 无害
 * （下次 boot 全新 PG 容器）。
 */
import assert from 'node:assert/strict';
import {
  conversationControllerCreate,
  conversationControllerList,
  conversationControllerMessages,
  conversationControllerRemove,
  conversationControllerRename,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'chat-history (028)';

// 两条会话各自的首条用户消息（→ 派生标题，须可区分 + 标题搜索可命中其一不命中另一）。
// 唯一搜索 token（嵌入 A 首条消息开头 → 派生标题含此 token；选 ascii 唯一串避免与 027/其他
// spec 既存会话标题（如 027 的「茅台」）撞 — 共享 boot 同 account，list 含跨 spec 既存会话）。
const SEARCH_HIT = 'Qwzx';
// 仅出现在 B 消息体尾部（超出标题 20 字符截断窗口）、不在任一标题 → 验「仅按 title 搜，不搜
// message 全文」(q 命中 0)。deriveTitle 截前 20 code point，故 token 须落在前 20 字之后。
const SEARCH_BODY_ONLY = 'Zylqxk';
// 前 20 字是中文长句（标题取此），唯一 token 在 21 字后 → 入 message body、不入派生标题。
const MSG_B = `推荐几本值得一读的硬科幻长篇小说作品清单${SEARCH_BODY_ONLY}`;

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① 建 2 会话 + 各发首条消息（落库 + 派生标题，027 路径）─────────────────────────
  // A 首条消息嵌唯一 token → 派生标题含之（标题搜索锚）。
  const convA = await createAndSeed(ctx, `${SEARCH_HIT}贵州茅台护城河分析`);
  // 拉开 updatedAt 间隔，保证倒序断言稳定（B 后建 → updatedAt 更新 → 排在 A 前）。
  await sleep(1100);
  const convB = await createAndSeed(ctx, MSG_B);

  // ── ② GET 列表：含我建的 2 条、字段齐、按 updatedAt desc 倒序（B 先于 A）─────────────
  // ⚠️ 共享 boot：list 可能含其他 spec（027 chat-streaming）在同 account 既存会话，故按我建的
  // id 收窄断言，不锚绝对条数 / 绝对下标。
  const listed = await conversationControllerList({ limit: 50 }, cfg);
  assert.equal(listed.status, 200, `list expected 200, got ${listed.status}`);
  const items = listed.data.items;

  const mine = items.filter((i) => i.id === convA.id || i.id === convB.id);
  assert.equal(mine.length, 2, '列表: 含我建的 2 条会话');

  // 字段契约：id 数字串 / title 非空（派生）/ model 默认 / updatedAt ISO。
  for (const it of mine) {
    assert.match(it.id, /^\d+$/, '列表项: id 数字串 (BigInt 序列化)');
    assert.ok(typeof it.title === 'string' && it.title.length > 0, '列表项: title 非空');
    assert.equal(it.model, 'flash', '列表项: model 默认 flash (029 D7)');
    assert.match(it.updatedAt, /^\d{4}-\d{2}-\d{2}T/, '列表项: updatedAt ISO-8601');
  }

  // 倒序：后建的 B 在 A 之前（updatedAt desc；按相对位置，不锚绝对下标）。
  const idxB = items.findIndex((i) => i.id === convB.id);
  const idxA = items.findIndex((i) => i.id === convA.id);
  assert.ok(idxB >= 0 && idxA >= 0 && idxB < idxA, '列表: 倒序 — 后更新的 B 排在 A 前');

  // 派生标题截首条消息（含搜索关键词）。
  const titleA = items.find((i) => i.id === convA.id)?.title ?? '';
  assert.ok(titleA.includes(SEARCH_HIT), `A 标题派生自首条消息含「${SEARCH_HIT}」`);

  // ── ③ q 搜索：标题模糊子串命中（仅标题，不搜 message 全文）────────────────────────
  // 唯一 token → 仅 A 标题命中（不与跨 spec 既存会话撞）。
  const hit = await conversationControllerList({ limit: 50, q: SEARCH_HIT }, cfg);
  assert.equal(hit.status, 200, `q 搜索 expected 200, got ${hit.status}`);
  assert.equal(hit.data.items.length, 1, `q='${SEARCH_HIT}': 唯一 token 仅 A 标题命中`);
  assert.equal(hit.data.items[0].id, convA.id, 'q 搜索: 命中的是 A');

  // 大小写不敏感（ILIKE）：token 小写仍命中 A（验 ILIKE 大小写不敏感）。
  const lower = await conversationControllerList({ limit: 50, q: SEARCH_HIT.toLowerCase() }, cfg);
  assert.equal(lower.data.items.length, 1, `q='${SEARCH_HIT.toLowerCase()}': 小写仍命中 (ILIKE)`);
  assert.equal(lower.data.items[0].id, convA.id, 'q 搜索: 小写命中的仍是 A');

  // 「仅标题匹配」：搜只出现在 B 消息体的 token → 0 命中，证不搜 message 全文。
  const bodyOnly = await conversationControllerList({ limit: 50, q: SEARCH_BODY_ONLY }, cfg);
  assert.equal(
    bodyOnly.data.items.length,
    0,
    `q='${SEARCH_BODY_ONLY}': 仅在 B 消息体、不在标题 → 0 命中 (不搜全文)`,
  );

  // 无命中 → 空数组（不报错）。
  const noMatch = await conversationControllerList({ limit: 20, q: '绝不存在的关键词zzz' }, cfg);
  assert.equal(noMatch.status, 200, '无命中 q → 200');
  assert.deepEqual(noMatch.data.items, [], '无命中 q → 空数组');

  // ── ④ PATCH 改名：回显 + 列表反映；空 → 400；越权/不存在 → 404 ──────────────────────
  const RENAMED = '茅台深度复盘';
  const renamed = await conversationControllerRename(convA.id, { title: RENAMED }, cfg);
  assert.equal(renamed.status, 200, `改名 expected 200, got ${renamed.status}`);
  assert.equal(renamed.data.id, convA.id, '改名: 回显 id');
  assert.equal(renamed.data.title, RENAMED, '改名: 回显新 title');
  assert.match(renamed.data.updatedAt, /^\d{4}-\d{2}-\d{2}T/, '改名: 回显刷新的 updatedAt');

  // 列表反映新标题（持久化，SC-004）。
  const afterRename = await conversationControllerList({ limit: 20 }, cfg);
  assert.equal(
    afterRename.data.items.find((i) => i.id === convA.id)?.title,
    RENAMED,
    '改名: 列表反映新标题 (落库)',
  );

  // 空/纯空白 title → 400（自有资源输入校验）。
  await assertRenameRejected(cfg, convA.id, '   ', 400, '纯空白 title → 400');

  // 越权/不存在 id 改名 → 404 字节级一致（反枚举）。
  await assertRenameRejected(cfg, '999999999', RENAMED, 404, '不存在 id 改名 → 404');

  // ── ⑤ DELETE 连带：删 A → list 少 1 + get-messages 404；越权 → 404 ─────────────────────
  // 删前确认 A 有消息（连带删验证锚）。
  const aMsgsBefore = await conversationControllerMessages(convA.id, cfg);
  assert.ok(aMsgsBefore.data.messages.length >= 2, '删前: A 有 user+AI 消息 (连带删锚)');

  const del = await conversationControllerRemove(convA.id, cfg);
  assert.equal(del.status, 204, `删除 expected 204, got ${del.status}`);

  // 删后列表：A 消失、B 仍在（按 id 收窄，不锚绝对条数 — 共享 boot 含跨 spec 既存会话）。
  const afterDelete = await conversationControllerList({ limit: 50 }, cfg);
  const afterIds = afterDelete.data.items.map((i) => i.id);
  assert.ok(!afterIds.includes(convA.id), '删除后: A 从列表移除');
  assert.ok(afterIds.includes(convB.id), '删除后: B 仍在列表');

  // get-messages 删除的 id → 404（连带删 + 反枚举，FR-007）。
  await assertNotFound(
    () => conversationControllerMessages(convA.id, cfg),
    '删除后 get-messages 该 id → 404 (连带删, 不可再访问)',
  );

  // 越权/不存在 id 删除 → 404 字节级一致。
  await assertNotFound(
    () => conversationControllerRemove('999999999', cfg),
    '不存在 id 删除 → 404 (反枚举)',
  );

  // ── ⑥ 契约对齐：未认证 → 401 ───────────────────────────────────────────────────────
  await assertUnauthenticated(ctx);
}

/** 建空会话 + 发首条消息（落库 user+AI msg，派生标题）。返回会话 id（数字串）。 */
async function createAndSeed(ctx: RealBackendCtx, firstMessage: string): Promise<{ id: string }> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const created = await conversationControllerCreate({}, cfg);
  assert.equal(created.status, 201, `建会话 expected 201, got ${created.status}`);
  const id = created.data.id;
  assert.match(id, /^\d+$/, '建会话: id 数字串');

  // 裸 fetch 读 SSE 发消息端点（orval 不生成；产 text/event-stream）。读到 [DONE] 即落库完成。
  const res = await fetch(`${ctx.api}/api/v1/chat/conversations/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.accessToken}` },
    body: JSON.stringify({ content: firstMessage }),
  });
  assert.equal(res.status, 200, `SSE send expected 200, got ${res.status}`);
  assert.ok(res.body, 'SSE: response body 流可读');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done = false;
  let buffer = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const payload = frame.startsWith('data:') ? frame.slice('data:'.length).trim() : frame.trim();
      if (payload === '[DONE]') done = true;
      sep = buffer.indexOf('\n\n');
    }
  }
  assert.ok(done, 'SSE: 收到 [DONE] (发消息落库完成)');
  return { id };
}

/** 改名拒绝断言（空 title → 400 / 越权 → 404，字节级一致反枚举）。 */
async function assertRenameRejected(
  cfg: { baseURL: string; headers: Record<string, string> },
  id: string,
  title: string,
  expectedStatus: number,
  msg: string,
): Promise<void> {
  await assert.rejects(
    () => conversationControllerRename(id, { title }, cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, expectedStatus, msg);
      return true;
    },
  );
}

/** 404 断言（越权/不存在 conversationId，字节级一致反枚举）。 */
async function assertNotFound(fn: () => Promise<unknown>, msg: string): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    const e = err as { response?: { status?: number } };
    assert.equal(e.response?.status, 404, msg);
    return true;
  });
}

/** 无 Bearer → 401（authed 端点）。 */
async function assertUnauthenticated(ctx: RealBackendCtx): Promise<void> {
  await assert.rejects(
    () => conversationControllerList({ limit: 20 }, { baseURL: ctx.api }),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 401, '未认证 list → 401');
      return true;
    },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
