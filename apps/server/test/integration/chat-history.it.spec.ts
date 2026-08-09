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

// 028 T004 全 boot 跨端点穷举 IT (真 DI 容器 + Testcontainers PG/Redis + Fastify, per
// plan「NO LIFECYCLE MOCKING」: JwtAuthGuard / AccountIdThrottlerGuard 绝不 jest.mock /
// new XxxGuard())。这是 spec state_branches ×12 的 server 段集中验证 —— 跨 list/rename/
// delete/get-messages 四端点串起来打, 与 Group A per-UC 单测有意重叠 (那是单端点视角,
// 本 IT 是会话生命周期端到端视角)。
//
// 覆盖 server 可验的 11 分支 (新建不落库 / 删当前回空态 / 流中切换中断 = mobile 侧 T009/T010):
//  ① 列表按 updatedAt 分组数据 (排序/字段) + 仅本人 /
//  ② 空历史 → [] (不报错) /
//  ③ 切换取消息 hydrate (复用 027 get-messages) /
//  ④ 改名空拒 400 (保留原标题) /
//  ⑤ 改名越权 404 (字节级一致) /
//  ⑥ 删除连带 (message 表清空验证) /
//  ⑦ 删除越权 404 /
//  ⑧ 搜索命中仅标题 (insensitive 子串) /
//  ⑨ 搜索清空回全量 /
//  ⑩ 未认证 401 (四端点) /
//  ⑪ 越权 404 字节级一致 (list 不串话 + rename/delete/messages 四端点同一一致体)。
describe('028 chat history — cross-endpoint state_branches (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'chat-t004-jwt-secret-min-32-bytes-abcdef';
    process.env.SMS_CODE_HMAC_SECRET = 'chat-t004-hmac-secret-min-32-bytes-zyxwv';

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
    await redis.flushall(); // 隔离限流桶
  });

  // ── helpers ───────────────────────────────────────────────────────────────
  const nextPhone = () => `+8613919${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

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
  interface MessageView {
    id: string;
    role: string;
    content: string;
    status: string;
    createdAt: string;
  }

  const listConversations = (token: string, query = '') =>
    app.inject({ method: 'GET', url: `/api/v1/chat/conversations${query}`, headers: auth(token) });
  const listMessages = (token: string, id: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${id}/messages`,
      headers: auth(token),
    });
  const rename = (token: string, id: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/chat/conversations/${id}`,
      headers: authJson(token),
      payload,
    });
  const del = (token: string, id: string) =>
    app.inject({ method: 'DELETE', url: `/api/v1/chat/conversations/${id}`, headers: auth(token) });

  const listOf = (res: { json: () => unknown }) => res.json() as ListView;
  const messagesOf = (res: { json: () => unknown }) =>
    (res.json() as { messages: MessageView[] }).messages;

  /** ProblemDetail 字节级一致比较 (剥动态 traceId/instance)。 */
  const strip = (raw: string) => {
    const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    void traceId;
    void instance;
    return rest;
  };

  const at = (iso: string) => new Date(iso);

  /** 种一批会话 (显式 updatedAt 拉开多条同毫秒撞序; @updatedAt 走 raw 绕过)。 */
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
      await prisma.$executeRaw`UPDATE "chat"."conversation" SET "updated_at" = ${s.updatedAt} WHERE "id" = ${row.id}`;
      ids.push(row.id);
    }
    return ids;
  }

  async function seedMessages(
    conversationId: bigint,
    msgs: { role: string; content: string }[],
  ): Promise<void> {
    for (const m of msgs) {
      await prisma.message.create({
        data: { conversationId, role: m.role, content: m.content, status: 'completed' },
      });
    }
  }

  // ── ① 列表按 updatedAt 分组数据 (排序/字段) + 仅本人 ─────────────────────────
  it('① 列表按 updatedAt desc 返回分组数据 (id/title/model/updatedAt 字段齐); 仅本人 accountId', async () => {
    const me = await activeToken();
    const other = await activeToken();
    await seedConversations(me.id, [
      { title: '上月话题', updatedAt: at('2026-05-20T00:00:00.000Z') }, // 更早分组数据
      { title: '上周话题', updatedAt: at('2026-06-08T00:00:00.000Z') }, // 前30天
      { title: '今日话题', updatedAt: at('2026-06-14T00:00:00.000Z') }, // 前7天
    ]);
    await seedConversations(other.id, [
      { title: '别人最新', updatedAt: at('2026-06-14T12:00:00.000Z') },
    ]);

    const list = listOf(await listConversations(me.token));
    // 排序: updatedAt desc (客户端按此分桶 前7天/前30天/更早)
    expect(list.items.map((i) => i.title)).toEqual(['今日话题', '上周话题', '上月话题']);
    // 字段齐全 (客户端分组依赖 updatedAt; model 只读展示)
    for (const item of list.items) {
      expect(item.id).toMatch(/^\d+$/);
      expect(typeof item.title).toBe('string');
      expect(item.model).toBe('deepseek-chat');
      expect(typeof item.updatedAt).toBe('string');
      expect(Number.isNaN(Date.parse(item.updatedAt))).toBe(false);
    }
    // 不串话: 他人会话不出现
    expect(list.items.map((i) => i.title)).not.toContain('别人最新');
  });

  // ── ② 空历史 → [] (不报错) ─────────────────────────────────────────────────
  it('② 无任何历史会话 → 200 空列表, 无 nextCursor (空态可渲染)', async () => {
    const me = await activeToken();
    const res = await listConversations(me.token);
    expect(res.statusCode).toBe(200);
    const list = listOf(res);
    expect(list.items).toEqual([]);
    expect(list.nextCursor).toBeUndefined();
  });

  // ── ③ 切换取消息 hydrate (复用 027 get-messages) ───────────────────────────
  it('③ 点历史会话 → get-messages 按插入序 hydrate 完整历史 (复用 027)', async () => {
    const me = await activeToken();
    const [cid] = await seedConversations(me.id, [
      { title: '茅台分析', updatedAt: at('2026-06-10T00:00:00.000Z') },
    ]);
    await seedMessages(cid!, [
      { role: 'user', content: '帮我分析贵州茅台' },
      { role: 'assistant', content: '好的, 茅台...' },
      { role: 'user', content: '估值怎么样' },
    ]);

    const msgs = messagesOf(await listMessages(me.token, cid!.toString()));
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']); // id asc = 插入序
    expect(msgs.map((m) => m.content)).toEqual(['帮我分析贵州茅台', '好的, 茅台...', '估值怎么样']);
  });

  // ── ④ 改名空拒 400 (保留原标题) ────────────────────────────────────────────
  it('④ 改名提交空 / 纯空白 title → 400; 原标题保留 (列表行不变)', async () => {
    const me = await activeToken();
    const [cid] = await seedConversations(me.id, [
      { title: '原始标题', updatedAt: at('2026-06-12T00:00:00.000Z') },
    ]);

    const empty = await rename(me.token, cid!.toString(), { title: '' });
    const blank = await rename(me.token, cid!.toString(), { title: '   ' });
    expect(empty.statusCode).toBe(400);
    expect(blank.statusCode).toBe(400);

    // 原标题保留 (落库 + 列表行均未变)
    const row = await prisma.conversation.findUnique({ where: { id: cid! } });
    expect(row?.title).toBe('原始标题');
    const list = listOf(await listConversations(me.token));
    expect(list.items[0]!.title).toBe('原始标题');
  });

  // ── ⑤ 改名越权 404 (字节级一致) ────────────────────────────────────────────
  it('⑤ 改名他人会话 → 404, 与 messages 端点 404 字节级一致; 他人标题未被改', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const [theirs] = await seedConversations(other.id, [
      { title: '别人的会话', updatedAt: at('2026-06-13T00:00:00.000Z') },
    ]);

    const renameRes = await rename(me.token, theirs!.toString(), { title: '试图改名' });
    expect(renameRes.statusCode).toBe(404);
    const msgsRes = await listMessages(me.token, theirs!.toString());
    expect(strip(renameRes.body)).toEqual(strip(msgsRes.body));

    const row = await prisma.conversation.findUnique({ where: { id: theirs! } });
    expect(row?.title).toBe('别人的会话');
  });

  // ── ⑥ 删除连带 (message 表清空验证) ────────────────────────────────────────
  it('⑥ 删除 → 204; conversation + 其全部 message 单事务连带物理删 (防孤儿)', async () => {
    const me = await activeToken();
    const [cid] = await seedConversations(me.id, [
      { title: '待删会话', updatedAt: at('2026-06-11T00:00:00.000Z') },
    ]);
    await seedMessages(cid!, [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    expect(await prisma.message.count({ where: { conversationId: cid! } })).toBe(3);

    const res = await del(me.token, cid!.toString());
    expect(res.statusCode).toBe(204);

    expect(await prisma.conversation.findUnique({ where: { id: cid! } })).toBeNull();
    expect(await prisma.message.count({ where: { conversationId: cid! } })).toBe(0); // 无孤儿
    // 删后 get-messages → 404 (不可再访问)
    expect((await listMessages(me.token, cid!.toString())).statusCode).toBe(404);
    // 列表移除该行
    expect(listOf(await listConversations(me.token)).items).toEqual([]);
  });

  // ── ⑦ 删除越权 404 ────────────────────────────────────────────────────────
  it('⑦ 删除他人会话 → 404; 他人会话 + 消息未被波及', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const [theirs] = await seedConversations(other.id, [
      { title: '别人待删', updatedAt: at('2026-06-13T00:00:00.000Z') },
    ]);
    await seedMessages(theirs!, [{ role: 'user', content: 'x' }]);

    const delRes = await del(me.token, theirs!.toString());
    expect(delRes.statusCode).toBe(404);

    expect(await prisma.conversation.findUnique({ where: { id: theirs! } })).not.toBeNull();
    expect(await prisma.message.count({ where: { conversationId: theirs! } })).toBe(1);
  });

  // ── ⑧ 搜索命中仅标题 (insensitive 子串) ────────────────────────────────────
  it('⑧ q 按 title 模糊子串 (大小写不敏感) 命中; 不搜 message 正文', async () => {
    const me = await activeToken();
    const [tencentCid] = await seedConversations(me.id, [
      { title: '腾讯财报解读', updatedAt: at('2026-06-09T00:00:00.000Z') },
      { title: '分析 MAOTAI 走势', updatedAt: at('2026-06-10T00:00:00.000Z') },
      { title: 'maotai 估值', updatedAt: at('2026-06-12T00:00:00.000Z') },
    ]);
    // 在「腾讯」会话里塞含 "maotai" 的消息正文 —— 验搜索不命中正文 (仅标题)。
    await seedMessages(tencentCid!, [{ role: 'user', content: '顺便聊聊 maotai' }]);

    const hit = listOf(await listConversations(me.token, '?q=maotai'));
    expect(hit.items.map((i) => i.title).sort()).toEqual(['maotai 估值', '分析 MAOTAI 走势']);
    // 标题不含 maotai 的「腾讯财报解读」不出现 (即便其消息正文含 maotai)
    expect(hit.items.map((i) => i.title)).not.toContain('腾讯财报解读');
  });

  // ── ⑨ 搜索清空回全量 ──────────────────────────────────────────────────────
  it('⑨ 搜索清空 (无 q) → 回到完整时间分组列表 (全量)', async () => {
    const me = await activeToken();
    await seedConversations(me.id, [
      { title: '腾讯财报', updatedAt: at('2026-06-09T00:00:00.000Z') },
      { title: '茅台估值', updatedAt: at('2026-06-12T00:00:00.000Z') },
      { title: '宁德时代', updatedAt: at('2026-06-13T00:00:00.000Z') },
    ]);

    // 先搜 → 筛子集
    expect(listOf(await listConversations(me.token, '?q=茅台')).items.map((i) => i.title)).toEqual([
      '茅台估值',
    ]);
    // 清空 → 全量回归
    const full = listOf(await listConversations(me.token));
    expect(full.items.map((i) => i.title)).toEqual(['宁德时代', '茅台估值', '腾讯财报']);
  });

  // ── ⑩ 未认证 → 401 (四端点) ────────────────────────────────────────────────
  it('⑩ 未认证 → 四端点均 401 (抽屉不加载列表)', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/chat/conversations' });
    const msgs = await app.inject({ method: 'GET', url: '/api/v1/chat/conversations/1/messages' });
    const ren = await app.inject({
      method: 'PATCH',
      url: '/api/v1/chat/conversations/1',
      headers: { 'content-type': 'application/json' },
      payload: { title: 'x' },
    });
    const rem = await app.inject({ method: 'DELETE', url: '/api/v1/chat/conversations/1' });
    expect([list.statusCode, msgs.statusCode, ren.statusCode, rem.statusCode]).toEqual([
      401, 401, 401, 401,
    ]);
  });

  // ── ⑪ 越权 404 字节级一致 (四端点同一一致体, 不串话) ───────────────────────
  it('⑪ 他人 / 不存在 / 非数字 id → messages·rename·delete 四路 404 字节级一致 (反枚举)', async () => {
    const me = await activeToken();
    const other = await activeToken();
    const [theirs] = await seedConversations(other.id, [
      { title: '别人专属', updatedAt: at('2026-06-13T00:00:00.000Z') },
    ]);

    const crossMsg = await listMessages(me.token, theirs!.toString());
    const crossRename = await rename(me.token, theirs!.toString(), { title: 'x' });
    const crossDel = await del(me.token, theirs!.toString());
    const unknownMsg = await listMessages(me.token, '888888888888');
    const nonNumericMsg = await listMessages(me.token, 'abc');

    for (const r of [crossMsg, crossRename, crossDel, unknownMsg, nonNumericMsg]) {
      expect(r.statusCode).toBe(404);
    }
    // 跨端点 + 跨 id 形态 (他人 / 不存在 / 非数字) 全字节级一致 (单一反枚举一致体)
    const ref = strip(crossMsg.body);
    expect(strip(crossRename.body)).toEqual(ref);
    expect(strip(crossDel.body)).toEqual(ref);
    expect(strip(unknownMsg.body)).toEqual(ref);
    expect(strip(nonNumericMsg.body)).toEqual(ref);

    // 列表层不串话: me 的列表里看不到他人会话
    expect(listOf(await listConversations(me.token)).items).toEqual([]);
  });
});
