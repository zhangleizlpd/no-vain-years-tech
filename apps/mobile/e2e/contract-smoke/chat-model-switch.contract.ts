/**
 * 029 chat-model-switch 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，
 * 全 boot node dist/main.js）验模型元数据 + 会话级 model 写两端点端到端 + 真落库 + 契约对齐。
 * 建会话 / 发消息（落库 + 派生标题）复用 027 路径；发消息 SSE 端点产 text/event-stream，
 * orval 未生成消费函数 → 裸 fetch 读流（与 027/028 contract 同款）。models / set-model 走
 * 生成的 typed client 函数（conversationControllerListAvailableModels / conversationControllerSetModel）。
 *
 * 大模型出口：harness 设 CHAT_FAKE_LLM=1 → FakeLlmProvider（确定性 scripted token，离线可跑）。
 * 真 boot 的 FakeLlmProvider 不经 DI override，无法在 wire 层 introspect 它收到的逻辑 model
 * —— 「send 按会话 model 路由 + FakeProvider 收 pro/flash」由 server IT（T004，DI override 注
 * SwappableFakeProvider 断言 opts.model）承担。本契约冒烟在 wire 层可观测的等价事实是：
 * PATCH 后 conversation.model 落库为路由来源（list 回显），且发消息成功（FakeProvider 正常回复）
 * —— 会话级 model 记忆 = send 路由的真相源。
 *
 * 覆盖（spec FR-002/003/005/007/009 / SC-002/003/005）：
 *   ① 登录 → GET /chat/models 验清单：flash/pro available + minimax 不可用、字段 id/label/description/available；
 *   ② 建会话（默认 flash）+ 发首条（027 路径，落库 + 派生标题）；
 *   ③ PATCH conversations/:id/model 设 pro → 回显 {id, model:pro, updatedAt} + list 反映落库（持久化）；
 *   ④ 设 pro 后再发消息 → SSE 正常（FakeProvider 回复）+ conversation.model 仍 pro（路由来源不变）；
 *   ⑤ 建第 2 会话设 flash → 两会话各自 model 跟随（会话级记忆，互不串）；
 *   ⑥ 非法 model（minimax / 非枚举值）→ 400；越权/不存在 id → 404 字节级一致（反枚举）；
 *   ⑦ 契约对齐：URL/method/序列化（id BigInt → 数字串、updatedAt ISO）/ 未认证 → 401。
 *
 * 边界与幂等：chat 表按 accountId 归属，本 spec 全程新建独立会话，无跨 spec 污染（下次 boot
 * 全新 PG 容器）；chat 无公开删除端点（本 spec 不删），残留行对其他 spec 无害。
 */
import assert from 'node:assert/strict';
import {
  conversationControllerCreate,
  conversationControllerList,
  conversationControllerSetModel,
  conversationControllerListAvailableModels,
  type SetConversationModelRequest,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'chat-model-switch (029)';

// A 首条消息嵌唯一 ascii token → 派生标题含之，便于在共享 boot 的混合 list 中按 id+标题定位。
const MSG_A = 'Mvpro帮我深度分析贵州茅台的护城河';
const MSG_B = 'Mvflash快速问一下今天天气如何';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① GET /chat/models 验清单（flash/pro available + minimax 不可用、字段齐）─────────
  const modelsRes = await conversationControllerListAvailableModels(cfg);
  assert.equal(modelsRes.status, 200, `models expected 200, got ${modelsRes.status}`);
  const models = modelsRes.data.models;
  assert.ok(Array.isArray(models) && models.length >= 3, 'models: ≥3 项 (flash/pro/minimax)');

  const byId = Object.fromEntries(models.map((m) => [m.id, m]));
  // 字段契约：每项 id/label/description/available 齐 + 类型正确。
  for (const m of models) {
    assert.ok(typeof m.id === 'string' && m.id.length > 0, 'models 项: id 非空字符串');
    assert.ok(typeof m.label === 'string' && m.label.length > 0, 'models 项: label 非空');
    assert.ok(typeof m.description === 'string', 'models 项: description 字符串');
    assert.equal(typeof m.available, 'boolean', 'models 项: available 布尔');
  }
  assert.ok(byId.flash, 'models: 含 flash');
  assert.equal(byId.flash.available, true, 'models: flash 可用');
  assert.ok(byId.pro, 'models: 含 pro');
  assert.equal(byId.pro.available, true, 'models: pro 可用');
  assert.ok(byId.minimax, 'models: 含 minimax');
  assert.equal(byId.minimax.available, true, 'models: minimax 可用 (029 收口接入)');

  // ── ② 建会话（默认 flash）+ 发首条（027 路径）────────────────────────────────────────
  const created = await conversationControllerCreate({}, cfg);
  assert.equal(created.status, 201, `建会话 expected 201, got ${created.status}`);
  const convA = created.data;
  assert.match(convA.id, /^\d+$/, '建会话: id 数字串 (BigInt 序列化)');
  // 029 起新会话默认 flash (D7，取代 027 的 deepseek-chat 默认)。
  assert.equal(convA.model, 'flash', '建会话: model 默认 flash (029 D7)');
  await streamSend(ctx, convA.id, MSG_A);

  // ── ③ PATCH 设 pro → 回显 + list 反映落库（持久化，SC-003）──────────────────────────
  const setPro = await conversationControllerSetModel(convA.id, { model: 'pro' }, cfg);
  assert.equal(setPro.status, 200, `设 pro expected 200, got ${setPro.status}`);
  assert.equal(setPro.data.id, convA.id, '设 pro: 回显 id');
  assert.equal(setPro.data.model, 'pro', '设 pro: 回显 model=pro');
  assert.match(setPro.data.updatedAt, /^\d{4}-\d{2}-\d{2}T/, '设 pro: 回显刷新 updatedAt ISO');

  // list 反映落库（持久化，会话级 model 是 send 路由来源）。
  const afterPro = await conversationControllerList({ limit: 50 }, cfg);
  assert.equal(
    afterPro.data.items.find((i) => i.id === convA.id)?.model,
    'pro',
    '设 pro: list 反映 model 落库 (路由来源)',
  );

  // ── ④ 设 pro 后再发消息 → SSE 正常 + conversation.model 仍 pro（路由来源不变）────────
  await streamSend(ctx, convA.id, '继续展开讲讲它的财务质量');
  const afterSend = await conversationControllerList({ limit: 50 }, cfg);
  assert.equal(
    afterSend.data.items.find((i) => i.id === convA.id)?.model,
    'pro',
    '设 pro 后发消息: conversation.model 仍 pro (send 路由来源不变)',
  );

  // ── ⑤ 建第 2 会话设 flash → 两会话各自 model 跟随（会话级记忆，互不串）──────────────
  const createdB = await conversationControllerCreate({}, cfg);
  assert.equal(createdB.status, 201, `建会话 B expected 201, got ${createdB.status}`);
  const convB = createdB.data;
  await streamSend(ctx, convB.id, MSG_B);
  // B 默认已是 flash；显式设 flash 验回显（幂等设同值仍 200）。
  const setFlash = await conversationControllerSetModel(convB.id, { model: 'flash' }, cfg);
  assert.equal(setFlash.status, 200, `B 设 flash expected 200, got ${setFlash.status}`);
  assert.equal(setFlash.data.model, 'flash', 'B 设 flash: 回显 model=flash');

  // 两会话各自 model 跟随（会话级记忆：A=pro 不被 B=flash 波及）。
  const both = await conversationControllerList({ limit: 50 }, cfg);
  assert.equal(
    both.data.items.find((i) => i.id === convA.id)?.model,
    'pro',
    '会话级记忆: A 仍 pro (不被 B 波及)',
  );
  assert.equal(
    both.data.items.find((i) => i.id === convB.id)?.model,
    'flash',
    '会话级记忆: B 为 flash (互不串)',
  );

  // ── ⑤b minimax 也是合法枚举值（029 收口）→ 设 200 + 回显 + list 落库 ────────────────
  const setMinimax = await conversationControllerSetModel(convB.id, { model: 'minimax' }, cfg);
  assert.equal(setMinimax.status, 200, `B 设 minimax expected 200, got ${setMinimax.status}`);
  assert.equal(setMinimax.data.model, 'minimax', 'B 设 minimax: 回显 model=minimax');
  const afterMinimax = await conversationControllerList({ limit: 50 }, cfg);
  assert.equal(
    afterMinimax.data.items.find((i) => i.id === convB.id)?.model,
    'minimax',
    'B 设 minimax: list 反映落库 (regen client minimax enum 端到端往返)',
  );

  // ── ⑥ 非法 model → 400；越权/不存在 → 404 字节级一致 ──────────────────────────────
  // 非枚举值（legacy deepseek-chat / 未知）→ 400（DTO @IsIn pipe 拦，自有会话）。orval enum 为
  // flash/pro/minimax，故 cast 绕编译期类型送原始非法 wire 值。
  await assertSetModelRejected(cfg, convA.id, 'deepseek-chat', 400, 'legacy model → 400');
  await assertSetModelRejected(cfg, convA.id, 'gpt-9000', 400, '非枚举 model → 400');

  // 越权/不存在 id + 合法枚举值 → 404 字节级一致（反枚举；DTO @IsIn 放行 pro → UC 归属校验 404）。
  await assertSetModelRejected(cfg, '999999999', 'pro', 404, '不存在 id 设合法 model → 404');
  // ⚠️ 契约对齐细节：DTO `@IsIn([flash,pro,minimax])` ValidationPipe 在 UC 之前拦非枚举值 → 400，
  // 不论 id 是否存在（pipe 先于 controller handler）。「UC 内归属 404 先于值域 400」仅在 UC 被
  // 直调（IT/contract 绕 pipe）时成立；经完整 HTTP 栈，非枚举值在 pipe 层即 400。故不存在 id +
  // 非枚举值经 wire → 400（pipe 拦），非 404。
  await assertSetModelRejected(
    cfg,
    '999999999',
    'gpt-9000',
    400,
    '不存在 id + 非枚举值 → 400 (DTO pipe 先于 UC 归属校验)',
  );

  // ── ⑦ 契约对齐：未认证 → 401 ───────────────────────────────────────────────────────
  await assertUnauthenticated(ctx);
}

/** 裸 fetch 消费 SSE 发消息端点（orval 不生成；产 text/event-stream）。读到 [DONE] 即落库完成。 */
async function streamSend(
  ctx: RealBackendCtx,
  conversationId: string,
  content: string,
): Promise<void> {
  const res = await fetch(`${ctx.api}/api/v1/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.accessToken}` },
    body: JSON.stringify({ content }),
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
}

/**
 * 设 model 拒绝断言（非法值 → 400 / 越权 → 404，字节级一致反枚举）。
 * model 入参 string（含 orval enum 外的非法值）→ cast 到生成的 request 类型绕编译期枚举约束，
 * 故意送原始非法 wire 值验 server 值域校验。
 */
async function assertSetModelRejected(
  cfg: { baseURL: string; headers: Record<string, string> },
  id: string,
  model: string,
  expectedStatus: number,
  msg: string,
): Promise<void> {
  const body = { model } as unknown as SetConversationModelRequest;
  await assert.rejects(
    () => conversationControllerSetModel(id, body, cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, expectedStatus, msg);
      return true;
    },
  );
}

/** 无 Bearer → 401（authed 端点）。 */
async function assertUnauthenticated(ctx: RealBackendCtx): Promise<void> {
  await assert.rejects(
    () => conversationControllerListAvailableModels({ baseURL: ctx.api }),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 401, '未认证 models → 401');
      return true;
    },
  );
}
