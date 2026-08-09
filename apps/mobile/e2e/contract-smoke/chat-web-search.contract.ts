/**
 * 030 chat-web-search 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，
 * 全 boot node dist/main.js）验联网智能搜索的工具帧序列 + sources 回填 + 降级落库端到端 +
 * 契约对齐。SSE 发消息端点产 text/event-stream（含 030 新增 tool_start/tool_result/degraded/
 * sources 帧），orval 未生成消费函数 → 裸 fetch 读流（与 027/028/029 contract 同款）；建会话 /
 * 取消息走生成的 typed client 函数（含 030 新增 metadata.{searched,degraded,sources}）。
 *
 * 大模型 + 检索出口：harness 设 CHAT_FAKE_LLM=1 + CHAT_FAKE_SEARCH=1 → chat.module 绑确定性
 * Fake providers（离线可跑）。env 注入路无法像 IT（T010）那样 .overrideProvider 注 scripted
 * script，故 Fake 走 **content-driven 分支**（plan B, T016）：030 A1 恒联网（server 恒挂
 * web_search 工具）下，消息内嵌 `WebSrch` 关键字 → FakeLlmProvider 吐 tool_call 驱动一轮检索
 * （query = 该 user 文本），检索结果回灌后吐 scripted token 收敛；消息再含 `FAIL` 标记 →
 * FakeSearchProvider 按 query throw → 驱动 FR-009 降级路径。无关键字 → 维持 027/029 行为。
 *
 * 覆盖（spec FR-003/006/007/009 / SC 联网作答 + 降级）：
 *   ① happy：发含 `WebSrch` 的消息（body 恒 `{content}`）→ SSE 验工具帧序列（tool_start → tool_result）
 *      + 最终答案 token + sources 帧 → GET messages 验 metadata.{searched=true, degraded=false,
 *      sources(编号 URL)} 落库回填（契约对齐 URL/method/SSE 帧形状/序列化）。
 *   ② 降级：发含 `WebSrch`+`FAIL` 的消息 → SSE 验 degraded 帧（无 sources 帧）
 *      + GET messages 验 metadata.{searched=true, degraded=true} 落库 + user msg 不丢。
 *
 * 边界与幂等：chat 表按 accountId 归属，本 spec 全程新建独立会话，无跨 spec 污染（下次 boot
 * 全新 PG 容器）；chat 无公开删除端点，残留行对其他 spec 无害，故无 cleanup。
 */
import assert from 'node:assert/strict';
import { conversationControllerCreate, conversationControllerMessages } from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'chat-web-search (030)';

// content-driven Fake 触发关键字（chat.module FAKE_LLM_WEB_SEARCH_KEYWORD 镜像）：030 A1 恒联网
// 下 server 恒挂 web_search 工具，消息含此关键字 → FakeLlmProvider 吐 tool_call 驱动检索。
const MSG_WEB = 'WebSrch请联网查一下今天的科技新闻';
// 同时含 WebSrch（驱动检索）+ FAIL（FakeSearchProvider 按 query 标记 throw → 降级）。
const MSG_DEGRADED = 'WebSrch帮我查 FAIL 这个话题';

// FakeLlmProvider scripted 收敛正文（chat.module FAKE_LLM_TOKENS 拼接；含中文多字节）。
const FAKE_AI_REPLY = '你好，这是一段测试回复。';

/** SSE 帧解析产物（按 sse.rules.ts 帧形状抽取，验工具/来源/降级帧序列）。 */
interface ParsedStream {
  tokens: string[];
  toolStarts: { query: string }[];
  toolResults: { count: number; sources: { title: string; url: string }[] }[];
  degraded: boolean;
  sources: { index: number; title: string; url: string }[];
  done: boolean;
}

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① happy：联网作答 → 工具帧序列 + sources 帧 + metadata 落库回填 ────────────────────
  const createdA = await conversationControllerCreate({}, cfg);
  assert.equal(createdA.status, 201, `建会话 expected 201, got ${createdA.status}`);
  const convA = createdA.data;
  assert.match(convA.id, /^\d+$/, '建会话: id 数字串 (BigInt 序列化)');

  const happy = await streamSend(ctx, convA.id, MSG_WEB);
  assert.ok(happy.done, 'happy SSE: 收到 [DONE] 哨兵');
  // 工具帧序列：≥1 轮 tool_start → tool_result（模型自决检索）。
  assert.ok(happy.toolStarts.length >= 1, 'happy SSE: ≥1 个 tool_start 帧 (模型发起检索)');
  assert.ok(happy.toolResults.length >= 1, 'happy SSE: ≥1 个 tool_result 帧 (一轮检索完成)');
  assert.equal(happy.degraded, false, 'happy SSE: 未降级 (无 degraded 帧)');
  // tool_result.count = 原始页数（Fake 注入 2 条）；摘要 sources 含 title/url。
  const tr = happy.toolResults[0];
  assert.ok(tr.count >= 1, 'happy SSE: tool_result.count ≥1 (原始页数)');
  assert.ok(
    tr.sources.length >= 1 && tr.sources.every((s) => s.title && /^https?:\/\//.test(s.url)),
    'happy SSE: tool_result.sources 含 title + http(s) url',
  );
  // 最终答案 token（检索回灌后 Fake 收敛）= scripted 回复。
  assert.ok(happy.tokens.length > 0, 'happy SSE: ≥1 个 token 帧 (最终答案)');
  assert.equal(happy.tokens.join(''), FAKE_AI_REPLY, 'happy SSE: token 拼接 = scripted 答案');
  // sources 帧（收尾完整编号来源，FR-007）：1-based 全局编号 + http(s) url。
  assert.ok(happy.sources.length >= 1, 'happy SSE: ≥1 个编号 source (sources 帧, FR-007)');
  happy.sources.forEach((s, i) => {
    assert.equal(s.index, i + 1, `happy SSE: source[${i}] index 1-based 连续编号`);
    assert.ok(s.title.length > 0, `happy SSE: source[${i}] title 非空`);
    assert.match(s.url, /^https?:\/\//, `happy SSE: source[${i}] url http(s)`);
  });

  // GET messages 验 metadata 落库回填（searched=true / degraded=false / sources 同 SSE 帧）。
  const afterA = await conversationControllerMessages(convA.id, cfg);
  assert.equal(afterA.status, 200, `happy messages expected 200, got ${afterA.status}`);
  const msgsA = afterA.data.messages;
  assert.equal(msgsA.length, 2, 'happy 落库: user + AI 共 2 条');
  assert.equal(msgsA[0].role, 'user', 'happy 落库: 首条 role=user');
  assert.equal(msgsA[0].content, MSG_WEB, 'happy 落库: user msg content 原样 (不丢)');
  const aiA = msgsA[1];
  assert.equal(aiA.role, 'assistant', 'happy 落库: 次条 role=assistant');
  assert.equal(aiA.status, 'completed', 'happy 落库: AI msg status=completed');
  assert.equal(aiA.content, FAKE_AI_REPLY, 'happy 落库: AI content = scripted 答案');
  assert.ok(aiA.metadata, 'happy 落库: AI msg 带 metadata (联网回填, FR-006)');
  assert.equal(
    aiA.metadata?.searched,
    true,
    'happy 落库: metadata.searched=true (实际发生 tool_call)',
  );
  assert.equal(aiA.metadata?.degraded, false, 'happy 落库: metadata.degraded=false');
  const persisted = aiA.metadata?.sources ?? [];
  assert.ok(persisted.length >= 1, 'happy 落库: metadata.sources 非空 (FR-007 编号来源回填)');
  // 落库 sources 与 SSE sources 帧一致（编号 + url）。
  assert.deepEqual(
    persisted.map((s) => ({ index: s.index, url: s.url })),
    happy.sources.map((s) => ({ index: s.index, url: s.url })),
    'happy 落库: metadata.sources 与 SSE sources 帧编号/URL 一致',
  );

  // ── ② 降级路径：检索失败 → degraded 帧 + metadata.degraded 落库 + user msg 不丢 ─────────
  const createdB = await conversationControllerCreate({}, cfg);
  assert.equal(createdB.status, 201, `建会话 B expected 201, got ${createdB.status}`);
  const convB = createdB.data;

  const deg = await streamSend(ctx, convB.id, MSG_DEGRADED);
  assert.ok(deg.done, '降级 SSE: 收到 [DONE] 哨兵');
  assert.ok(deg.toolStarts.length >= 1, '降级 SSE: ≥1 个 tool_start 帧 (发起检索后才失败)');
  assert.equal(deg.degraded, true, '降级 SSE: 收到 degraded 帧 (FR-009)');
  assert.equal(deg.sources.length, 0, '降级 SSE: 无编号来源 (检索失败无 sources 帧)');
  // 降级后仍兜底无 tools 收敛作答（最终答案不空）。
  assert.ok(deg.tokens.length > 0, '降级 SSE: 仍产最终答案 token (兜底收敛)');

  const afterB = await conversationControllerMessages(convB.id, cfg);
  assert.equal(afterB.status, 200, `降级 messages expected 200, got ${afterB.status}`);
  const msgsB = afterB.data.messages;
  assert.equal(msgsB.length, 2, '降级 落库: user + AI 共 2 条 (user 不丢)');
  assert.equal(msgsB[0].role, 'user', '降级 落库: 首条 role=user');
  assert.equal(msgsB[0].content, MSG_DEGRADED, '降级 落库: user msg content 原样 (FR-006 不丢)');
  const aiB = msgsB[1];
  assert.equal(aiB.role, 'assistant', '降级 落库: 次条 role=assistant');
  assert.equal(aiB.status, 'completed', '降级 落库: AI msg status=completed (降级仍正常收尾)');
  assert.ok(aiB.metadata, '降级 落库: AI msg 带 metadata');
  assert.equal(
    aiB.metadata?.searched,
    true,
    '降级 落库: metadata.searched=true (检索失败前已发 tool_call)',
  );
  assert.equal(aiB.metadata?.degraded, true, '降级 落库: metadata.degraded=true (FR-009)');
  assert.deepEqual(aiB.metadata?.sources, [], '降级 落库: metadata.sources 空 (检索失败无来源)');
}

/**
 * 裸 fetch 消费 SSE 发消息端点（orval 不生成；产 text/event-stream）。解 030 全帧形状
 * （token / tool_start / tool_result / degraded / sources / [DONE]），按 payload 字段判别
 * （sse.rules.ts 契约：token 帧 `.token`、tool 帧 `.tool`、degraded 帧 `.degraded`、
 * sources 帧 `.sources`）。跨 chunk 半帧用 buffer 累积（同 027/029 contract 分帧逻辑）。
 */
async function streamSend(
  ctx: RealBackendCtx,
  conversationId: string,
  content: string,
): Promise<ParsedStream> {
  const res = await fetch(`${ctx.api}/api/v1/chat/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.accessToken}` },
    // 030 A1：恒联网 → body 恒 `{content}`（去 per-message webSearch 字段）；是否检索由 Fake
    // 按 content 关键字 `WebSrch` 自决（server 恒挂 web_search 工具，content-driven Fake 仍触发）。
    body: JSON.stringify({ content }),
  });
  assert.equal(res.status, 200, `SSE send expected 200, got ${res.status}`);
  assert.match(
    res.headers.get('content-type') ?? '',
    /text\/event-stream/,
    'SSE: Content-Type text/event-stream',
  );
  assert.ok(res.body, 'SSE: response body 流可读');

  const out: ParsedStream = {
    tokens: [],
    toolStarts: [],
    toolResults: [],
    degraded: false,
    sources: [],
    done: false,
  };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
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
        out.done = true;
      } else if (payload.length > 0) {
        parseFrame(payload, out);
      }
      sep = buffer.indexOf('\n\n');
    }
  }
  return out;
}

/** 按 sse.rules.ts payload 字段判别分派一帧（token / tool / degraded / sources / error）。 */
function parseFrame(payload: string, out: ParsedStream): void {
  const obj = JSON.parse(payload) as {
    token?: string;
    error?: string;
    tool?: string;
    status?: string;
    query?: string;
    count?: number;
    degraded?: boolean;
    sources?: unknown;
  };
  assert.equal(obj.error, undefined, `SSE: 收到错误帧 ${obj.error}`);
  if (obj.tool === 'web_search' && obj.status === 'start') {
    out.toolStarts.push({ query: obj.query ?? '' });
  } else if (obj.tool === 'web_search' && obj.status === 'result') {
    out.toolResults.push({
      count: obj.count ?? 0,
      sources: (obj.sources as { title: string; url: string }[]) ?? [],
    });
  } else if (obj.degraded === true) {
    out.degraded = true;
  } else if (obj.sources !== undefined) {
    // sources 帧（收尾完整编号来源）；与 tool_result 帧区分：tool_result 同时带 tool 字段，
    // 此处已被上面分支拦掉，剩下纯 `{sources:[...]}` 即收尾帧。
    out.sources = obj.sources as { index: number; title: string; url: string }[];
  } else if (obj.token !== undefined) {
    out.tokens.push(obj.token);
  }
}
