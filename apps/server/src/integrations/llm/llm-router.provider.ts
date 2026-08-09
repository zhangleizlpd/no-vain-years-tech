import type { Msg, LlmProvider, LlmStreamEvent, LlmStreamOptions } from './llm-provider.port.js';

/**
 * RoutingLlmProvider (029 收口) — 按逻辑 model 把流式委托给具体 vendor provider。
 *
 * 实现 `LlmProvider` 接口本身 (装饰者/委托), 故 send-message UC 仍只注入单个
 * `LLM_PROVIDER`、调用 `stream(messages, {signal, model})` 不变 (port 注释承诺的
 * 「二期接 MiniMax 仅加新实现, 不动 send-message UC 调用方」)。
 *
 * 路由表 (按 opts.model 逻辑名):
 *   - 'minimax'            → MinimaxProvider (MiniMax M3)
 *   - 'flash' / 'pro' / 其他 → DeepseekProvider (v4 双模式; 未知值已在 send-message
 *                             normalizeLogicalModel 兜底成 flash, 故默认 DeepSeek 安全)
 *
 * 复杂度: O(1) 选择 + 透传委托 (无额外 I/O)。
 */
export class RoutingLlmProvider implements LlmProvider {
  constructor(
    private readonly deepseek: LlmProvider,
    private readonly minimax: LlmProvider,
  ) {}

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    // opts (含 030 tools) 整体透传委托 — 路由不变, tool 事件由具体 provider 决定
    // (DeepSeek 透传 tools 可吐 tool_call;MiniMax 忽略 tools 永远只吐 token)。
    const delegate = opts.model === 'minimax' ? this.minimax : this.deepseek;
    return delegate.stream(messages, opts);
  }
}
