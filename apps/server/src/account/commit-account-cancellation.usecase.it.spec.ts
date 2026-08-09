import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { CommitAccountCancellationUseCase } from './commit-account-cancellation.usecase';

const DAY_MS = 24 * 60 * 60 * 1000;

// T020: FROZEN-in-grace → ACTIVE 写半段 (account 持 tx 参与)。并发裁决 = 条件 UPDATE
// WHERE status='FROZEN' AND freezeUntil>now 的 affected-count。FROZEN-in-grace→won /
// grace 已过→lost / ACTIVE→lost / ANONYMIZED→lost。grace 边界 (freezeUntil===now)
// 归匿名化 (lost, `gt` 严格)。run via `nx test server <file>` (cwd=apps/server)。
describe('CommitAccountCancellationUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: CommitAccountCancellationUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new CommitAccountCancellationUseCase();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextPhone = () => `+861380020${String(++seq).padStart(4, '0')}`;
  // tx 参与: 包一层 $transaction 模拟 auth 的 cancel-deletion 持 tx。
  const cancel = (accountId: bigint, now: Date) =>
    prisma.$transaction((tx) => usecase.execute(tx, accountId, now));

  it('FROZEN-in-grace → won: status ACTIVE + freezeUntil 清空 + updatedAt 推进', async () => {
    const acc = await prisma.account.create({
      data: {
        phone: nextPhone(),
        status: 'FROZEN',
        freezeUntil: new Date(Date.now() + 5 * DAY_MS),
      },
    });
    const before = acc.updatedAt.getTime();

    const { won } = await cancel(acc.id, new Date());
    expect(won).toBe(true);

    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ACTIVE');
    expect(reloaded.freezeUntil).toBeNull();
    expect(reloaded.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('grace 已过 (freezeUntil <= now) → count0 lost: 状态不变 (与匿名化互斥, 防 scheduler 抢跑)', async () => {
    const past = new Date(Date.now() - 60_000);
    const acc = await prisma.account.create({
      data: { phone: nextPhone(), status: 'FROZEN', freezeUntil: past },
    });

    const { won } = await cancel(acc.id, new Date());
    expect(won).toBe(false);

    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN'); // freezeUntil>now 不匹配 → 不解冻
    expect(reloaded.freezeUntil?.getTime()).toBe(past.getTime());
  });

  it('grace 边界 (freezeUntil === now) → count0 lost (gt 严格, 边界归匿名化)', async () => {
    const now = new Date();
    const acc = await prisma.account.create({
      data: { phone: nextPhone(), status: 'FROZEN', freezeUntil: now },
    });

    const { won } = await cancel(acc.id, now);
    expect(won).toBe(false);

    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN');
  });

  it('ACTIVE → count0 lost (WHERE status=FROZEN 不匹配)', async () => {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    const { won } = await cancel(acc.id, new Date());
    expect(won).toBe(false);
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ACTIVE');
  });

  it('ANONYMIZED → count0 lost (终态不可逆)', async () => {
    const acc = await prisma.account.create({
      data: { phone: nextPhone(), status: 'ANONYMIZED' },
    });
    const { won } = await cancel(acc.id, new Date());
    expect(won).toBe(false);
    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('ANONYMIZED');
  });

  it('不存在账号 → count0 lost', async () => {
    const { won } = await cancel(9_999_999n, new Date());
    expect(won).toBe(false);
  });
});
