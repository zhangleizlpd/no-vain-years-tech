import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedDb } from '../../test/_support/isolated-db';
import { PrismaService } from '../security/prisma.service';
import { UpdateMarketPreferenceUseCase } from './update-market-preference.usecase';
import { MarketNotFoundException } from './market-not-found.exception';
import { MarketNotAvailableException } from './market-not-available.exception';
import { MinOneMarketRequiredException } from './min-one-market-required.exception';

// 011 T005 US2 + ADR-0046 单行模型: 切换核心市场 (单行 upsert + min-1 单行非空 + 海外拒绝 + 幂等)。
// run via `nx test server <file>` (cwd=apps/server)。
describe('UpdateMarketPreferenceUseCase (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let usecase: UpdateMarketPreferenceUseCase;
  let seq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    const url = db.databaseUrl;
    prisma = new PrismaService(url);
    usecase = new UpdateMarketPreferenceUseCase(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  const nextAccountId = (): bigint => BigInt(800_000 + ++seq);
  const activeOf = (markets: { marketCode: string; active: boolean }[], code: string) =>
    markets.find((m) => m.marketCode === code)?.active;
  const activeSet = (accountId: bigint) =>
    prisma.portfolioPreference
      .findUnique({ where: { accountId } })
      .then((r) => new Set(r?.activeMarkets ?? []));

  it('toggle on (hk) → 200 单行 upsert, 激活集 {cn,hk}', async () => {
    const accountId = nextAccountId();
    const { markets } = await usecase.execute(accountId, 'hk', true);

    expect(activeOf(markets, 'cn')).toBe(true); // 默认仍激活
    expect(activeOf(markets, 'hk')).toBe(true); // 新激活
    expect(activeOf(markets, 'us')).toBe(false);

    expect(await prisma.portfolioPreference.count({ where: { accountId } })).toBe(1); // 单行
    expect(await activeSet(accountId)).toEqual(new Set(['cn', 'hk']));
  });

  it('多激活关其一 (cn off, hk 仍激活) → 200 成功', async () => {
    const accountId = nextAccountId();
    await usecase.execute(accountId, 'hk', true); // {cn,hk}
    const { markets } = await usecase.execute(accountId, 'cn', false);

    expect(activeOf(markets, 'cn')).toBe(false);
    expect(activeOf(markets, 'hk')).toBe(true); // 满足 min-1
    expect(await activeSet(accountId)).toEqual(new Set(['hk']));
  });

  it('单激活关最后一个 (cn off when only cn) → 422 MIN_ONE_MARKET_REQUIRED 态不变', async () => {
    const accountId = nextAccountId();
    await usecase.execute(accountId, 'cn', true); // 激活集 {cn}

    await expect(usecase.execute(accountId, 'cn', false)).rejects.toBeInstanceOf(
      MinOneMarketRequiredException,
    );
    expect(await activeSet(accountId)).toEqual(new Set(['cn'])); // cn 仍 active (0 affected)
  });

  it('新用户首 PUT 关 cn → 422 + 默认行 materialize {cn} (GET 投影默认仍 cn:active)', async () => {
    const accountId = nextAccountId();
    await expect(usecase.execute(accountId, 'cn', false)).rejects.toBeInstanceOf(
      MinOneMarketRequiredException,
    );
    // 单行模型: upsert 默认行先落 {cn}, conditional UPDATE 0 affected → 拒。
    // 观察等价: 激活集仍 {cn} == 默认投影 (无 0-激活破坏)。
    expect(await activeSet(accountId)).toEqual(new Set(['cn']));
  });

  it('激活海外市场 (jp) → 422 MARKET_NOT_AVAILABLE 不写库 (字典前拒)', async () => {
    const accountId = nextAccountId();
    await expect(usecase.execute(accountId, 'jp', true)).rejects.toBeInstanceOf(
      MarketNotAvailableException,
    );
    expect(await prisma.portfolioPreference.count({ where: { accountId } })).toBe(0);
  });

  it('未知市场码 (XXX) → 404 MARKET_NOT_FOUND 不写库', async () => {
    const accountId = nextAccountId();
    await expect(usecase.execute(accountId, 'XXX', true)).rejects.toBeInstanceOf(
      MarketNotFoundException,
    );
    expect(await prisma.portfolioPreference.count({ where: { accountId } })).toBe(0);
  });

  it('幂等: 已 active 再 PUT active → 200 激活集不变 (无重复)', async () => {
    const accountId = nextAccountId();
    await usecase.execute(accountId, 'hk', true);
    const { markets } = await usecase.execute(accountId, 'hk', true);

    expect(activeOf(markets, 'hk')).toBe(true);
    expect(await activeSet(accountId)).toEqual(new Set(['cn', 'hk'])); // 去重, 无重复
  });

  it('幂等: 关一个本就 inactive 的核心 (us off when {cn}) → 200 不拒 (≥1 仍满足)', async () => {
    const accountId = nextAccountId();
    await usecase.execute(accountId, 'cn', true); // {cn}
    const { markets } = await usecase.execute(accountId, 'us', false); // us 本就 off
    expect(activeOf(markets, 'cn')).toBe(true);
    expect(activeOf(markets, 'us')).toBe(false);
    expect(await activeSet(accountId)).toEqual(new Set(['cn']));
  });
});
