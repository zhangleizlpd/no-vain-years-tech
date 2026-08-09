import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AuthModule } from '../../src/auth/auth.module';
import { PortfolioModule } from '../../src/portfolio/portfolio.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 013 T010 全 boot IT — 覆盖 spec frontmatter state_branches 每条 (US1 分组 CRUD + US2 自选项):
//  ① groups(new user) 零写库投影恰 2 系统组 / ② groups(custom) 全 CRUD + dup 400 /
//  ③ system group rename·delete → 422 / ④ reorder+visibility 持久化 / ⑤ items list shape (无行情) /
//  ⑥ holdings group 派生只读 V1 空(即便结构挂了 item) / ⑦ item ops 固顶常驻顶 + 移到最前在固顶下方 +
//  改组 + 删 / ⑧ holdings item delete → 422 / 删非空自定义组 item 回落自选(冲突幂等) /
//  反枚举 401(未认证/非 ACTIVE 字节级一致) / 限流 429(读 121 / 写 61 边界)。
// beforeEach redis flushall 隔离限流桶 (读/写桶共享 per-account key)。
describe('013 watchlist US1+US2 (Testcontainers PG + Redis + Fastify)', () => {
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
    process.env.AUTH_JWT_SECRET = 'watchlist-t010-jwt-secret-min-32-bytes-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'watchlist-t010-hmac-secret-min-32-bytes-z';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule, PortfolioModule],
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
  const nextPhone = () => `+8613813${String(++seq).padStart(6, '0')}`;
  async function activeToken(): Promise<{ id: bigint; token: string }> {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    return { id: acc.id, token: jwt.signAccessToken({ accountId: acc.id }) };
  }

  interface GroupItem {
    id: string;
    name: string;
    type: 'system' | 'custom';
    systemKind: 'watchlist' | 'holdings' | null;
    visible: boolean;
    order: number;
    itemCount: number;
  }
  interface ItemView {
    id: string;
    groupId: string;
    market: string;
    code: string;
    pinned: boolean;
    order: number;
    color: string | null;
    noteRef: string | null;
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const authJson = (token: string) => ({ ...auth(token), 'content-type': 'application/json' });

  const listGroups = (token: string) =>
    app.inject({ method: 'GET', url: '/api/v1/portfolio/watchlist-groups', headers: auth(token) });
  const createGroup = (token: string, name: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/portfolio/watchlist-groups',
      headers: authJson(token),
      payload: { name },
    });
  const renameGroup = (token: string, groupId: string, name: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/portfolio/watchlist-groups/${groupId}`,
      headers: authJson(token),
      payload: { name },
    });
  const deleteGroup = (token: string, groupId: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/portfolio/watchlist-groups/${groupId}`,
      headers: auth(token),
    });
  const reorderGroups = (
    token: string,
    ordered: Array<{ groupId: string; order: number; visible: boolean }>,
  ) =>
    app.inject({
      method: 'PATCH',
      url: '/api/v1/portfolio/watchlist-groups',
      headers: authJson(token),
      payload: { ordered },
    });
  const listItems = (token: string, groupId: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/portfolio/watchlist-groups/${groupId}/items`,
      headers: auth(token),
    });
  const addItem = (token: string, groupId: string, market: string, code: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/portfolio/watchlist-groups/${groupId}/items`,
      headers: authJson(token),
      payload: { market, code },
    });
  const patchItem = (token: string, itemId: string, body: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/portfolio/watchlist-items/${itemId}`,
      headers: authJson(token),
      payload: body,
    });
  const deleteItem = (token: string, itemId: string) =>
    app.inject({
      method: 'DELETE',
      url: `/api/v1/portfolio/watchlist-items/${itemId}`,
      headers: auth(token),
    });

  const groupsOf = (res: { json: () => unknown }) => (res.json() as { groups: GroupItem[] }).groups;
  const itemsOf = (res: { json: () => unknown }) => (res.json() as { items: ItemView[] }).items;
  const findGroup = (groups: GroupItem[], kind: 'watchlist' | 'holdings') =>
    groups.find((g) => g.systemKind === kind)!;

  // ── ① groups (new user): 零写库投影恰 2 系统组 ────────────────────────────
  it('① 新账号 GET → 恰 2 系统组「自选」「我的持仓」(零写库投影, order/visible 固定)', async () => {
    const { id, token } = await activeToken();
    const groups = groupsOf(await listGroups(token));
    expect(groups).toHaveLength(2);

    const wl = findGroup(groups, 'watchlist');
    const hold = findGroup(groups, 'holdings');
    expect(wl).toMatchObject({
      id: 'watchlist',
      name: '自选',
      type: 'system',
      visible: true,
      order: 0,
      itemCount: 0,
    });
    expect(hold).toMatchObject({
      id: 'holdings',
      name: '我的持仓',
      type: 'system',
      visible: true,
      order: 1,
      itemCount: 0,
    });

    // 零写库: GET 后 DB 仍无任何 group 行 (D2)。
    expect(await prisma.group.count({ where: { accountId: id } })).toBe(0);
  });

  // ── ② groups (custom): 全 CRUD + per-account 去重 ─────────────────────────
  it('② 建自定义组 → type=custom + materialize 2 系统组; 重名 → 400 FORM_VALIDATION', async () => {
    const { id, token } = await activeToken();
    const groups = groupsOf(await createGroup(token, '科技股'));
    const custom = groups.find((g) => g.type === 'custom');
    expect(custom).toMatchObject({ name: '科技股', type: 'custom', systemKind: null });
    // 首写 materialize: 2 系统组 + 1 自定义 = 3 真实行。
    expect(groups).toHaveLength(3);
    expect(await prisma.group.count({ where: { accountId: id } })).toBe(3);

    const dup = await createGroup(token, '科技股');
    expect(dup.statusCode).toBe(400);
    expect((dup.json() as { code: string }).code).toBe('FORM_VALIDATION');
  });

  it('② 重命名自定义组 → 名更新', async () => {
    const { token } = await activeToken();
    const created = groupsOf(await createGroup(token, '旧名'));
    const custom = created.find((g) => g.type === 'custom')!;
    const renamed = groupsOf(await renameGroup(token, custom.id, '新名'));
    expect(renamed.find((g) => g.id === custom.id)!.name).toBe('新名');
  });

  it('② 删自定义组 → 组消失, 系统组保留', async () => {
    const { token } = await activeToken();
    const created = groupsOf(await createGroup(token, '待删'));
    const custom = created.find((g) => g.type === 'custom')!;
    const after = groupsOf(await deleteGroup(token, custom.id));
    expect(after.some((g) => g.id === custom.id)).toBe(false);
    expect(after.filter((g) => g.type === 'system')).toHaveLength(2);
  });

  // ── ③ system group rename / delete → 422 (keyword + 真实行两形态) ─────────
  it('③ 系统组改名/删除 → 422 SYSTEM_GROUP_PROTECTED (keyword + materialize 后真实行)', async () => {
    const { token } = await activeToken();
    // keyword 形 (未 materialize)。
    expect((await renameGroup(token, 'watchlist', 'x')).statusCode).toBe(422);
    expect((await deleteGroup(token, 'holdings')).statusCode).toBe(422);

    // materialize 后用真实数字 id 仍拒。
    const groups = groupsOf(await createGroup(token, '触发 materialize'));
    const wlReal = findGroup(groups, 'watchlist');
    const renameRes = await renameGroup(token, wlReal.id, 'x');
    expect(renameRes.statusCode).toBe(422);
    expect((renameRes.json() as { code: string }).code).toBe('SYSTEM_GROUP_PROTECTED');
    expect((await deleteGroup(token, wlReal.id)).statusCode).toBe(422);
  });

  it('③ 改名未知组 vs 他人组 → 404 字节级一致 (反枚举)', async () => {
    const { token } = await activeToken();
    const other = await activeToken();
    const otherGroups = groupsOf(await createGroup(other.token, '他人组'));
    const otherCustom = otherGroups.find((g) => g.type === 'custom')!;

    const unknown = await renameGroup(token, '888888888888', 'x');
    const cross = await renameGroup(token, otherCustom.id, 'x');
    expect(unknown.statusCode).toBe(404);
    expect(cross.statusCode).toBe(404);
    const strip = (raw: string) => {
      const { traceId, instance, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      void traceId;
      void instance;
      return rest;
    };
    expect(strip(unknown.body)).toEqual(strip(cross.body));
  });

  // ── ④ reorder + visibility 持久化 ────────────────────────────────────────
  it('④ 拖拽序 + 隐藏切换 → 持久化 (keyword 首拖即 materialize)', async () => {
    const { token } = await activeToken();
    // 新账号直接对 keyword 拖拽: 持仓置顶 order 0、自选 order 1 且隐藏。
    const reordered = groupsOf(
      await reorderGroups(token, [
        { groupId: 'holdings', order: 0, visible: true },
        { groupId: 'watchlist', order: 1, visible: false },
      ]),
    );
    const wl = findGroup(reordered, 'watchlist');
    const hold = findGroup(reordered, 'holdings');
    expect(hold.order).toBe(0);
    expect(wl.order).toBe(1);
    expect(wl.visible).toBe(false);

    // 重新 GET 验持久化。
    const refetched = groupsOf(await listGroups(token));
    expect(findGroup(refetched, 'watchlist').visible).toBe(false);
    expect(findGroup(refetched, 'holdings').order).toBe(0);
  });

  // ── ⑤ items list shape (无行情值) + ⑥ holdings V1 空 ─────────────────────
  it('⑤ 加自选 → GET items shape {market,code,pinned,order,color,noteRef} 无行情值', async () => {
    const { token } = await activeToken();
    await addItem(token, 'watchlist', 'cn', '600519');
    const items = itemsOf(await listItems(token, 'watchlist'));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      market: 'cn',
      code: '600519',
      pinned: false,
      order: 0,
      color: null,
      noteRef: null,
    });
    // 行情值 (最新/涨幅/涨跌) 不在契约 (ADR-0048): view 仅这些 key。
    expect(Object.keys(items[0]!).sort()).toEqual(
      ['code', 'color', 'groupId', 'id', 'market', 'noteRef', 'order', 'pinned'].sort(),
    );
  });

  it('⑥ 持仓组派生只读 → GET items V1 空 (即便结构上挂了 item)', async () => {
    const { id, token } = await activeToken();
    // 直建持仓真实组 + 挂一项 (绕 API, 模拟未来 holdings/import 落库)。
    const hold = await prisma.group.create({
      data: {
        accountId: id,
        name: '持仓',
        type: 'system',
        systemKind: 'holdings',
        visible: true,
        order: 1,
      },
    });
    await prisma.watchlistItem.create({
      data: { groupId: hold.id, market: 'cn', code: '000001', pinned: false, order: 0 },
    });
    // keyword 与真实 id 两路径都返空 (派生只读视图)。
    expect(itemsOf(await listItems(token, 'holdings'))).toHaveLength(0);
    expect(itemsOf(await listItems(token, hold.id.toString()))).toHaveLength(0);
  });

  it('⑥ 加自选默认落「自选」+ 幂等 (重复 market+code → no-op)', async () => {
    const { token } = await activeToken();
    await addItem(token, 'watchlist', 'hk', '00700');
    const again = itemsOf(await addItem(token, 'watchlist', 'hk', '00700'));
    expect(again).toHaveLength(1); // 幂等: 不重复落库
  });

  it('⑥ 持仓组加自选 → 422 HOLDINGS_GROUP_READONLY; market 非法 → 400', async () => {
    const { token } = await activeToken();
    const readonly = await addItem(token, 'holdings', 'cn', '600519');
    expect(readonly.statusCode).toBe(422);
    expect((readonly.json() as { code: string }).code).toBe('HOLDINGS_GROUP_READONLY');

    const badMarket = await addItem(token, 'watchlist', 'jp', '7203');
    expect(badMarket.statusCode).toBe(400);
  });

  // ── ⑦ item ops: 固顶常驻顶 + 移到最前在固顶下方 + 改组 + 删 ─────────────
  it('⑦ 固顶常驻顶 > 非固顶区; 移到最前落在固顶项下方 (FR-S05)', async () => {
    const { token } = await activeToken();
    await addItem(token, 'watchlist', 'cn', 'A'); // order 0
    await addItem(token, 'watchlist', 'cn', 'B'); // order 1
    const cItems = itemsOf(await addItem(token, 'watchlist', 'cn', 'C')); // order 2
    const idByCode = new Map(cItems.map((i) => [i.code, i.id]));

    // 固顶 C → C 常驻顶。
    await patchItem(token, idByCode.get('C')!, { pinned: true });
    let items = itemsOf(await listItems(token, 'watchlist'));
    expect(items.map((i) => i.code)).toEqual(['C', 'A', 'B']);
    expect(items[0]).toMatchObject({ code: 'C', pinned: true });

    // 非固顶项 B「移到最前」→ 落非固顶区头部 = 固顶 C 下方。
    await patchItem(token, idByCode.get('B')!, { move: 'front' });
    items = itemsOf(await listItems(token, 'watchlist'));
    expect(items.map((i) => i.code)).toEqual(['C', 'B', 'A']);
    expect(items.find((i) => i.code === 'B')!.pinned).toBe(false);
  });

  it('⑦ 改归属组 → item 移到目标组 (源移出、目标接入)', async () => {
    const { token } = await activeToken();
    const created = groupsOf(await createGroup(token, '目标组'));
    const target = created.find((g) => g.type === 'custom')!;
    const added = itemsOf(await addItem(token, 'watchlist', 'us', 'AAPL'));
    const itemId = added[0]!.id;

    await patchItem(token, itemId, { targetGroupId: target.id });
    expect(itemsOf(await listItems(token, 'watchlist'))).toHaveLength(0);
    const inTarget = itemsOf(await listItems(token, target.id));
    expect(inTarget.map((i) => i.code)).toEqual(['AAPL']);
  });

  it('⑦ 删自选项 → 组内不再含 + 剩余稠密化', async () => {
    const { token } = await activeToken();
    await addItem(token, 'watchlist', 'cn', 'X');
    const added = itemsOf(await addItem(token, 'watchlist', 'cn', 'Y'));
    const yId = added.find((i) => i.code === 'Y')!.id;
    const after = itemsOf(await deleteItem(token, yId));
    expect(after.map((i) => i.code)).toEqual(['X']);
    expect(after[0]!.order).toBe(0);
  });

  // ── ⑧ holdings item delete → 422 + 删非空自定义组回落自选 ─────────────────
  it('⑧ 持仓组派生项删除 → 422 HOLDINGS_GROUP_READONLY (防御性, V1 不可达)', async () => {
    const { id, token } = await activeToken();
    const hold = await prisma.group.create({
      data: {
        accountId: id,
        name: '持仓',
        type: 'system',
        systemKind: 'holdings',
        visible: true,
        order: 1,
      },
    });
    const held = await prisma.watchlistItem.create({
      data: { groupId: hold.id, market: 'cn', code: '000001', pinned: false, order: 0 },
    });
    const res = await deleteItem(token, held.id.toString());
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe('HOLDINGS_GROUP_READONLY');
  });

  it('⑧ 删非空自定义组 → item 回落「自选」不丢 (冲突项幂等丢弃, FR-S02)', async () => {
    const { token } = await activeToken();
    const created = groupsOf(await createGroup(token, '临时组'));
    const custom = created.find((g) => g.type === 'custom')!;
    // 自选已有 cn:600519; 自定义组含 cn:600519 (冲突) + cn:600036 (独有)。
    await addItem(token, 'watchlist', 'cn', '600519');
    await addItem(token, custom.id, 'cn', '600519');
    await addItem(token, custom.id, 'cn', '600036');

    await deleteGroup(token, custom.id);
    const wlItems = itemsOf(await listItems(token, 'watchlist'));
    const codes = wlItems.map((i) => i.code).sort();
    expect(codes).toEqual(['600036', '600519']); // 冲突项不重复, 独有项迁入
  });

  // ── 反枚举 401 (未认证 / 非 ACTIVE 字节级一致) ───────────────────────────
  it('未认证 vs 非 ACTIVE → 均 401 字节级一致 (反枚举)', async () => {
    const frozen = await prisma.account.create({ data: { phone: nextPhone(), status: 'FROZEN' } });
    const frozenToken = jwt.signAccessToken({ accountId: frozen.id });

    const noAuth = await app.inject({ method: 'GET', url: '/api/v1/portfolio/watchlist-groups' });
    const nonActive = await listGroups(frozenToken);
    expect(noAuth.statusCode).toBe(401);
    expect(nonActive.statusCode).toBe(401);
    const strip = (raw: string) => {
      const { traceId, ...rest } = JSON.parse(raw) as Record<string, unknown>;
      void traceId;
      return rest;
    };
    expect(strip(noAuth.body)).toEqual(strip(nonActive.body));
  });

  // ── 限流 429 (读 121 / 写 61 边界, D5) ───────────────────────────────────
  it('限流: GET 第 121 次 → 429 (读桶 120/60s)', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 121; i += 1) last = await listGroups(token);
    expect(last!.statusCode).toBe(429);
    expect(Number(last!.headers['retry-after'])).toBeGreaterThan(0);
  });

  // 61 个串行请求空闲 ~1s, 但全套件并行满载时可超 vitest 默认 5s → 显式放宽防 flake。
  it('限流: 写第 61 次 → 429 (写桶 60/60s, POST/PATCH/DELETE 共享)', async () => {
    const { token } = await activeToken();
    let last;
    for (let i = 0; i < 61; i += 1) last = await createGroup(token, `g${i}`); // 撞重名 400 但计入桶
    expect(last!.statusCode).toBe(429);
  }, 15_000);
});
