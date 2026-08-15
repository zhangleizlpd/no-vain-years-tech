import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import fastifyMultipart from '@fastify/multipart';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { ResearchModule } from '../../src/research/research.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { FakeObjectStorage } from '../../src/integrations/oss/fake-object-storage.adapter';
import { OBJECT_STORAGE_PORT } from '../../src/integrations/oss/object-storage.port';
import { guestUploadConfig, researchOssConfig, type ResearchOssConfig } from '../../src/config';
import {
  RESEARCH_MAX_BYTES,
  RESEARCH_OSS_MAX_BYTES,
} from '../../src/research/research-report.rules';

/**
 * 057 T009 研报投递端点 IT（共享 PG + 收窄 boot + 真 HTTP + fake 对象存储）。
 *
 * ## 为什么必须是真 HTTP 而不是直接调 usecase
 *
 * 本文件验的四件事**全部只存在于通道层**：① multipart 的 per-request `fileSize` 覆盖真的
 * 生效（3MB 在全局 2MB 的 multipart 注册下也能过）；② `FST_REQ_FILE_TOO_LARGE` 被 catch 在
 * 正确位置（写错位置的表现是 500 而非 413）；③ guard 在 lifecycle 里真拦得住；④ 三项必填
 * 元数据走 query 而非 form field（通道层的市场闸只读得到 query）。直接 new usecase 的话
 * 这四条一条都测不到。
 *
 * 🚨 **multipart 注册镜像 `main.ts` 的全局 2MB** —— 这是故意的：3MB → 201 这条断言的全部
 * 意义就在于证明**调用点的 `req.file({ limits })` 覆盖了全局值**。把这里改成 16MB 会让那条
 * 断言变成平凡绿，而生产上真正跑的是全局 2MB 那份配置。
 *
 * 🚨 **OSS config 走 `useValue` DI override 而非 `process.env`**：`@nestjs/config` 会跨独立
 * `Test` DI 容器缓存 provider，前一次 AppModule boot（env 未设）会把本 IT 毒化成
 * `unconfigured` ⇒ 期望 201 实得 503（既有实证见 `accounts.upload-credential-009.it.spec.ts`）。
 */
const TOKEN = 'g'.repeat(43);

const ALIYUN_OSS: ResearchOssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'nvy-research-oss-it',
  accessKeyId: 'LTAI-it-fake-ak',
  accessKeySecret: 'it-fake-sk',
};

const BOUNDARY = '----t009researchingest';

/** 造一份指定大小的合法 PDF（`%PDF-` 魔数开头 + 填充）。 */
function pdfOfSize(bytes: number, marker = 'x'): Buffer {
  const head = Buffer.from('%PDF-1.4\n');
  const tail = Buffer.from('\n%%EOF\n');
  const fill = Buffer.alloc(Math.max(0, bytes - head.length - tail.length), marker);
  return Buffer.concat([head, fill, tail]);
}

function multipartBody(file: { filename: string; mime: string; data: Buffer } | null): Buffer {
  const chunks: Buffer[] = [];
  if (file) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.mime}\r\n\r\n`,
      ),
    );
    chunks.push(file.data, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

describe('057 T009 研报投递端点 (共享 PG + 收窄 boot + 真 HTTP)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let storage: FakeObjectStorage;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  const QUERY =
    'symbol=hk%3A01698&reportDate=2026-08-01&title=%E6%9F%90%E5%85%AC%E5%8F%B8%E7%A0%94%E6%8A%A5';

  function post(options: {
    query?: string;
    file?: { filename: string; mime: string; data: Buffer } | null;
    token?: string | null;
    guest?: string | null;
  }) {
    const headers: Record<string, string> = {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    };
    if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
    if (options.guest !== null) headers['x-guest'] = options.guest ?? 'friend1';
    return app.inject({
      method: 'POST',
      url: `/api/v1/research/reports?${options.query ?? QUERY}`,
      headers,
      payload: multipartBody(
        options.file === undefined
          ? { filename: 'report.pdf', mime: 'application/pdf', data: pdfOfSize(4096) }
          : options.file,
      ),
    });
  }

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    process.env.REDIS_URL = 'redis://127.0.0.1:6399'; // 恒不连（REDIS_CLIENT 被 stub 覆盖）
    process.env.AUTH_JWT_SECRET = 'research-057-t009-jwt-secret-min-32-bytes-long';
    process.env.SMS_CODE_HMAC_SECRET = 'research-057-t009-hmac-secret-min-32-bytes-x';
    process.env.MARKETDATA_PROVIDER = 'mock';
    // 本地 shell 常泄漏部署凭据；两组 OSS config 的分支都要求整组齐备，缺一个 boot 期 ZodError。
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OSS_') || key.startsWith('RESEARCH_OSS_')) delete process.env[key];
    }

    storage = new FakeObjectStorage();

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([ResearchModule]),
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(OBJECT_STORAGE_PORT)
      .useValue(storage)
      .overrideProvider(researchOssConfig.KEY)
      .useValue(ALIYUN_OSS)
      .overrideProvider(guestUploadConfig.KEY)
      .useValue({ token: TOKEN })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // 🚨 镜像 main.ts 的全局 2MB —— 见文件头注释，别改大。
    await app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE research.research_report RESTART IDENTITY CASCADE');
    storage.calls.length = 0;
  });

  // ── 体积天花板：这两条是 plan D-5 / Guardrail 1 的解法证明 ─────────────────────
  describe('四层体积天花板', () => {
    it('常量大小关系：multipart 上限 < OSS content-length-range 上界（让中间那层先跳闸）', () => {
      // nginx 的 client_max_body_size 20m 在 services/guest-proxy 侧（T012），三者关系是
      // nginx(20MB) > OSS(17MB) > multipart(16MB)：唯一能给干净 ProblemDetail 的是 multipart 那层。
      expect(RESEARCH_MAX_BYTES).toBeLessThan(RESEARCH_OSS_MAX_BYTES);
      expect(RESEARCH_OSS_MAX_BYTES).toBeLessThan(20 * 1024 * 1024);
    });

    it('3MB → 201：调用点的 fileSize 覆盖真的生效（全局 multipart 只有 2MB）', async () => {
      const res = await post({
        file: { filename: 'big.pdf', mime: 'application/pdf', data: pdfOfSize(3 * 1024 * 1024) },
      });
      expect(res.statusCode).toBe(201);
    });

    it('17MB → 413（超 16MB 上限，且是 413 不是 500 —— 证明 catch 在 toBuffer 那一侧）', async () => {
      const res = await post({
        file: { filename: 'huge.pdf', mime: 'application/pdf', data: pdfOfSize(17 * 1024 * 1024) },
      });
      expect(res.statusCode).toBe(413);
      expect(await prisma.researchReport.count()).toBe(0);
    });
  });

  // ── 鉴权（state_branch 11 / 12）────────────────────────────────────────────
  describe('通道凭证', () => {
    it('无 Authorization → 401', async () => {
      const res = await post({ token: null });
      expect(res.statusCode).toBe(401);
      expect(storage.calls).toHaveLength(0);
    });

    it('凭证不符 → 401，且与「缺失」剥掉 traceId 后逐字节不可区分', async () => {
      // traceId 逐请求不同（CLS 生成），按仓内反枚举纪律剥掉它再深等 —— 留着比对必然假红，
      // 但**只**剥它：任何别的字段有差异都说明两条分支对外可区分了。
      const strip = (raw: string) => {
        const { traceId: _traceId, ...rest } = JSON.parse(raw) as Record<string, unknown>;
        return rest;
      };
      const missing = await post({ token: null });
      const wrong = await post({ token: 'x'.repeat(43) });
      expect(wrong.statusCode).toBe(401);
      expect(strip(wrong.body)).toEqual(strip(missing.body));
      expect(JSON.parse(missing.body)).toHaveProperty('traceId');
    });
  });

  // ── 成功路径（state_branch 1 / 2 / 3）──────────────────────────────────────
  describe('投递成功与幂等', () => {
    it('合规投递 → 201，落一行 COMMITTED，写一个对象，返回可反查的标识', async () => {
      const res = await post({});
      expect(res.statusCode).toBe(201);
      const body = res.json() as { reportId: string; symbol: string; deduplicated: boolean };
      expect(body.symbol).toBe('hk:01698');
      expect(body.deduplicated).toBe(false);

      const row = await prisma.researchReport.findUnique({ where: { id: BigInt(body.reportId) } });
      expect(row).toMatchObject({
        symbol: 'hk:01698',
        status: 'COMMITTED',
        uploaderKind: 'guest',
        uploaderRef: 'friend1',
        source: '自研',
      });
      expect(row?.reportDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(storage.calls).toHaveLength(1);
    });

    it('同投递方重复投递同一份 → 同一 reportId，对象数不增，记录数不增', async () => {
      const first = (await post({})).json() as { reportId: string };
      const second = await post({});
      expect(second.statusCode).toBe(201);
      const body = second.json() as { reportId: string; deduplicated: boolean };

      expect(body.reportId).toBe(first.reportId);
      expect(body.deduplicated).toBe(true);
      expect(await prisma.researchReport.count()).toBe(1);
      expect(storage.calls).toHaveLength(1); // 第二次完全没碰对象存储
    });

    it('X-Guest 决定归属：两个投递方各留一行，但复用同一个 objectKey', async () => {
      await post({ guest: 'friend1' });
      await post({ guest: 'friend2' });

      const rows = await prisma.researchReport.findMany({ orderBy: { uploaderRef: 'asc' } });
      expect(rows.map((r) => r.uploaderRef)).toEqual(['friend1', 'friend2']);
      expect(rows[0].objectKey).toBe(rows[1].objectKey);
    });

    it('未提供 X-Guest（未经代理直连）→ 归属记为 unknown，仍可追溯', async () => {
      await post({ guest: null });
      const row = await prisma.researchReport.findFirst();
      expect(row?.uploaderRef).toBe('unknown');
    });
  });

  // ── 不合规输入，五类各自可区分（SC-004 / state_branch 13 / 15 / 16 / 17）────────
  describe('不合规投递', () => {
    it('缺必填元数据 → 400，且指出缺的是哪一项', async () => {
      const res = await post({ query: 'reportDate=2026-08-01&title=x' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('symbol');
    });

    it('非 PDF（PNG 字节改名 .pdf）→ 422 RESEARCH_FILE_NOT_PDF，判据基于内容', async () => {
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(512, 0),
      ]);
      const res = await post({
        file: { filename: 'fake.pdf', mime: 'application/pdf', data: png },
      });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { code: string }).code).toBe('RESEARCH_FILE_NOT_PDF');
      expect(await prisma.researchReport.count()).toBe(0);
    });

    it('市场不在白名单 → 422 RESEARCH_SYMBOL_MARKET_UNSUPPORTED，MUST NOT 落库', async () => {
      const res = await post({ query: 'symbol=jp%3A7203&reportDate=2026-08-01&title=x' });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { code: string }).code).toBe('RESEARCH_SYMBOL_MARKET_UNSUPPORTED');
      expect(await prisma.researchReport.count()).toBe(0);
    });

    it('标的做了百分号编码 → 422 RESEARCH_SYMBOL_ENCODED，且消息里明说不要编码', async () => {
      // 注意这是**双重编码**：`hk%253A1698` 解码一次后是字面量 `hk%3A1698`，
      // 即投递方自己编码过一次的形态（nginx 侧 `$arg_*` 不解码，就长这样）。
      const res = await post({ query: 'symbol=hk%253A1698&reportDate=2026-08-01&title=x' });
      expect(res.statusCode).toBe(422);
      // ProblemDetailFilter 把异常体的 `message` 折进 RFC 9457 的 `detail`，`code` 原样保留。
      const body = res.json() as { code: string; detail: string };
      expect(body.code).toBe('RESEARCH_SYMBOL_ENCODED');
      expect(body.detail).toContain('不要');
    });

    it('研报日期形态不认 → 422 RESEARCH_REPORT_DATE_INVALID', async () => {
      const res = await post({ query: 'symbol=hk%3A01698&reportDate=2026%2F08%2F01&title=x' });
      expect(res.statusCode).toBe(422);
      expect((res.json() as { code: string }).code).toBe('RESEARCH_REPORT_DATE_INVALID');
    });

    it('归一：后缀式写法落库为归一形式（US1-AS3）', async () => {
      const res = await post({ query: 'symbol=1698.HK&reportDate=2026-08-01&title=x' });
      expect(res.statusCode).toBe(201);
      const row = await prisma.researchReport.findFirst();
      expect(row?.symbol).toBe('hk:01698');
    });
  });

  // ── 单向收集箱：服务端不实装任何读取动作（state_branch 20 / 21）───────────────
  describe('只写不读', () => {
    it.each([
      ['GET', '/api/v1/research/reports'],
      ['GET', '/api/v1/research/reports/1'],
      ['PATCH', '/api/v1/research/reports/1'],
      ['DELETE', '/api/v1/research/reports/1'],
      ['PUT', '/api/v1/research/reports/1'],
    ])('%s %s → 未实装（404/405），持有效凭证也读不到', async (method, url) => {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect([404, 405]).toContain(res.statusCode);
    });
  });
});
