# 027 RN 流式 PoC — 结论（2026-06-14）

> 喂给 `/speckit-plan`：移动端流式读取方案已 PoC 实证定稿（spec 跨契约 1 / Risk 第 1 条的硬约束解除）。PoC 代码 throwaway，已删。

## 验证矩阵（全过）

| 验证项                                                         | 方式                                 | 结果                                                                  |
| -------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| 服务端 Fastify raw SSE（`reply.hijack()` + `reply.raw.write`） | curl 本地                            | ✅ 逐 token drip，`[DONE]` 正常                                       |
| DeepSeek 接线（OpenAI 兼容 `stream:true`）                     | curl + 真 key                        | ✅ `data:{delta.content}` 中继成功                                    |
| **expo/fetch 增量渲染（Android #21710 风险）**                 | **Mate50 真机 adb 驱动 + screencap** | ✅ **无缓冲 bug，逐字浮现**                                           |
| 首 token 时延 TTFT                                             | Mate50 实测                          | 假流 **118ms** / DeepSeek 端到端 **518ms**（远低于 SC-001 的 p95≤3s） |
| POST + Authorization + JSON body 同时流式                      | Mate50                               | ✅                                                                    |
| AbortController 停止生成                                       | Mate50（点停止）                     | ✅ 流立即中断、内容冻结（chunks 停在 2）                              |

> 真机环境：Expo SDK 54 / RN 0.81.5 / dev-client / Mate50（CET-AL00, Android）/ adb USB / adb reverse 转发 server+Metro。

## 定稿架构（plan 直接采用）

1. **移动端** = `expo/fetch` 流式（`import { fetch } from 'expo/fetch'`，`response.body.getReader()` + `TextDecoder`，自切 `\n\n` 解 SSE 帧）。**首选确认，无需 react-native-sse 兜底**（Android 增量已实证 OK）。
2. **服务端** = Fastify 5 `reply.hijack()` + `reply.raw.writeHead(...SSE headers...)` + `reply.raw.write('data:…\n\n')`，消费 DeepSeek 流（`openai` SDK async iterable 或裸 fetch）。**不用** Nest `@Sse()`。
3. **停止生成** = 客户端 `AbortController.abort()`；服务端 `reply.raw.on('close', () => upstreamAbort())` 取消上游、止付 token。
4. **DeepSeek** = `baseURL=https://api.deepseek.com`，`model=deepseek-chat`，key 在 server `.env`（`DEEPSEEK_API_KEY`，已在位）。

## impl 必带 gotcha（PoC 现场踩出）

- **中断检测**：expo/fetch abort 抛的 error message = `"Fetch request has been canceled"`（**不含** "Abort"）。判中断用 `controller.signal.aborted` 或 `e.name`，**别匹配 message 字符串**（否则误归类成 error 而非 stopped）。
- **SSE 必关压缩/缓冲**：响应头带 `X-Accel-Buffering: no` + `Cache-Control: no-cache, no-transform`；若日后加 `@fastify/compress` 须排除 `text/event-stream`；nginx（prod 前置）须 `proxy_buffering off`——否则 token 憋到末尾一次性到。
- **`reply.hijack()`** 必加，否则 Fastify 二次 finalize 响应。
- **CORS**：跨端开发期 PoC server 加宽松 CORS；prod 走同 server 不涉及。

## 对 spec 的影响

- spec Risk「RN fetch 不支持流式」→ **已消除**（expo/fetch 实证可用，无 Android 缓冲）。
- SC-001 TTFT p95≤3s → 实测 DeepSeek 518ms，预算宽裕。
- 不引入 `react-native-sse` 依赖（兜底未触发）。
