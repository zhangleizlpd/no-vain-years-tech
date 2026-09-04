import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';

// 074 锚域搜索 IT (真 PG + 收窄 boot + 真 HTTP)。
//
// ## 为什么**必须**要真 PG + 真 HTTP —— 逐条都是 mock **结构上抓不到**的
//
// 1. **pg_trgm `%` / `similarity()` 与 GIN 索引只活在真 PG** —— 相似路的命中与排序第二键
//    在 mock 里只能是「mock 返回值本身」。
// 2. **ILIKE `ESCAPE` 的字面语义是 PG 端行为** (plan D4 的有意偏离) —— `%` / `_` 到底当
//    通配符还是字面, 只有真引擎会回答。
// 3. **路由吞没 (`anchors/search` vs `anchors/:id`) 是 HTTP 路由层的事** (plan D1) ——
//    typecheck / controller 单测两边全绿, 只有真 Fastify 路由树能证伪 (T004 臂 ①)。
// 4. **域判据 = 两张真表的 INNER JOIN** —— 「未建锚不出现 / 孤锚不出现」要在真 join 上验。
//
// PG 取自 `setupIsolatedDb()` (共享 PG 模板克隆, 禁自起容器); Redis 用 stub 覆盖
// (RedisLifecycle 惰性连接, 覆盖后零 socket, 体例同 optionsdesk-046.detail.it.spec.ts)。
// 请求经 `app.inject()` 走完整 lifecycle: Guards → ValidationPipe → Controller → Filter。
describe('074 锚域搜索 IT (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let token: string;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.AUTH_JWT_SECRET = 'optionsdesk-074-it-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'optionsdesk-074-it-hmac-secret-min-32-bytes';
    // 本地 shell 常泄漏 MARKETDATA_PROVIDER=live 与 OSS_* 部署凭据 → 两者的 config 分支要求
    // 整组 env 齐备, 缺一个就在 boot 期 ZodError (CI 干净, 只有本地中招)。
    process.env.MARKETDATA_PROVIDER = 'mock';
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OSS_')) delete process.env[key];
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([OptionsdeskModule]),
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // 与 main.ts 同形态 —— 通道层不做特例。
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    const account = await prisma.account.create({
      data: { phone: '+8613810000074', status: 'ACTIVE' },
    });
    token = moduleRef.get(JwtTokenService).signAccessToken({ accountId: account.id });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change, marketdata.instrument RESTART IDENTITY CASCADE',
    );
  });

  // ── fixture helpers ────────────────────────────────────────────────────────

  interface InstrumentFixture {
    market: string;
    code: string;
    name: string;
    pinyinAbbr?: string | null;
    pinyinFull?: string | null;
  }

  async function seedInstrument(f: InstrumentFixture): Promise<void> {
    await prisma.instrument.create({
      data: {
        market: f.market,
        code: f.code,
        name: f.name,
        type: 'stock',
        currency: f.market === 'hk' ? 'HKD' : 'USD',
        status: 'active',
        pinyinAbbr: f.pinyinAbbr ?? null,
        pinyinFull: f.pinyinFull ?? null,
      },
    });
  }

  async function seedAnchor(
    ticker: string,
    over: { lLevelEffective?: string; excluded?: boolean } = {},
  ): Promise<void> {
    await prisma.anchor.create({
      data: {
        ticker,
        market: ticker.split(':')[0]!,
        v: '50',
        asof: day('2026-06-30'),
        method: 'dcf',
        confidence: '8',
        confidenceSource: 'manual',
        lLevelEffective: over.lLevelEffective ?? 'L2',
        excluded: over.excluded ?? false,
        excludeReason: over.excluded === true ? '暂不交易' : null,
        nextReview: day('2099-01-01'),
        lastReviewedOn: day('2026-06-30'),
      },
    });
  }

  /**
   * 标准搜索域夹具 (T003 钉的必含项):
   * - 拼音列齐备的港股 (腾讯) + 带点代码 (`us:BRK.B`, US1-AS3)
   * - 同名跨市场双票 (阿里巴巴 us+hk)
   * - excluded=true 的锚 (可口可乐)
   * - **已注册 instrument 但未建锚**的票 (百事) —— 域反例
   * - name=code 的注册表占位行 (hk:01024)
   * - **孤锚** (`us:GHOST`: 锚在、注册行不在) —— 域判据另半边, 也是 JOIN→LEFT JOIN
   *   变异的观测面 (没有它, 变异后没有任何臂会红)
   */
  async function seedSearchUniverse(): Promise<void> {
    await seedInstrument({
      market: 'hk',
      code: '00700',
      name: '腾讯控股',
      pinyinAbbr: 'txkg',
      pinyinFull: 'tengxunkonggu',
    });
    await seedAnchor('hk:00700', { lLevelEffective: 'L2' });

    await seedInstrument({ market: 'us', code: 'BRK.B', name: '伯克希尔B', pinyinAbbr: 'bkxeb' });
    await seedAnchor('us:BRK.B', { lLevelEffective: 'L1' });

    await seedInstrument({
      market: 'us',
      code: 'BABA',
      name: '阿里巴巴',
      pinyinAbbr: 'albb',
      pinyinFull: 'alibaba',
    });
    await seedAnchor('us:BABA');
    await seedInstrument({
      market: 'hk',
      code: '09988',
      name: '阿里巴巴',
      pinyinAbbr: 'albb',
      pinyinFull: 'alibaba',
    });
    await seedAnchor('hk:09988');

    await seedInstrument({ market: 'us', code: 'KO', name: '可口可乐', pinyinAbbr: 'kkkl' });
    await seedAnchor('us:KO', { excluded: true });

    // 已注册但未建锚 —— MUST NOT 出现在任何结果里 (FR-004 / state_branch 5)。
    await seedInstrument({ market: 'us', code: 'PEP', name: '百事', pinyinAbbr: 'bs' });

    // 注册表占位行: name = code (universe 还没轮到它填真名)。
    await seedInstrument({ market: 'hk', code: '01024', name: '01024' });
    await seedAnchor('hk:01024');

    // 孤锚: 锚在、注册行不在 ⇒ INNER JOIN 的另半边把它挡在域外。
    await seedAnchor('us:GHOST');
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────────

  interface SearchItem {
    ticker: string;
    name: string;
    lLevelEffective: string;
  }

  const search = (q?: string) =>
    app.inject({
      method: 'GET',
      url:
        q === undefined
          ? '/api/v1/optionsdesk/anchors/search'
          : `/api/v1/optionsdesk/anchors/search?q=${encodeURIComponent(q)}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const itemsOf = (res: { body: string }): SearchItem[] =>
    (JSON.parse(res.body) as { items: SearchItem[] }).items;

  const tickersOf = (res: { body: string }) => itemsOf(res).map((i) => i.ticker);

  // ── T003: 搜索域与匹配行为六臂 ─────────────────────────────────────────────

  describe('T003 搜索域与匹配行为 (FR-003/FR-004/FR-005, state_branches 3/5/6/10)', () => {
    it('① 六路输入形态各自命中: 中文名 / 单汉字 / 简拼 / 全拼 / 代码前缀(带点) / 全 ticker 前缀', async () => {
      await seedSearchUniverse();

      // 中文名 (整名 + Edge「单个汉字」)
      expect(tickersOf(await search('腾讯控股'))).toContain('hk:00700');
      expect(tickersOf(await search('腾'))).toContain('hk:00700');
      // 拼音简拼 / 全拼 (FR-003)
      expect(tickersOf(await search('txkg'))).toContain('hk:00700');
      expect(tickersOf(await search('tengxun'))).toContain('hk:00700');
      // 交易所代码前缀, 含带点形态 (US1-AS3 `BRK.B`)
      expect(tickersOf(await search('BRK.'))).toContain('us:BRK.B');
      // canonical ticker 前缀 (谓词第 ④ 路: 代码前缀路够不到冒号形态)
      expect(tickersOf(await search('hk:007'))).toContain('hk:00700');

      // 提示行三字段与徽标值 (FR-006 服务端半边)
      const hit = itemsOf(await search('腾讯控股')).find((i) => i.ticker === 'hk:00700')!;
      expect(hit.name).toBe('腾讯控股');
      expect(hit.lLevelEffective).toBe('L2');
    });

    it('② 同名跨市场双命中 —— hk+us 两行都在 (无 market 过滤, state_branch 10 服务端半边)', async () => {
      await seedSearchUniverse();

      const tickers = tickersOf(await search('阿里巴巴'));
      expect(tickers).toContain('us:BABA');
      expect(tickers).toContain('hk:09988');
    });

    it('③ 域判据 = 锚 JOIN 注册表: 已注册未建锚不出现, 孤锚 (无注册行) 也不出现', async () => {
      await seedSearchUniverse();

      // 已注册 instrument 但未建锚 (state_branch 5): 名与代码两路都够不到。
      expect(tickersOf(await search('百事'))).toEqual([]);
      expect(tickersOf(await search('PEP'))).toEqual([]);
      // 孤锚: 唯一能够到它的是 ticker 前缀路, INNER JOIN 把它挡掉 —— 这一半正是
      // 「JOIN 改 LEFT JOIN」变异的观测面 (LEFT JOIN 会让它带着 null 名字漏出来)。
      expect(tickersOf(await search('us:GHOST'))).toEqual([]);
    });

    it('④ excluded=true 的锚照常命中, 提示行零额外标记字段 (Clarifications 2026-09-03, state_branch 6)', async () => {
      await seedSearchUniverse();

      const items = itemsOf(await search('可口可乐'));
      const ko = items.find((i) => i.ticker === 'us:KO');
      expect(ko).toBeDefined();
      // 响应行**恰好**三字段 —— 不加 excluded 等任何新标记 (搜索是定位通道不是可动区镜头)。
      expect(Object.keys(ko!).sort()).toEqual(['lLevelEffective', 'name', 'ticker']);
    });

    it('⑤ 零命中 ⇒ 200 + items: [] (非 404, state_branch 4 服务端半边)', async () => {
      await seedSearchUniverse();

      const res = await search('不存在的锚xyz');
      expect(res.statusCode).toBe(200);
      expect(itemsOf(res)).toEqual([]);
    });

    it('⑥ name=code 的注册表占位行照实返回代号 (plan D5, 不拼假名、不特判)', async () => {
      await seedSearchUniverse();

      const items = itemsOf(await search('01024'));
      const hit = items.find((i) => i.ticker === 'hk:01024');
      expect(hit).toBeDefined();
      expect(hit!.name).toBe('01024');
    });
  });

  // ── T004: 协议与边界六臂 ───────────────────────────────────────────────────

  describe('T004 协议与边界 (FR-011, plan D1/D4, state_branches 1/3, Edge)', () => {
    it('① 🚨 路由防吞: /anchors/search 返 200 搜索响应, 不被 anchors/:id 吞成 404', async () => {
      // 钉住「search 是可达的独立路由」: 一旦它从路由表上消失 / 改名 / 前缀漂移, 这个 URL 会
      // 落进 `anchors/:id` → parseAnchorId('search') 折叠 404 —— typecheck / controller 单测
      // 两边全绿, 只有这一臂能抓 (变异证红: @Get 改 'anchors/searchX' ⇒ 本臂 404 红)。
      // ⚠️ 实测订正 (2026-09-04 本 IT 变异): plan D1 设想的「声明序在 :id 之后即被吞」在当前
      // Fastify (find-my-way) 上**未复现** —— 静态段优先于参数段, 挪后仍 200。本臂钉的是
      // 200 语义本身, 不锚定 router 的实现细节。
      const res = await search('x');
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(itemsOf(res))).toBe(true);
    });

    it('② 排序三键: 代码精确命中排第一 → 相似度 → 代码序 (FR-011)', async () => {
      // 四票同吃 code ILIKE 'AOS%' 前缀路:
      //   AOS  = 代码精确命中 (第一键);
      //   AOSA 名含 'AOS' ⇒ trgm 相似度 > 0 (第二键);
      //   AOSB / AOSC 同名 ⇒ 相似度并列, 靠 i.code ASC 拆序 (第三键)。
      for (const [code, name] of [
        ['AOSC', '平凡二号'],
        ['AOSB', '平凡二号'],
        ['AOSA', 'AOS Group'],
        ['AOS', '平凡一号'],
      ] as const) {
        await seedInstrument({ market: 'us', code, name });
        await seedAnchor(`us:${code}`);
      }

      expect(tickersOf(await search('AOS'))).toEqual(['us:AOS', 'us:AOSA', 'us:AOSB', 'us:AOSC']);
    });

    it('③ 命中数 > 20 ⇒ 截断到 20 (FR-011 单页上限, 无翻页)', async () => {
      for (let n = 1; n <= 21; n++) {
        const code = `Q${String(n).padStart(2, '0')}`;
        await seedInstrument({ market: 'us', code, name: `占位${code}` });
        await seedAnchor(`us:${code}`);
      }

      const res = await search('Q');
      expect(res.statusCode).toBe(200);
      expect(itemsOf(res)).toHaveLength(20);
    });

    it('④ `%` / `_` 字面匹配 (Edge「元字符字面」—— escapeLike + ESCAPE 在真 PG 上的落点)', async () => {
      await seedSearchUniverse();
      await seedInstrument({ market: 'us', code: 'PCT', name: 'A%B特殊' });
      await seedAnchor('us:PCT');
      await seedInstrument({ market: 'us', code: 'UND', name: 'X_Y特殊' });
      await seedAnchor('us:UND');

      // 字面语义的强断言: 裸 '%' / '_' 只命中名字**真含**该字符的行。若转义被拆掉
      // (对齐回参照 adapter), '%' 变 ILIKE 通配 ⇒ 整个夹具域全命中, 这两条当场红。
      expect(tickersOf(await search('A%B'))).toEqual(['us:PCT']);
      expect(tickersOf(await search('%'))).toEqual(['us:PCT']);
      expect(tickersOf(await search('_'))).toEqual(['us:UND']);
    });

    it('⑤ 超长 q 按 64 字符截断后正常匹配, 不 500 (Edge「超长输入」)', async () => {
      const longName = 'Y'.repeat(80); // varchar(128) 内
      await seedInstrument({ market: 'us', code: 'LONG', name: longName });
      await seedAnchor('us:LONG');

      const res = await search('Y'.repeat(100)); // 截断后 64 个 Y, 是 80 个 Y 的子串
      expect(res.statusCode).toBe(200);
      expect(tickersOf(res)).toContain('us:LONG');
    });

    it('⑥ q 空 / 纯空白 / 缺参 ⇒ items: [] 且零 SQL (state_branch 1 服务端半边)', async () => {
      await seedSearchUniverse();

      const spy = vi.spyOn(prisma, '$queryRaw');
      try {
        for (const res of [await search(''), await search('   '), await search()]) {
          expect(res.statusCode).toBe(200);
          expect(itemsOf(res)).toEqual([]);
        }
        // 短路发生在 use case 入口 —— 空输入连一条 SQL 都不该发。
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});
