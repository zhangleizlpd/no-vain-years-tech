import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { setupIsolatedDb } from '../_support/isolated-db';
import { narrowTestModule } from '../_support/narrow-boot';
import { OptionsdeskModule } from '../../src/optionsdesk/optionsdesk.module';
import { PrismaService } from '../../src/security/prisma.service';
import { REDIS_CLIENT } from '../../src/security/redis.token';
import { ApproveAnchorSubmissionUseCase } from '../../src/optionsdesk/approve-anchor-submission.usecase';
import { SubmitAnchorFromGuestUseCase } from '../../src/optionsdesk/submit-anchor-from-guest.usecase';

process.env.AUTH_JWT_SECRET ??= 'optionsdesk-072-it-jwt-secret-min-32-bytes';
process.env.SMS_CODE_HMAC_SECRET ??= 'optionsdesk-072-it-hmac-secret-min-32-bytes';
process.env.MARKETDATA_PROVIDER = 'mock';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OSS_')) delete process.env[key];
}

/**
 * 072 待审箱采纳 IT（真 PG）。
 *
 * ## 为什么这些必须上真库 —— 逐条都是 mock Prisma **结构上抓不到**的
 *
 * 1. **并发双采纳**：条件 `UPDATE … WHERE status='PENDING'` 的原子性只在真 READ COMMITTED
 *    下成立。mock 里两条都会「成功」。
 * 2. **partial unique 的运行时行为**：Prisma 把它建模成**全表**复合唯一，谓词在类型系统里
 *    消失 ⇒ `upsert` 类型全绿、运行时炸。这条**只有**真 PG 会告诉你。
 * 3. **refresh 真的清人工位**：级联写入横跨 anchor + anchor_change 两表。
 */
describe('072 待审箱采纳 IT (Testcontainers PG)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let approve: ApproveAnchorSubmissionUseCase;
  let submit: SubmitAnchorFromGuestUseCase;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  const ASOF = new Date('2026-08-28T00:00:00Z');

  const seedSubmission = (over: Record<string, unknown> = {}) =>
    prisma.anchorSubmission.create({
      data: {
        submitter: 'friend2',
        ticker: 'us:AOS',
        v: '80.0000',
        asof: ASOF,
        method: 'dcf',
        confidence: '7.50',
        status: 'PENDING',
        ...over,
      },
    });

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    moduleRef = await Test.createTestingModule({
      imports: narrowTestModule([OptionsdeskModule]),
    })
      .overrideProvider(REDIS_CLIENT)
      .useValue({ call: () => undefined, quit: () => undefined, on: () => undefined })
      .compile();
    prisma = moduleRef.get(PrismaService);
    approve = moduleRef.get(ApproveAnchorSubmissionUseCase);
    submit = moduleRef.get(SubmitAnchorFromGuestUseCase);
  }, 180_000);

  afterAll(async () => {
    await moduleRef?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    await prisma.anchorChange.deleteMany({});
    await prisma.anchor.deleteMany({});
    await prisma.anchorSubmission.deleteMany({});
  });

  it('采纳一条 → 锚落库 + status=CONSUMED + consumed_anchor_id 有值', async () => {
    const row = await seedSubmission();
    const res = await approve.execute({ id: row.id, asofAck: 'accept' });

    expect(res.action).toBe('create');
    expect(res.statusFlipped).toBe(true);

    const anchor = await prisma.anchor.findUniqueOrThrow({ where: { ticker: 'us:AOS' } });
    expect(anchor.confidenceSource).toBe('model');

    const after = await prisma.anchorSubmission.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('CONSUMED');
    expect(after.consumedAnchorId).toBe(anchor.id);
  });

  // 🚨 条件更新的原子性:mock 里两条都会「成功」,只有真 READ COMMITTED 能证伪。
  it('并发双采纳同一条 → 恰好一条翻转成功, 且只落一只锚', async () => {
    const row = await seedSubmission();
    const results = await Promise.allSettled([
      approve.execute({ id: row.id, asofAck: 'accept' }),
      approve.execute({ id: row.id, asofAck: 'accept' }),
    ]);

    const flipped = results.filter(
      (r) => r.status === 'fulfilled' && r.value.statusFlipped === true,
    );
    expect(flipped).toHaveLength(1);

    expect(await prisma.anchor.count({ where: { ticker: 'us:AOS' } })).toBe(1);
    const after = await prisma.anchorSubmission.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('CONSUMED');
  });

  it('已 CONSUMED 的条目再采纳 → 409, 且不再写第二只锚', async () => {
    const row = await seedSubmission();
    await approve.execute({ id: row.id, asofAck: 'accept' });
    await expect(approve.execute({ id: row.id, asofAck: 'accept' })).rejects.toThrow();
    expect(await prisma.anchor.count()).toBe(1);
  });

  it('refresh 真的冲掉三处人工位并把来源翻 model', async () => {
    const first = await seedSubmission();
    await approve.execute({ id: first.id, asofAck: 'accept' });
    await prisma.anchor.update({
      where: { ticker: 'us:AOS' },
      data: {
        vManual: '95.0000',
        lLevelManual: 'L2',
        positionCapManual: '0.2500',
        confidenceSource: 'manual',
      },
    });

    const second = await seedSubmission({ v: '88.0000', confidence: '9.00' });
    const res = await approve.execute({ id: second.id, asofAck: 'accept' });

    expect(res.action).toBe('update');
    expect(res.fallbackEntries.length).toBeGreaterThan(0);
    const anchor = await prisma.anchor.findUniqueOrThrow({ where: { ticker: 'us:AOS' } });
    expect(anchor.vManual).toBeNull();
    expect(anchor.lLevelManual).toBeNull();
    expect(anchor.positionCapManual).toBeNull();
    expect(anchor.confidenceSource).toBe('model');
  });

  describe('投递口幂等 (FR-008)', () => {
    it('同 (ticker, asof) 重投 → 覆盖同一行, 回同一个 id, 不堆行', async () => {
      const a = await submit.execute({
        submitter: 'friend2',
        ticker: 'us:AOS',
        v: '80',
        asof: ASOF,
        method: 'dcf',
        confidence: '7.5',
        note: null,
      });
      const b = await submit.execute({
        submitter: 'friend2',
        ticker: 'us:AOS',
        v: '81',
        asof: ASOF,
        method: 'dcf',
        confidence: '8.0',
        note: '改了',
      });

      expect(b.id).toBe(a.id);
      expect(await prisma.anchorSubmission.count()).toBe(1);
      const row = await prisma.anchorSubmission.findUniqueOrThrow({ where: { id: a.id } });
      expect(row.v.toString()).toBe('81');
      expect(row.note).toBe('改了');
    });

    // partial 的全部意义:处置完之后必须还能重投。全表唯一会把这条正当路径永久堵死。
    it('处置完(REJECTED)之后同键可再投, 变成两行', async () => {
      const a = await seedSubmission();
      await prisma.anchorSubmission.update({
        where: { id: a.id },
        data: { status: 'REJECTED' },
      });
      await submit.execute({
        submitter: 'friend2',
        ticker: 'us:AOS',
        v: '82',
        asof: ASOF,
        method: 'dcf',
        confidence: '7.0',
        note: null,
      });
      expect(await prisma.anchorSubmission.count()).toBe(2);
    });

    // 🚨 这条把「类型绿但运行时炸」钉死:Prisma 把 partial unique 建模成全表复合唯一,
    //    ON CONFLICT 缺谓词 ⇒ PG 拒。故投递口 MUST NOT 用 upsert。
    it('直接对 partial unique 用 upsert → 运行时报 no unique or exclusion constraint', async () => {
      await seedSubmission();
      await expect(
        prisma.anchorSubmission.upsert({
          where: { ticker_asof: { ticker: 'us:AOS', asof: ASOF } },
          update: { v: '99' },
          create: {
            submitter: 'friend2',
            ticker: 'us:AOS',
            v: '99',
            asof: ASOF,
            method: 'dcf',
            confidence: '7.5',
            status: 'PENDING',
          },
        }),
      ).rejects.toThrow(/no unique or exclusion constraint/i);
    });
  });
});
