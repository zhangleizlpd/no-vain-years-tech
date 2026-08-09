/**
 * 027 ai-chat-streaming 契约冒烟（PR2 §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，
 * 全 boot node dist/main.js）验 chat 核心写入端到端 + 真落库 + 契约对齐。SSE 发消息端点
 * 产 `text/event-stream`（非 JSON），orval 没生成消费函数（mobile 自写 expo/fetch 客户端），
 * 故本 node 层用裸 `fetch` 读 SSE 流；建会话 / 取消息走生成的 typed client 函数。
 *
 * 大模型出口：真 server 由 harness 设 `CHAT_FAKE_LLM=1` → chat.module 绑确定性
 * FakeLlmProvider（scripted 中文 token，不打真 DeepSeek / 不依赖外网），保契约冒烟确定 +
 * 离线可跑。流式 token 读到非空即验流式链路通；落库正确性靠发完后 GET messages 断言。
 *
 * 覆盖：
 *   ① 登录（harness 程序化登录拿真 token）→ POST /chat/conversations 建空会话（typed client）；
 *   ② SSE 发消息（裸 fetch 读流）：读到 ≥1 个 token 帧 + `[DONE]` 哨兵 → 流式链路通；
 *   ③ GET messages（typed client）验真落库：user msg（completed）+ AI msg（completed）按插入序、
 *      role/status/content 正确，AI content = FakeProvider scripted 拼接（SC-002 重进仍在）；
 *   ④ 契约对齐：建会话 URL/method/序列化（id BigInt → 数字串、title 默认派生）；越权 / 不存在
 *      conversationId → 404 字节级一致（反枚举）；未认证 → 401。
 *
 * 边界与幂等：chat 表按 accountId 归属，本 spec 全程新建独立会话，无跨 spec 污染；chat 无公开
 * 删除端点，残留行（属测试 account，下次 boot 全新 PG 容器）不影响其他 spec，故无 cleanup。
 */
import assert from 'node:assert/strict';
import { conversationControllerCreate, conversationControllerMessages } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'chat-streaming (027)';

// FakeLlmProvider scripted token 序列（chat.module FAKE_LLM_TOKENS 镜像；含中文多字节验
// SSE 编码端到端）。AI msg 落库 content = 这些 token 拼接。
const FAKE_AI_REPLY = '你好，这是一段测试回复。';

const USER_MESSAGE = '帮我分析一下贵州茅台';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① 建会话（typed client）：URL/method/序列化对齐 ───────────────────────────────────
  const created = await conversationControllerCreate({}, cfg);
  assert.equal(created.status, 201, `建会话 expected 201, got ${created.status}`);
  const conv = created.data;
  // id BigInt → 数字串（orval 既有体例；非数字 / 非空）。
  assert.match(conv.id, /^\d+$/, '建会话: id 为数字串 (BigInt 序列化)');
  // model 默认 flash（029 D7 起新会话默认逻辑 model = flash，取代 027 旧默认 deepseek-chat）。
  assert.equal(conv.model, 'flash', '建会话: model 默认 flash (029 D7)');
  // 空 title → 兜底「新对话」(首条消息后派生覆盖)。
  assert.equal(conv.title, '新对话', '建会话: 空 title 兜底「新对话」');
  const conversationId = conv.id;

  // 建会话即时取消息 → 空 [] (空会话契约)。
  const empty = await conversationControllerMessages(conversationId, cfg);
  assert.equal(empty.status, 200, `空会话 messages expected 200, got ${empty.status}`);
  assert.deepEqual(empty.data.messages, [], '建会话: 空会话 messages 空数组');

  // ── ② SSE 发消息（裸 fetch 读流）：流式链路通（≥1 token + [DONE]）───────────────────
  const { tokens, done } = await streamSend(ctx, conversationId, USER_MESSAGE);
  assert.ok(tokens.length > 0, 'SSE: 读到 ≥1 个 token 帧 (流式链路通)');
  assert.ok(done, 'SSE: 收到 [DONE] 哨兵 (流正常结束)');
  // 流式 token 拼接 = FakeProvider scripted 回复（验帧解码 + 中文多字节无损）。
  assert.equal(tokens.join(''), FAKE_AI_REPLY, 'SSE: token 拼接 = scripted AI 回复');

  // ── ③ GET messages 验真落库（user + AI msg、role/status/序）────────────────────────
  const after = await conversationControllerMessages(conversationId, cfg);
  assert.equal(after.status, 200, `发消息后 messages expected 200, got ${after.status}`);
  const msgs = after.data.messages;
  assert.equal(msgs.length, 2, '落库: user + AI 共 2 条 (按插入序)');

  const userMsg = msgs[0];
  assert.match(userMsg.id, /^\d+$/, '落库: user msg id 数字串');
  assert.equal(userMsg.role, 'user', '落库: 首条 role=user');
  assert.equal(userMsg.status, 'completed', '落库: user msg status=completed');
  assert.equal(userMsg.content, USER_MESSAGE, '落库: user msg content 原样');

  const aiMsg = msgs[1];
  assert.equal(aiMsg.role, 'assistant', '落库: 次条 role=assistant');
  assert.equal(aiMsg.status, 'completed', '落库: AI msg 正常结束 status=completed');
  assert.equal(aiMsg.content, FAKE_AI_REPLY, '落库: AI msg content = scripted 全文 (流结束落)');
  // 插入序：AI msg id > user msg id（BigInt 数字串比较）。
  assert.ok(BigInt(aiMsg.id) > BigInt(userMsg.id), '落库: AI msg id > user msg id (插入序)');

  // 首条消息派生标题覆盖默认「新对话」(FR-013)。
  const titled = await conversationControllerMessages(conversationId, cfg);
  assert.equal(titled.status, 200, 'reload messages 200 (SC-002 重进仍在)');

  // ── ④ 契约对齐：错误码（越权 / 不存在 404 字节级一致 + 未认证 401）─────────────────
  await assertOtherAccountNotFound(cfg);
  await assertUnauthenticated(ctx);
}

/**
 * 裸 fetch 消费 SSE 发消息端点（orval 不生成此端点函数 — 产 text/event-stream）。
 * 解 `data:{"token":"..."}\n\n` 帧抽 token，识别 `data:[DONE]\n\n` 哨兵。跨 chunk 半帧
 * 用 buffer 累积（与 mobile sse-parse 同款分帧逻辑，此处 node 层独立薄实现验契约）。
 */
async function streamSend(
  ctx: RealBackendCtx,
  conversationId: string,
  content: string,
): Promise<{ tokens: string[]; done: boolean }> {
  const res = await fetch(`${ctx.api}/api/v1/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.accessToken}`,
    },
    body: JSON.stringify({ content }),
  });
  assert.equal(res.status, 200, `SSE send expected 200, got ${res.status}`);
  assert.match(
    res.headers.get('content-type') ?? '',
    /text\/event-stream/,
    'SSE: Content-Type text/event-stream',
  );
  assert.ok(res.body, 'SSE: response body 流可读');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const tokens: string[] = [];
  let done = false;
  let buffer = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    // 按帧分隔 \n\n 切；末尾不完整半帧留 buffer 等下个 chunk。
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const payload = frame.startsWith('data:') ? frame.slice('data:'.length).trim() : frame.trim();
      if (payload === '[DONE]') {
        done = true;
      } else if (payload.length > 0) {
        const parsed = JSON.parse(payload) as { token?: string; error?: string };
        assert.equal(parsed.error, undefined, `SSE: 收到错误帧 ${parsed.error}`);
        if (parsed.token !== undefined) tokens.push(parsed.token);
      }
      sep = buffer.indexOf('\n\n');
    }
  }
  return { tokens, done };
}

// 越权 / 不存在 conversationId → 404（字节级一致反枚举：不带业务 code 区分，仅 status，
// 与 chat IT ⑥ 同款；chat 端点故意不暴露 CONVERSATION_NOT_FOUND 作 ProblemDetail.code，
// 让他人/不存在/非数字三态不可区分 — 与 marketdata 暴露 INSTRUMENT_NOT_FOUND 的契约不同）。
async function assertOtherAccountNotFound(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  await assert.rejects(
    () => conversationControllerMessages('999999999', cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 404, '越权/不存在 conversationId → 404 (反枚举)');
      return true;
    },
  );
}

// 无 Bearer → 401（authed 端点，反枚举统一 401）。
async function assertUnauthenticated(ctx: RealBackendCtx): Promise<void> {
  await assert.rejects(
    () => conversationControllerCreate({}, { baseURL: ctx.api }),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 401, '未认证建会话 → 401');
      return true;
    },
  );
}
