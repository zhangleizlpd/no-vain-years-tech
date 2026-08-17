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
 * 本片验的东西有一半只存在于通道层：两个端点的鉴权三态、提交口**结构上够不到锚表**、
 * DTO 形状与 400 的可区分性。直接 new use case 一条都测不到。
 *
 * ⚠️ 两个端点持**同一把** token（059 收口的取舍，理由在 `guest-upload.config.ts` 顶部）⇒
 * 「谁能直写锚」在本文件里**无法验**，那道闸整个落在通道层，归 `verify-guards.sh`。
 *
 * 🚨 **NO LIFECYCLE MOCKING**：整个 `OptionsdeskModule` 经 `Test.createTestingModule` 装进真
 * DI 容器，两个 guard 在真实 lifecycle 里跑；只有 `guestUploadConfig`（token 的值）与
 * Redis 被 `useValue` 换掉。
 *
 * T004 段 = 待审收件箱的数据面形态；T006 段 = 两个端点接线通了（happy path + 鉴权失败）。
 * 18 条 `state_branch` 的穷举归 T007，同文件续写。
 */
const UPLOAD_TOKEN = 'g'.repeat(43);

const IMPORT_PATH = '/api/v1/optionsdesk/anchors/model-import';
const SUBMIT_PATH = '/api/v1/optionsdesk/anchors/submissions';

describe('059 锚模型导入通道 IT (Testcontainers PG)', () => {
  let app: NestFastifyApplication;
  let moduleRef: TestingModule;
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

  /** body 里**没有** ticker —— 它走 query，通道层的市场闸才读得到（见 controller 文件头）。 */
  const importBody = { v: '50.0000', asof: '2026-06-30', method: 'dcf', confidence: '8.00' };
  const TICKER = 'us:AOS';

  const post = (url: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: body, headers });

  const withTicker = (url: string, ticker: string | null) =>
    ticker === null ? url : `${url}?ticker=${encodeURIComponent(ticker)}`;

  const importAs = (
    body: Record<string, unknown>,
    token = UPLOAD_TOKEN,
    ticker: string | null = TICKER,
  ) => post(withTicker(IMPORT_PATH, ticker), body, { authorization: `Bearer ${token}` });

  const submitAs = (
    body: Record<string, unknown>,
    token = UPLOAD_TOKEN,
    guest = 'guest-a',
    ticker: string | null = TICKER,
  ) =>
    post(withTicker(SUBMIT_PATH, ticker), body, {
      authorization: `Bearer ${token}`,
      'x-guest': guest,
    });

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    moduleRef = await Test.createTestingModule({
      imports: narrowTestModule([OptionsdeskModule]),
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .overrideProvider(guestUploadConfig.KEY)
      .useValue({ token: UPLOAD_TOKEN })
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

    it.each([
      ['导入口', IMPORT_PATH],
      ['提交口', SUBMIT_PATH],
    ])('%s：凭证不符 → 401 且不落任何行', async (_label, url) => {
      const res = await post(url, importBody, { authorization: `Bearer ${'x'.repeat(43)}` });
      expect(res.statusCode).toBe(401);
      expect(await prisma.anchor.count()).toBe(0);
      expect(await prisma.anchorSubmission.count()).toBe(0);
    });
  });

  // ── T007 18 条 state_branch 穷举 ───────────────────────────────────────────────
  //
  // 逐条对应 spec.md 的 `state_branches`（EXHAUSTIVE BRANCHING，plan § Testing Invariants
  // 第三条）。通道层那一半（nginx 的 limit_except / 授权闸 / 市场闸 / 限频）归
  // `services/guest-proxy/verify-guards.sh`，两层各拒一次、互不依赖。
  describe('18 条 state_branch 穷举', () => {
    /** 建一只已在库里的锚（经导入口，走的就是被测那条路径）。 */
    const seedAnchor = async (ticker = TICKER, body: Record<string, unknown> = importBody) => {
      const res = await importAs(body, UPLOAD_TOKEN, ticker);
      expect(res.statusCode).toBe(201);
      return prisma.anchor.findUniqueOrThrow({ where: { ticker } });
    };

    it('① 标的尚无锚 → 建锚, 且立即具备「模型来源」身份', async () => {
      const res = await importAs(importBody);
      expect((res.json() as { action: string }).action).toBe('create');
      const row = await prisma.anchor.findUniqueOrThrow({ where: { ticker: 'us:AOS' } });
      expect(row.confidenceSource).toBe('model');
      expect(row.lLevelEffective).toBe('L2'); // confidence 8 → L2（映射档单点在 anchor.rules）
      const changes = await prisma.anchorChange.findMany({ where: { anchorId: row.id } });
      expect(changes.map((c) => c.source)).toEqual(['model']);
    });

    it('② 已有锚且估值有变 → 按导入语义更新, 不报冲突（建锚口对同 ticker 是蓄意 409）', async () => {
      await seedAnchor();
      const res = await importAs({ ...importBody, v: '60.0000', confidence: '9.50' });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { action: string }).action).toBe('update');
      const row = await prisma.anchor.findUniqueOrThrow({ where: { ticker: 'us:AOS' } });
      expect(row.v.toString()).toBe('60');
      expect(await prisma.anchor.count()).toBe(1); // 更新而非第二行
      // 更新路径的痕迹同样记 model（FR-008：来源是系统对写入路径的判断，不是调方声明）。
      const changes = await prisma.anchorChange.findMany({
        where: { anchorId: row.id },
        orderBy: { id: 'asc' },
      });
      expect(changes.map((c) => c.source)).toEqual(['model', 'model']);
    });

    it('③ 值全等 → 零写入零痕迹（SC-003 同参重放：updated_at 不动 + 零新增痕迹）', async () => {
      const before = await seedAnchor();
      const changesBefore = await prisma.anchorChange.count();

      const res = await importAs(importBody);
      expect((res.json() as { action: string }).action).toBe('noop');

      const after = await prisma.anchor.findUniqueOrThrow({ where: { ticker: 'us:AOS' } });
      expect(after).toEqual(before); // 逐列相同，含 updated_at（Prisma @updatedAt 只随真写变）
      expect(await prisma.anchorChange.count()).toBe(changesBefore);
    });

    it('④ 连续两日各导入一次 → 第二日仍成功（首日写下的 model 身份不反过来阻断）', async () => {
      await seedAnchor();
      const day2 = await importAs({
        ...importBody,
        asof: '2026-07-31',
        v: '60.0000',
        confidence: '9.50',
      });
      expect(day2.statusCode).toBe(201);
      const day3 = await importAs({
        ...importBody,
        asof: '2026-08-31',
        v: '62.0000',
        confidence: '9.00',
      });
      expect(day3.statusCode).toBe(201);
      expect((day3.json() as { action: string }).action).toBe('update');
      const row = await prisma.anchor.findUniqueOrThrow({ where: { ticker: 'us:AOS' } });
      expect(row.confidence.toString()).toBe('9');
    });

    it('⑤ 有人工调整 → 回落且逐条回报, 且与痕迹的 beforeValues **逐条对得上**（SC-004）', async () => {
      const anchor = await seedAnchor();
      // 人工位由 App 侧写（本片不经 App，直接落列造出「有人工调整」的现场）。
      await prisma.anchor.update({
        where: { id: anchor.id },
        data: { vManual: '55', lLevelManual: 'L3', positionCapManual: '0.1' },
      });

      const res = await importAs({ ...importBody, v: '60.0000', confidence: '9.50' });
      const body = res.json() as {
        fallbackEntries: { slot: string; manualValue: string; fallbackValue: string | null }[];
      };
      expect(body.fallbackEntries.map((e) => e.slot).sort()).toEqual([
        'lLevel',
        'positionCap',
        'v',
      ]);

      const change = (await prisma.anchorChange.findMany({ orderBy: { id: 'desc' }, take: 1 }))[0]!;
      const beforeValues = change.beforeValues as Record<string, string | null>;
      const columnOf: Record<string, string> = {
        v: 'vManual',
        lLevel: 'lLevelManual',
        positionCap: 'positionCapManual',
      };
      // 无一遗漏（回报的每条都在痕迹里）且无一编造（痕迹里被清的每条都被回报了）。
      for (const entry of body.fallbackEntries) {
        const column = columnOf[entry.slot]!;
        expect(change.changedFields).toContain(column);
        expect(String(beforeValues[column])).toBe(entry.manualValue);
      }
      const clearedInTrace = change.changedFields.filter((f) => f.endsWith('Manual'));
      expect(clearedInTrace.sort()).toEqual(['lLevelManual', 'positionCapManual', 'vManual']);

      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: anchor.id } });
      expect([row.vManual, row.lLevelManual, row.positionCapManual]).toEqual([null, null, null]);
    });

    it('⑥ 无人工调整 → 清单为空, 不编造条目', async () => {
      await seedAnchor();
      const res = await importAs({ ...importBody, v: '60.0000' });
      expect((res.json() as { fallbackEntries: unknown[] }).fallbackEntries).toEqual([]);
    });

    it('⑦ 导入不重置复审日期、不解除逾期红标', async () => {
      const anchor = await seedAnchor();
      // 造一只「逾期且正在跌破」的锚：复审日在过去 + 本轮跌破起点已置。
      await prisma.anchor.update({
        where: { id: anchor.id },
        data: {
          nextReview: new Date('2026-01-31T00:00:00Z'),
          lastReviewedOn: new Date('2025-12-31T00:00:00Z'),
          breachStartedOn: new Date('2026-02-01T00:00:00Z'),
        },
      });
      const before = await prisma.anchor.findUniqueOrThrow({ where: { id: anchor.id } });

      await importAs({ ...importBody, v: '60.0000', confidence: '9.50' });

      const after = await prisma.anchor.findUniqueOrThrow({ where: { id: anchor.id } });
      expect(after.nextReview).toEqual(before.nextReview);
      expect(after.lastReviewedOn).toEqual(before.lastReviewedOn);
      expect(after.breachStartedOn).toEqual(before.breachStartedOn);
    });

    it.each([
      ['缺市场前缀', 'AOS'],
      ['后缀式', 'PEP.US'],
      ['代码段小写', 'us:pep'],
      ['市场段大写', 'US:PEP'],
    ])('⑧ 标的写法非规范（%s）→ 400, 且不建出无行情的锚', async (_label, ticker) => {
      const res = await importAs(importBody, UPLOAD_TOKEN, ticker);
      expect(res.statusCode).toBe(400);
      expect(await prisma.anchor.count()).toBe(0);
    });

    it('⑨ 市场不在白名单（cn:）→ 400 且不落库, 原因与写法不合规可区分', async () => {
      const res = await importAs(importBody, UPLOAD_TOKEN, 'cn:600519');
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('INVALID_IMPORT_MARKET');
      expect(await prisma.anchor.count()).toBe(0);
    });

    it('⑩ 置信度越界 → 400「输入不合法」而**不是** 5xx（不许穿透到 PG 变 numeric overflow）', async () => {
      const res = await importAs({ ...importBody, confidence: '999' });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('INVALID_IMPORT_CONFIDENCE');
      expect(await prisma.anchor.count()).toBe(0);
    });

    it.each(['0', '-1'])('⑪ 估值为零或负（%s）→ 400（045 既有边界, 本片不回归）', async (v) => {
      const res = await importAs({ ...importBody, v });
      expect(res.statusCode).toBe(400);
      expect(await prisma.anchor.count()).toBe(0);
    });

    /**
     * 🚨 **本分支在服务层不可判, 这条钉的就是「不可判」这件事本身** —— 不是漏写的反例。
     * 059 收口把两把 token 回退成一把 ⇒ 服务端拿不到「调用方是谁」的任何可判之据,
     * 同一个 bearer 打两个口都放行。「只有本人可直写」的判据**单点落在通道层**
     * （nginx `/anchor-import` 的 `$anchor_write_allowed`, 反例在
     * `services/guest-proxy/verify-guards.sh` 的锚导入闸）—— 这与 FR-010「判据 MUST 在
     * 通道层完成」一致, 不是缺口。取舍理由在 `guest-upload.config.ts` 顶部。
     *
     * 谁将来把 token 重新拆成两把, 本条会红。那时该做的是同步改 config 顶部那段决策 +
     * spec 的 state_branch ⑫, 而不是顺手把本条删掉。
     */
    it('⑫ 本人以外的调用方直接写锚 → 服务层无可判之据, 判据单点在通道层（FR-010）', async () => {
      expect((await importAs(importBody)).statusCode).toBe(201);
      expect((await submitAs(importBody)).statusCode).toBe(201);
    });

    it('⑬ 他人提交 → 只落待审, 锚表**逐字段零变化**', async () => {
      const before = await seedAnchor();
      const changesBefore = await prisma.anchorChange.count();

      const res = await submitAs({ ...importBody, v: '999.0000', confidence: '1.00' });
      expect(res.statusCode).toBe(201);

      expect(await prisma.anchor.count()).toBe(1);
      expect(await prisma.anchor.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
      expect(await prisma.anchorChange.count()).toBe(changesBefore);
      expect(await prisma.anchorSubmission.count()).toBe(1);
    });

    it('⑭ 待审被采纳 → 经与本人导入**完全相同**的路径落锚（提交本身落不了锚）', async () => {
      const submitted = await submitAs(
        { ...importBody, v: '400.0000' },
        UPLOAD_TOKEN,
        'guest-a',
        'hk:00700',
      );
      expect(submitted.statusCode).toBe(201);
      expect(await prisma.anchor.count()).toBe(0); // 提交这一步落不了锚

      // 采纳 = 本人用**自己的**凭证把同样的值重放一次（系统里不存在第二条写锚路径）。
      const adopted = await importAs({ ...importBody, v: '400.0000' }, UPLOAD_TOKEN, 'hk:00700');
      expect((adopted.json() as { action: string }).action).toBe('create');

      const row = await prisma.anchor.findUniqueOrThrow({ where: { ticker: 'hk:00700' } });
      expect(row.confidenceSource).toBe('model');
      const changes = await prisma.anchorChange.findMany({ where: { anchorId: row.id } });
      expect(changes.map((c) => c.source)).toEqual(['model']);
      // 采纳与否是人的判断, 系统不代翻状态。
      const submission = await prisma.anchorSubmission.findFirstOrThrow();
      expect(submission.status).toBe('PENDING');
    });

    it('⑮/⑯ 凭证缺失 与 凭证不符 → 响应**逐字节相同**（对外不可区分）', async () => {
      // 两发**同一个 URL**，只差 Authorization —— `instance` 回显请求路径，URL 不同会
      // 让这条断言拿不同的路径去比，测的就不是「缺失 vs 不符」了。
      const missing = await post(withTicker(IMPORT_PATH, TICKER), importBody);
      const wrong = await importAs(importBody, 'x'.repeat(43));
      expect(missing.statusCode).toBe(wrong.statusCode);
      // 剥 traceId 后深等（它按请求生成、本就该不同；仓内反枚举断言的既有口径）。
      const withoutTrace = (raw: string) => {
        const { traceId: _traceId, ...rest } = JSON.parse(raw) as Record<string, unknown>;
        return rest;
      };
      expect(withoutTrace(missing.body)).toEqual(withoutTrace(wrong.body));
    });

    it('⑰ 读 / 删 / 列举 → 拒, 通道侧无任何读取面', async () => {
      const probes = await Promise.all([
        app.inject({
          method: 'GET',
          url: '/api/v1/optionsdesk/anchors',
          headers: { authorization: `Bearer ${UPLOAD_TOKEN}` },
        }),
        app.inject({
          method: 'GET',
          url: IMPORT_PATH,
          headers: { authorization: `Bearer ${UPLOAD_TOKEN}` },
        }),
        app.inject({
          method: 'GET',
          url: SUBMIT_PATH,
          headers: { authorization: `Bearer ${UPLOAD_TOKEN}` },
        }),
        app.inject({
          method: 'DELETE',
          url: '/api/v1/optionsdesk/anchors/1',
          headers: { authorization: `Bearer ${UPLOAD_TOKEN}` },
        }),
      ]);
      // guest 那把 token 过不了 JwtAuthGuard；且这两个前缀下**没有**任何 guest 面的
      // GET / DELETE 实现 —— 「恰好没实现」不算护栏，故这条断言钉的是「以后也不许有」。
      for (const res of probes) {
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.body).not.toContain('us:AOS');
      }
    });

    it('⑱ 导入与更新之间锚被并发删除 → 以「不存在」收敛, 且不写孤儿痕迹', async () => {
      const anchor = await seedAnchor();
      const changesBefore = await prisma.anchorChange.count();

      // 读写窗只能这样确定性地打开：让「读现状」这一步返回后、写之前，行已经没了。
      // 打的是数据访问那一层，被测的 affected-count 判定与真 SQL 全程未被替换。
      const anchorDelegate = prisma.anchor as unknown as {
        findUnique: (args: unknown) => Promise<unknown>;
      };
      const original = anchorDelegate.findUnique.bind(prisma.anchor);
      anchorDelegate.findUnique = async (args: unknown) => {
        const row = await original(args);
        await prisma.anchor.deleteMany({ where: { id: anchor.id } });
        return row;
      };
      try {
        const res = await importAs({ ...importBody, v: '60.0000' });
        expect(res.statusCode).toBe(404);
      } finally {
        anchorDelegate.findUnique = original;
      }
      expect(await prisma.anchorChange.count()).toBe(changesBefore);
    });
  });
});
