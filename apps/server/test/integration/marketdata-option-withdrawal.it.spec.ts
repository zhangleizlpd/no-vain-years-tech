import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { marketdataSyncConfig } from '../../src/config/marketdata.config';
import { OptionSnapshotCoverageCheck } from '../../src/marketdata/option-snapshot-coverage.check';
import { SyncOptionContractUseCase } from '../../src/marketdata/sync-option-contract.usecase';
import type {
  OptionChainPort,
  OptionChainWindowQuery,
  OptionContractStatic,
  OptionExpiry,
} from '../../src/marketdata/option-chain.port';
import type { WorkingInstrument } from '../../src/marketdata/dimension-executor';
import { emptyStats } from '../../src/marketdata/sync-run.recorder';

/**
 * 期权合约软下架 (withdrawn_at) 真库 IT —— #334 后续 (毒批病根: vendor 已删的码留在工作集
 * 毒掉整批 snapshot 调用)。Testcontainers 共享 PG (模板已含本列)。
 *
 * ## 为什么必须真库 (mock 顶不了)
 *
 * 被测的两件事都是「哪些**行**被改 / 被算」:
 * ① 链发现对账**真的**把某几行的 `withdrawn_at` 置上 / 清回, 且**只**碰该动的那些行 —— mock
 *    prisma 的 `updateMany` 返一个我自己编的 count, 证不了「改的是不是那几行」。
 * ② 覆盖率判据的分母是「基线日行 ⋈ 未软下架」两趟真 SQL —— mock 里那两趟是被测方自己编的答案。
 *
 * 时间锚: 固定「当日」= FIXED_TODAY, 到期日一律远月, 免得跑到某天真到期。
 */

const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

const FIXED_TODAY = '2026-09-18';
const FAR_A = '2026-10-16'; // 近月 (会被「摘掉」的那一档)
const FAR_B = '2026-12-18'; // 远月 (始终在阶梯里)

/** adapter 已归一化后的链合约行。 */
function chainRow(
  symbol: string,
  root: string,
  code: string,
  expiry: string,
): OptionContractStatic {
  return {
    market: 'hk',
    code,
    root,
    underlyingSymbol: symbol,
    expiryDate: expiry,
    strikePrice: '100',
    optionType: 'PUT',
    expirationCycle: 'MONTH',
    settlementMode: 'PM',
    isStandard: true,
  };
}

/**
 * 链端口替身: `getExpiryDates` 返 `ladder[symbol]`; `getChainWindow` 从 `chainBySymbol[symbol]`
 * 里挑落在窗内的行。两者由用例分别控制, 从而能造「阶梯里少了 FAR_A」这种 vendor 删列的形态。
 */
function stubChain(
  ladder: Record<string, string[]>,
  chainBySymbol: Record<string, OptionContractStatic[]>,
): OptionChainPort {
  return {
    getExpiryDates: async (symbol: string): Promise<OptionExpiry[]> =>
      (ladder[symbol] ?? []).map((d) => ({
        expiryDate: d,
        expirationCycle: 'MONTH',
        daysToExpiry: null,
      })),
    getChainWindow: async (q: OptionChainWindowQuery): Promise<OptionContractStatic[]> =>
      (chainBySymbol[q.symbol] ?? []).filter(
        (c) => c.expiryDate >= q.start && c.expiryDate <= q.end,
      ),
  };
}

describe('期权合约软下架 withdrawn_at (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;
  let coverage: OptionSnapshotCoverageCheck;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    prisma = new PrismaService(db.databaseUrl);
    coverage = new OptionSnapshotCoverageCheck(prisma, marketdataSyncConfig());
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.optionDailySnapshot.deleteMany();
    await prisma.optionContract.deleteMany();
    await prisma.instrument.deleteMany();
  });

  async function seedInstrument(code: string): Promise<bigint> {
    const row = await prisma.instrument.create({
      data: {
        market: 'hk',
        code,
        name: `hk:${code}`,
        type: 'stock',
        currency: 'HKD',
        status: 'active',
        needSync: true,
      },
    });
    return row.id;
  }

  /** 造一张合约, 返 `{ id, code }`。`withdrawn` 直接把它落成已软下架。 */
  async function seedContract(
    instrumentId: bigint,
    root: string,
    code: string,
    expiry: string,
    withdrawn = false,
  ): Promise<{ id: bigint; code: string }> {
    const row = await prisma.optionContract.create({
      data: {
        market: 'hk',
        code,
        root,
        underlyingInstrumentId: instrumentId,
        expiryDate: day(expiry),
        strikePrice: 100,
        optionType: 'PUT',
        isStandard: true,
        withdrawnAt: withdrawn ? new Date() : null,
      },
    });
    return { id: row.id, code };
  }

  async function seedSnapshot(contractId: bigint, sessionDate: string): Promise<void> {
    await prisma.optionDailySnapshot.create({
      data: {
        contractId,
        sessionDate: day(sessionDate),
        source: 'eod',
        quoteAsOf: day(sessionDate),
        oiAsOf: day(sessionDate),
        greeksComplete: true,
      },
    });
  }

  const withdrawnAtOf = async (id: bigint): Promise<Date | null> =>
    (await prisma.optionContract.findUniqueOrThrow({ where: { id } })).withdrawnAt;

  describe('链发现对账 (reconcileListingState, 真库)', () => {
    it('🚨 vendor 阶梯里没了的到期列 → 那几行 withdrawn_at 被置上, 阶梯里仍在的行不动', async () => {
      const instId = await seedInstrument('00700');
      // 两档到期: FAR_A (将从阶梯消失) 与 FAR_B (始终在)。
      const a1 = await seedContract(instId, 'TCH', 'HK.TCHA1', FAR_A);
      const a2 = await seedContract(instId, 'TCH', 'HK.TCHA2', FAR_A);
      const b1 = await seedContract(instId, 'TCH', 'HK.TCHB1', FAR_B);

      // vendor 当前阶梯只剩 FAR_B —— FAR_A 那列已被 vendor 删 (词根撞市场那种)。
      const chain = stubChain(
        { 'hk:00700': [FAR_B] },
        { 'hk:00700': [chainRow('hk:00700', 'TCH', 'HK.TCHB1', FAR_B)] },
      );
      const useCase = new SyncOptionContractUseCase(chain, prisma);
      const stats = emptyStats();

      await useCase.collect(
        [{ id: instId, market: 'hk', code: '00700' } satisfies WorkingInstrument],
        { businessDate: FIXED_TODAY },
        stats,
      );

      // FAR_A 两行被软下架, FAR_B 那行不动。
      expect(await withdrawnAtOf(a1.id)).toBeInstanceOf(Date);
      expect(await withdrawnAtOf(a2.id)).toBeInstanceOf(Date);
      expect(await withdrawnAtOf(b1.id)).toBeNull();
      // 落 notice finding (withdrawn: 2)。
      expect(stats.findings).toContainEqual(
        expect.objectContaining({
          kind: 'notice',
          step: 'option_contract_listing',
          detail: expect.objectContaining({ symbol: 'hk:00700', withdrawn: 2, restored: 0 }),
        }),
      );
    });

    it('🚨 vendor 把到期列认回来 → 之前软下架的行 withdrawn_at 清回 null (自愈复采)', async () => {
      const instId = await seedInstrument('00700');
      // FAR_A 起手就是软下架态 (上一轮摘的)。
      const a1 = await seedContract(instId, 'TCH', 'HK.TCHA1', FAR_A, true);
      const b1 = await seedContract(instId, 'TCH', 'HK.TCHB1', FAR_B);

      // 这回阶梯把 FAR_A 也返回来了。
      const chain = stubChain(
        { 'hk:00700': [FAR_A, FAR_B] },
        {
          'hk:00700': [
            chainRow('hk:00700', 'TCH', 'HK.TCHA1', FAR_A),
            chainRow('hk:00700', 'TCH', 'HK.TCHB1', FAR_B),
          ],
        },
      );
      const stats = emptyStats();
      await new SyncOptionContractUseCase(chain, prisma).collect(
        [{ id: instId, market: 'hk', code: '00700' }],
        { businessDate: FIXED_TODAY },
        stats,
      );

      expect(await withdrawnAtOf(a1.id)).toBeNull(); // 复活
      expect(await withdrawnAtOf(b1.id)).toBeNull();
      expect(stats.findings).toContainEqual(
        expect.objectContaining({ detail: expect.objectContaining({ restored: 1 }) }),
      );
    });

    it('🚨 链有差集 (FAR_A 是真合约但链这轮抖动没返回它) → 不对账: FAR_A 的行不被误摘', async () => {
      const instId = await seedInstrument('00700');
      // FAR_A 是**真合约** (阶梯里有), 只是链窗口这一轮抖动没返回它 ⇒ 正是 gate 要护住的形态:
      // 若不设 gate, 对账会拿残缺的 discovered ({FAR_B}) 把 FAR_A 误判成下架。
      const a1 = await seedContract(instId, 'TCH', 'HK.TCHA1', FAR_A);
      const b1 = await seedContract(instId, 'TCH', 'HK.TCHB1', FAR_B);

      // 阶梯声明有 FAR_A + FAR_B, 但链窗口一条都没返回 FAR_A ⇒ gapCheck 差集 ⇒ 整票 throw。
      const chain = stubChain(
        { 'hk:00700': [FAR_A, FAR_B] },
        { 'hk:00700': [chainRow('hk:00700', 'TCH', 'HK.TCHB1', FAR_B)] },
      );
      const stats = emptyStats();
      await new SyncOptionContractUseCase(chain, prisma)
        .collect(
          [{ id: instId, market: 'hk', code: '00700' }],
          { businessDate: FIXED_TODAY },
          stats,
        )
        .catch(() => undefined); // 差集 ⇒ collect 末尾上抛, 吞掉

      // gate 生效 ⇒ 两行都**没被**误摘 (差集时 discovered 不是权威阶梯)。FAR_A 尤其关键 ——
      // 无 gate 时它会因「不在残缺的 discovered 里」被错摘, 而它明明是真合约。
      expect(await withdrawnAtOf(a1.id)).toBeNull();
      expect(await withdrawnAtOf(b1.id)).toBeNull();
      expect(stats.findings.some((f) => f.kind === 'notice')).toBe(false);
    });
  });

  describe('覆盖率判据排除软下架合约 (evaluate, 真库)', () => {
    it('🚨 昨天在采、今天已软下架的合约不进分母 → 不判 degraded (否则假 ERROR)', async () => {
      const instId = await seedInstrument('00700');
      const live1 = await seedContract(instId, 'TCH', 'HK.TCHL1', FAR_B);
      const live2 = await seedContract(instId, 'TCH', 'HK.TCHL2', FAR_B);
      const dead = await seedContract(instId, 'TCH', 'HK.TCHDEAD', FAR_B, true); // 软下架

      // 基线日 (昨天): 三张都采到了。今天: 只采到两张 live (dead 已不采)。
      const YESTERDAY = '2026-09-17';
      for (const c of [live1, live2, dead]) await seedSnapshot(c.id, YESTERDAY);
      for (const c of [live1, live2]) await seedSnapshot(c.id, FIXED_TODAY);

      const report = await coverage.evaluate('hk', FIXED_TODAY);

      // dead 被排除出分母 ⇒ 该票 covered==expected==2 ⇒ 不 degraded。
      const row = report.underlyings.find((u) => u.symbol === 'hk:00700');
      expect(row).toBeDefined();
      expect(row!.expected).toBe(2);
      expect(row!.covered).toBe(2);
      expect(report.status).not.toBe('degraded');
    });

    it('🚨 未到期合约全被软下架的票不进名册 → 不判 absent (存在性层)', async () => {
      const instId = await seedInstrument('00700');
      // 该票唯一的未到期合约已软下架 ⇒ 无可采。基线日给它铺一行 (够构成一个基线日)。
      const dead = await seedContract(instId, 'TCH', 'HK.TCHONLY', FAR_B, true);
      // 另造一只正常票, 好让基线日 / 当日都有数据 (否则 no_subject)。
      const otherId = await seedInstrument('09999');
      const otherLive = await seedContract(otherId, 'BAB', 'HK.BABL1', FAR_B);
      await seedSnapshot(dead.id, '2026-09-17');
      await seedSnapshot(otherLive.id, '2026-09-17');
      await seedSnapshot(otherLive.id, FIXED_TODAY);

      const report = await coverage.evaluate('hk', FIXED_TODAY);

      // 00700 全下架 ⇒ 既不在分母 (基线行被 withdrawnAt 滤掉) 也不在名册 ⇒ 不出现、不判红。
      expect(report.underlyings.some((u) => u.symbol === 'hk:00700')).toBe(false);
      expect(report.degraded.some((u) => u.symbol === 'hk:00700')).toBe(false);
    });
  });
});
