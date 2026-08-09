import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ossConfig, ossPublicBaseUrl, type OssConfig } from '../config/index';
import { PrismaService } from '../security/prisma.service';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type Msg,
  type MsgPart,
  type ToolCall,
} from '../integrations/llm/llm-provider.port';
import type { ToolDef } from '../integrations/llm/llm-provider.port';
import {
  CODE_INDEX,
  type CodeIndexProvider,
  type CodeChunk,
} from '../integrations/codeindex/code-index.port';
import {
  ASK_CLARIFYING_QUESTION_TOOL,
  interviewToolsFor,
  toSourceRefs,
  TOOL_ASK_CLARIFYING_QUESTION,
  TOOL_CODEINDEX_RETRIEVAL,
} from './ideation-tools';
import type { SseSourceRef } from './ideation-sse.rules';
import {
  normalizeSuggestion,
  shouldOfferChips,
  type NormalizedSuggestion,
  type RawSuggestion,
  type RawSuggestionOption,
} from './suggestion-gate.rules';
import { SESSION_STATUS_OPEN } from './session-status.rules';
import { DEFAULT_INTERVIEW_PERSONA, PROMPT_KEY_INTERVIEW_PERSONA } from './interview-persona';
import { PromptConfigService } from './prompt-config.service';

/**
 * 澄清轮流式编排 (032 T008, 契约 doc §3 两相 + §4.2 两步微循环) —— ideation 叶子 ctx,
 * 扁平 + 贫血 + 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 流程 (plan ④⑤ / §Impl Guardrails split-tx / 契约 doc §4.2):
 *   ① scope 校验 session 归属本 accountId + status=open → 他人/不存在 404 字节级一致
 *      (反枚举, 与 get/delete 同款 SESSION_NOT_FOUND); 非 open (converged/handed-off)
 *      → 同折 404 不可区分 (先 reopen 才能续问)。
 *   ② content 非空校验 (纯空白 → 400; user turn 不落)。
 *   ③ 落 user turn 即时 (append-only; 落了就不丢, 即便后续 provider 失败)。
 *   ④ per-turn 两步微循环 (用户只看到一轮):
 *      - 步1 接地: tools=`interviewToolsFor(session.repo)`, tool_choice='auto' (已选仓 → 含
 *        codeindex `auto`; 未选仓 → 仅 ask, 条件注册 FR-007 模型拿不到检索工具)。模型发起
 *        `codeindex_retrieval` → **tool-result 回灌循环** (034 T006, plan §Architecture Notes #2):
 *        ① onToolStart 帧 → ② 经 CODE_INDEX 端口 search(session.repo, query, signal) 真检索 →
 *        ③ append assistant(toolCalls) + role:'tool'(toolCallId, 命中 JSON) 到 messages[] →
 *        重入 stream 让模型据真实代码出澄清问题 → ④ onSources 帧 (命中 ≤5)。
 *        **降级 (FR-008)**: 端口 throw (不可达/超时/401/5xx) → catch → onNotice (grounding_degraded)
 *        + 视空命中续提问, 绝不 abort/error 整轮; **0 命中** (端口正常返 []) 与不可达严格分流
 *        (FR-009): 0 命中正常回灌空集 (role:'tool' 表达「未找到」), **不**发 notice。
 *      - 步2 提问: tools=[ask_clarifying_question], required(M3)/best-effort(DS) → 出
 *        `{question, options[], multi_select, allow_freetext}`。
 *   ⑤ 流式分离 (契约 doc §4.7): `question` 文本逐帧 drip (onToken); chips 经 T004
 *      shouldOfferChips + normalizeSuggestion 两道闸过滤 (第一问永不给 chips) → 过闸则
 *      JSON 收口整出 (onSuggestion 一次, 非逐字)。
 *   ⑥ 终态分流 (split-tx, 流式期间不开 tx, 落库流前/流后独立短写):
 *      - 正常结束     → 落 assistant turn (+ 过闸 suggestion), 返回 {kind:'completed'}。
 *      - 停止 (abort) → **保留半成品** assistant turn (已 drip 的 question 文本), 返回
 *                       {kind:'stopped'} (FR-008 语义对齐)。
 *      - provider 失败 → **不落半截** assistant turn (FR-010), 返回 {kind:'error'};
 *                       user turn 已落不丢, controller 写 error 帧让客户端重试。
 *
 * onToken / onSuggestion 是 HTTP-agnostic 回调 (controller 注入), UC 不碰 reply/raw。
 */

/** 澄清轮终态 — controller 据此写最终 SSE 帧。 */
export type ClarifyTurnOutcome =
  | { kind: 'completed'; turnId: bigint }
  | { kind: 'stopped'; turnId: bigint }
  | { kind: 'error'; message: string };

export interface ClarifyTurnParams {
  accountId: bigint;
  sessionId: bigint;
  content: string;
  /**
   * 036 T006 带图轮 (可选): 本轮直传成功的烧录图 OSS key 列表。非空 → 校验归属 (前缀必为
   * `ideation/<accountId>/` 否则 404) → 落 IdeaAttachment 引用 + 组多模态 Msg + 路由 minimax。
   * 空/未传 → 纯文本轮, 行为零回归 (SC-005)。
   */
  attachmentKeys?: string[];
  /** 036 T006: SoM 同编号合成标注文字, 注入当前轮 user Msg 的 text part (带图轮)。 */
  annotationText?: string;
  /** controller 持有的 AbortSignal (reply.raw 'close' → abort), 透传 provider 止付。 */
  signal: AbortSignal;
}

/** 036 T006: 带图轮路由的视觉模型逻辑名 (M3 原生多模态; fact #1/#3, 替纯文本轮 'pro')。 */
const MODEL_VISION = 'minimax';
/** 纯文本轮默认模型 (DeepSeek v4 pro; 视觉 API 未开放 fact #2, 零回归)。 */
const MODEL_TEXT = 'pro';

/** 澄清流式回调 (controller 注入, 据此写对应 SSE 帧; UC 不碰 reply)。 */
export interface ClarifyTurnCallbacks {
  /** question 文本逐帧 drip (契约 doc §4.7)。 */
  onToken: (token: string) => void;
  /** 过两闸的 chips → JSON 收口整出一帧 (契约 doc §4.7; 纯文本问题不调)。 */
  onSuggestion: (suggestion: NormalizedSuggestion) => void;
  /** 接地检索发起指示 (034 FR-013, tool_start 帧「正在检索代码…」)。 */
  onToolStart: () => void;
  /** 接地命中来源 (034 FR-002, sources 帧, 已截 ≤5; 0 命中调用 [] 不发帧由 controller 决定)。 */
  onSources: (sources: SseSourceRef[]) => void;
  /** 接地降级系统气泡 (034 FR-008, notice 帧 grounding_degraded; 端口不可达时)。 */
  onNotice: () => void;
}

/** 步2 提问菜单 (仅 ask, required(M3)/best-effort(DS); 不给 codeindex/emit)。 */
const ASK_ONLY_TOOLS: ToolDef[] = [ASK_CLARIFYING_QUESTION_TOOL];

/** 接地回灌循环上限 (防模型反复发起检索死循环; 1 次足够本期单仓接地)。 */
const MAX_GROUNDING_ROUNDS = 2;

/** 回灌给模型的命中上限 (与 sources 帧 ≤5 一致, 控 token 预算)。 */
const MAX_GROUNDING_HITS = 5;

/** provider 抛错统一取 message (兜底常量)。 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'IDEATION_LLM_PROVIDER_ERROR';
}

/**
 * 解析 codeindex_retrieval tool_call → {id, query} (034 T006 回灌循环输入)。query 非串/空
 * → null (不触发检索, 回灌循环视作无检索请求收束)。id 用于 role:'tool' 配对回灌。
 */
function parseGroundingArgs(call: ToolCall): { id: string; query: string } | null {
  try {
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (query.length === 0) return null;
    return { id: call.id, query };
  } catch {
    return null;
  }
}

/**
 * 接地命中 → role:'tool' 回灌 content (喂模型据真实代码出问题, 034 FR-001)。
 * 降级 (端口失败) → 明确「服务暂不可用」让模型据未接地续问 (不泄露内部错误细节, FR-008);
 * 0 命中 → 明确「未找到相关代码」让模型据此续问而非造引用 (FR-009)。命中 → 出处坐标 + 文本
 * 子集 JSON (relPath/symbol/startLine/endLine/text), 截 ≤5 与 sources 帧一致。
 */
function buildToolResultContent(hits: readonly CodeChunk[], degraded: boolean): string {
  if (degraded) {
    return JSON.stringify({ status: 'unavailable', note: 'code index service unavailable' });
  }
  if (hits.length === 0) {
    return JSON.stringify({ status: 'no_match', hits: [] });
  }
  const trimmed = hits.slice(0, MAX_GROUNDING_HITS).map((h) => ({
    relPath: h.relPath,
    symbol: h.symbol,
    startLine: h.startLine,
    endLine: h.endLine,
    text: h.text,
  }));
  return JSON.stringify({ status: 'ok', hits: trimmed });
}

/** 解析 ask_clarifying_question tool_call.arguments (JSON 字符串) → 原始 suggestion。 */
function parseAskArgs(call: ToolCall): RawSuggestion | null {
  try {
    const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    const question = typeof args.question === 'string' ? args.question : '';
    if (question.length === 0) return null;
    const rawOptions = Array.isArray(args.options)
      ? (args.options as unknown[]).flatMap((o): RawSuggestionOption[] => {
          if (o === null || typeof o !== 'object') return [];
          const label = (o as { label?: unknown }).label;
          if (typeof label !== 'string') return [];
          const recommended = (o as { recommended?: unknown }).recommended;
          const fill = (o as { fill?: unknown }).fill;
          return [
            {
              label,
              recommended: recommended === true,
              ...(typeof fill === 'string' ? { fill } : {}),
            },
          ];
        })
      : [];
    return {
      question,
      options: rawOptions,
      multi_select: args.multi_select === true,
      allow_freetext: args.allow_freetext === true,
    };
  } catch {
    return null;
  }
}

@Injectable()
export class ClarifyTurnUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    // CODE_INDEX 是 platform integration 端口 (ADR-0058, 与 LLM_PROVIDER 同类 vendor I/O,
    // 非业务 ctx 注入 → 无护城河注释要求 per ADR-0041 platform infra 例外)。
    @Inject(CODE_INDEX) private readonly codeIndex: CodeIndexProvider,
    private readonly promptConfig: PromptConfigService,
    // ossConfig 是 platform config (ADR-0058 平台层 OSS); 仅用于把烧录图 ossKey 派生为
    // public URL 注入 image_url part (036 T006), 非业务跨 ctx 注入 → 无护城河注释要求。
    @Inject(ossConfig.KEY) private readonly ossCfg: OssConfig,
  ) {}

  /**
   * 036 T006: 组当前带图轮的多模态 user content (OpenAI vision content parts)。
   *   - text part = `content` (用户输入) + (有则) `annotationText` (SoM 同编号合成文字), 拼一段。
   *   - image_url part = 每个烧录图 ossKey 派生的 OSS public URL (`ossPublicBaseUrl/<ossKey>`,
   *     与 account confirm-profile-image 同款派生)。OSS 未配置 (dev/test unconfigured) →
   *     无 region/bucket 派生不出 URL → 退化为纯文本 string (防御性, 不抛; 带图轮在真 OSS env 才有效)。
   */
  private buildMultimodalContent(
    content: string,
    annotationText: string | undefined,
    keys: string[],
  ): string | MsgPart[] {
    const text =
      annotationText && annotationText.trim().length > 0
        ? `${content}\n\n${annotationText}`
        : content;
    if (this.ossCfg.kind !== 'aliyun') {
      return text;
    }
    const base = ossPublicBaseUrl(
      this.ossCfg.region,
      this.ossCfg.bucket,
      this.ossCfg.publicBaseUrl,
    );
    const parts: MsgPart[] = [{ type: 'text', text }];
    for (const ossKey of keys) {
      parts.push({ type: 'image_url', image_url: { url: `${base}/${ossKey}` } });
    }
    return parts;
  }

  async execute(
    params: ClarifyTurnParams,
    callbacks: ClarifyTurnCallbacks,
  ): Promise<ClarifyTurnOutcome> {
    const { accountId, sessionId, content, attachmentKeys, annotationText, signal } = params;

    // ① scope 校验归属 + open: 查不到本人 open 会话即 404 (反枚举字节级一致)。
    //    非 open (converged/handed-off) 同折 404 不可区分 (续问前须先 reopen)。
    const session = await this.prisma.ideaSession.findFirst({
      where: { id: sessionId, accountId, status: SESSION_STATUS_OPEN },
      // repo: 接地命名空间锁 (034 FR-003); null/空 = 未选仓 → 条件注册不给检索工具。
      select: { id: true, repo: true },
    });
    if (!session) {
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    // ② content 非空校验 (纯空白 → 400; user turn 不落)。
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('IDEATION_EMPTY_CONTENT');
    }

    // 036 T006 带图轮: 校验每个烧录图 key 归属本 account (前缀必为 `ideation/<accountId>/`,
    // 即 T005 凭证签发锁定的 scope)。任一不匹配 → **字节级一致 404** (反枚举 FR-013, 与
    // session-not-found 同折, 不区分「他人图」vs「session 不存在」)。空/未传 → 纯文本轮。
    const keys = (attachmentKeys ?? []).filter((k) => k.length > 0);
    const hasImage = keys.length > 0;
    if (hasImage) {
      const ownPrefix = `ideation/${accountId}/`;
      if (keys.some((k) => !k.startsWith(ownPrefix))) {
        throw new NotFoundException('SESSION_NOT_FOUND');
      }
    }

    // ③ 落 user turn + (带图轮) IdeaAttachment 引用 —— **同 tx** (落了就一起落; turn 与附件
    //    引用原子, FR-009 会话重载可重展示)。外部 I/O (视觉模型调用) 在 tx 外 (split-tx, 见下)。
    await this.prisma.$transaction(async (tx) => {
      const userTurn = await tx.ideaTurn.create({
        data: { sessionId, role: 'user', content },
        select: { id: true },
      });
      if (hasImage) {
        // 036 T018: turnId 关联当轮新建 user turn (同轮多附件共用此 id)，使会话重载可 per-turn
        // 投影附件 (FR-009 读侧补全)。
        await tx.ideaAttachment.createMany({
          data: keys.map((ossKey) => ({
            sessionId,
            accountId,
            turnId: userTurn.id,
            ossKey,
            kind: 'image',
          })),
        });
      }
    });

    // ④ 取本会话历史 (含刚落的 user turn) → 组 messages[]: 访谈人设 system (loadPersona,
    //    DB 可配 / 回落 DEFAULT) 置首, 后接历史 turn → user/assistant 消息。轮序 = 已落
    //    user turn 数 (第一问 turnIndex=0 永不给 chips, §4.6 反锚定)。
    const history = await this.prisma.ideaTurn.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true },
    });
    // 访谈人设 system prompt 置于 history 前 (引导冷启招呼/模糊输入也回话, 见 interview-persona)。
    const persona = await this.promptConfig.get(
      PROMPT_KEY_INTERVIEW_PERSONA,
      DEFAULT_INTERVIEW_PERSONA,
    );
    // 036 T006 send-once (FR-015): **仅当前轮**注入 image —— 历史轮一律从 DB 重建为纯文本
    // string (历史带图轮的图绝不重注, 控 token)。带图轮把**最后一条** user 消息 (= 刚落的本轮)
    // 的 content 升级为多模态 MsgPart[] (annotationText → text part + 各烧录图 OSS public URL
    // → image_url part); 其余轮维持 string。
    const lastUserIdx = history.map((t) => t.role).lastIndexOf('user');
    const messages: Msg[] = [
      { role: 'system', content: persona },
      ...history.map(
        (t, i): Msg => ({
          role: t.role === 'assistant' ? 'assistant' : 'user',
          content:
            hasImage && i === lastUserIdx
              ? this.buildMultimodalContent(t.content, annotationText, keys)
              : t.content,
        }),
      ),
    ];
    // turnIndex = 已存在的 user turn 序 (0-based): 含刚落的本轮 → -1 得本轮序。
    const userTurnCount = history.filter((t) => t.role === 'user').length;
    const turnIndex = Math.max(0, userTurnCount - 1);

    // 带图轮强制路由视觉模型 (M3); 纯文本轮维持 'pro' (DeepSeek, 零回归 SC-005)。
    const model = hasImage ? MODEL_VISION : MODEL_TEXT;

    // ⑤⑥ per-turn 两步微循环 + 流式 + split-tx 终态。repo 透传供步1 条件注册 + 回灌检索。
    return this.runClarifyTurn(
      { sessionId, repo: session.repo, messages, turnIndex, model, signal },
      callbacks,
    );
  }

  /**
   * per-turn 两步微循环 (契约 doc §4.2) + 流式分离 (§4.7) + split-tx 终态 (plan ⑥)。
   *
   *   步1 接地 (auto): streamGrounded(tools=interviewToolsFor(repo))。模型若发起
   *        codeindex_retrieval → **回灌循环** (真检索 + 降级分流 + append role:'tool' → 重入
   *        stream, 034 T006); 模型若直接出 ask → 步1 即拿到结果, 跳过步2。**接地非阻塞**。
   *   步2 提问 (required/best-effort): stream(tools=PRODUCE? 否 —— ask only)。出 ask_clarifying_question
   *        → 解析 {question, options...}。
   *   流式: question 文本逐帧 onToken; 过两闸 chips → onSuggestion 收口整出。
   *   split-tx: 全程不开 tx; 落 assistant turn 是流后独立短写。
   *     - abort      → 保留半成品 assistant turn (status 语义靠 append; ideation turn 无
   *                    status 列, 半成品=已 drip 文本落库), 返回 stopped。
   *     - provider 失败 (非 abort) → 不落 assistant turn, 返回 error。
   */
  private async runClarifyTurn(
    ctx: {
      sessionId: bigint;
      repo: string | null;
      messages: Msg[];
      turnIndex: number;
      /** 036 T006: 本轮路由的逻辑 model (带图轮 'minimax' / 纯文本轮 'pro')。 */
      model: string;
      signal: AbortSignal;
    },
    callbacks: ClarifyTurnCallbacks,
  ): Promise<ClarifyTurnOutcome> {
    const { sessionId, repo, messages, turnIndex, model, signal } = ctx;

    let ask: RawSuggestion | null;
    let replyText = '';
    try {
      // 步1 接地 (auto): tools=interviewToolsFor(repo) (已选仓含 codeindex auto + ask;
      // 未选仓仅 ask — 条件注册 FR-007 模型拿不到检索工具)。模型若直接出 ask → 步1 即拿到
      // (无需步2); 若发起 codeindex_retrieval → 进入**回灌循环** (runGroundingRetrieval:
      // 真检索 → append role:'tool' → 重入 stream)。**接地非阻塞** (降级也续问)。
      const grounded = await this.streamGrounded(messages, repo, model, signal, callbacks);
      if (grounded.aborted) {
        return { kind: 'stopped', turnId: await this.landAssistant(sessionId, '', null) };
      }

      ask = grounded.ask;
      replyText = grounded.text;
      // 步2 仅在步1 既无 ask 又无任何文本时触发 (纯接地 stub / 空轮 → 强制提问)。
      // 若步1 已吐文本 (招呼/模糊输入的引导回话, 见 interview-persona 形态 A) → 直接走纯文本
      // 兜底, 不再追问 (省一次 LLM 调用, 也避免把欢迎语硬挤成澄清问题)。
      if (ask === null && replyText.trim().length === 0) {
        const asked = await this.streamAskRound(messages, ASK_ONLY_TOOLS, model, signal);
        if (asked.aborted) {
          return { kind: 'stopped', turnId: await this.landAssistant(sessionId, '', null) };
        }
        ask = asked.ask;
        replyText = asked.text;
      }
    } catch (err) {
      // abort 引起的中断不算 error (走 stopped); 否则 provider 真失败 → 不落 assistant turn。
      if (signal.aborted) {
        return { kind: 'stopped', turnId: await this.landAssistant(sessionId, '', null) };
      }
      return { kind: 'error', message: errMessage(err) };
    }

    // 纯文本兜底 (FR: 闲聊/模糊输入也回话): 模型没调 ask 工具但吐了文本 → 当引导式回复落库,
    // 而非 IDEATION_NO_QUESTION 报错。仅当 ask 与文本皆空 (真空响应) 才报 error 不落半截。
    if (ask === null) {
      const fallback = replyText.trim();
      if (fallback.length === 0) {
        if (signal.aborted) {
          return { kind: 'stopped', turnId: await this.landAssistant(sessionId, '', null) };
        }
        return { kind: 'error', message: 'IDEATION_NO_QUESTION' };
      }
      // 文本逐帧 drip (打字机, 同 question 路径); abort → 保留已落半成品 (整串)。
      for (const ch of fallback) {
        if (signal.aborted) {
          return { kind: 'stopped', turnId: await this.landAssistant(sessionId, fallback, null) };
        }
        callbacks.onToken(ch);
      }
      const turnId = await this.landAssistant(sessionId, fallback, null);
      return { kind: 'completed', turnId };
    }

    // 流式分离: question 文本逐帧 drip (§4.7); abort → 半成品保留。
    const question = ask.question;
    for (const ch of question) {
      if (signal.aborted) {
        // 半成品 = 已 drip 的前缀 (本实现按整串 drip, abort 早退保留空/前缀)。
        return { kind: 'stopped', turnId: await this.landAssistant(sessionId, question, null) };
      }
      callbacks.onToken(ch);
    }

    // chips 两道闸 (T004): 过闸 + 非第一问才给; 模型自决 enumerable/defensibleRec (options
    // 非空且含 recommended ⇒ 两闸过)。第一问 (turnIndex===0) 永不给 (shouldOfferChips 内拦)。
    const hasOptions = (ask.options ?? []).length > 0;
    const hasRec = (ask.options ?? []).some((o) => o.recommended === true);
    let suggestion: NormalizedSuggestion | null = null;
    if (shouldOfferChips({ turnIndex, enumerable: hasOptions, defensibleRec: hasRec })) {
      suggestion = normalizeSuggestion(ask);
      callbacks.onSuggestion(suggestion);
    }

    if (signal.aborted) {
      return { kind: 'stopped', turnId: await this.landAssistant(sessionId, question, suggestion) };
    }

    // 正常结束 → 落 assistant turn (+ 过闸 suggestion)。
    const turnId = await this.landAssistant(sessionId, question, suggestion);
    return { kind: 'completed', turnId };
  }

  /**
   * 步1 接地编排 (034 T006 回灌循环, plan §Architecture Notes #2)。tools=interviewToolsFor(repo)。
   *
   * 循环 (上限 MAX_GROUNDING_ROUNDS 防死循环):
   *   stream 一轮 → 若模型出 `ask` 或纯文本 → 返回 (无需检索); 若发起 `codeindex_retrieval`
   *   → runGroundingRetrieval (真检索 + 降级 + append role:'tool' 命中) → **重入 stream**
   *   让模型据真实代码出问题。检索是 tx 外 HTTP (split-tx 纪律不变)。
   *
   * `messages` 本地 clone 不污染 caller (回灌的 assistant/tool 消息只在本步内可见;
   * 落库仍走 landAssistant 流后短写, 来源不单独落 idea_turn 表)。
   */
  private async streamGrounded(
    baseMessages: Msg[],
    repo: string | null,
    model: string,
    signal: AbortSignal,
    callbacks: ClarifyTurnCallbacks,
  ): Promise<{ ask: RawSuggestion | null; text: string; aborted: boolean }> {
    const tools = interviewToolsFor(repo);
    const messages: Msg[] = [...baseMessages];

    for (let round = 0; round < MAX_GROUNDING_ROUNDS; round++) {
      const out = await this.streamAskRound(messages, tools, model, signal);
      if (out.aborted) return { ask: null, text: out.text, aborted: true };

      // 模型给了 ask / 纯文本 / 无检索请求 → 步1 收束 (回灌循环结束)。
      if (out.ask !== null || out.grounding === null) {
        return { ask: out.ask, text: out.text, aborted: false };
      }

      // 模型发起检索 → 回灌一轮 (真检索 + 降级分流 + append assistant/tool 消息), 再重入 stream。
      await this.runGroundingRetrieval(out.grounding, repo, messages, signal, callbacks);
      if (signal.aborted) return { ask: null, text: '', aborted: true };
    }

    // 达上限仍只发检索 (异常多轮) → 收束为空 ask (caller 走纯文本兜底 / NO_QUESTION 分流)。
    return { ask: null, text: '', aborted: signal.aborted };
  }

  /**
   * 接地回灌一轮 (034 FR-002/008/009): onToolStart → CODE_INDEX.search(repo, query) →
   * append assistant(toolCalls) + role:'tool'(toolCallId, 命中 JSON) → onSources。
   *
   * **降级分流** (关键):
   *   - 端口 throw (不可达/超时/401/5xx) → catch → onNotice (grounding_degraded) + 视空命中
   *     (role:'tool' content 表达「检索服务暂不可用」) 续提问, **绝不** abort/error 整轮 (FR-008)。
   *   - 0 命中 (端口正常返 []) → 正常回灌空集 (content 表达「未找到相关代码」), **不**发 notice
   *     (FR-009 严格分流)。
   * `repo` 必非空 (能进此路径必已选仓 → 工具已注册); 防御性兜底空字符串。
   */
  private async runGroundingRetrieval(
    grounding: { id: string; query: string },
    repo: string | null,
    messages: Msg[],
    signal: AbortSignal,
    callbacks: ClarifyTurnCallbacks,
  ): Promise<void> {
    callbacks.onToolStart();

    let hits: CodeChunk[] = [];
    let degraded = false;
    try {
      // tx 外 HTTP (split-tx): 检索期不持任何 DB 锁/事务 (server-impl-playbook 外部 I/O)。
      hits = await this.codeIndex.search(repo ?? '', grounding.query, signal);
    } catch {
      // 降级 (FR-008): 端口失败 → 系统气泡 + 视空命中续问, 不泄露内部错误细节 (catch 不取 message)。
      degraded = true;
      callbacks.onNotice();
    }

    // 回灌消息对: assistant 携带本轮 toolCalls (让模型看到自己上轮调了什么) + tool 结果配对。
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: grounding.id,
          type: 'function',
          function: {
            name: TOOL_CODEINDEX_RETRIEVAL,
            arguments: JSON.stringify({ query: grounding.query }),
          },
        },
      ],
    });
    messages.push({
      role: 'tool',
      toolCallId: grounding.id,
      content: buildToolResultContent(hits, degraded),
    });

    // 命中来源回流 (≤5, FR-002); 降级/0 命中 → toSourceRefs([]) = []。
    if (!degraded && hits.length > 0) {
      callbacks.onSources(toSourceRefs(hits));
    }
  }

  /**
   * 跑一轮带 tools 的 stream, 收口 ask_clarifying_question / codeindex_retrieval。
   * 累加纯文本 token (`text`): 模型未调 ask 工具而直接吐文本时 (招呼/模糊输入引导, 或 DS
   * auto 下没命中工具), 供调用方纯文本兜底 (FR: 闲聊也回话, 不报 IDEATION_NO_QUESTION)。
   * `grounding` 非空 = 模型发起接地检索 (caller 据此回灌)。返回 ask / grounding / text /
   * aborted。throw 透传 (abort vs error)。
   */
  private async streamAskRound(
    messages: Msg[],
    tools: ToolDef[],
    model: string,
    signal: AbortSignal,
  ): Promise<{
    ask: RawSuggestion | null;
    grounding: { id: string; query: string } | null;
    text: string;
    aborted: boolean;
  }> {
    let ask: RawSuggestion | null = null;
    let grounding: { id: string; query: string } | null = null;
    let text = '';
    for await (const event of this.provider.stream(messages, {
      signal,
      // 036 T006: 带图轮路由视觉模型 (minimax), 纯文本轮 'pro' (零回归); 由 caller 透传。
      model,
      tools,
    })) {
      if (signal.aborted) return { ask, grounding, text, aborted: true };
      if (event.kind === 'token') {
        text += event.text;
        continue;
      }
      if (event.kind !== 'tool_call') continue;
      for (const call of event.calls) {
        if (call.function.name === TOOL_ASK_CLARIFYING_QUESTION) {
          ask = parseAskArgs(call);
        } else if (call.function.name === TOOL_CODEINDEX_RETRIEVAL) {
          // 接地检索请求 (034 T006): 取 query 供 caller 回灌循环 (真检索 + append role:'tool')。
          grounding = parseGroundingArgs(call);
        }
      }
    }
    return { ask, grounding, text, aborted: signal.aborted };
  }

  /**
   * 落 assistant turn 终态短写 (split-tx 流后段)。content = question 文本 (abort 时为半成品);
   * suggestion 过两闸才非 null (落 idea_turn.suggestion Json)。返回新 turn id。
   * 防御性: 不在此 throw (落库失败由 caller try/catch 兜底)。
   */
  private async landAssistant(
    sessionId: bigint,
    content: string,
    suggestion: NormalizedSuggestion | null,
  ): Promise<bigint> {
    const turn = await this.prisma.ideaTurn.create({
      data: {
        sessionId,
        role: 'assistant',
        content,
        // Prisma Json? 列要求 InputJsonValue; NormalizedSuggestion 是闭合 JSON-safe 接口。
        suggestion:
          suggestion === null ? undefined : (suggestion as unknown as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
    return turn.id;
  }
}
