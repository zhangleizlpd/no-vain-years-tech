import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ChatModule } from '../../src/chat/chat.module';
import { narrowTestModule } from '../_support/narrow-boot';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 028 T001 全 boot IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per plan
// Architecture Notes「NO LIFECYCLE MOCKING」)。覆盖 GET /chat/conversations:
//  ① 默认页倒序 (updatedAt desc, id desc) + 只返本人 accountId /
//  ② cursor 翻页不重不漏 (复合游标稳定分页) /
//  ③ q 命中 insensitive 子串 / ④ q 无命中 → [] / ⑤ 空账号 → [] /
//  ⑥ 未认证 → 401 / ⑦ 非法 cursor → 当首页 (不报错)。
describe('028 list conversations (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let redis: Redis;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'chat-t001-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t001-hmac-secret-min-32-bytes-zyxwv';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([ChatModule]),
    }).compile();
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
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613916${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  interface ListItem {
    id: string;
    title: string;
    model: string;
    updatedAt: string;
  }
  interface ListView {
    items: ListItem[];
    nextCursor?: string;
  }

  const listConversations = (token: string, query = '') =>
    app.inject({ method: 'GET', url: `/api/v1/chat/conversations${query}`, headers: auth(token) });
  const listOf = (res: { json: () => unknown }) => res.json() as ListView;

  /**
   * 种一批会话, 用显式 updatedAt 保证排序确定 (@updatedAt 在 create 时默认 now(),
   * 多条同毫秒会撞 → 直接 createMany 后逐条 update updatedAt 拉开)。
   */
  async function seedConversations(
    accountId: bigint,
    specs: { title: string; updatedAt: Date }[],
  ): Promise<bigint[]> {
    const ids: bigint[] = [];
    for (const s of specs) {
      const row = await prisma.conversation.create({
        data: { accountId, title: s.title, model: 'deepseek-chat' },
        select: { id: true },
      });
      // @updatedAt 只在 update data 含其他列时不动它; 直接 set updatedAt 需 updateMany 绕 @updatedAt。
      await prisma.$executeRaw`UPDATE "chat"."conversation" SET "updated_at" = ${s.updatedAt} WHERE "id" = ${row.id}`;
      ids.push(row.id);
    }
    return ids;
  }

  const at = (iso: string) => new Date(iso);

  // ── ① 默认页倒序 + 只返本人 ────────────────────────────────────────────────
  it('① 默认页按 (updatedAt desc, id desc) 倒序; 仅返本人 accountId', async () => {
    const me = await activeToken();
    const other = await activeToken();
    await seedConversations(me.id, [
      { title: '最早', updatedAt: at('2026-06-01T00:00:00.000Z') },
      { title: '居中', updatedAt: at('2026-06-10T00:00:00.000Z') },
      { title: '最近', updatedAt: at('2026-06-14T00:00:00.000Z') },
    ]);
    await seedConversations(other.id, [
      { title: '别人的', updatedAt: at('2026-06-13T00:00:00.000Z') },
    ]);

    const list = listOf(await listConversations(me.token));
    expect(list.items.map((i) => i.title)).toEqual(['最近', '居中', '最早']);
    expect(list.items.every((i) => i.id.match(/^\d+$/))).toBe(true);
    expect(list.items.every((i) => typeof i.updatedAt === 'string')).toBe(true);
    // 不含他人会话
    expect(list.items.map((i) => i.title)).not.toContain('别人的');
  });

  // ── ② cursor 翻页不重不漏 ──────────────────────────────────────────────────
  it('② cursor 翻页: 逐页累加全量, 不重不漏 (含同 updatedAt 行靠 id 区分)', async () => {
    const me = await activeToken();
    // 5 条; 其中两条同 updatedAt → 验复合游标二级 id 区分。
    await seedConversations(me.id, [
      { title: 'A', updatedAt: at('2026-06-05T00:00:00.000Z') },
      { title: 'B', updatedAt: at('2026-06-05T00:00:00.000Z') }, // 同 updatedAt
      { title: 'C', updatedAt: at('2026-06-06T00:00:00.000Z') },
      { title: 'D', updatedAt: at('2026-06-07T00:00:00.000Z') },
      { title: 'E', updatedAt: at('2026-06-08T00:00:00.000Z') },
    ]);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const q = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = listOf(await listConversations(me.token, q));
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor && ++guard < 10);

    expect(seen).toHaveLength(5); // 全量
    expect(new Set(seen).size).toBe(5); // 无重复
    // 顺序: E(08) D(07) C(06) 然后 06-05 两条 (B,A id desc)。
    const titlesByOrder = ['E', 'D', 'C'];
    const fullList = listOf(await listConversations(me.token, '?limit=50'));
    expect(fullList.items.slice(0, 3).map((i) => i.title)).toEqual(titlesByOrder);
    expect(fullList.nextCursor).toBeUndefined();
  });

  // ── ③ q 命中 insensitive 子串 ──────────────────────────────────────────────
  it('③ q 命中标题模糊子串 (大小写不敏感)', async () => {
    const me = await activeToken();
    await seedConversations(me.id, [
      { title: '分析 MAOTAI 走势', updatedAt: at('2026-06-10T00:00:00.000Z') },
      { title: '腾讯财报', updatedAt: at('2026-06-11T00:00:00.000Z') },
      { title: 'maotai 估值', updatedAt: at('2026-06-12T00:00:00.000Z') },
    ]);
    const list = listOf(await listConversations(me.token, '?q=maotai'));
    expect(list.items.map((i) => i.title).sort()).toEqual(['maotai 估值', '分析 MAOTAI 走势']);
  });

  // ── ④ q 无命中 → [] ────────────────────────────────────────────────────────
  it('④ q 无任何标题命中 → 空列表 (不报错)', async () => {
    const me = await activeToken();
    await seedConversations(me.id, [
      { title: '腾讯财报', updatedAt: at('2026-06-11T00:00:00.000Z') },
    ]);
    const res = await listConversations(me.token, '?q=不存在的关键词');
    expect(res.statusCode).toBe(200);
    expect(listOf(res).items).toEqual([]);
  });

  // ── ⑤ 空账号 → [] ──────────────────────────────────────────────────────────
  it('⑤ 无任何会话的账号 → 空列表', async () => {
    const me = await activeToken();
    const res = await listConversations(me.token);
    expect(res.statusCode).toBe(200);
    const list = listOf(res);
    expect(list.items).toEqual([]);
    expect(list.nextCursor).toBeUndefined();
  });

  // ── ⑥ 未认证 → 401 ─────────────────────────────────────────────────────────
  it('⑥ 未认证 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/chat/conversations' });
    expect(res.statusCode).toBe(401);
  });

  // ── ⑦ 非法 cursor → 当首页 (不报错) ────────────────────────────────────────
  it('⑦ 非法 cursor → 回退首页, 不报错', async () => {
    const me = await activeToken();
    await seedConversations(me.id, [{ title: '唯一', updatedAt: at('2026-06-11T00:00:00.000Z') }]);
    const res = await listConversations(me.token, '?cursor=not-a-valid-cursor');
    expect(res.statusCode).toBe(200);
    expect(listOf(res).items.map((i) => i.title)).toEqual(['唯一']);
  });
});
