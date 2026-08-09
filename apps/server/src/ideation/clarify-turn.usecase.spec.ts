import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ClarifyTurnUseCase, type ClarifyTurnCallbacks } from './clarify-turn.usecase';
import type {
  LlmProvider,
  LlmStreamEvent,
  LlmStreamOptions,
  Msg,
} from '../integrations/llm/llm-provider.port';
import type { CodeIndexProvider } from '../integrations/codeindex/code-index.port';
import type { PromptConfigService } from './prompt-config.service';
import type { PrismaService } from '../security/prisma.service';
import type { OssConfig } from '../config/index';

/**
 * 036 T006 — clarify-turn 带图轮路由 + 多模态 Msg 合成 + send-once 纯逻辑断言 (无 DB / 无外呼,
 * 真 DI override 替身, per plan「NO LIFECYCLE MOCKING」)。完整 state_branches IT 留 T007。
 *
 * 替身策略: prisma 用 UC-level data stub (ideaSession.findFirst 喂归属 / $transaction 跑回调
 * 收集落库 / ideaTurn.findMany 喂历史); provider 记录被调的 model + 当前轮 messages, 吐一段
 * 文本走纯文本兜底完成轮 (不触发接地 / 提问二步)。
 */

const ALIYUN_CFG: OssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'mbw-imgs',
  accessKeyId: 'ak',
  accessKeySecret: 'sk',
};

const NOOP_CALLBACKS: ClarifyTurnCallbacks = {
  onToken: () => {},
  onSuggestion: () => {},
  onToolStart: () => {},
  onSources: () => {},
  onNotice: () => {},
};

interface Captured {
  model?: string;
  messages?: Msg[];
}

/** 记录被调 model + messages 的假 provider; 吐一段文本 → UC 走纯文本兜底完成轮。 */
function recordingProvider(cap: Captured): LlmProvider {
  return {
    async *stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
      // 仅记录首次 (步1) 调用 — 含当前轮 user content (多模态断言点)。
      if (cap.model === undefined) {
        cap.model = opts.model;
        cap.messages = messages;
      }
      yield { kind: 'token', text: '收到，已对焦。' };
    },
  };
}

interface BuildOpts {
  session?: { id: bigint; repo: string | null } | null;
  history?: { role: string; content: string }[];
  cfg?: OssConfig;
}

function build(opts?: BuildOpts): {
  useCase: ClarifyTurnUseCase;
  cap: Captured;
  createdTurns: unknown[];
  createdAttachments: unknown[];
} {
  const cap: Captured = {};
  const createdTurns: unknown[] = [];
  const createdAttachments: unknown[] = [];

  const session = opts && 'session' in opts ? opts.session : { id: 7n, repo: null };
  const history = opts?.history ?? [{ role: 'user', content: '帮我看看这张图' }];

  const tx = {
    // 036 T018: tx 内 user turn create 返回新建 id (UC 据此写 attachment.turnId)。
    ideaTurn: {
      create: vi.fn(async (a: unknown) => {
        createdTurns.push(a);
        return { id: 555n };
      }),
    },
    ideaAttachment: { createMany: vi.fn(async (a: unknown) => createdAttachments.push(a)) },
  };
  const prisma = {
    ideaSession: { findFirst: vi.fn().mockResolvedValue(session) },
    ideaTurn: {
      findMany: vi.fn().mockResolvedValue(history),
      create: vi.fn(async (a: { select?: unknown }) => {
        createdTurns.push(a);
        return { id: 99n };
      }),
    },
    $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<void>) => cb(tx)),
  } as unknown as PrismaService;

  const provider = recordingProvider(cap);
  const codeIndex = { search: vi.fn().mockResolvedValue([]) } as unknown as CodeIndexProvider;
  const promptConfig = {
    get: vi.fn().mockResolvedValue('persona'),
  } as unknown as PromptConfigService;

  const useCase = new ClarifyTurnUseCase(
    prisma,
    provider,
    codeIndex,
    promptConfig,
    opts?.cfg ?? ALIYUN_CFG,
  );
  return { useCase, cap, createdTurns, createdAttachments };
}

const SIGNAL = new AbortController().signal;

describe('ClarifyTurnUseCase — 036 带图轮路由 + 多模态合成', () => {
  it('带图轮 → 路由 minimax + 当前轮 content 为 MsgPart[] (text + image_url)', async () => {
    // history 末条 user = 刚落的本轮 (真流程: landed before findMany), content 与 param 一致。
    const { useCase, cap } = build({ history: [{ role: 'user', content: '看这里' }] });
    await useCase.execute(
      {
        accountId: 42n,
        sessionId: 7n,
        content: '看这里',
        attachmentKeys: ['ideation/42/uuid/img'],
        annotationText: '1：天空改蓝',
        signal: SIGNAL,
      },
      NOOP_CALLBACKS,
    );

    expect(cap.model).toBe('minimax');
    const lastUser = cap.messages!.filter((m) => m.role === 'user').at(-1)!;
    expect(Array.isArray(lastUser.content)).toBe(true);
    const parts = lastUser.content as Exclude<Msg['content'], string>;
    expect(parts).toContainEqual({ type: 'text', text: '看这里\n\n1：天空改蓝' });
    expect(parts).toContainEqual({
      type: 'image_url',
      image_url: { url: 'https://mbw-imgs.oss-cn-shanghai.aliyuncs.com/ideation/42/uuid/img' },
    });
  });

  it('纯文本轮 → 路由 pro + content 维持 string (零回归 SC-005)', async () => {
    const { useCase, cap, createdAttachments } = build();
    await useCase.execute(
      { accountId: 42n, sessionId: 7n, content: '纯文字', signal: SIGNAL },
      NOOP_CALLBACKS,
    );

    expect(cap.model).toBe('pro');
    const lastUser = cap.messages!.filter((m) => m.role === 'user').at(-1)!;
    expect(typeof lastUser.content).toBe('string');
    expect(createdAttachments).toHaveLength(0);
  });

  it('send-once: 历史带图轮在后续轮组上下文时 MUST NOT 重注 image (仅当前轮注图)', async () => {
    // 历史含一条早先 user 轮 + assistant 回复; 本轮再发一张新图。历史 user 轮必为纯 string。
    const { useCase, cap } = build({
      history: [
        { role: 'user', content: '第一轮(曾带图)' },
        { role: 'assistant', content: '助手回复' },
        { role: 'user', content: '本轮' },
      ],
    });
    await useCase.execute(
      {
        accountId: 42n,
        sessionId: 7n,
        content: '本轮',
        attachmentKeys: ['ideation/42/u2/img'],
        signal: SIGNAL,
      },
      NOOP_CALLBACKS,
    );

    const userMsgs = cap.messages!.filter((m) => m.role === 'user');
    // 历史 user 轮 (第一条) 为纯 string (无 image_url 重注)。
    expect(typeof userMsgs[0].content).toBe('string');
    // 当前轮 (最后一条) 为多模态 MsgPart[] (含 image_url)。
    expect(Array.isArray(userMsgs.at(-1)!.content)).toBe(true);
    const imageParts = cap
      .messages!.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((p) => p.type === 'image_url');
    expect(imageParts).toHaveLength(1);
  });

  it('落 IdeaAttachment 引用 (createMany) 与 user turn 同 $transaction', async () => {
    const { useCase, createdAttachments } = build();
    await useCase.execute(
      {
        accountId: 42n,
        sessionId: 7n,
        content: '看这里',
        attachmentKeys: ['ideation/42/uuid/img'],
        signal: SIGNAL,
      },
      NOOP_CALLBACKS,
    );
    expect(createdAttachments).toHaveLength(1);
    // 036 T018: turnId = 当轮 tx 内新建 user turn id (555n stub)，关联具体轮。
    expect(createdAttachments[0]).toEqual({
      data: [
        {
          sessionId: 7n,
          accountId: 42n,
          turnId: 555n,
          ossKey: 'ideation/42/uuid/img',
          kind: 'image',
        },
      ],
    });
  });

  it('attachmentKey 前缀不属本 account → 字节级一致 404 (FR-013)', async () => {
    const { useCase } = build();
    await expect(
      useCase.execute(
        {
          accountId: 42n,
          sessionId: 7n,
          content: '看这里',
          attachmentKeys: ['ideation/99/uuid/img'],
          signal: SIGNAL,
        },
        NOOP_CALLBACKS,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('他人/不存在 session → 404 (沿既有反枚举)', async () => {
    const { useCase } = build({ session: null });
    await expect(
      useCase.execute(
        { accountId: 42n, sessionId: 999n, content: 'x', signal: SIGNAL },
        NOOP_CALLBACKS,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
