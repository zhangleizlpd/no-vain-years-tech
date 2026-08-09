/**
 * LlmProvider port (027 T005, plan D7) — chat ctx 大模型流式出口的 vendor I/O 抽象。
 *
 * external vendor I/O 是 ADR-0043 允许的 port/adapter 场景 (sms / push gateway 同款,
 * 非自有表 repository)。provider-agnostic: DeepSeek 仅是 `LlmProvider` 的一个实现
 * (`deepseek.provider.ts`); 二期接 MiniMax 仅加新实现,不动 send-message UC 调用方。
 *
 * 实现:
 * - DeepseekProvider — 生产默认绑定 (OpenAI 兼容 `openai` SDK + baseURL, key 仅 server env)。
 * - FakeLlmProvider  — IT 确定性替身 (scripted token + 可注入 error/delay, 尊重 signal)。
 *
 * 测试用真 DI 容器 override 此 token 注入 FakeLlmProvider, 不 jest.mock
 * (per plan Architecture Notes「NO LIFECYCLE MOCKING」)。
 */
/**
 * 模型决定调用的工具调用 (OpenAI function-calling 兼容形状, 030 D3)。
 * `arguments` 是 JSON 字符串 (模型分片吐出, provider 累加拼接后整体交付);
 * 回灌历史时 assistant 消息携带本数组、对应 tool 消息以 `toolCallId` 配对结果。
 *
 * 058 (ADR-0058): LLM wire-format 类型从 chat/chat-context.rules 上移至本 port —
 * `Msg`/`ToolCall` 是「喂 LLM 的消息契约」, 归 integrations/llm 平台层 (chat / ideation
 * 双消费方经此 port 共享); chat-context.rules 反向 import + 复出保 chat 内部消费零改。
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * 多模态 content part (036 T004) — OpenAI vision content parts 形状, 严格对齐
 * `chat.completions` 的 `ChatCompletionContentPart`。`toApiMessages` 数组形态时原样透传。
 * - `{type:'text', text}`               — 文本片段 (含 SoM 编号合成文字)。
 * - `{type:'image_url', image_url:{url}}` — 图片 (OSS public URL 或 `data:` base64)。
 */
export type MsgPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * 喂给 LLM 的单条消息最小形状 (与 send-message UC 的 messages[] 对齐)。
 *
 * 027 仅 user/assistant 纯文本。030 D3 扩展支持 tool calling 回灌:
 * - `role:'system'`  — D8 可组合系统提示 (联网 steering + 日期 context), 置于 history 之前。
 * - `role:'tool'`    — 工具执行结果回灌, 必带 `toolCallId` 与触发它的 assistant tool_call 配对。
 * - assistant 可携带 `toolCalls` — 模型该轮决定的工具调用 (回灌时让模型看到自己上轮调了什么)。
 *
 * 向后兼容: 非联网路径只产 user/assistant 纯文本, 不带 toolCalls/toolCallId → 行为同 027。
 *
 * 036 T004 多模态: `content` 由 `string` 扩为 `string | MsgPart[]` (OpenAI vision content
 * parts)。**向后兼容铁律 (SC-005)**: 纯文本路径仍传 `string` = 旧形状,行为零回归
 * (`toApiMessages` 对 string 维持旧映射);带图轮传 `MsgPart[]` → 原样透传 image_url+text part。
 */
export interface Msg {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | MsgPart[];
  /** assistant 该轮决定的工具调用 (仅 role:'assistant' 联网轮回灌时携带)。 */
  toolCalls?: ToolCall[];
  /** 工具结果消息配对的 tool_call id (仅 role:'tool' 携带)。 */
  toolCallId?: string;
}

/** DI token — send-message UC 注入 `LlmProvider` 接口而非具体类 (便于 IT override)。 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * 工具定义 (OpenAI function-calling 兼容形状, 030 D3) — 调用方 (send-message 联网分支)
 * 经 `LlmStreamOptions.tools` 附给 provider, 模型自决是否调用 (`tool_choice:'auto'`)。
 * `web_search.rules.WEB_SEARCH_TOOL` 是唯一实例;形状刻意宽松 (parameters 任意对象),
 * 与 openai SDK 的 `ChatCompletionTool` 结构对齐, provider 透传即可。
 */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * stream 调用选项 — `signal` 透传上游 provider, abort 时止付 token (停止/断连语义);
 * `model` 是**逻辑** model id (029 D6: flash | pro), 由 send-message 按 conversation.model
 * 路由传入, provider 边界再把逻辑名映射到真实 vendor model id (deepseek.provider:
 * flash→deepseek-v4-flash / pro→deepseek-v4-pro)。调用方只认逻辑名, 二期换 provider
 * 不动 send-message。
 *
 * `tools` (030 D3, 可选): 附则模型可自决调用 (`tool_choice:'auto'`)。**未传 → provider
 * 永不吐 `tool_call` 事件, 行为同 027 (纯 token 流)** —— 向后兼容铁律。
 */
export interface LlmStreamOptions {
  signal: AbortSignal;
  /** 逻辑 model id (flash | pro); provider 内部映射到真实 vendor model。 */
  model: string;
  /** 030 D3: 联网分支附 `web_search` 工具;未传 → 纯 token 流 (027 行为零回归)。 */
  tools?: ToolDef[];
}

/**
 * 流式补全产出的事件 (030 D3) — 027 的 `AsyncIterable<string>` 升级为事件联合, 以承载
 * tool calling。向后兼容: 无 `tools` 时 provider 只吐 `{kind:'token'}`, 调用方解构 `.text`
 * 等价于旧的纯字符串流。
 * - `{kind:'token', text}`        — 一段正文 token (累加为最终答案)。
 * - `{kind:'tool_call', calls}`   — 模型该轮决定调用的工具 (一或多个), arguments 已累加完整。
 */
export type LlmStreamEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call'; calls: ToolCall[] };

export interface LlmProvider {
  /**
   * 流式补全: 喂多轮上下文 `messages` (oldest→newest, 由 chat-context.rules 组), 逐事件吐出。
   * `opts.signal` abort → 停止迭代并中断上游 HTTP。`opts.tools` 未传 → 只吐 `{kind:'token'}`
   * (027 行为零回归);传 tools 且模型决定调用 → 吐 `{kind:'tool_call'}` 收口该轮。
   */
  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent>;
}
