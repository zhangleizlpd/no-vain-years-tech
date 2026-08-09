import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { CommitAccountFreezeUseCase } from './commit-account-freeze.usecase';

const DAY_MS = 24 * 60 * 60 * 1000;

// T011: ACTIVE → FROZEN 写半段 (account 持 tx 参与)。并发裁决 = 条件 UPDATE
// WHERE status='ACTIVE' 的 affected-count。ACTIVE→won / 已 FROZEN→count0 lost /
// 不存在→lost。run via `nx test server <file>` (cwd=apps/server)。
describe('CommitAccountFreezeUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: CommitAccountFreezeUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new CommitAccountFreezeUseCase();
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextPhone = () => `+861380017${String(++seq).padStart(4, '0')}`;
  // tx 参与: 包一层 $transaction 模拟 auth 的 delete-account 持 tx。
  const freeze = (accountId: bigint, freezeUntil: Date) =>
    prisma.$transaction((tx) => usecase.execute(tx, accountId, freezeUntil));

  it('ACTIVE → won: status FROZEN + freezeUntil 落库 + updatedAt 推进', async () => {
    const acc = await prisma.account.create({ data: { phone: nextPhone(), status: 'ACTIVE' } });
    const before = acc.updatedAt.getTime();
    const freezeUntil = new Date(Date.now() + 15 * DAY_MS);

    const { won } = await freeze(acc.id, freezeUntil);
    expect(won).toBe(true);

    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN');
    expect(reloaded.freezeUntil?.getTime()).toBe(freezeUntil.getTime());
    expect(reloaded.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('已 FROZEN → count0 lost: status / freezeUntil 不被新值覆盖', async () => {
    const original = new Date(Date.now() + 3 * DAY_MS);
    const acc = await prisma.account.create({
      data: { phone: nextPhone(), status: 'FROZEN', freezeUntil: original },
    });

    const { won } = await freeze(acc.id, new Date(Date.now() + 15 * DAY_MS));
    expect(won).toBe(false);

    const reloaded = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(reloaded.status).toBe('FROZEN');
    expect(reloaded.freezeUntil?.getTime()).toBe(original.getTime()); // WHERE status='ACTIVE' 不匹配 → 不覆盖
  });

  it('不存在账号 → count0 lost', async () => {
    const { won } = await freeze(9_999_999n, new Date(Date.now() + 15 * DAY_MS));
    expect(won).toBe(false);
  });
});
