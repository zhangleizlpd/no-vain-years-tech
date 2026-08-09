import type {
  Msg,
  ToolCall,
  LlmProvider,
  LlmStreamEvent,
  LlmStreamOptions,
} from './llm-provider.port.js';
import { msgText } from './llm-stream.rules.js';

/**
 * FakeLlmProvider (027 T005, plan Gate 0.1; 030 T004 扩 tool calling) — IT 确定性基石。
 *
 * 真 DeepSeek 流非确定 (token 化 / 时延 / 内容随机),IT 注入本替身得可复现的事件序列 +
 * 可注入故障,精确驱动 state_branches (失败不落 / 停止保留 / 断连 / 联网 loop)。通过 DI
 * override `LLM_PROVIDER` token 注入 (不 jest.mock)。
 *
 * 三种编排 (互斥优先级: script > content-driven > tokens):
 * - `tokens`  — 027 简单单轮:scripted token 序列, 每个吐成 `{kind:'token'}` (向后兼容)。
 * - `script`  — 030 多轮:一个 `FakeRound[]`, 逐轮按调用次数推进 (loop 每轮一次 stream):
 *     - `{ tokens: [...] }`     — 该轮吐若干 token 事件 (正文)。
 *     - `{ toolCall: {...} }`   — 该轮吐一个 `{kind:'tool_call'}` 事件 (模型决定检索)。
 *   驱动「第 1 轮 tool_call(web_search,query) → 第 2 轮 text」收敛 loop。**仅当调用方传了
 *   `opts.tools` 才吐 tool_call 轮**;未传 tools → tool_call 轮降级为空轮 (向后兼容铁律,
 *   与真 provider 一致:无 tools 永不吐 tool_call)。
 * - content-driven (030 T016 契约冒烟真 boot 用, 经 `CHAT_FAKE_LLM=1` env 注入路绑定) —
 *   `tokens` 模式但开 `webSearchKeyword`: env 注入路无法像 IT 那样 .overrideProvider 注 script,
 *   故按**入参内容**自决是否走联网 ReAct loop, 让契约冒烟在真全 boot 下也能驱动工具帧序列。
 *   触发判据 (三者皆需):① 调用方传了 `opts.tools`;② 最近一条 user message 内嵌 `webSearchKeyword`;
 *   ③ 本次 messages **尚未含 role:'tool' 回灌** (即检索结果还没喂回来) → 吐
 *   `{kind:'tool_call'}`(web_search, query=该 user 文本) 驱动一轮检索;一旦检索结果回灌
 *   (messages 出现 role:'tool') → 转吐 `tokens` 正文收敛。无 tools / 无关键字 → 维持纯 `tokens`
 *   行为 (向后兼容铁律: 既有 027/029 contract-smoke 默认行为零改变)。
 *
 * 故障注入 (两种编排通用, 作用于"当前轮"的 token 吐出):
 * - `errorAfter` — 吐出该数量 token 后抛 `FAKE_PROVIDER_ERROR`;0 = 首 token 前即抛。
 * - `delayMs`    — 每 token 前等待该毫秒数 (模拟慢流, 为停止/断连测留时窗)。
 *
 * 尊重 `opts.signal`: abort 即停止迭代 (含 delay 等待期间), 模拟真 provider 中断。
 */

/** 一轮 fake 输出:吐 token 序列 或 吐一个 tool_call (二选一)。 */
export type FakeRound = { tokens: string[] } | { toolCall: FakeToolCall };

/** scripted tool_call 形状 (FakeRound 内, 转成 port 的 ToolCall)。 */
export interface FakeToolCall {
  /** tool_call id (默认自动生成 `call_<round>`)。 */
  id?: string;
  name: string;
  /** function arguments 对象 (内部 JSON.stringify 成 ToolCall.function.arguments)。 */
  args: Record<string, unknown>;
}

export interface FakeLlmProviderConfig {
  /** 027 单轮 token 序列 (与 `script` 互斥, 二选一)。 */
  tokens?: string[];
  /** 030 多轮编排 (与 `tokens` 互斥);每次 stream 调用消费下一轮。 */
  script?: FakeRound[];
  /**
   * 030 T016 content-driven 联网触发关键字 (仅 `tokens` 模式叠加, 与 `script` 互斥)。
   * 设值后: 传 tools 且最近 user message 含此关键字且尚未回灌 tool 结果 → 吐 tool_call 驱动检索;
   * 否则 (含检索结果回灌后) 走 `tokens` 正文。未设 → 纯 `tokens` 行为 (向后兼容)。
   */
  webSearchKeyword?: string;
  /**
   * 031 T011 content-driven 系统提示回显关键字 (仅 `tokens` 模式叠加, 与 `script` 互斥)。
   * env 注入路 (CHAT_FAKE_LLM=1) 无法像 IT 那样 .overrideProvider 注 spy 捕获入参 messages,
   * 故契约冒烟靠**回显**验系统提示真组装: 设值后, 最近 user message 含此关键字且本次 messages
   * 含 `role:'system'` 段 (检索回灌前) → 把该 system 段内容**逐字符**吐成 token (落库 AI 正文 =
   * 系统提示原文) → node 层客户端读 GET messages 即可断言平台基座层 + 用户自定义层文本真注入。
   * 优先级低于 `webSearchKeyword` (联网回显在检索回灌后才命中, 见 shouldEchoSystem)。
   * 未设 / 无关键字 / 无 system 段 → 走 `tokens` 正文 (向后兼容铁律, 既有 027/029/030 行为不变)。
   */
  systemEchoKeyword?: string;
  errorAfter?: number;
  delayMs?: number;
}

export class FakeLlmProvider implements LlmProvider {
  /** script 编排下的轮次游标 (每次 stream 调用 +1)。 */
  private round = 0;

  constructor(private readonly config: FakeLlmProviderConfig) {}

  // port 契约统一签名;script 模式不读 messages, content-driven 模式按 messages 内容自决。
  async *stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    // content-driven (T016): tokens 模式 + 关键字 + tools + 关键字命中 + 尚未回灌 tool 结果
    // → 吐 tool_call 驱动一轮检索 (检索结果回灌后转吐正文收敛)。优先级低于 script。
    if (!this.config.script && this.shouldEmitToolCall(messages, opts)) {
      if (!opts.signal.aborted) {
        yield {
          kind: 'tool_call',
          calls: [toToolCall({ name: 'web_search', args: { query: latestUserText(messages) } }, 0)],
        };
      }
      return;
    }

    // 系统提示回显 (031 T011): tokens 模式 + 配了 systemEchoKeyword + 最近 user message 命中 +
    // 本次 messages 含 role:'system' 段 → 吐 system 段内容作正文 (落库 = 系统提示原文, 供契约
    // 冒烟黑盒断言平台基座 + 用户自定义层真组装)。检索回灌后 (含 role:'tool') 也命中, 故联网分支
    // 在工具结果回来后这一轮即回显已组装的 system 段。优先级低于 content-driven tool_call。
    if (!this.config.script) {
      const echo = this.systemEchoText(messages);
      if (echo !== null) {
        yield* this.streamTokens([echo], opts);
        return;
      }
    }

    const current = this.nextRound(opts);

    // tool_call 轮:仅当调用方传了 tools 才吐 (向后兼容铁律, 与真 provider 一致)。
    if ('toolCall' in current) {
      if (opts.tools && opts.tools.length > 0 && !opts.signal.aborted) {
        yield { kind: 'tool_call', calls: [toToolCall(current.toolCall, this.round)] };
      }
      return;
    }

    // token 轮:逐 token 吐 {kind:'token'}, 应用 errorAfter / delayMs / signal。
    yield* this.streamTokens(current.tokens, opts);
  }

  /**
   * content-driven 触发判据 (T016, 三者皆需):传了 tools + 配了 webSearchKeyword + 最近 user
   * message 命中关键字 + 本次 messages 尚未含 role:'tool' 回灌 (检索结果回来前)。命中 → 吐
   * tool_call 驱动检索;否则走 tokens 正文 (含检索回灌后收敛 + 兜底无 tools 收敛)。
   */
  private shouldEmitToolCall(messages: Msg[], opts: LlmStreamOptions): boolean {
    const kw = this.config.webSearchKeyword;
    if (kw === undefined || kw.length === 0) return false;
    if (!opts.tools || opts.tools.length === 0) return false;
    if (messages.some((m) => m.role === 'tool')) return false;
    return latestUserText(messages).includes(kw);
  }

  /**
   * 系统提示回显判据 (031 T011): 配了 systemEchoKeyword + 最近 user message 命中关键字 +
   * 本次 messages 含 `role:'system'` 段 → 返回该 system 段内容 (供 streamTokens 吐成正文);
   * 任一不满足 → null (走常规 tokens)。多个 system 段取首个 (send-message 仅 prepend 一条)。
   */
  private systemEchoText(messages: Msg[]): string | null {
    const kw = this.config.systemEchoKeyword;
    if (kw === undefined || kw.length === 0) return null;
    if (!latestUserText(messages).includes(kw)) return null;
    const sys = messages.find((m) => m.role === 'system');
    return sys ? msgText(sys.content) : null;
  }

  /**
   * 取本次 stream 调用对应的轮次:
   * - `script` 模式:返回 script[round++];越界 → 空 token 轮 (收敛, 不再吐)。
   * - `tokens` 模式:始终返回同一 token 轮 (027 单轮语义, 多次调用幂等)。
   */
  private nextRound(_opts: LlmStreamOptions): FakeRound {
    if (this.config.script) {
      const r = this.config.script[this.round];
      this.round += 1;
      return r ?? { tokens: [] };
    }
    return { tokens: this.config.tokens ?? [] };
  }

  private async *streamTokens(
    tokens: string[],
    opts: LlmStreamOptions,
  ): AsyncIterable<LlmStreamEvent> {
    const { errorAfter, delayMs } = this.config;

    for (let i = 0; i < tokens.length; i++) {
      // abort (含已 abort / 迭代途中 abort) → 立即停止,不再吐 token。
      if (opts.signal.aborted) return;

      // errorAfter=N: 已吐 N 个 token 后 (i===N) 抛出,模拟 provider 失败。
      if (errorAfter !== undefined && i === errorAfter) {
        throw new Error('FAKE_PROVIDER_ERROR: injected provider failure');
      }

      if (delayMs !== undefined && delayMs > 0) {
        const interrupted = await this.sleepOrAbort(delayMs, opts.signal);
        if (interrupted) return;
      }

      yield { kind: 'token', text: tokens[i] };
    }

    // 序列全部吐完后仍可能命中 errorAfter === tokens.length (吐完才失败)。
    if (errorAfter !== undefined && errorAfter === tokens.length && !opts.signal.aborted) {
      throw new Error('FAKE_PROVIDER_ERROR: injected provider failure');
    }
  }

  /**
   * 睡 ms 毫秒,期间若 signal abort 则提前 resolve(true)。返回是否被 abort 打断。
   * 复杂度 O(1) 定时器,abort 监听用 once 自清理避免泄漏。
   */
  private sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(true);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(false);
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** 取最近一条 user message 的 content (content-driven 关键字命中 + tool_call query 用);无则空串。 */
function latestUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return msgText(messages[i].content);
  }
  return '';
}

/** FakeToolCall → port ToolCall (args 序列化, id 兜底)。 */
function toToolCall(fc: FakeToolCall, round: number): ToolCall {
  return {
    id: fc.id ?? `call_${round}`,
    type: 'function',
    function: { name: fc.name, arguments: JSON.stringify(fc.args) },
  };
}
