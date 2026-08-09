// 032 T014 — ideation 澄清 SSE 流式客户端（**非 orval**，SSE 产 text/event-stream 非 JSON）。
// 复用 027 chat-stream-client 范式（expo/fetch + AbortController + signal.aborted 判中断）。
//
// 职责：POST /api/v1/ideation/sessions/{id}/turns body {content} + auth header → 读
// response.body 流 → parseIdeationChunk 逐帧 → 回调吐 token / suggestion / done / error / abort。
//
// 设计取舍（同 chat-stream-client）：
// - `fetch` from **`expo/fetch`**（随 Expo SDK 自带 = 零新依赖；Android 无缓冲增量到达）。
// - **不复用** axios 003-tokens refresh 拦截器：那套绑死 axios 实例，无法包裹 raw stream。
//   裸 fetch 自带 `Authorization: Bearer <accessToken>`，token 读法与 setup.ts 同源。
//   流式期间 401 透明续期不在 scope（流已开始难原子重放）；首 token 前 401 由调用方按
//   error 处理（用户输入已落不丢，重发即可）。
// - 解析核心全在 ideation-sse-parse.ts（纯函数 vitest 覆盖）；本文件是薄壳（流 IO）。
import { fetch } from 'expo/fetch';
import { useAuthStore } from '~/auth';
import {
  parseIdeationChunk,
  type IdeationFrame,
  type IdeationSource,
  type NormalizedSuggestion,
} from './ideation-sse-parse';

/** 流式澄清回合的事件回调。token 增量逐次到达；done/error/aborted 三选一终态恰好一次。 */
export interface IdeationStreamCallbacks {
  /** 每收到一个 token 增量回调一次（UI 累加打字机，反问文本）。 */
  onToken: (token: string) => void;
  /** 一轮建议式选项收口（过两闸后整出一帧；纯文本轮不发）。 */
  onSuggestion: (suggestion: NormalizedSuggestion) => void;
  /** 034 接地：检索开始（tool_start 帧）→ 显示「正在检索代码…」指示。 */
  onToolStart: () => void;
  /** 034 接地：命中来源（sources 帧，≤5）→ 挂当前 assistant turn。 */
  onSources: (sources: IdeationSource[]) => void;
  /** 034 接地：降级系统气泡（notice 帧，FR-008）→ 落一条会话内系统提示（T011 渲染）。 */
  onNotice: (notice: string) => void;
  /** 流正常结束（收到 `[DONE]`）。 */
  onDone: () => void;
  /** 服务端 error 帧（provider 失败）或网络/HTTP 错误。 */
  onError: (message: string) => void;
  /** 上层主动 abort（停止）。中断判定靠 `signal.aborted`，**不**匹配 error message。 */
  onAborted: () => void;
}

/** sendTurn 句柄：暴露 controller 供上层停止；promise 在流终态（done/error/abort）resolve。 */
export interface IdeationStreamHandle {
  controller: AbortController;
  done: Promise<void>;
}

/**
 * 036 带图轮可选 payload（标注烧录发送 T012 / 仅附图直发 T014 共用）。
 * - `attachmentKeys`：本轮烧录图 / 原图 OSS key（server 校验归属 → 落库 + 注入 image_url part）。
 * - `annotationText`：SoM 同编号合成标注文字（注入视觉模型 text part）。
 * 二者缺省 = 纯文本轮（行为零回归，server 维持 `model:'pro'` + string content）。
 */
export interface IdeationTurnImagePayload {
  attachmentKeys?: string[];
  annotationText?: string;
}

/** 流式澄清端点 path（含 global prefix `api` + controller `v1/ideation`）。 */
function turnUrl(sessionId: string): string {
  // Dot access required for Expo/metro 静态内联（per setup.ts 注释）。
  const baseURL = process.env.EXPO_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';
  return `${baseURL}/api/v1/ideation/sessions/${sessionId}/turns`;
}

/**
 * 发一轮澄清输入并流式消费 SSE 响应。复杂度 O(总字节数)（每 chunk decode + 切帧线性）。
 *
 * @param sessionId 目标会话 id（BigInt 经 JSON 序列化为 string，orval 同款）。
 * @param content 本轮用户澄清输入文本。
 * @param callbacks token / suggestion / done / error / aborted 回调。
 * @param image 036 可选带图 payload（attachmentKeys + annotationText；缺省 = 纯文本轮零回归）。
 * @returns `{controller, done}` —— controller.abort() 停止；done 在终态 resolve（不 reject）。
 */
export function sendTurn(
  sessionId: string,
  content: string,
  callbacks: IdeationStreamCallbacks,
  image?: IdeationTurnImagePayload,
): IdeationStreamHandle {
  const controller = new AbortController();
  const done = streamLoop(sessionId, content, controller, callbacks, image);
  return { controller, done };
}

async function streamLoop(
  sessionId: string,
  content: string,
  controller: AbortController,
  callbacks: IdeationStreamCallbacks,
  image?: IdeationTurnImagePayload,
): Promise<void> {
  const accessToken = useAuthStore.getState().accessToken;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  // 036：带图轮附 attachmentKeys + annotationText（仅非空才入 body —— 纯文本轮维持旧形状
  // `{content}`，server 据缺省维持 `model:'pro'` + string content，行为零回归 SC-005）。
  const payload: { content: string; attachmentKeys?: string[]; annotationText?: string } = {
    content,
  };
  if (image?.attachmentKeys && image.attachmentKeys.length > 0) {
    payload.attachmentKeys = image.attachmentKeys;
  }
  if (image?.annotationText && image.annotationText.length > 0) {
    payload.annotationText = image.annotationText;
  }
  const body = JSON.stringify(payload);

  try {
    const response = await fetch(turnUrl(sessionId), {
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

    // 逐 chunk decode（stream:true 保多字节字符跨 chunk 不截断）→ parseIdeationChunk 切帧。
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;

      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = parseIdeationChunk(buffer);
      buffer = rest; // 未闭合尾部留到下个 chunk 前面（半帧缓冲）。

      const terminal = dispatchFrames(frames, callbacks);
      if (terminal) return; // done / error 已终态，停止读流。
    }

    // 流自然结束但未见 [DONE]（理论不应发生）—— 容错按 done 收尾。
    callbacks.onDone();
  } catch (err) {
    // 🚨 中断判定用 signal.aborted，**不**匹配 error message（expo/fetch abort 抛
    // "Fetch request has been canceled" 不含 "Abort"）。
    if (controller.signal.aborted) {
      callbacks.onAborted();
      return;
    }
    callbacks.onError(err instanceof Error ? err.message : String(err));
  }
}

/** 按序派发帧；遇 done/error 返回 true（终态，调用方停止读流）。 */
function dispatchFrames(frames: IdeationFrame[], callbacks: IdeationStreamCallbacks): boolean {
  for (const frame of frames) {
    switch (frame.type) {
      case 'token':
        callbacks.onToken(frame.token);
        break;
      case 'suggestion':
        callbacks.onSuggestion(frame.suggestion);
        break;
      case 'tool_start':
        callbacks.onToolStart();
        break;
      case 'sources':
        callbacks.onSources(frame.sources);
        break;
      case 'notice':
        callbacks.onNotice(frame.notice);
        break;
      case 'done':
        callbacks.onDone();
        return true;
      case 'error':
        callbacks.onError(frame.error);
        return true;
    }
  }
  return false;
}
