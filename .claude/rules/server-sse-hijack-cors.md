---
paths:
  - 'apps/server/src/**/*.controller.ts'
---

# SSE / `reply.hijack()` 端点必须手动带 CORS 头（path-triggered，改 server controller 自动加载）

> **仅当端点用 `reply.hijack()` 裸写响应（SSE / `text/event-stream` / 流式）时适用** —— 普通 JSON 端点请忽略本条（Nest/Fastify 正常响应链自带 CORS）。

## 硬性 invariant

`reply.hijack()` 脱离 Fastify reply 生命周期 → `@fastify/cors`（默认 `onRequest` hook，已在 handler 前把 `Access-Control-Allow-Origin` / `Vary` 写到 reply 上）的头**不随裸 `reply.raw.writeHead()` 流出**。症状：浏览器 web 端 preflight（OPTIONS）过 204，但实际流被 CORS 拦读（`net::ERR_FAILED`，无 `Access-Control-Allow-Origin`）。

> **真机 native fetch（okhttp / CFNetwork）不走 CORS 故不暴露 —— 「真机正常、web 坏」先想这条。**

**MUST**：新 SSE 端点一律走 `apps/server/src/security/sse-stream.ts` 的 `openLazySseStream(reply)`，不在 controller 里自写 `reply.hijack()` / `writeHead`。helper 在 hijack 前把 cors 已算好的头（`pickCorsHeaders`：`access-control-*` + `vary`）并入 `writeHead`，并收口 lazy hijack 与断连 abort：

```ts
const stream = openLazySseStream(reply); // 首帧 / 末帧时才 hijack + writeHead(SSE 头 + cors 头)
// UC 回调里 stream.write(frame)；前置异常 `if (!stream.started) throw err`；收尾 stream.end(lastFrame)
```

allowlist 判定仍由 `@fastify/cors` 负责，**不在 controller 重复跨域策略**。用法样板 = `apps/server/src/chat/chat-stream.controller.ts` / `apps/server/src/ideation/clarify-stream.controller.ts`。

## 回归测试

新 SSE 端点的 IT **必须显式 `app.register(fastifyCors, ...)`**（CORS 在 `main.ts` 注册、不在 `AppModule`，IT 默认无 cors），再带 `Origin` 发请求、断言响应头回显 Origin。先例 = `apps/server/test/integration/chat-streaming.it.spec.ts` 测 ⑨ / `ideation-clarify-turn.it.spec.ts` 测 ⑩。

## 相关

[ADR-0055](../../docs/adr/0055-chat-ctx-sse-streaming-llm-provider.md) §2 确立 `reply.hijack()` SSE 范式（headers / abort / split-tx 落库三件套）；CORS 头是其 headers 件的硬约束。第二个流式端点（ideation clarify-stream）出现后已按 ADR-0055 sunset trigger 抽成 server 级 helper（headers / abort / lazy hijack）；split-tx 落库是业务语义，仍留各 ctx use case。
