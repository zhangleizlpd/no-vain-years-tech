import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { ChatModule } from '../../src/chat/chat.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { SendMessageUseCase } from '../../src/chat/send-message.usecase';
import {
  LLM_PROVIDER,
  type LlmProvider,
  type LlmStreamEvent,
  type LlmStreamOptions,
} from '../../src/integrations/llm/llm-provider.port';
import { FakeLlmProvider } from '../../src/integrations/llm/fake-llm.provider';
import type { Msg } from '../../src/chat/chat-context.rules';

// 029 T003 全 boot IT (真 DI + Testcontainers PG/Redis, per plan「NO LIFECYCLE
// MOCKING」)。验 send-message 按 conversation.model 路由所选逻辑 model 给 LlmProvider:
//  ① 会话 model=pro → provider 收逻辑 model 'pro' /
//  ② 会话 model=flash → provider 收 'flash' /
//  ③ 会话 model=legacy (deepseek-chat) → 归一化为默认 flash (不传 legacy 给 provider)。
// 用 SwappableFakeProvider 记录 lastModel (opts.model) 断言路由来源随会话变。
describe('029 send-message model routing (Testcontainers PG + Redis)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let provider: SwappableFakeProvider;
  let sendMessage: SendMessageUseCase;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'chat-t003-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t003-hmac-secret-min-32-bytes-zyxw';
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-placeholder-key';

    provider = new SwappableFakeProvider();
    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([ChatModule]) })
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .compile();
    // send-message UC 直调 (UC 层路由验证, 不经 HTTP/SSE — controller 写 SSE 不影响 model 路由)。
    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    sendMessage = moduleRef.get(SendMessageUseCase);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await stores.drop();
  });

  const nextPhone = () => `+8613917${String(++seq).padStart(6, '0')}`;
  async function activeAccount(): Promise<bigint> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return acc.id;
  }
  async function seedConversation(accountId: bigint, model: string): Promise<bigint> {
    const c = await prisma.conversation.create({
      data: { accountId, title: '会话', model },
      select: { id: true },
    });
    return c.id;
  }
  function runSend(accountId: bigint, conversationId: bigint) {
    return sendMessage.execute(
      { accountId, conversationId, content: '你好', signal: new AbortController().signal },
      () => undefined,
    );
  }

  // ── ① 会话 model=pro → provider 收逻辑 model 'pro' ─────────────────────────
  it('① 会话 model=pro → LlmProvider 收逻辑 model "pro"', async () => {
    const acc = await activeAccount();
    const cid = await seedConversation(acc, 'pro');
    const out = await runSend(acc, cid);
    expect(out.kind).toBe('completed');
    expect(provider.lastModel).toBe('pro');
  });

  // ── ② 会话 model=flash → provider 收 'flash' ──────────────────────────────
  it('② 会话 model=flash → LlmProvider 收逻辑 model "flash"', async () => {
    const acc = await activeAccount();
    const cid = await seedConversation(acc, 'flash');
    await runSend(acc, cid);
    expect(provider.lastModel).toBe('flash');
  });

  // ── ③ 会话 model=legacy (deepseek-chat) → 归一化默认 flash ─────────────────
  it('③ 会话 model=deepseek-chat (legacy) → 归一化为默认 flash 传 provider', async () => {
    const acc = await activeAccount();
    const cid = await seedConversation(acc, 'deepseek-chat');
    await runSend(acc, cid);
    expect(provider.lastModel).toBe('flash');
  });
});

/** 单 DI override fake, 记录最后收到的逻辑 model (opts.model) 供路由断言。 */
class SwappableFakeProvider implements LlmProvider {
  private inner = new FakeLlmProvider({ tokens: ['ok'] });
  lastModel: string | undefined;

  stream(messages: Msg[], opts: LlmStreamOptions): AsyncIterable<LlmStreamEvent> {
    this.lastModel = opts.model;
    return this.inner.stream(messages, opts);
  }
}
