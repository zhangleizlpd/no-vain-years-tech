import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type Msg,
  type ToolCall,
} from '../integrations/llm/llm-provider.port';
import { PRODUCE_PHASE_TOOLS, TOOL_EMIT_REQUIREMENTS_BRIEF } from './ideation-tools';
import { isConverged } from './brief-gate.rules';
import { briefSchema, type T1SegmentKey } from './brief.schema';
import { SESSION_STATUS_CONVERGED, SESSION_STATUS_OPEN } from './session-status.rules';
import { DEFAULT_BRIEF_EMIT_PERSONA, PROMPT_KEY_BRIEF_EMIT_PERSONA } from './interview-persona';
import { PromptConfigService } from './prompt-config.service';

/**
 * 生成/重生 brief 编排 (032 T009, 契约 doc §3.1 产出相 / §3.4 收敛门) —— ideation 叶子 ctx,
 * 扁平 + 贫血 + 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 流程 (plan ⑥ / §Impl Guardrails split-tx):
 *   ① scope 校验 session 归属本 accountId + status=open → 他人/不存在/非 open 404 字节级一致
 *      (反枚举, 与 clarify 同款; converged 重生需先 reopen 回 open, 与 reopen 闭环对齐)。
 *   ② 产出相 forced emit (契约 doc §3.1): stream(tools=PRODUCE_PHASE_TOOLS) →
 *      - M3: tool_choice='required' (provider 路由层强制单工具)。
 *      - DS 降级: best-effort + **正则兜底** 从纯文本捞 JSON (契约 doc §4.3 / FR-010 /
 *        plan §⑥模型策略); 仍捞不出 → 缺段信号 (无 brief 可落)。
 *   ③ zod 校 (briefSchema) + 收敛门 isConverged 只查 T1 五段 (绝不含 T2, SC-007):
 *      - 未齐 → **不落** brief + 回「继续追问缺失段」信号 (带 missing 段列表)。
 *      - 齐 → **upsert** requirements_draft (1:1 覆盖上版, 不留 v1/v2) + session
 *        open→converged (conditional UPDATE affected-count)。
 *   ④ 接地 stub 非阻塞 (SC-007): T2 全空也必须能收敛 (收敛门只看 T1)。
 *
 * split-tx: emit 是外部 LLM I/O → 禁 tx 内等 HTTP; stream 在 tx 外, 落库是流后短写。
 */

/** 生成 brief 终态 — controller 据此响应。 */
export type GenerateBriefOutcome =
  | { kind: 'converged'; briefJson: Prisma.JsonValue }
  /** 未收敛: 缺 T1 段 → 回「继续追问缺失段」信号。 */
  | { kind: 'incomplete'; missing: T1SegmentKey[] };

/** 从纯文本兜底捞首个 JSON 对象 (DS 降级路径, 契约 doc §4.3)。捞不出返 null。 */
function salvageJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 解析 emit_requirements_brief tool_call.arguments (JSON 字符串) → brief 对象。 */
function parseEmitArgs(call: ToolCall): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(call.function.arguments) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

@Injectable()
export class GenerateBriefUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider,
    private readonly promptConfig: PromptConfigService,
    @Inject(OUTBOX_PUBLISHER) private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(accountId: bigint, sessionId: bigint): Promise<GenerateBriefOutcome> {
    // ① scope + open 校验 (反枚举字节级一致; converged 重生须先 reopen)。
    const session = await this.prisma.ideaSession.findFirst({
      where: { id: sessionId, accountId, status: SESSION_STATUS_OPEN },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException('SESSION_NOT_FOUND');
    }

    // 取会话历史组 messages: emit 产出指令 system (promptConfig 可配 / 回落 DEFAULT) 置首,
    // 引导模型稳定调 emit、只填真聊过的段不编造 (见 interview-persona DEFAULT_BRIEF_EMIT_PERSONA)。
    // 产出相不再聊天, 仅喂上下文让模型 emit。
    const history = await this.prisma.ideaTurn.findMany({
      where: { sessionId },
      orderBy: { id: 'asc' },
      select: { role: true, content: true },
    });
    const emitPersona = await this.promptConfig.get(
      PROMPT_KEY_BRIEF_EMIT_PERSONA,
      DEFAULT_BRIEF_EMIT_PERSONA,
    );
    const messages: Msg[] = [
      { role: 'system', content: emitPersona },
      ...history.map(
        (t): Msg => ({
          role: t.role === 'assistant' ? 'assistant' : 'user',
          content: t.content,
        }),
      ),
    ];

    // ② 产出相 forced emit (tx 外, split-tx)。tool_call 优先; 无则正文正则兜底 (DS 降级)。
    const briefJson = await this.emitBrief(messages);

    // ③ zod 校 + 收敛门 (只查 T1, isConverged)。zod 失败 / 收敛门未齐 → 不落 + 缺段信号。
    const parsed = briefSchema.safeParse(briefJson ?? {});
    const gate = isConverged(briefJson ?? {});
    if (!parsed.success || !gate.converged) {
      return { kind: 'incomplete', missing: gate.missing };
    }

    // ④ 齐 → upsert requirements_draft (1:1 覆盖上版) + session open→converged + R3 入队事件,
    //    同 $transaction (outbox 事件行与状态写原子, per server-impl-playbook)。
    const draftJson = briefJson as Prisma.InputJsonValue;
    await this.prisma.$transaction(async (tx) => {
      await tx.requirementsDraft.upsert({
        where: { sessionId },
        create: { sessionId, briefJson: draftJson },
        update: { briefJson: draftJson },
      });
      // session open→converged (conditional UPDATE + affected-count; 并发只一笔 won)。
      const { count } = await tx.ideaSession.updateMany({
        where: { id: sessionId, accountId, status: SESSION_STATUS_OPEN },
        data: { status: SESSION_STATUS_CONVERGED },
      });
      // 仅本请求赢得 open→converged 才发事件 → exactly-once 定稿 (并发重生不重复入队)。
      if (count > 0) {
        // CROSS-CONTEXT-ASYNC: ideation.requirement-finalized → agent-bridge 入队 (P1.5;
        // worker 凭委托 token 拉胖数据驱动 mockup)。payload BigInt → string (JSON 安全)。
        await this.outboxPublisher.publish(
          tx,
          'ideation.requirement-finalized',
          { accountId: accountId.toString(), sessionId: sessionId.toString() },
          'ideation',
        );
      }
    });

    return { kind: 'converged', briefJson: briefJson as Prisma.JsonValue };
  }

  /**
   * 产出相单轮 emit (契约 doc §3.1 forced)。tools=PRODUCE_PHASE_TOOLS (仅 emit) →
   * - M3 (required): 模型吐 emit_requirements_brief tool_call → 解析 args 为 brief。
   * - DS 降级: 吐纯文本 → 正则兜底 salvageJson 从正文捞 brief (契约 doc §4.3)。
   * 返回 brief 对象 (未校验) / null (彻底捞不出, 调用方回缺段信号)。
   */
  private async emitBrief(messages: Msg[]): Promise<Record<string, unknown> | null> {
    const signal = new AbortController().signal;
    let brief: Record<string, unknown> | null = null;
    let text = '';
    for await (const event of this.provider.stream(messages, {
      signal,
      model: 'pro',
      tools: PRODUCE_PHASE_TOOLS,
    })) {
      if (event.kind === 'token') {
        text += event.text;
      } else if (event.kind === 'tool_call') {
        const emit = event.calls.find((c) => c.function.name === TOOL_EMIT_REQUIREMENTS_BRIEF);
        if (emit) brief = parseEmitArgs(emit);
      }
    }
    // tool_call 优先; 无 tool_call (DS 降级吐纯文本) → 正则兜底捞 JSON。
    return brief ?? salvageJson(text);
  }
}
