// 027 T010 — expo/fetch SSE 流式客户端（**非 orval**，SSE 产 text/event-stream 非 JSON）。
//
// 职责：POST /api/v1/chat/conversations/{id}/messages body {content} + auth header
// → 读 response.body 流 → parseSseChunk 逐帧 → 回调吐 token / 识别 done / error / abort。
// `AbortController` 暴露给上层（T011 use-chat 停止生成用）。
//
// 设计取舍（干净上下文须知）：
// - `fetch` from **`expo/fetch`**（非全局 fetch、非 react-native-sse）。PoC 实证 Android
//   无缓冲、增量到达；`expo/fetch` 随 Expo SDK 自带 = 零新依赖。
// - **不复用** axios 003-tokens refresh 拦截器（setup.ts）：那套绑死 axios 实例，无法
//   包裹 raw stream。本客户端裸 fetch 自带 `Authorization: Bearer <accessToken>`，token
//   读法与 setup.ts 同源（`useAuthStore.getState().accessToken`）。SSE 流式期间的 401
//   透明续期不在 027 scope（流已开始难以原子重放）——首 token 前若 401，由调用方按
//   error 处理（FR-009 重试：用户 msg 已落不丢，重发即可）。
// - 解析核心全在 `sse-parse.ts`（纯函数 vitest 覆盖）；本文件是薄壳（流 IO），真流式
//   交互验证留 T013 e2e。
import { fetch } from 'expo/fetch';
import { useAuthStore } from '~/auth';
import {
  parseSseChunk,
  type NumberedSource,
  type ParsedFrame,
  type ToolResultSource,
} from './sse-parse';

/** 030 工具事件（中间态「已阅读 N 个网页」驱动）。tool_start 起检索 / tool_result 一轮完成。 */
export type ChatToolEvent =
  | { type: 'tool_start'; query: string }
  | { type: 'tool_result'; count: number; sources: ToolResultSource[] };

/** 流式发消息的事件回调。token 增量逐次到达；done/error/aborted 三选一终态恰好一次。 */
export interface ChatStreamCallbacks {
  /** 每收到一个 token 增量回调一次（UI 累加打字机）。 */
  onToken: (token: string) => void;
  /** 流正常结束（收到 `[DONE]`）。 */
  onDone: () => void;
  /** 服务端 error 帧（provider 失败，AI msg 不落）或网络/HTTP 错误。 */
  onError: (message: string) => void;
  /** 上层主动 abort（停止生成）。中断判定靠 `signal.aborted`，**不**匹配 error message。 */
  onAborted: () => void;
  /** 030：模型自决一轮检索的 start/result 工具事件（驱动「已阅读 N」中间态）。可选（027 调用方不传）。 */
  onToolEvent?: (event: ChatToolEvent) => void;
  /** 030：收尾完整编号来源（[N]→源映射 + 来源列表）。可选。 */
  onSources?: (sources: NumberedSource[]) => void;
  /** 030：本轮检索失败降级（FR-009，标「本次未联网」）。可选。 */
  onDegraded?: () => void;
}

/** sendMessage 句柄：暴露 controller 供上层停止；promise 在流终态（done/error/abort）resolve。 */
export interface ChatStreamHandle {
  controller: AbortController;
  done: Promise<void>;
}

/** 流式发消息端点 path（与 orval 生成同源，含 global prefix `api` + controller `v1/chat`）。 */
function sendMessageUrl(conversationId: string): string {
  // Dot access required for Expo/metro 静态内联（per setup.ts 注释）。
  const baseURL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';
  return `${baseURL}/api/v1/chat/conversations/${conversationId}/messages`;
}

/**
 * 发一条消息并流式消费 SSE 响应。复杂度：O(总字节数)（每 chunk decode + 切帧线性）。
 *
 * 030 A1：去 per-message `webSearch` 开关 —— ChatGPT 式恒联网，是否检索由 server 模型自决
 * （send body 恒 `{content}`，工具事件/来源/降级仍按帧回调）。
 *
 * @param conversationId 目标会话 id（BigInt 经 JSON 序列化为 string，orval 同款）。
 * @param content 用户输入文本。
 * @param callbacks token / done / error / aborted（+ 030 工具事件）回调。
 * @returns `{controller, done}` —— controller.abort() 停止；done 在终态 resolve（不 reject）。
 */
export function sendMessage(
  conversationId: string,
  content: string,
  callbacks: ChatStreamCallbacks,
): ChatStreamHandle {
  const controller = new AbortController();
  const done = streamLoop(conversationId, content, controller, callbacks);
  return { controller, done };
}

async function streamLoop(
  conversationId: string,
  content: string,
  controller: AbortController,
  callbacks: ChatStreamCallbacks,
): Promise<void> {
  const accessToken = useAuthStore.getState().accessToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  // 030 A1：恒联网 → body 恒 `{content}`（是否检索由 server 模型自决，无 per-message 开关）。
  const body = JSON.stringify({ content });

  try {
    const response = await fetch(sendMessageUrl(conversationId), {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      callbacks.onError(`HTTP ${response.status}`);
      return;
    }
    if (!response.body) {
      callbacks.onError('No response body');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // 逐 chunk decode（stream:true 保多字节字符跨 chunk 不截断）→ parseSseChunk 切帧。
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;

      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseChunk(buffer);
      buffer = rest; // 未闭合尾部留到下个 chunk 前面（半帧缓冲）。

      const terminal = dispatchFrames(frames, callbacks);
      if (terminal) return; // done / error 已终态，停止读流。
    }

    // 流自然结束但未见 [DONE]（理论不应发生）—— 容错按 done 收尾。
    callbacks.onDone();
  } catch (err) {
    // 🚨 中断判定用 signal.aborted，**不**匹配 error message（PoC gotcha：expo/fetch
    // abort 抛 "Fetch request has been canceled" 不含 "Abort"）。
    if (controller.signal.aborted) {
      callbacks.onAborted();
      return;
    }
    callbacks.onError(err instanceof Error ? err.message : String(err));
  }
}

/** 按序派发帧；遇 done/error 返回 true（终态，调用方停止读流）。 */
function dispatchFrames(frames: ParsedFrame[], callbacks: ChatStreamCallbacks): boolean {
  for (const frame of frames) {
    switch (frame.type) {
      case 'token':
        callbacks.onToken(frame.token);
        break;
      case 'done':
        callbacks.onDone();
        return true;
      case 'error':
        callbacks.onError(frame.error);
        return true;
      // 030 工具帧 → 非终态回调（可选，027 调用方不传则忽略）。
      case 'tool_start':
        callbacks.onToolEvent?.({ type: 'tool_start', query: frame.query });
        break;
      case 'tool_result':
        callbacks.onToolEvent?.({
          type: 'tool_result',
          count: frame.count,
          sources: frame.sources,
        });
        break;
      case 'sources':
        callbacks.onSources?.(frame.sources);
        break;
      case 'degraded':
        callbacks.onDegraded?.();
        break;
    }
  }
  return false;
}
