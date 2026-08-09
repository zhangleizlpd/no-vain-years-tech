import { describe, it, expect } from 'vitest';
import {
  IDEATION_TOOLS,
  interviewToolsFor,
  PRODUCE_PHASE_TOOLS,
  EMIT_REQUIREMENTS_BRIEF_TOOL,
  ASK_CLARIFYING_QUESTION_TOOL,
  TOOL_ASK_CLARIFYING_QUESTION,
  TOOL_CODEINDEX_RETRIEVAL,
  TOOL_EMIT_REQUIREMENTS_BRIEF,
} from './ideation-tools';

/** 访谈相菜单 fixture (已选仓 = codeindex+ask; 034 T003 后 INTERVIEW_PHASE_TOOLS→interviewToolsFor)。 */
const INTERVIEW_PHASE_TOOLS = interviewToolsFor('mono');
import { T1_SEGMENT_KEYS } from './brief.schema';
import { FakeIdeationLlmProvider, type FakeIdeationRound } from './fake-ideation-llm.provider';
import type { LlmStreamEvent, LlmStreamOptions } from '../integrations/llm/llm-provider.port';

// ── helpers ──────────────────────────────────────────────────────────────────
function opts(over: Partial<LlmStreamOptions> = {}): LlmStreamOptions {
  return { signal: new AbortController().signal, model: 'minimax', ...over };
}

async function drain(
  provider: FakeIdeationLlmProvider,
  o: LlmStreamOptions,
): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const e of provider.stream([], o)) events.push(e);
  return events;
}

function parseCall(events: LlmStreamEvent[]) {
  const tc = events.find((e) => e.kind === 'tool_call');
  if (!tc || tc.kind !== 'tool_call') throw new Error('no tool_call event');
  const call = tc.calls[0];
  return {
    name: call.function.name,
    args: JSON.parse(call.function.arguments) as Record<string, unknown>,
  };
}

// ── 工具 schema ───────────────────────────────────────────────────────────────
describe('032 T006 ideation-tools (3 工具 schema, 契约 doc §3.1/§4.4)', () => {
  it('导出 3 工具 (codeindex / ask / emit), 名字稳定', () => {
    const names = IDEATION_TOOLS.map((t) => t.function.name);
    expect(names).toEqual([
      TOOL_CODEINDEX_RETRIEVAL,
      TOOL_ASK_CLARIFYING_QUESTION,
      TOOL_EMIT_REQUIREMENTS_BRIEF,
    ]);
  });

  it('emit_requirements_brief 参数 required = brief.schema T1 五段 (收敛硬门)', () => {
    const required = EMIT_REQUIREMENTS_BRIEF_TOOL.function.parameters?.required as string[];
    expect([...required].sort()).toEqual([...T1_SEGMENT_KEYS].sort());
    // T1 五段全在 properties 内
    const props = EMIT_REQUIREMENTS_BRIEF_TOOL.function.parameters?.properties as Record<
      string,
      unknown
    >;
    for (const k of T1_SEGMENT_KEYS) expect(props[k]).toBeDefined();
    // T2/T3 段不在 required (非阻塞)
    expect(required).not.toContain('affected_surface');
    expect(required).not.toContain('edge_cases');
  });

  it('ask_clarifying_question 仅 question required, options 可空 (纯文本 vs chips)', () => {
    const required = ASK_CLARIFYING_QUESTION_TOOL.function.parameters?.required as string[];
    expect(required).toEqual(['question']);
  });

  it('两相菜单: 访谈相 = [codeindex, ask], 产出相 = [emit]', () => {
    expect(INTERVIEW_PHASE_TOOLS.map((t) => t.function.name)).toEqual([
      TOOL_CODEINDEX_RETRIEVAL,
      TOOL_ASK_CLARIFYING_QUESTION,
    ]);
    expect(PRODUCE_PHASE_TOOLS.map((t) => t.function.name)).toEqual([TOOL_EMIT_REQUIREMENTS_BRIEF]);
  });
});

// ── FakeIdeationLlmProvider 两相驱动 ───────────────────────────────────────────
describe('032 T006 FakeIdeationLlmProvider (两相剧本驱动)', () => {
  it('访谈轮: 吐 ask_clarifying_question (纯文本, 无 chips)', async () => {
    const provider = new FakeIdeationLlmProvider({
      script: [{ ask: { question: '这个功能想达成什么?' } }],
    });
    const events = await drain(provider, opts({ tools: INTERVIEW_PHASE_TOOLS }));
    const { name, args } = parseCall(events);
    expect(name).toBe(TOOL_ASK_CLARIFYING_QUESTION);
    expect(args.question).toBe('这个功能想达成什么?');
    expect(args.options).toBeUndefined();
  });

  it('访谈轮: 吐 ask_clarifying_question 含 chips (含 recommended 标注)', async () => {
    const script: FakeIdeationRound[] = [
      {
        ask: {
          question: '输出流走 SSE 流式还是一次性?',
          options: [{ label: 'SSE 流式', recommended: true }, { label: '一次性全文' }],
          multi_select: false,
          allow_freetext: true,
        },
      },
    ];
    const provider = new FakeIdeationLlmProvider({ script });
    const events = await drain(provider, opts({ tools: INTERVIEW_PHASE_TOOLS }));
    const { args } = parseCall(events);
    const options = args.options as Array<Record<string, unknown>>;
    expect(options).toHaveLength(2);
    expect(options[0]).toEqual({ label: 'SSE 流式', recommended: true });
    expect(options[1]).toEqual({ label: '一次性全文' });
    expect(args.multi_select).toBe(false);
  });

  it('产出轮: 吐 emit_requirements_brief (T1 五段 brief JSON)', async () => {
    const brief = {
      problem: '行情页缺收藏',
      user_stories: 'P1 用户能收藏',
      functional_requirements: 'FR-001 收藏按钮',
      success_criteria: '收藏后重进仍在',
      non_goals: '不做分组',
    };
    const provider = new FakeIdeationLlmProvider({ script: [{ emit: brief }] });
    const events = await drain(provider, opts({ tools: PRODUCE_PHASE_TOOLS }));
    const { name, args } = parseCall(events);
    expect(name).toBe(TOOL_EMIT_REQUIREMENTS_BRIEF);
    expect(args).toEqual(brief);
  });

  it('降级: 吐纯文本 token (模型吐不出结构化, §4.3 / FR-010)', async () => {
    const provider = new FakeIdeationLlmProvider({
      script: [{ text: ['需', '求', '够', '清', '楚', '了'] }],
    });
    const events = await drain(provider, opts({ tools: PRODUCE_PHASE_TOOLS }));
    expect(events.every((e) => e.kind === 'token')).toBe(true);
    const text = events.map((e) => (e.kind === 'token' ? e.text : '')).join('');
    expect(text).toBe('需求够清楚了');
  });

  it('菜单守门: 产出菜单下 ask 轮不吐 (访谈期不给 emit / 反之)', async () => {
    // 脚本排了 ask 轮, 但只给 produce 菜单 → ask 不在菜单 → 空轮。
    const provider = new FakeIdeationLlmProvider({ script: [{ ask: { question: '?' } }] });
    const events = await drain(provider, opts({ tools: PRODUCE_PHASE_TOOLS }));
    expect(events).toHaveLength(0);
  });

  it('菜单守门: 未传 tools → tool_call 轮不吐 (与真 provider 一致)', async () => {
    const provider = new FakeIdeationLlmProvider({ script: [{ emit: { problem: 'x' } }] });
    const events = await drain(provider, opts()); // 无 tools
    expect(events).toHaveLength(0);
  });

  it('多轮: 逐次 stream 消费下一轮 (访谈→访谈→产出)', async () => {
    const provider = new FakeIdeationLlmProvider({
      script: [
        { ask: { question: 'Q1' } },
        { ask: { question: 'Q2', options: [{ label: 'A', recommended: true }] } },
        {
          emit: {
            problem: 'p',
            user_stories: 'u',
            functional_requirements: 'f',
            success_criteria: 's',
            non_goals: 'n',
          },
        },
      ],
    });
    const r1 = parseCall(await drain(provider, opts({ tools: INTERVIEW_PHASE_TOOLS })));
    expect(r1.args.question).toBe('Q1');
    const r2 = parseCall(await drain(provider, opts({ tools: INTERVIEW_PHASE_TOOLS })));
    expect(r2.args.question).toBe('Q2');
    const r3 = parseCall(await drain(provider, opts({ tools: PRODUCE_PHASE_TOOLS })));
    expect(r3.name).toBe(TOOL_EMIT_REQUIREMENTS_BRIEF);
    // 越界 → 空轮收敛
    expect(await drain(provider, opts({ tools: INTERVIEW_PHASE_TOOLS }))).toHaveLength(0);
  });

  it('故障注入: errorAfter=0 → 首 event 前抛 (provider 失败不落半截)', async () => {
    const provider = new FakeIdeationLlmProvider({
      script: [{ emit: { problem: 'x' } }],
      errorAfter: 0,
    });
    await expect(drain(provider, opts({ tools: PRODUCE_PHASE_TOOLS }))).rejects.toThrow(
      /FAKE_IDEATION_PROVIDER_ERROR/,
    );
  });

  it('abort: 已 abort 的 signal → 不吐任何 event (中断保留语义由 UC)', async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = new FakeIdeationLlmProvider({
      script: [{ text: ['a', 'b', 'c'] }],
    });
    const events = await drain(provider, opts({ signal: ac.signal, tools: PRODUCE_PHASE_TOOLS }));
    expect(events).toHaveLength(0);
  });

  it('abort: delay 期间 abort → 中途停止吐 token', async () => {
    const ac = new AbortController();
    const provider = new FakeIdeationLlmProvider({
      script: [{ text: ['a', 'b', 'c', 'd'] }],
      delayMs: 50,
    });
    const o = opts({ signal: ac.signal, tools: PRODUCE_PHASE_TOOLS });
    setTimeout(() => ac.abort(), 60);
    const events = await drain(provider, o);
    // 50ms 后吐第 1 个, 60ms abort → 第 2 个 delay 期间被打断
    expect(events.length).toBeLessThan(4);
  });
});

// ── loopByToolMenu (真 boot bake): 菜单驱动环扫选轮, 与冒烟套件调用次数解耦 ──────────
describe('loopByToolMenu (契约冒烟 bake 模式)', () => {
  const SCRIPT: FakeIdeationRound[] = [
    { ask: { question: 'Q1?', allow_freetext: true } },
    {
      ask: {
        question: 'Q2?',
        options: [{ label: 'A', recommended: true }, { label: 'B' }],
      },
    },
    { emit: { problem: 'p' } },
  ];

  it('剧本走满一圈后访谈调用环回 ask 轮 (034 越界空轮 40 天连红的回归反例)', async () => {
    const p = new FakeIdeationLlmProvider({ script: SCRIPT, loopByToolMenu: true });
    // 模拟 032 套件: 两轮访谈 + 一轮产出 → 三轮剧本耗尽
    await drain(p, opts({ tools: INTERVIEW_PHASE_TOOLS }));
    await drain(p, opts({ tools: INTERVIEW_PHASE_TOOLS }));
    await drain(p, opts({ tools: PRODUCE_PHASE_TOOLS }));
    // 034 套件的澄清轮: cursor 语义下这里是越界空轮 (历史 bug 现场); 菜单环扫下环回 ask
    const events = await drain(p, opts({ tools: INTERVIEW_PHASE_TOOLS }));
    expect(parseCall(events).name).toBe(TOOL_ASK_CLARIFYING_QUESTION);
  });

  it('访谈菜单跳过 emit 轮选中 ask (相位错配不再产生空轮)', async () => {
    const p = new FakeIdeationLlmProvider({
      script: [{ emit: { problem: 'p' } }, { ask: { question: 'Q?' } }],
      loopByToolMenu: true,
    });
    const events = await drain(p, opts({ tools: [ASK_CLARIFYING_QUESTION_TOOL] }));
    expect(parseCall(events).name).toBe(TOOL_ASK_CLARIFYING_QUESTION);
  });

  it('产出菜单跳过 ask 轮选中 emit', async () => {
    const p = new FakeIdeationLlmProvider({ script: SCRIPT, loopByToolMenu: true });
    const events = await drain(p, opts({ tools: PRODUCE_PHASE_TOOLS }));
    expect(parseCall(events).name).toBe(TOOL_EMIT_REQUIREMENTS_BRIEF);
  });

  it('全剧本无菜单匹配 → 空轮; 未设 flag 的越界语义不变 (IT 剧本不受影响)', async () => {
    const menuOnly = new FakeIdeationLlmProvider({
      script: [{ emit: { problem: 'p' } }],
      loopByToolMenu: true,
    });
    expect(await drain(menuOnly, opts({ tools: [ASK_CLARIFYING_QUESTION_TOOL] }))).toEqual([]);

    const cursor = new FakeIdeationLlmProvider({ script: [{ ask: { question: 'Q?' } }] });
    await drain(cursor, opts({ tools: INTERVIEW_PHASE_TOOLS }));
    // 越界 → 空轮 (cursor 语义保留给 IT)
    expect(await drain(cursor, opts({ tools: INTERVIEW_PHASE_TOOLS }))).toEqual([]);
  });
});
