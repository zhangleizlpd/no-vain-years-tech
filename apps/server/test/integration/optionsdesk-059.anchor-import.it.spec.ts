import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { guestUploadConfig } from '../../src/config';

// boot-time zod 校验的最小 env 集（与 optionsdesk.controller.spec.ts 同口径）。必须在 Nest
// 编译前落位：SecurityModule 的 ConfigModule.forRoot 在模块实例化时 .parse()。
process.env.AUTH_JWT_SECRET ??= 'optionsdesk-059-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-059-it-hmac-secret-min-32-bytes';
process.env.MARKETDATA_PROVIDER = 'mock';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 059 锚的模型导入通道 IT（共享 PG + 收窄 boot + 真 HTTP）。
 *
 * ## 为什么必须真 HTTP 而不是直接调 use case
 *
 * 本片验的东西有一半只存在于通道层：两个端点**各认各的 token**（抄错的表现不是 401 而是
 * 授权分流形同虚设）、提交口**结构上够不到锚表**、DTO 形状与 400 的可区分性。直接 new
 * use case 一条都测不到。
 *
 * 🚨 **NO LIFECYCLE MOCKING**：整个 `OptionsdeskModule` 经 `Test.createTestingModule` 装进真
 * DI 容器，两个 guard 在真实 lifecycle 里跑；只有 `guestUploadConfig`（两把 token 的值）与
 * Redis 被 `useValue` 换掉。
 *
 * T004 段 = 待审收件箱的数据面形态；T006 段 = 两个端点接线通了（happy path + 鉴权失败）。
 * 18 条 `state_branch` 的穷举归 T007，同文件续写。
 */
const UPLOAD_TOKEN = 'g'.repeat(43);
const ANCHOR_TOKEN = 'a'.repeat(43);

const IMPORT_PATH = '/api/v1/optionsdesk/anchors/model-import';
const SUBMIT_PATH = '/api/v1/optionsdesk/anchors/submissions';

describe('059 锚模型导入通道 IT (Testcontainers PG)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  const submissionSeed = {
    submitter: 'guest-a',
    ticker: 'us:PEP',
    v: '150.5',
    asof: new Date('2026-08-16T00:00:00Z'),
    method: 'dcf',
    confidence: '7.25', // Decimal(4,2): 提交方也可给非整值
    status: 'PENDING',
  };

  const importBody = {
    ticker: 'us:AOS',
    v: '50.0000',
    asof: '2026-06-30',
    method: 'dcf',
    confidence: '8.00',
  };

  const post = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: body, headers });

  const importAs = (body: Record<string, unknown>, token = ANCHOR_TOKEN) =>
    post(IMPORT_PATH, body, { authorization: `Bearer ${token}` });

  const submitAs = (body: Record<string, unknown>, token = UPLOAD_TOKEN, guest = 'guest-a') =>
    post(SUBMIT_PATH, body, { authorization: `Bearer ${token}`, 'x-guest': guest });

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: narrowTestModule([OptionsdeskModule]),
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(guestUploadConfig.KEY)
      .useValue({ token: UPLOAD_TOKEN, anchorImportToken: ANCHOR_TOKEN })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change, optionsdesk.anchor_submission RESTART IDENTITY',
    );
  });

  // ── T004 数据面：待审收件箱的表形态 ────────────────────────────────────────────
  describe('anchor_submission 数据面', () => {
    it('表落在 optionsdesk schema（不新建 namespace）', async () => {
      const rows = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'optionsdesk' AND table_name = 'anchor_submission'`,
      );
      expect(rows).toHaveLength(1);
    });

    it('五列与 anchor 逐列同型同宽（采纳 = 原样重放，宽度漂了只在采纳那刻才炸）', async () => {
      const shapeOf = (table: string) =>
        prisma.$queryRawUnsafe<
          {
            column_name: string;
            data_type: string;
            character_maximum_length: number | null;
            numeric_precision: number | null;
            numeric_scale: number | null;
          }[]
        >(
          `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale
             FROM information_schema.columns
            WHERE table_schema = 'optionsdesk' AND table_name = $1
              AND column_name IN ('ticker', 'v', 'asof', 'method', 'confidence')
            ORDER BY column_name`,
          table,
        );
      expect(await shapeOf('anchor_submission')).toEqual(await shapeOf('anchor'));
    });

    it('三态各自写得进（PENDING 由系统写，另两态是人工处置的留痕）', async () => {
      for (const status of ['PENDING', 'CONSUMED', 'REJECTED']) {
        const row = await prisma.anchorSubmission.create({ data: { ...submissionSeed, status } });
        expect(row.status).toBe(status);
      }
      expect(await prisma.anchorSubmission.count()).toBe(3);
    });

    it('同一提交方同一标的可提交多次（一行 = 一次提交，刻意无唯一键）', async () => {
      await prisma.anchorSubmission.create({ data: submissionSeed });
      await prisma.anchorSubmission.create({ data: { ...submissionSeed, v: '160' } });
      expect(await prisma.anchorSubmission.count()).toBe(2);
    });

    it('附言可空；不填即 null，不伪造空串', async () => {
      const row = await prisma.anchorSubmission.create({ data: submissionSeed });
      expect(row.note).toBeNull();
    });

    it('索引只有 PK（日均个位数，status 上撒 B-tree 是 cargo cult）', async () => {
      const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'optionsdesk' AND tablename = 'anchor_submission'`,
      );
      expect(rows.map((r) => r.indexname)).toEqual(['anchor_submission_pkey']);
    });
  });

  // ── T006 端点接线：happy path + 鉴权 ───────────────────────────────────────────
  describe('两个端点接线通了', () => {
    it('导入口：新标的 → 201 + action=create + 锚真落库（来源 model）', async () => {
      const res = await importAs(importBody);
      expect(res.statusCode).toBe(201);
      const body = res.json() as { action: string; anchor: { ticker: string } };
      expect(body.action).toBe('create');
      expect(body.anchor.ticker).toBe('us:AOS');

      const row = await prisma.anchor.findUniqueOrThrow({ where: { ticker: 'us:AOS' } });
      expect(row.confidenceSource).toBe('model');
      const changes = await prisma.anchorChange.findMany({ where: { anchorId: row.id } });
      expect(changes).toHaveLength(1);
      expect(changes[0]!.source).toBe('model');
    });

    it('提交口：→ 201 + 落待审表 PENDING + 提交方取自 X-Guest', async () => {
      const res = await submitAs(
        { ...importBody, note: '按三阶段 DCF 重算' },
        UPLOAD_TOKEN,
        'guest-b',
      );
      expect(res.statusCode).toBe(201);
      const body = res.json() as { status: string; submitter: string; id: string };
      expect(body.status).toBe('PENDING');
      expect(body.submitter).toBe('guest-b');

      const row = await prisma.anchorSubmission.findUniqueOrThrow({
        where: { id: BigInt(body.id) },
      });
      expect(row.note).toBe('按三阶段 DCF 重算');
    });

    it.each([
      ['导入口', IMPORT_PATH],
      ['提交口', SUBMIT_PATH],
    ])('%s：无凭证 → 401 且不落任何行', async (_label, url) => {
      const res = await post(url, importBody);
      expect(res.statusCode).toBe(401);
      expect(await prisma.anchor.count()).toBe(0);
      expect(await prisma.anchorSubmission.count()).toBe(0);
    });

    it('🚨 拿提交口的 token 打导入口 → 401（授权分流的服务端那一层，Guardrail 6）', async () => {
      const res = await importAs(importBody, UPLOAD_TOKEN);
      expect(res.statusCode).toBe(401);
      expect(await prisma.anchor.count()).toBe(0);
    });

    it('🚨 拿导入口的 token 打提交口 → 401（反向同样拒，两把不是「一把的两个别名」）', async () => {
      const res = await submitAs(importBody, ANCHOR_TOKEN);
      expect(res.statusCode).toBe(401);
      expect(await prisma.anchorSubmission.count()).toBe(0);
    });
  });
});
