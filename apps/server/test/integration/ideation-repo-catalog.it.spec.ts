import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { IdeationModule } from '../../src/ideation/ideation.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import {
  CODE_INDEX,
  type CodeIndexProvider,
  type CodeChunk,
  type RepoCatalogEntry,
} from '../../src/integrations/codeindex/code-index.module';

/**
 * 034 T005 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
 * 「NO LIFECYCLE MOCKING」)。覆盖 GET /ideation/repos (可接地仓目录, 经 CODE_INDEX 端口):
 *  ① 列 repo: status / lastSha / chunkCount / indexedAt 透传 /
 *  ② 端口不可达 → 503 CODE_INDEX_UNAVAILABLE (非裸 500, 不泄露内部细节) /
 *  ③ 空列表 → items: [] / ④ 未认证 → 401。
 *
 * CODE_INDEX 经 DI override 注一个可切换配置的确定性 fake (不 jest.mock, per plan)。
 */
type FakeState = { repos: RepoCatalogEntry[]; unreachable: boolean };

describe('034 ideation repo-catalog (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  // 可切换的 fake 配置 (每个 it 重置 → 驱动列表 / 空态 / 不可达)。
  const fakeState: FakeState = { repos: [], unreachable: false };
  const fakeCodeIndex: CodeIndexProvider = {
    async search(_repo: string, _query: string): Promise<CodeChunk[]> {
      if (fakeState.unreachable) throw new Error('FAKE_UNREACHABLE');
      return [];
    },
    async listRepos(): Promise<RepoCatalogEntry[]> {
      if (fakeState.unreachable) throw new Error('FAKE_UNREACHABLE');
      return fakeState.repos;
    },
  };

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'ideation-t005-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'ideation-t005-hmac-secret-min-32-bytes-zy';

    moduleRef = await Test.createTestingModule({ imports: narrowTestModule([IdeationModule]) })
      .overrideProvider(CODE_INDEX)
      .useValue(fakeCodeIndex)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    redis = moduleRef.get(REDIS_CLIENT);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  beforeEach(async () => {
    await redis.flushall();
    fakeState.repos = [];
    fakeState.unreachable = false;
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613916${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<string> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return jwt.signAccessToken({ accountId: acc.id });
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const getRepos = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/ideation/repos', headers: auth(token) });

  // ── ① 列 repo (透传) ────────────────────────────────────────────────────────
  it('① GET repos → 200, 列 repo 透传 status / lastSha / chunkCount / indexedAt', async () => {
    fakeState.repos = [
      {
        repo: 'no-vain-years-mono',
        lastSha: 'a1b2c3d',
        indexedAt: '2026-06-22T00:00:00.000Z',
        chunkCount: 1280,
        status: 'ready',
      },
      {
        repo: 'agent-platform',
        lastSha: 'e4f5g6h',
        indexedAt: '2026-06-21T12:00:00.000Z',
        chunkCount: 640,
        status: 'indexing',
      },
    ];
    const token = await activeToken();
    const res = await getRepos(token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: RepoCatalogEntry[] };
    expect(body.items).toEqual(fakeState.repos);
    expect(body.items[0].status).toBe('ready');
    expect(body.items[1].status).toBe('indexing');
  });

  // ── ② 端口不可达 → 503 (非裸 500, 不泄露细节) ───────────────────────────────
  it('② code-index 不可达 → 503 CODE_INDEX_UNAVAILABLE (非裸 500, 不泄露内部)', async () => {
    fakeState.unreachable = true;
    const token = await activeToken();
    const res = await getRepos(token);
    expect(res.statusCode).toBe(503); // 可重试错误态, 非 500
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.code).toBe('CODE_INDEX_UNAVAILABLE');
    // 不泄露底层错误细节 (token / stack / FAKE_UNREACHABLE 内部串)
    expect(JSON.stringify(body)).not.toContain('FAKE_UNREACHABLE');
    expect(JSON.stringify(body)).not.toContain('stack');
  });

  // ── ③ 空列表 → [] ───────────────────────────────────────────────────────────
  it('③ catalog 空 → 200, items: []', async () => {
    fakeState.repos = [];
    const token = await activeToken();
    const res = await getRepos(token);
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { items: unknown[] }).items).toEqual([]);
  });

  // ── ④ 未认证 → 401 ─────────────────────────────────────────────────────────
  it('④ 未认证 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ideation/repos' });
    expect(res.statusCode).toBe(401);
  });
});
