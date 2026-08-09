import type {
  Msg,
  ToolCall,
  LlmProvider,
  LlmStreamEvent,
  LlmStreamOptions,
} from '../integrations/llm/llm-provider.port.js';
import {
  TOOL_ASK_CLARIFYING_QUESTION,
  TOOL_CODEINDEX_RETRIEVAL,
  TOOL_EMIT_REQUIREMENTS_BRIEF,
} from './ideation-tools.js';

/**
 * FakeIdeationLlmProvider (032 T006, plan Gate 0.1 / 契约 doc §7) —— ideation 两相剧本的
 * 确定性 LLM 替身。**实现 `LlmProvider` port** (照 `integrations/llm/fake-llm.provider.ts`
 * 的 port 形状), 但驱动 ideation 自己的两相剧本 —— 与 chat 的 fake 是**两个不同 fake**
 * (chat 走 web_search ReAct loop, ideation 走访谈相 ask_clarifying_question + 产出相
 * emit_requirements_brief)。本 fake 放 ideation ctx, 经自有开关 `IDEATION_FAKE_LLM`
 * 装配 (非 chat 的 `CHAT_FAKE_LLM`)。
 *
 * IT 经 DI `.overrideProvider(LLM_PROVIDER)` 注入 scripted 实例驱动 state_branches
 * (访谈轮出问题 ± chips / 产出轮出 brief / 降级吐纯文本 / abort 中断), 不 jest.mock
 * (per plan「NO LIFECYCLE MOCKING」)。
 *
 * ── 编排模型 (scripted rounds) ─────────────────────────────────────────────
 * `script: FakeIdeationRound[]` 逐次 stream 调用消费下一轮:
 * - `{ ask: {...} }`        —— 吐 `ask_clarifying_question` tool_call (访谈相)。
 *                              `options` 省略/空 = 纯文本问题; 非空 = 含 chips。
 * - `{ grounding: {...} }`  —— 吐 `codeindex_retrieval` tool_call (034 接地, `query` 触发
 *                              UC 回灌循环: UC 真检索 → append role:'tool' → 重入 stream)。
 * - `{ emit: {...} }`       —— 吐 `emit_requirements_brief` tool_call (产出相, brief JSON)。
 * - `{ text: [...] }`       —— 吐纯文本 token (降级: 模型吐不出结构化, §4.3 / FR-010)。
 * 越界 (script 耗尽) → 空轮 (不再吐, 收敛)。
 *
 * **`loopByToolMenu` 模式 (真 boot bake 专用, ideation.module `IDEATION_FAKE_SCRIPT`)**:
 * 不按游标硬对位, 每次调用从游标起**环扫**剧本, 消费第一个「其工具在本次 `opts.tools`
 * 菜单里」的轮 (text 轮恒可用)。存在理由: 契约冒烟一次 boot 顺序跑**全部**套件、共享
 * provider 单例 —— 按「调用次数」对位会被前序套件耗尽 (2026-06-23..08-02 实证: 032 把
 * 三轮剧本走完后, 034 的澄清轮拿到越界空轮 → 0 token 帧, e2e-real-backend 自 034 合入
 * 当晚起连红 40 天)。IT 不设此 flag, 游标语义不变。
 *
 * **工具菜单守门 (与真 provider 一致)**: tool_call 轮仅当调用方传了对应工具才吐 ——
 * `ask` 轮需 `opts.tools` 含 `ask_clarifying_question`; `grounding` 轮需含
 * `codeindex_retrieval` (未选仓 → `interviewToolsFor(null)` 不含 → 接地轮降级空轮,
 * 验条件注册不触发检索); `emit` 轮需含 `emit_requirements_brief`。未传 → 该 tool_call
 * 轮降级为空轮 (相位/选仓菜单切换语义)。
 *
 * 故障注入 (作用于当前轮):
 * - `errorAfter` —— 吐出该数量 event 后抛 `FAKE_IDEATION_PROVIDER_ERROR` (0 = 首 event 前即抛,
 *   驱动 provider 失败不落半截 FR-010)。
 * - `delayMs`    —— 每 event 前等待该毫秒 (为 abort 测留时窗)。
 *
 * 尊重 `opts.signal`: abort 即停止迭代 (含 delay 等待期间), 模拟真 provider 中断 (abort
 * 保留半成品 turn 语义由 UC 编排, 本 fake 仅负责止付 event)。
 */

/** 单个 ask_clarifying_question 选项 (fake 脚本输入)。 */
export interface FakeAskOption {
  label: string;
  recommended?: boolean;
}

/** ask_clarifying_question 轮脚本 (访谈相)。options 省略/空 = 纯文本问题。 */
export interface FakeAskRound {
  ask: {
    question: string;
    options?: FakeAskOption[];
    multi_select?: boolean;
    allow_freetext?: boolean;
  };
}

/**
 * codeindex_retrieval 轮脚本 (034 接地)。`query` 喂 UC 回灌循环 (UC 据此真调 CODE_INDEX
 * 端口 search(session.repo, query) → append role:'tool' 命中 JSON → 重入 stream)。
 */
export interface FakeGroundingRound {
  grounding: {
    query: string;
  };
}

/** emit_requirements_brief 轮脚本 (产出相)。brief = 任意 brief JSON (mono 侧 zod 再校验)。 */
export interface FakeEmitRound {
  emit: Record<string, unknown>;
}

/** 纯文本降级轮脚本 (模型吐不出结构化, §4.3)。 */
export interface FakeTextRound {
  text: string[];
}

export type FakeIdeationRound = FakeAskRound | FakeGroundingRound | FakeEmitRound | FakeTextRound;

export interface FakeIdeationLlmConfig {
  /** 两相剧本: 每次 stream 调用消费下一轮 (访谈 ask / 产出 emit / 降级 text)。 */
  script: FakeIdeationRound[];
  /**
   * 按工具菜单环扫选轮 (真 boot bake 专用, 见文件头「loopByToolMenu 模式」)。
   * true → 每次调用取「其 tool 在本次菜单里」的下一轮而非游标硬对位, 与冒烟套件
   * 数量 / 调用次序解耦。IT 剧本不设, 游标语义不变。
   */
  loopByToolMenu?: boolean;
  /** 吐出该数量 event 后抛错 (provider 失败注入)。 */
  errorAfter?: number;
  /** 每 event 前等待毫秒 (为 abort 测留时窗)。 */
  delayMs?: number;
}

export class FakeIdeationLlmProvider implements LlmProvider {
  /** script 轮次游标 (每次 stream 调用 +1)。 */
  private round = 0;

  constructor(private readonly config: FakeIdeationLlmConfig) {}

  async *stream(_messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    const current =
      this.config.loopByToolMenu === true ? this.nextByMenu(opts) : this.nextByCursor();

    // 越界 (cursor) / 全剧本无菜单匹配 (menu) → 空轮收敛 (不再吐)。
    if (current === undefined) return;

    if ('ask' in current) {
      yield* this.maybeToolCall(TOOL_ASK_CLARIFYING_QUESTION, buildAskArgs(current.ask), opts);
      return;
    }
    if ('grounding' in current) {
      // 接地轮: 仅当调用方传了 codeindex_retrieval (interviewToolsFor(repo) 含, 即已选仓)
      // 才吐 tool_call → 触发 UC 回灌循环; 未选仓 → 菜单不含 → 守门降级空轮 (条件注册验证)。
      yield* this.maybeToolCall(TOOL_CODEINDEX_RETRIEVAL, { query: current.grounding.query }, opts);
      return;
    }
    if ('emit' in current) {
      yield* this.maybeToolCall(TOOL_EMIT_REQUIREMENTS_BRIEF, current.emit, opts);
      return;
    }
    // 纯文本降级轮。
    yield* this.streamTokens(current.text, opts);
  }

  /** 游标硬对位 (IT 剧本语义): 每次调用消费下一轮, 越界 → undefined。 */
  private nextByCursor(): FakeIdeationRound | undefined {
    const current = this.config.script[this.round];
    this.round += 1;
    return current;
  }

  /**
   * 菜单驱动环扫选轮 (loopByToolMenu): 从游标起环扫 script, 取第一个「其 tool 在本次
   * 菜单里」的轮 (text 降级轮恒可用), 游标推进到其后。全剧本无匹配 → undefined (空轮,
   * 游标不动)。复杂度 O(script.length)。
   */
  private nextByMenu(opts: LlmStreamOptions): FakeIdeationRound | undefined {
    const { script } = this.config;
    if (script.length === 0) return undefined;
    const offered = new Set((opts.tools ?? []).map((t) => t.function.name));
    for (let i = 0; i < script.length; i++) {
      const idx = (this.round + i) % script.length;
      const tool = roundTool(script[idx]);
      if (tool === null || offered.has(tool)) {
        this.round = idx + 1;
        return script[idx];
      }
    }
    return undefined;
  }

  /**
   * 工具菜单守门 (与真 provider 一致): 仅当调用方传了同名工具才吐 tool_call;
   * 未传 → 空轮 (相位菜单切换: 访谈期不给 emit → emit 轮不吐)。应用 errorAfter/signal。
   */
  private async *maybeToolCall(
    name: string,
    args: Record<string, unknown>,
    opts: LlmStreamOptions,
  ): AsyncIterable<LlmStreamEvent> {
    const offered = (opts.tools ?? []).some((t) => t.function.name === name);
    if (!offered) return;
    if (opts.signal.aborted) return;
    if (this.config.errorAfter !== undefined && this.config.errorAfter === 0) {
      throw new Error('FAKE_IDEATION_PROVIDER_ERROR: injected provider failure');
    }
    if (this.config.delayMs !== undefined && this.config.delayMs > 0) {
      const interrupted = await sleepOrAbort(this.config.delayMs, opts.signal);
      if (interrupted) return;
    }
    yield { kind: 'tool_call', calls: [toToolCall(name, args, this.round)] };
  }

  /** 逐 token 吐 {kind:'token'}, 应用 errorAfter / delayMs / signal (降级正文)。 */
  private async *streamTokens(
    tokens: string[],
    opts: LlmStreamOptions,
  ): AsyncIterable<LlmStreamEvent> {
    const { errorAfter, delayMs } = this.config;
    for (let i = 0; i < tokens.length; i++) {
      if (opts.signal.aborted) return;
      if (errorAfter !== undefined && i === errorAfter) {
        throw new Error('FAKE_IDEATION_PROVIDER_ERROR: injected provider failure');
      }
      if (delayMs !== undefined && delayMs > 0) {
        const interrupted = await sleepOrAbort(delayMs, opts.signal);
        if (interrupted) return;
      }
      yield { kind: 'token', text: tokens[i] };
    }
    if (errorAfter !== undefined && errorAfter === tokens.length && !opts.signal.aborted) {
      throw new Error('FAKE_IDEATION_PROVIDER_ERROR: injected provider failure');
    }
  }
}

/** 该轮要吐的 tool 名 (text 降级轮 = null, 恒可用)。菜单环扫选轮用。 */
function roundTool(round: FakeIdeationRound): string | null {
  if ('ask' in round) return TOOL_ASK_CLARIFYING_QUESTION;
  if ('grounding' in round) return TOOL_CODEINDEX_RETRIEVAL;
  if ('emit' in round) return TOOL_EMIT_REQUIREMENTS_BRIEF;
  return null;
}

/** ask 轮脚本 → ask_clarifying_question 工具参数对象。 */
function buildAskArgs(ask: FakeAskRound['ask']): Record<string, unknown> {
  const args: Record<string, unknown> = { question: ask.question };
  if (ask.options !== undefined) {
    args.options = ask.options.map((o) =>
      o.recommended === undefined
        ? { label: o.label }
        : { label: o.label, recommended: o.recommended },
    );
  }
  if (ask.multi_select !== undefined) args.multi_select = ask.multi_select;
  if (ask.allow_freetext !== undefined) args.allow_freetext = ask.allow_freetext;
  return args;
}

/** (name, args 对象) → port ToolCall (args JSON.stringify, id 自动生成)。 */
function toToolCall(name: string, args: Record<string, unknown>, round: number): ToolCall {
  return {
    id: `call_${round}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 睡 ms 毫秒, 期间 signal abort → 提前 resolve(true)。返回是否被打断。复杂度 O(1)。 */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
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
