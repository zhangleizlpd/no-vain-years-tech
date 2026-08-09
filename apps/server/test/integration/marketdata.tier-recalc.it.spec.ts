import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../src/security/prisma.service';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';

// 018 T001: SyncTierRecalc 重算 (Testcontainers PG-only)。Q7-B 直查全账号自选并集 →
// 双 updateMany 条件落 Instrument.syncTier (命中→0 / 未命中→2); `{not}` 过滤 = 幂等零行
// 变更 (FR-S01); 读失败降级返 null 不抛 + warn (FR-S06, D4)。
describe('018 SyncTierRecalc recalc (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let recalc: SyncTierRecalc;
  let groupSeq = 0;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;
    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    recalc = new SyncTierRecalc(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.watchlistItem.deleteMany();
    await prisma.group.deleteMany();
    await prisma.instrument.deleteMany();
  });

  /** seed cn instrument (status=active; syncTier 可指定预置态)。 */
  async function seedInstrument(code: string, syncTier = 2): Promise<void> {
    await prisma.instrument.create({
      data: {
        market: 'cn',
        code,
        name: `股${code}`,
        type: 'stock',
        currency: 'CNY',
        status: 'active',
        syncTier,
      },
    });
  }

  /** seed 某账号一个自选组 + items (custom 组绕开 @@unique(accountId, systemKind) 限制)。 */
  async function seedWatchlist(accountId: bigint, codes: string[]): Promise<void> {
    const group = await prisma.group.create({
      data: { accountId, name: `g${++groupSeq}`, type: 'custom', order: 0 },
    });
    await prisma.watchlistItem.createMany({
      data: codes.map((code, i) => ({ groupId: group.id, market: 'cn', code, order: i })),
    });
  }

  async function tierOf(code: string): Promise<number> {
    const row = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'cn', code } },
      select: { syncTier: true },
    });
    return row.syncTier;
  }

  it('命中并集 → 0; 未命中 → 2 (含预置 0 的降回)', async () => {
    await seedInstrument('600519'); // 命中, 2 → 0
    await seedInstrument('000001', 0); // 不在自选但预置 0 → 降回 2
    await seedInstrument('600000'); // 未命中, 保持 2
    await seedWatchlist(1001n, ['600519']);

    const result = await recalc.recalcSafely();

    expect(result).toEqual({ promoted: 1, demoted: 1 });
    expect(await tierOf('600519')).toBe(0);
    expect(await tierOf('000001')).toBe(2);
    expect(await tierOf('600000')).toBe(2);
  });

  it('多用户多组引用同标的 → 并集去重, 单行升 0', async () => {
    await seedInstrument('600519');
    await seedWatchlist(1001n, ['600519']);
    await seedWatchlist(1001n, ['600519']); // 同账号第二组
    await seedWatchlist(2002n, ['600519']); // 另一账号

    const result = await recalc.recalcSafely();

    expect(result).toEqual({ promoted: 1, demoted: 0 });
    expect(await tierOf('600519')).toBe(0);
  });

  it('并集不变连跑两次 → 第二次幂等零行变更', async () => {
    await seedInstrument('600519');
    await seedInstrument('600000');
    await seedWatchlist(1001n, ['600519']);

    const first = await recalc.recalcSafely();
    expect(first).toEqual({ promoted: 1, demoted: 0 });

    const second = await recalc.recalcSafely();
    expect(second).toEqual({ promoted: 0, demoted: 0 });
  });

  it('自选全空 → 全 universe 回 T2 (不报错不特判)', async () => {
    await seedInstrument('600519', 0);
    await seedInstrument('600000', 0);
    await seedInstrument('000001');

    const result = await recalc.recalcSafely();

    expect(result).toEqual({ promoted: 0, demoted: 2 });
    expect(await tierOf('600519')).toBe(2);
    expect(await tierOf('600000')).toBe(2);
    expect(await tierOf('000001')).toBe(2);
  });

  /** seed hk instrument (status=active; syncTier 预置态)。 */
  async function seedHkInstrument(code: string, syncTier = 2): Promise<void> {
    await prisma.instrument.create({
      data: {
        market: 'hk',
        code,
        name: `港${code}`,
        type: 'stock',
        currency: 'HKD',
        status: 'active',
        syncTier,
      },
    });
  }

  async function hkTierOf(code: string): Promise<number> {
    const row = await prisma.instrument.findUniqueOrThrow({
      where: { market_code: { market: 'hk', code } },
      select: { syncTier: true },
    });
    return row.syncTier;
  }

  async function seedHkWatchlist(accountId: bigint, codes: string[]): Promise<void> {
    const group = await prisma.group.create({
      data: { accountId, name: `hg${++groupSeq}`, type: 'custom', order: 0 },
    });
    await prisma.watchlistItem.createMany({
      data: codes.map((code, i) => ({ groupId: group.id, market: 'hk', code, order: i })),
    });
  }

  // 038 T011 (Clarification Q1): hk 分层 —— HSI/港股通成分 (curated 种子) 提级 tier-0 优先回填,
  // 长尾在市标的 tier-2 后置 (但仍全量纳入, 不缩范围)。
  it('038 T011: hk HSI 成分 → syncTier=0; 长尾在市 hk → =2 (全量纳入不缩范围); cn 无回归', async () => {
    await seedHkInstrument('00700'); // HSI 成分 (curated 种子) → 提级 0
    await seedHkInstrument('99998'); // 长尾非成分 → 2
    await seedInstrument('600519'); // cn 无回归: 无自选 → 2
    await seedWatchlist(1001n, ['600519']); // cn 自选 → 0

    const result = await recalc.recalcSafely();
    expect(result).not.toBeNull();

    expect(await hkTierOf('00700')).toBe(0); // 成分提级
    expect(await hkTierOf('99998')).toBe(2); // 长尾后置
    expect(await tierOf('600519')).toBe(0); // cn 自选仍提级 (无回归)
    // 全量纳入: 两只 hk 都在库 (tier 只排序、不过滤同步范围)。
    expect(await prisma.instrument.count({ where: { market: 'hk' } })).toBe(2);
  });

  it('038 T011: hk 自选标的 (非成分) 也提级 tier-0 (与 cn 自选语义一致)', async () => {
    await seedHkInstrument('99997'); // 非 HSI 成分
    await seedHkWatchlist(2002n, ['99997']); // 但被自选 → 提级

    const result = await recalc.recalcSafely();

    expect(result).not.toBeNull();
    expect(await hkTierOf('99997')).toBe(0);
  });

  it('038 T011: hk 幂等连跑两次 → 第二次零行变更', async () => {
    await seedHkInstrument('00700'); // 成分
    await seedHkInstrument('99996'); // 长尾

    const first = await recalc.recalcSafely();
    expect(first?.promoted).toBe(1); // 00700 2→0

    const second = await recalc.recalcSafely();
    expect(second).toEqual({ promoted: 0, demoted: 0 }); // 幂等
  });

  it('portfolio 读取异常 → 返 null 不抛 + warn log (降级, 同步不阻塞)', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const broken = {
      watchlistItem: {
        findMany: vi.fn().mockRejectedValue(new Error('portfolio read failed')),
      },
    } as unknown as PrismaService;

    const result = await new SyncTierRecalc(broken).recalcSafely();

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('portfolio read failed');
    warnSpy.mockRestore();
  });
});
