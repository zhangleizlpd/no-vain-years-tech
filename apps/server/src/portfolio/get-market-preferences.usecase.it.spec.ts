import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { GetMarketPreferencesUseCase } from './get-market-preferences.usecase';

// 011 T004 US1: 读取市场偏好 (投影默认 + 持久化态 + 海外元信息 + GET 零写库)。
// run via `nx test server <file>` (cwd=apps/server) per memory testcontainers_spec_run_via_nx_cwd。
describe('GetMarketPreferencesUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: GetMarketPreferencesUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new GetMarketPreferencesUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  // 每个测试用独立 accountId, 避免跨测试串扰。
  const nextAccountId = (): bigint => BigInt(900_000 + ++seq);

  const byCode = <T extends { marketCode: string }>(markets: T[]): Record<string, T> =>
    Object.fromEntries(markets.map((m) => [m.marketCode, m]));

  it('新账号 (无偏好行) → 核心投影默认 {cn:active, hk/us:inactive} + 9 行', async () => {
    const accountId = nextAccountId();
    const { markets } = await usecase.execute(accountId);

    expect(markets).toHaveLength(9);
    const m = byCode(markets);
    expect(m['cn'].active).toBe(true);
    expect(m['hk'].active).toBe(false);
    expect(m['us'].active).toBe(false);
  });

  it('GET 零写库副作用 — 读后 DB 仍 0 行 (FR-S01/D4)', async () => {
    const accountId = nextAccountId();
    await usecase.execute(accountId);
    const count = await prisma.portfolioPreference.count({ where: { accountId } });
    expect(count).toBe(0);
  });

  it('预置激活集 {cn,hk} → 返回持久化态 (港股也激活)', async () => {
    const accountId = nextAccountId();
    await prisma.portfolioPreference.create({
      data: { accountId, activeMarkets: ['cn', 'hk'] },
    });

    const m = byCode((await usecase.execute(accountId)).markets);
    expect(m['cn'].active).toBe(true);
    expect(m['hk'].active).toBe(true);
    expect(m['us'].active).toBe(false);
  });

  it('海外 6 市场元信息: group=overseas / v1Available=false / 恒 inactive', async () => {
    const accountId = nextAccountId();
    const { markets } = await usecase.execute(accountId);
    const overseas = markets.filter((m) => m.group === 'overseas');
    expect(overseas).toHaveLength(6);
    for (const m of overseas) {
      expect(m.v1Available).toBe(false);
      expect(m.active).toBe(false);
      expect(typeof m.isoCurrency).toBe('string');
    }
  });
});
