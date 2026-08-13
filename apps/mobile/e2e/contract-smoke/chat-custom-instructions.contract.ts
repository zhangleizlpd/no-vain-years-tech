/**
 * 031 chat-custom-instructions 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，
 * 全 boot node dist/main.js）验：① 偏好读/写端点契约对齐 + 真落库（URL/method/序列化）；
 * ② 自定义指令真组装进发送时的 system 消息（平台基座层 + 用户自定义层）端到端。
 *
 * 系统提示验证机制（关键）：env 注入路（CHAT_FAKE_LLM=1）无法像 server IT（T006）那样
 * .overrideProvider 注 spy 捕获 provider 入参 messages，故 contract-smoke 改走 **content-driven
 * 回显**（plan B，与 030 content-driven Fake 同思路）：FakeLlmProvider 配 systemEchoKeyword=
 * `SysEcho`（chat.module 镜像），消息内嵌该 ascii 关键字 → Fake 把本次组装的 `role:'system'`
 * 段原文吐成正文 → AI 消息落库 content = 系统提示原文。node 层经生成的 typed GET messages 读回
 * AI content，即可断言平台基座文本在首 + 用户自定义指令在 delimiter 内末段（验真组装进 system，
 * 补 server IT「in-process spy」与 hermetic mock 都覆盖不到的「真 boot 全链路组装」缝）。
 *
 * 偏好端点出口：GET/PUT /chat/preferences 走生成的 typed client 函数（契约对齐）；发消息走 SSE
 * 裸 fetch（orval 不生成 text/event-stream 消费函数，同 027/030 contract）。
 *
 * 覆盖（spec FR-001/002/003/006/007 / SC-001/002/003）：
 *   ① PUT 写自定义指令 → GET 验回显落库（契约对齐 URL/method/序列化）；
 *   ② 建会话 + 发含 SysEcho 的消息（SSE）→ GET messages 验 AI content（= 回显的 system 段）
 *      含平台基座文本 + delimiter 包裹的自定义指令文本（验真组装进 system，FR-001/003/006）；
 *   ③ 清空（PUT 空串）→ GET 验回空串（D9 清空语义）→ 再发消息 → system 段仅含平台基座、
 *      不含 delimiter（SC-004 清空回退仅平台基座）。
 *
 * 边界与幂等：偏好按 accountId 自绑单行（PUT 幂等覆盖）；chat 表按 accountId 归属，全程新建独立
 * 会话，无跨 spec 污染（下次 boot 全新 PG 容器）；chat 无公开删除端点，残留行对其他 spec 无害。
 */
import assert from 'node:assert/strict';
import {
  chatPreferenceControllerGet,
  chatPreferenceControllerUpsert,
  conversationControllerCreate,
  conversationControllerMessages,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'chat-custom-instructions (031)';

// 系统提示回显触发关键字（chat.module FAKE_LLM_SYSTEM_ECHO_KEYWORD 镜像）：消息内嵌 → Fake
// 把组装的 system 段原文吐成 AI 正文，落库后 GET 即可断言 system 真组装。
const ECHO_KW = 'SysEcho';

// 平台基座层身份前缀（system-prompt.rules.platformBaseLayer 镜像）—— 恒在 system 段首位。
const PLATFORM_BASE_PREFIX = '你是「不负光阴」App 的 AI 助手';
// 用户自定义层 delimiter（system-prompt.rules USER_CUSTOM_OPEN/CLOSE 镜像）。
const USER_CUSTOM_OPEN = '<<<USER_CUSTOM>>>';
const USER_CUSTOM_CLOSE = '<<<END_USER_CUSTOM>>>';

// 写入的自定义指令（含可辨识 ascii sentinel 便于在回显里精确断言落位）。
const CUSTOM_INSTRUCTION = 'CISENTINEL 请用沪语简洁回答, 先给结论。';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① PUT 写自定义指令 → GET 验回显落库（契约对齐 URL/method/序列化）────────────────────
  const put = await chatPreferenceControllerUpsert({ customInstruction: CUSTOM_INSTRUCTION }, cfg);
  assert.equal(put.status, 200, `PUT preferences expected 200, got ${put.status}`);
  assert.equal(put.data.customInstruction, CUSTOM_INSTRUCTION, 'PUT: 回显写入的 customInstruction');

  const get1 = await chatPreferenceControllerGet(cfg);
  assert.equal(get1.status, 200, `GET preferences expected 200, got ${get1.status}`);
  assert.equal(
    get1.data.customInstruction,
    CUSTOM_INSTRUCTION,
    'GET: 真落库回显写入的 customInstruction (SC-002 持久 hydrate)',
  );

  // ── ② 发含 SysEcho 的消息 → AI content = 回显 system 段，验平台基座 + 自定义指令真组装 ─────
  const createdA = await conversationControllerCreate({}, cfg);
  assert.equal(createdA.status, 201, `建会话 expected 201, got ${createdA.status}`);
  const convA = createdA.data;
  assert.match(convA.id, /^\d+$/, '建会话: id 数字串 (BigInt 序列化)');

  const echoA = await streamSend(ctx, convA.id, `${ECHO_KW} 帮我分析一下贵州茅台`);
  assert.ok(echoA.done, 'SSE: 收到 [DONE] 哨兵');
  assert.ok(echoA.tokens.length > 0, 'SSE: 读到 ≥1 个 token 帧 (回显 system 段)');

  const afterA = await conversationControllerMessages(convA.id, cfg);
  assert.equal(afterA.status, 200, `messages expected 200, got ${afterA.status}`);
  const msgsA = afterA.data.messages;
  assert.equal(msgsA.length, 2, '落库: user + AI 共 2 条');
  assert.equal(msgsA[0].role, 'user', '落库: 首条 role=user');
  const aiSystem = msgsA[1].content; // AI content = 回显的 system 段原文。
  assert.equal(msgsA[1].role, 'assistant', '落库: 次条 role=assistant');

  // 平台基座层在 system 段首位（FR-001 恒生效最高优先）。
  assert.ok(
    aiSystem.startsWith(PLATFORM_BASE_PREFIX),
    `系统提示: 平台基座层在首位 (FR-001/SC-003)，实际开头: ${aiSystem.slice(0, 30)}`,
  );
  // 用户自定义指令在 delimiter 内（FR-006 注入沙箱 + FR-003 真注入）。
  assert.ok(
    aiSystem.includes(USER_CUSTOM_OPEN),
    '系统提示: 含 USER_CUSTOM 起始 delimiter (FR-006)',
  );
  assert.ok(
    aiSystem.includes(USER_CUSTOM_CLOSE),
    '系统提示: 含 USER_CUSTOM 结束 delimiter (FR-006)',
  );
  assert.ok(
    aiSystem.includes(CUSTOM_INSTRUCTION),
    '系统提示: 自定义指令文本真组装进 system (FR-003/SC-001)',
  );
  // 自定义指令落在平台基座之后（固定优先级序: 平台基座 > 用户自定义，FR-007）。
  assert.ok(
    aiSystem.indexOf(PLATFORM_BASE_PREFIX) < aiSystem.indexOf(USER_CUSTOM_OPEN),
    '系统提示: 平台基座先于用户自定义层 (FR-007 固定优先级序)',
  );

  // ── ③ 清空（PUT 空串）→ GET 验空 → 发消息验 system 仅平台基座（SC-004 清空回退）────────────
  const clear = await chatPreferenceControllerUpsert({ customInstruction: '' }, cfg);
  assert.equal(clear.status, 200, `PUT 清空 expected 200, got ${clear.status}`);
  assert.equal(clear.data.customInstruction, '', 'PUT 清空: 回显空串 (D9)');

  const get2 = await chatPreferenceControllerGet(cfg);
  assert.equal(get2.status, 200, `GET (清空后) expected 200, got ${get2.status}`);
  assert.equal(get2.data.customInstruction, '', 'GET 清空后: 回空串 (D9 清空语义)');

  const createdB = await conversationControllerCreate({}, cfg);
  assert.equal(createdB.status, 201, `建会话 B expected 201, got ${createdB.status}`);
  const echoB = await streamSend(ctx, createdB.data.id, `${ECHO_KW} 再问一个问题`);
  assert.ok(echoB.done, 'SSE (清空后): 收到 [DONE] 哨兵');

  const afterB = await conversationControllerMessages(createdB.data.id, cfg);
  assert.equal(afterB.status, 200, `messages B expected 200, got ${afterB.status}`);
  const aiSystemB = afterB.data.messages[1].content;
  assert.ok(
    aiSystemB.startsWith(PLATFORM_BASE_PREFIX),
    '系统提示 (清空后): 平台基座层仍在首位 (SC-003 恒带平台基座)',
  );
  assert.ok(
    !aiSystemB.includes(USER_CUSTOM_OPEN),
    '系统提示 (清空后): 无 USER_CUSTOM delimiter (SC-004 清空回退仅平台基座)',
  );
  assert.ok(
    !aiSystemB.includes(CUSTOM_INSTRUCTION),
    '系统提示 (清空后): 旧自定义指令文本已不在 system (清空生效)',
  );

  // ── ④ 契约对齐：未认证 GET/PUT → 401（authed 端点，反枚举统一 401）────────────────────────
  await assertUnauthenticated(ctx);
}

/**
 * 裸 fetch 消费 SSE 发消息端点（orval 不生成；产 text/event-stream）。解 `data:{"token":"..."}`
 * 帧抽 token，识别 `[DONE]` 哨兵（同 027 contract 分帧逻辑）。非联网路径（不传 webSearch）。
 */
async function streamSend(
  ctx: RealBackendCtx,
  conversationId: string,
  content: string,
): Promise<{ tokens: string[]; done: boolean }> {
  const res = await fetch(`${ctx.api}/api/v1/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.accessToken}` },
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

// 无 Bearer → 401（authed 偏好端点，反枚举统一 401）。
async function assertUnauthenticated(ctx: RealBackendCtx): Promise<void> {
  await assert.rejects(
    () => chatPreferenceControllerGet({ baseURL: ctx.api }),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 401, '未认证 GET preferences → 401');
      return true;
    },
  );
}
