import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';

// 059 锚的模型导入通道 IT（Testcontainers PG）。
//
// T004 段 = 待审收件箱的数据面形态：表落在 optionsdesk schema、五列与 anchor 同量纲同宽度
// （采纳时是**原样重放**，宽度不一致会让「库里存得下、重放时 400」这种只在采纳那一刻才暴露
// 的偏差成为可能）、三态都写得进、索引只有 PK。
//
// 端点行为与 18 条 state_branch 穷举归 T006 / T007，同文件续写。
describe('059 anchor_submission 数据面 (Testcontainers PG)', () => {
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

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE optionsdesk.anchor_submission RESTART IDENTITY');
  });

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
      const row = await prisma.anchorSubmission.create({
        data: { ...submissionSeed, status },
      });
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
