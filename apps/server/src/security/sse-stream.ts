import type { FastifyReply } from 'fastify';

/**
 * `reply.hijack()` 裸写 SSE 的 server 级 helper —— headers / abort / lazy hijack 三件
 * (ADR-0055 sunset trigger「出现第二个流式端点」: chat-stream + ideation clarify-stream)。
 * 帧格式与落库仍归各 ctx 自己的 `*sse.rules.ts` / use case, 本文件不碰业务语义。
 */

/**
 * 从 Fastify reply 已有 header 里挑出 `@fastify/cors` 写的跨域 header (`access-control-*` + `vary`),
 * 转成 writeHead 可用形态。SSE 走 reply.hijack() 裸写, 必须手动带这批 header, 否则 web build
 * 流式响应缺 `Access-Control-Allow-Origin` 被浏览器拦 (preflight 由 plugin 独立处理故能过)。
 * allowlist 判定仍由 plugin 负责, 不在此重复策略 (server-sse-hijack-cors rule)。
 */
export function pickCorsHeaders(
  headers: Record<string, number | string | string[] | undefined>,
): Record<string, number | string | string[]> {
  const picked: Record<string, number | string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith('access-control-') || lower === 'vary') picked[key] = value;
  }
  return picked;
}

export interface LazySseStream {
  /** 客户端断连 / 主动停止 (end 之前的 close) → aborted; 透传 UC → provider 止付上游。 */
  readonly signal: AbortSignal;
  /** 是否已 hijack。false 时前置校验异常应原样抛回 Nest ProblemDetailFilter。 */
  readonly started: boolean;
  /** 写一帧; 首帧时才 hijack + writeHead。 */
  write(frame: string): void;
  /** 写末帧 ([DONE] / error 帧) 并收尾; 未开流时同样先 hijack。 */
  end(lastFrame: string): void;
}

/**
 * lazy hijack: 仅在首帧 (或末帧) 时 hijack + writeHead, 故 UC 的前置校验异常 (scope 404 /
 * 空输入 400) 在 hijack **之前**抛出 → 走 Nest ProblemDetailFilter 正常 JSON 响应 (与 GET
 * 端点字节级一致, 反枚举); 流一旦开始则永远 SSE。
 */
export function openLazySseStream(reply: FastifyReply): LazySseStream {
  // reply.raw 'close' 在 end() 后也会触发, 用 finished 哨兵区分: 正常结束不视作 stop。
  const controller = new AbortController();
  let finished = false;
  reply.raw.on('close', () => {
    if (!finished) controller.abort();
  });

  let hijacked = false;
  const ensureHijacked = () => {
    if (hijacked) return;
    hijacked = true;
    // @fastify/cors 在 onRequest hook 里按 allowlist 把 `Access-Control-*` / `Vary` 写到了
    // reply 上。reply.hijack() 脱离 Fastify reply 生命周期 → 这些 header 不会随裸 writeHead
    // 流出, 故把 cors 已算好的 header 带进 writeHead。
    const corsHeaders = pickCorsHeaders(reply.getHeaders());
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    });
  };

  return {
    signal: controller.signal,
    get started() {
      return hijacked;
    },
    write(frame) {
      ensureHijacked();
      reply.raw.write(frame);
    },
    end(lastFrame) {
      ensureHijacked();
      finished = true;
      reply.raw.write(lastFrame);
      reply.raw.end();
    },
  };
}
