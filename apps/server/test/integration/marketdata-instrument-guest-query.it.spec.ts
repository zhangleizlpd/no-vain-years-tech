import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedStores } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { MarketdataModule } from '../../src/marketdata/marketdata.module';
import { PrismaService } from '../../src/security/prisma.service';
import { guestUploadConfig } from '../../src/config';
import { INSTRUMENT_BASICS_MAX_CODES } from '../../src/marketdata/instrument-query.rules';

/**
 * guest 通道标的查询 IT（Testcontainers PG + Redis + 收窄 boot + 真 HTTP）。
 *
 * ## 为什么必须真 HTTP 而不是直接调 use case
 *
 * 本片验的一半东西只存在于通道面：鉴权三态、`market` / `codes` 的 400 可区分性、
 * **其它动词根本不存在**。直接 new use case 一条都测不到。
 *
 * ## 本文件承担的对账职责
 *
 * 通道层 nginx 有一份**独立文本**的市场白名单与字符集闸（`$arg_market` / `$arg_codes`）。
 * 两份会漂，钉住它俩的是：本文件的三市场断言（服务端一半）+ `verify-guards.sh` 闸 9 的
 * 反例（通道一半）。**只跑一侧等于只验了半条判据。**
 *
 * 🚨 **NO LIFECYCLE MOCKING**：整个 `MarketdataModule` 进真 DI 容器，`GuestUploadAuthGuard`
 * 在真实 lifecycle 里跑；只有 `guestUploadConfig`（token 的值）被 `useValue` 换掉。
 */
const UPLOAD_TOKEN = 'g'.repeat(43);

const CODES_PATH = '/api/v1/marketdata/instrument-codes';
const BASICS_PATH = '/api/v1/marketdata/instrument-basics';

/**
 * 🚨 registry 里**真实存在**的特殊形态（2026-08-22 本机实测 us 侧 112 条）。种进去是为了让
 * 「枚举口发出去的串，批量口必须认」这条端到端成立 —— 照 `/option-snapshot` 那道
 * `[A-Za-z0-9.,-]` 闸原样抄，这几条会被自己的接口 400 拒掉。
 */
const US_ODD_CODES = ['WFC_Z', 'BHVN*', 'PSUS/PS', 'SPGIw'] as const;

describe('guest 通道标的查询 IT (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  const get = (url: string, token: string | null = UPLOAD_TOKEN) =>
    app.inject({
      method: 'GET',
      url,
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'marketdata-guest-query-jwt-secret-min-32-bytes';
    process.env.SMS_CODE_HMAC_SECRET = 'marketdata-guest-query-hmac-secret-min-32-byt';
    delete process.env.MARKETDATA_PROVIDER; // mock boot 干净（同 marketdata.search.it.spec.ts）

    moduleRef = await Test.createTestingModule({
      imports: narrowTestModule([MarketdataModule]),
    })
      .overrideProvider(guestUploadConfig.KEY)
      .useValue({ token: UPLOAD_TOKEN })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);

    await prisma.instrument.createMany({
      data: [
        // cn / hk：理杏仁供 listingStatus + listDate，字段近乎全覆盖。
        {
          market: 'cn',
          code: '600519',
          name: '贵州茅台',
          type: 'stock',
          currency: 'CNY',
          status: 'active',
          listingStatus: 'normally_listed',
          listDate: new Date('2001-08-27T00:00:00Z'),
        },
        {
          market: 'cn',
          code: '000002',
          name: '万科A',
          type: 'stock',
          currency: 'CNY',
          status: 'inactive',
          listingStatus: 'delisted',
          delistDate: new Date('2026-01-15T00:00:00Z'),
        },
        {
          market: 'cn',
          code: '510300',
          name: '沪深300ETF',
          type: 'etf',
          currency: 'CNY',
          status: 'active',
        },
        {
          market: 'hk',
          code: '00700',
          name: '腾讯控股',
          type: 'stock',
          currency: 'HKD',
          status: 'active',
          listingStatus: 'normally_listed',
          listDate: new Date('2004-06-16T00:00:00Z'),
        },
        // us：东财 universe 不供 listingStatus / listDate ⇒ 恒 null（**不代表退市**）。
        {
          market: 'us',
          code: 'AOS',
          name: 'A. O. Smith',
          type: 'stock',
          currency: 'USD',
          status: 'active',
        },
        {
          market: 'us',
          code: 'BRK.B',
          name: 'Berkshire B',
          type: 'stock',
          currency: 'USD',
          status: 'active',
        },
        // 占位行：universe 收录了但尚未富化到名（us 侧实测 555 条）。
        {
          market: 'us',
          code: 'ZZZP',
          name: 'ZZZP',
          type: 'stock',
          currency: 'USD',
          status: 'active',
        },
        ...US_ODD_CODES.map((code) => ({
          market: 'us',
          code,
          name: `odd ${code}`,
          type: 'stock',
          currency: 'USD',
          status: 'active',
        })),
      ],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  // ── 鉴权：两个口各拒一次（闸是逐端点写的）────────────────────────────────────
  describe('通道凭证', () => {
    it('无 token → 401（两个口）', async () => {
      expect((await get(`${CODES_PATH}?market=us`, null)).statusCode).toBe(401);
      expect((await get(`${BASICS_PATH}?market=us&codes=AOS`, null)).statusCode).toBe(401);
    });

    it('token 不符 → 401，且与「未配置」对外不可区分（裸 401，不泄原因）', async () => {
      const res = await get(`${CODES_PATH}?market=us`, 'x'.repeat(43));
      expect(res.statusCode).toBe(401);
      expect(JSON.stringify(res.json())).not.toMatch(/token|guest|config/i);
    });

    it('🚨 鉴权先于参数校验 —— 无 token 打坏参数仍是 401，不是 400', async () => {
      // 反过来会把这两个端点变成「参数写法」的探测器（无凭证也能问出 market 值域）。
      expect((await get(`${CODES_PATH}?market=jp`, null)).statusCode).toBe(401);
    });
  });

  // ── MUST NOT 实装其它动词（通道层 limit_except GET 是独立的第二道）──────────
  describe('只有 GET', () => {
    it('POST / DELETE 在服务端根本没有这条路由 → 404', async () => {
      for (const method of ['POST', 'DELETE'] as const) {
        const res = await app.inject({
          method,
          url: `${CODES_PATH}?market=us`,
          headers: { authorization: `Bearer ${UPLOAD_TOKEN}` },
        });
        expect(res.statusCode).toBe(404);
      }
    });
  });

  // ── 枚举口 ────────────────────────────────────────────────────────────────
  describe('instrument-codes 枚举口', () => {
    it('三个市场各自可枚举（服务端这一半的市场白名单对账）', async () => {
      for (const [market, expected] of [
        ['cn', ['510300', '600519']],
        ['hk', ['00700']],
      ] as const) {
        const res = await get(`${CODES_PATH}?market=${market}`);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ market, count: expected.length, codes: expected });
      }
      const us = await get(`${CODES_PATH}?market=us`);
      expect(us.statusCode).toBe(200);
      expect((us.json() as { market: string }).market).toBe('us');
    });

    it('count 与 codes 长度恒一致（调方的自检钩子）', async () => {
      const body = (await get(`${CODES_PATH}?market=us`)).json() as {
        count: number;
        codes: string[];
      };
      expect(body.count).toBe(body.codes.length);
    });

    it('codes 升序，且是**裸 code**（不带 market: 前缀）', async () => {
      const { codes } = (await get(`${CODES_PATH}?market=us`)).json() as { codes: string[] };
      expect(codes).toEqual([...codes].sort());
      expect(codes.every((c) => !c.includes(':'))).toBe(true);
    });

    it('缺省只返 active —— 响应里没有 status 字段可区分已退市标的', async () => {
      const { codes } = (await get(`${CODES_PATH}?market=cn`)).json() as { codes: string[] };
      expect(codes).not.toContain('000002');
    });

    it('status=all 显式要全量时才带上已退市的', async () => {
      const { codes } = (await get(`${CODES_PATH}?market=cn&status=all`)).json() as {
        codes: string[];
      };
      expect(codes).toContain('000002');
    });

    it('type 过滤', async () => {
      const { codes } = (await get(`${CODES_PATH}?market=cn&type=etf`)).json() as {
        codes: string[];
      };
      expect(codes).toEqual(['510300']);
    });

    it('market 缺失 / 大写 / 未知 → 400 FORM_VALIDATION（原因可区分）', async () => {
      for (const url of [CODES_PATH, `${CODES_PATH}?market=US`, `${CODES_PATH}?market=jp`]) {
        const res = await get(url);
        expect(res.statusCode).toBe(400);
        expect((res.json() as { code: string }).code).toBe('FORM_VALIDATION');
      }
    });

    it('status 未知值 → 400（不静默回落到缺省）', async () => {
      expect((await get(`${CODES_PATH}?market=cn&status=listed`)).statusCode).toBe(400);
    });
  });

  // ── 批量口 ────────────────────────────────────────────────────────────────
  describe('instrument-basics 批量口', () => {
    it('命中项字段齐全；cn 侧 listDate 按 YYYY-MM-DD 序列化（不差一天）', async () => {
      // @db.Date 读回来是 UTC 零点；用本地时区格式化会整体差一天**且不报错**。
      const res = await get(`${BASICS_PATH}?market=cn&codes=600519`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        market: 'cn',
        items: [
          {
            symbol: 'cn:600519',
            market: 'cn',
            code: '600519',
            name: '贵州茅台',
            type: 'stock',
            currency: 'CNY',
            status: 'active',
            listingStatus: 'normally_listed',
            listDate: '2001-08-27',
            delistDate: null,
          },
        ],
        missing: [],
      });
    });

    it('🚨 us 侧 listingStatus / listDate 恒 null —— 这不是「查无此票」，missing[] 才是', async () => {
      const body = (await get(`${BASICS_PATH}?market=us&codes=AOS,NOSUCH`)).json() as {
        items: { code: string; listDate: string | null; listingStatus: string | null }[];
        missing: string[];
      };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({ code: 'AOS', listDate: null, listingStatus: null });
      expect(body.missing).toEqual(['NOSUCH']);
    });

    it('missing 按**请求顺序**回显，调方对得上自己发出去的那一批', async () => {
      const body = (await get(`${BASICS_PATH}?market=us&codes=ZZ9,AOS,ZZ1`)).json() as {
        missing: string[];
      };
      expect(body.missing).toEqual(['ZZ9', 'ZZ1']);
    });

    it('🚨 枚举口发出去的串，批量口必须逐条认得（含 _ * / 与小写）', async () => {
      // 这条是端到端的：先枚举、再把枚举结果原样回传。字符集闸抄错时它整条红。
      const { codes } = (await get(`${CODES_PATH}?market=us`)).json() as { codes: string[] };
      const res = await get(`${BASICS_PATH}?market=us&codes=${codes.join(',')}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { code: string }[]; missing: string[] };
      expect(body.missing).toEqual([]);
      expect(body.items.map((i) => i.code).sort()).toEqual([...codes].sort());
      for (const odd of US_ODD_CODES) expect(body.items.map((i) => i.code)).toContain(odd);
    });

    it('大小写敏感、不归一 —— 小写打大写 code 进 missing 而不是被悄悄命中', async () => {
      const body = (await get(`${BASICS_PATH}?market=us&codes=aos`)).json() as {
        items: unknown[];
        missing: string[];
      };
      expect(body.items).toEqual([]);
      expect(body.missing).toEqual(['aos']);
    });

    it('市场是独立参数 ⇒ 跨市场混批在结构上不可能（cn 的 code 在 us 下查不到）', async () => {
      const body = (await get(`${BASICS_PATH}?market=us&codes=600519`)).json() as {
        missing: string[];
      };
      expect(body.missing).toEqual(['600519']);
    });

    it('codes 缺失 / 空 / 百分号编码 / 冒号前缀 → 400', async () => {
      for (const url of [
        `${BASICS_PATH}?market=us`,
        `${BASICS_PATH}?market=us&codes=`,
        `${BASICS_PATH}?market=us&codes=AOS%252CPEP`,
        `${BASICS_PATH}?market=us&codes=us:AOS`,
      ]) {
        const res = await get(url);
        expect(res.statusCode).toBe(400);
        expect((res.json() as { code: string }).code).toBe('FORM_VALIDATION');
      }
    });

    it(`超过 ${INSTRUMENT_BASICS_MAX_CODES} 个 → 400（别让它落到 PG 的 IN 里）`, async () => {
      const over = Array.from({ length: INSTRUMENT_BASICS_MAX_CODES + 1 }, (_, i) => `C${i}`);
      expect((await get(`${BASICS_PATH}?market=us&codes=${over.join(',')}`)).statusCode).toBe(400);
    });

    it('market 坏 → 400（与枚举口同一判据，两个口各校验一次）', async () => {
      expect((await get(`${BASICS_PATH}?market=jp&codes=AOS`)).statusCode).toBe(400);
    });
  });
});
