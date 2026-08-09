import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import {
  buildContext,
  DEFAULT_CONTEXT_BUDGET,
  type Msg,
  type ToolCall,
} from './chat-context.rules';
import { deriveTitle, EMPTY_TITLE_FALLBACK } from './chat-title.rules';
import { AVAILABLE_MODEL_IDS, DEFAULT_CHAT_MODEL } from './list-models.usecase';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type ToolDef,
} from '../integrations/llm/llm-provider.port';
import { SEARCH_PROVIDER, type SearchProvider, type SearchResult } from './search-provider.port';
import {
  dedupAndNumber,
  DEFAULT_TOP_K,
  topK,
  WEB_SEARCH_TOOL,
  type NumberedSource,
} from './web-search.rules';
import { composeSystemPrompt } from './system-prompt.rules';
import { GetChatPreferenceUseCase } from './get-chat-preference.usecase';

/**
 * 把会话落库的 model 值归一化为有效逻辑 model (flash | pro), 传给 LlmProvider 路由
 * (029 D6/D7)。已落库会话读 conversation.model; 历史/legacy 值 (deepseek-chat 等,
 * 027 旧默认) 或未知值兜底默认 flash (spec edge case「会话历史含旧/未知 model 值」+
 * D7 默认 flash)。provider 边界再把逻辑名映射到真实 v4 model id (F1)。
 */
function normalizeLogicalModel(raw: string): string {
  return AVAILABLE_MODEL_IDS.includes(raw) ? raw : DEFAULT_CHAT_MODEL;
}

/**
 * 流式发消息编排 (027 T007, plan D3) — chat 叶子 ctx, 扁平 + 贫血 + 直注 PrismaService。
 *
 * 流程 (plan D3 / Clarify 落库语义):
 *   ① scope 校验 conversation 归属本 accountId → 他人/不存在 404 字节级一致 (反枚举,
 *      与 GetMessagesUseCase 同款; 非数字 id 在 controller 折叠 404)。
 *   ② 校验 content 非空 (纯空白拒 → 400; user msg 不落)。
 *   ③ 落 user message 即时 (status=completed; FR-006 落了就不丢, 即便后续失败)。
 *   ④ 首条消息 → deriveTitle 派生标题覆盖默认「新对话」(FR-013; 已有非默认 title 不覆盖)。
 *   ⑤ 取本会话历史 → buildContext token 预算窗口组 messages[] (含刚落的 user msg)。
 *   ⑥ LlmProvider.stream(messages, {signal}) 逐 token → onToken 回调 (controller 写 SSE 帧)
 *      + 累加到 acc。
 *   ⑦ 终态分流 (split-tx, 流式期间不开 tx, 落库是流前/流后独立短写):
 *      - 正常结束     → 落 AI msg status=completed, 返回 {kind:'completed'}。
 *      - 停止 (abort) → 落已生成半成品 AI msg status=stopped (FR-008 保留), 返回 {kind:'stopped'}。
 *                       判据: provider 迭代结束后 signal.aborted 为真 (客户端断连/主动停止)。
 *      - provider 失败 → **不落 AI msg** (无 failed 占位, FR-009), 返回 {kind:'error'};
 *                       user msg 已落不丢, controller 写 error 帧让客户端重试。
 *
 * 注: onToken 是 HTTP-agnostic 回调 (controller 注入), UC 不碰 reply/raw, 仅驱动 token 流;
 * 终态由返回的 SendMessageOutcome 描述, controller 据此写 DONE / error 帧 + end()。
 */

/** 发消息终态 — controller 据此写最终 SSE 帧。 */
export type SendMessageOutcome =
  | { kind: 'completed'; aiMessageId: bigint }
  | { kind: 'stopped'; aiMessageId: bigint }
  | { kind: 'error'; message: string };

export interface SendMessageParams {
  accountId: bigint;
  conversationId: bigint;
  content: string;
  /** controller 持有的 AbortSignal (reply.raw 'close' → abort), 透传 provider 止付 token。 */
  signal: AbortSignal;
}

/**
 * 联网分支的工具/来源/降级帧回调 (030 D4/D5) —— controller 注入, 据此写对应 SSE 帧。
 * HTTP-agnostic (UC 不碰 reply);非联网路径不调用任何回调 (027 行为零回归)。
 */
export interface WebSearchCallbacks {
  /** 模型自决发起一轮检索 → controller 写 tool_start 帧 (query)。 */
  onToolStart: (query: string) => void;
  /** 一轮检索完成 → controller 写 tool_result 帧 (count=原始页数, sources=摘要)。 */
  onToolResult: (count: number, sources: { title: string; url: string }[]) => void;
  /** 检索失败降级 (FR-009) → controller 写 degraded 帧。 */
  onDegraded: () => void;
  /** 收尾前完整编号来源 → controller 写 sources 帧 (FR-007)。 */
  onSources: (sources: NumberedSource[]) => void;
}

/** ReAct loop 最大检索轮数 (plan 调参锁定, FR-010)。 */
const MAX_SEARCH_ROUNDS = 3;

/**
 * 持久化在 Message.metadata 的联网作答元数据 (贫血 JSON narrow, plan D6; 030 A1 改造)。
 *
 * A1 amend (T019): 联网恒开后 `webSearch` 字段恒 true 冗余 → 改记 `searched` (本条作答是否
 * 实际发生了 web_search tool_call)。三态可分: 凭知识答 (searched=false) / 搜了但零结果
 * (searched=true,sources=[],degraded=false) / 搜到来源 (searched=true,sources≠[])。
 */
export interface MessageMetadata {
  /** 本条作答是否实际触发了 web_search 检索 (模型自决调过 tool → true)。 */
  searched: boolean;
  degraded: boolean;
  sources: NumberedSource[];
}

/** web_search 工具定义 (附给联网分支 LlmProvider.stream)。 */
const WEB_SEARCH_TOOLS: ToolDef[] = [WEB_SEARCH_TOOL as unknown as ToolDef];

/** 从 tool_call.function.arguments (JSON 字符串) 解析 query;解析失败兜底空串。 */
function extractQuery(call: ToolCall): string {
  try {
    const args = JSON.parse(call.function.arguments) as { query?: unknown };
    return typeof args.query === 'string' ? args.query : '';
  } catch {
    return '';
  }
}

/** provider 抛错统一取 message (兜底常量)。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'LLM_PROVIDER_ERROR';
}

/** ReAct loop 跨轮可变累加态 (内存, split-tx loop 期间无 DB 写)。 */
interface LoopState {
  /** 喂模型的对话 (随轮回灌 assistant/tool 消息增长)。 */
  messages: Msg[];
  /** 累加的最终答案文本。 */
  acc: string;
  /** 去重编号后的累计来源 (FR-006)。 */
  sources: NumberedSource[];
  /** 检索失败降级标识 (FR-009);零结果不置位。 */
  degraded: boolean;
  /** 本次作答是否实际发生过 web_search tool_call (模型自决调过 → metadata.searched)。 */
  searched: boolean;
  /** 调过工具但未在带 tools 轮自然收敛 → 需兜底无 tools 收敛一次 (max-out / 降级)。 */
  pendingFinalize: boolean;
}

/** 序列化检索结果喂回模型 (tool message content);仅 title/url/snippet/content/publishedAt。 */
function serializeResults(results: SearchResult[]): string {
  return JSON.stringify(
    results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      ...(r.content !== undefined ? { content: r.content } : {}),
      ...(r.publishedAt !== undefined ? { publishedAt: r.publishedAt } : {}),
    })),
  );
}

@Injectable()
export class SendMessageUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    @Inject(SEARCH_PROVIDER) private readonly search: SearchProvider,
    // 031 D3: 同 chat ctx 读偏好 (R1 同 ctx, 非跨业务 ctx — 无 moat 注释要求)。
    private readonly getChatPreference: GetChatPreferenceUseCase,
  ) {}

  async execute(
    params: SendMessageParams,
    onToken: (token: string) => void,
    callbacks?: WebSearchCallbacks,
  ): Promise<SendMessageOutcome> {
    const { accountId, conversationId, content, signal } = params;

    // ① scope 校验归属: 查不到本人的 conversation 即 404 (他人/不存在不可区分, 反枚举)。
    //    读 model 用于路由 (029 D6): 已落库会话的 conversation.model 决定 flash/pro。
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true, title: true, model: true },
    });
    if (!conversation) {
      throw new NotFoundException('CONVERSATION_NOT_FOUND');
    }

    // ② content 非空校验 (纯空白 → 400; user msg 不落)。
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('CHAT_EMPTY_CONTENT');
    }

    // ③ 落 user message 即时 (FR-006)。
    await this.prisma.message.create({
      data: { conversationId, role: 'user', content, status: 'completed' },
    });

    // ④ 首条消息 → 派生标题 (仅当 title 仍为默认兜底; 已有自定义 title 不覆盖)。
    if (conversation.title === EMPTY_TITLE_FALLBACK) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { title: deriveTitle(content) },
      });
    }

    // ⑤ 取本会话历史 (含刚落的 user msg) → token 预算窗口组 messages[]。
    const history = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true },
    });
    const context = buildContext(
      history.map((m) => ({ role: m.role as Msg['role'], content: m.content })),
      DEFAULT_CONTEXT_BUDGET,
    );

    // 按 conversation.model 路由逻辑 model (029 D6; legacy/未知值归一化默认 flash)。
    const model = normalizeLogicalModel(conversation.model);

    // ⑥ 系统提示组装上提 (031 D3): 在 loop 前读本 accountId 自定义指令 → composeSystemPrompt →
    //    prepend system 消息。平台基座层恒非 null → 每条发送恒带 system。短读在 stream tx 外
    //    (split-tx)。A1 amend: 联网恒开 → steering/date 两层默认常带; 平台层 + 用户层与之正交。
    const { customInstruction } = await this.getChatPreference.execute(accountId);
    const systemPrompt = composeSystemPrompt({
      webSearch: true,
      now: new Date(),
      locale: 'zh-CN',
      userCustomInstruction: customInstruction,
    });
    const messages: Msg[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...context]
      : [...context];

    // ⑦ 统一 ReAct loop (A1 amend, T019): 去 webSearch gate —— 所有会话/模型默认走联网 loop
    //    (附 web_search 工具 + tool_choice:'auto', 模型自决检索)。模型不调 tool → 首轮 text
    //    收敛 = 等价旧单轮 (零成本路径)。split-tx: 流式编排全程 tx 外, 落库是流前/流后独立短写。
    return this.runWebSearchLoop({ conversationId, model, messages, signal }, onToken, callbacks);
  }

  /**
   * 联网 ReAct loop (plan D4) —— split-tx, 全程 tx 外多次 stream + search HTTP, 中间结果内存累加。
   *
   *   1. system 提示已由 execute() 上提 prepend (031 D3: 平台基座 + 联网 steering + 日期 + 用户层)。
   *   2. for round 1..MAX_SEARCH_ROUNDS: stream(附 web_search 工具) →
   *      - token → onToken + 累加 acc。
   *      - tool_call → 写 tool_start 帧 + SearchProvider.search(top-K 5) + 写 tool_result 帧 +
   *        去重编号累加 sources + 回灌 assistant(toolCalls)/tool(result) → 续轮。
   *      - 无 tool_call → 收敛 break (该轮 token 即最终答案)。
   *   3. 兜底 (FR-010 max-out 仍要检索 / FR-009 降级): 不再附 tools 最后一次 stream 收敛作答。
   *   4. 降级: 任一 search throw (非 abort) → degraded=true + 停检索 + 走兜底无 tools 收敛;
   *      零结果不标 degraded; user msg 已落不丢。
   *   5. abort: 透传 signal 止付 token + 取消在途检索 → status=stopped, 半成品 + 已检索 sources 保留。
   */
  private async runWebSearchLoop(
    ctx: { conversationId: bigint; model: string; messages: Msg[]; signal: AbortSignal },
    onToken: (token: string) => void,
    callbacks?: WebSearchCallbacks,
  ): Promise<SendMessageOutcome> {
    const { conversationId, model, messages, signal } = ctx;

    // system 提示已在 execute() 上提组装并 prepend (031 D3): 含平台基座 + 联网 steering +
    // 日期 + 用户自定义层, 置于 history 之前 / token 窗口之外。loop 直接用传入的 messages。
    const state: LoopState = {
      messages,
      acc: '',
      sources: [],
      degraded: false,
      searched: false,
      pendingFinalize: false,
    };

    // ② 带 tools 的检索轮 (max 3) → 收敛 / 降级 / max-out;provider 真失败 → 提前返 error。
    const roundsError = await this.runSearchRounds({ model, signal, state, callbacks }, onToken);
    if (roundsError) return roundsError;

    // ③ 兜底无 tools 收敛 (FR-010 max-out 仍要检索 / FR-009 降级未收敛)。abort 时跳过。
    if (state.pendingFinalize && !signal.aborted) {
      try {
        for await (const event of this.provider.stream(messages, { signal, model })) {
          if (event.kind === 'token') {
            state.acc += event.text;
            onToken(event.text);
          }
        }
      } catch (err) {
        if (!signal.aborted) return { kind: 'error', message: errMessage(err) };
      }
    }

    const { acc, sources, degraded, searched } = state;
    // ④ 收尾前写完整编号来源帧 (有来源才写)。
    if (sources.length > 0) callbacks?.onSources(sources);

    // ⑤ 终态: 落 assistant msg + metadata (abort → stopped 半成品 + 已检索 sources 保留)。
    return this.finalizeAssistant(conversationId, acc, signal, {
      searched,
      degraded,
      sources,
    });
  }

  /**
   * 带 tools 的检索轮循环 (max MAX_SEARCH_ROUNDS): 每轮 stream → token/tool_call;
   * 无 tool_call 收敛 break;有则执行检索 (改写 state) 续轮;降级/abort 停。改写 state.acc/
   * sources/degraded/pendingFinalize。返回非空 = provider 真失败 (调用方据此提前返 error,
   * 不落 AI msg);返回 undefined = 正常 (含收敛/降级/abort, 由调用方走兜底+终态)。
   */
  private async runSearchRounds(
    ctx: {
      model: string;
      signal: AbortSignal;
      state: LoopState;
      callbacks?: WebSearchCallbacks;
    },
    onToken: (token: string) => void,
  ): Promise<SendMessageOutcome | undefined> {
    const { model, signal, state, callbacks } = ctx;
    for (let round = 1; round <= MAX_SEARCH_ROUNDS; round++) {
      if (signal.aborted) return undefined;

      let toolCalls: ToolCall[] | null;
      let roundContent: string;
      try {
        ({ toolCalls, content: roundContent } = await this.streamRound(
          { messages: state.messages, model, signal, tools: WEB_SEARCH_TOOLS },
          (t) => {
            state.acc += t;
            onToken(t);
          },
        ));
      } catch (err) {
        // abort 引起的中断不算 error (走 stopped 终态); 否则 provider 真失败 → error。
        if (signal.aborted) return undefined;
        return { kind: 'error', message: errMessage(err) };
      }
      if (signal.aborted) return undefined;

      // 无 tool_call → 模型收敛, 该轮 token 即最终答案 (无需兜底再 stream)。
      if (!toolCalls || toolCalls.length === 0) {
        state.pendingFinalize = false;
        return undefined;
      }

      // 模型决定检索 → 标记 searched + 回灌 assistant(toolCalls) + 逐 call 执行 search (改写 state)。
      state.searched = true;
      state.messages.push({ role: 'assistant', content: roundContent, toolCalls });
      const aborted = await this.executeSearches(toolCalls, signal, state, callbacks);
      if (aborted || signal.aborted) return undefined;

      // 调过工具 → 需后续模型作答; 降级 → 停检索走兜底; 否则续下一轮 (max 3)。
      state.pendingFinalize = true;
      if (state.degraded) return undefined;
    }
    return undefined;
  }

  /**
   * 跑一轮带 tools 的 stream: 逐 token onToken + 累加 roundContent, 收口该轮 tool_calls。
   * 返回该轮正文与 tool_calls (无则 null → 调用方据此判收敛)。throw 透传给调用方分流 (abort vs error)。
   */
  private async streamRound(
    opts: { messages: Msg[]; model: string; signal: AbortSignal; tools: ToolDef[] },
    onToken: (token: string) => void,
  ): Promise<{ content: string; toolCalls: ToolCall[] | null }> {
    const { messages, model, signal, tools } = opts;
    let content = '';
    let toolCalls: ToolCall[] | null = null;
    for await (const event of this.provider.stream(messages, { signal, model, tools })) {
      if (event.kind === 'token') {
        content += event.text;
        onToken(event.text);
      } else if (event.kind === 'tool_call') {
        toolCalls = event.calls;
      }
    }
    return { content, toolCalls };
  }

  /**
   * 逐 tool_call 执行检索 (改写 state.sources/degraded + 回灌 tool 消息 + 触发回调)。
   * 返回是否因 abort 中断 (调用方据此停 loop, abort 不标 degraded)。
   * - 成功: topK 截取 + onToolResult(原始页数, 摘要) + dedupAndNumber 累加 + 回灌 tool 结果。
   * - search throw (非 abort): degraded=true + onDegraded + 回灌失败标记, 停后续 call (FR-009)。
   */
  private async executeSearches(
    toolCalls: ToolCall[],
    signal: AbortSignal,
    state: LoopState,
    callbacks?: WebSearchCallbacks,
  ): Promise<boolean> {
    for (const call of toolCalls) {
      const query = extractQuery(call);
      callbacks?.onToolStart(query);
      let results: SearchResult[];
      try {
        results = await this.search.search(query, { signal, maxResults: DEFAULT_TOP_K });
      } catch (err) {
        // abort 引起的检索取消不标 degraded (停止生成语义); 真失败 → 降级。
        if (signal.aborted) return true;
        void err;
        state.degraded = true;
        callbacks?.onDegraded();
        state.messages.push({ role: 'tool', content: 'SEARCH_FAILED', toolCallId: call.id });
        return false;
      }
      const top = topK(results, DEFAULT_TOP_K);
      // count = 本轮原始页数 (贴「已阅读 N」语义, 可 > 去重来源数, F3)。
      callbacks?.onToolResult(
        results.length,
        top.map((r) => ({ title: r.title, url: r.url })),
      );
      state.sources = dedupAndNumber(state.sources, top);
      state.messages.push({ role: 'tool', content: serializeResults(top), toolCallId: call.id });
    }
    return false;
  }

  /**
   * 落 assistant message 终态短写 (split-tx 流后段)。abort → stopped 半成品; 否则 completed。
   * A1 amend: loop 是唯一作答路径 → assistant msg 恒带 metadata (searched/degraded/sources);
   * user msg 仍无 metadata (null), 旧消息亦 null (加性可空, 读取不破)。
   */
  private async finalizeAssistant(
    conversationId: bigint,
    content: string,
    signal: AbortSignal,
    metadata: MessageMetadata,
  ): Promise<SendMessageOutcome> {
    const status = signal.aborted ? 'stopped' : 'completed';
    const aiMessage = await this.prisma.message.create({
      data: {
        conversationId,
        role: 'assistant',
        content,
        status,
        // Prisma Json? 列要求 InputJsonValue (带索引签名); MessageMetadata 是闭合接口,
        // 内容均 JSON-safe (boolean/number/string/array), 安全断言为 Prisma JSON 输入。
        metadata: metadata as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return status === 'stopped'
      ? { kind: 'stopped', aiMessageId: aiMessage.id }
      : { kind: 'completed', aiMessageId: aiMessage.id };
  }
}
