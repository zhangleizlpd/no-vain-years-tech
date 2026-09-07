import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { PrismaService } from '../../src/security/prisma.service';
import { marketdataSyncConfig } from '../../src/config/marketdata.config';
import { OptionSnapshotCoverageCheck } from '../../src/marketdata/option-snapshot-coverage.check';
import { SyncOptionContractUseCase } from '../../src/marketdata/sync-option-contract.usecase';
import { SyncOptionSnapshotUseCase } from '../../src/marketdata/sync-option-snapshot.usecase';
import type {
  OptionChainPort,
  OptionChainWindowQuery,
  OptionContractStatic,
  OptionExpiry,
} from '../../src/marketdata/option-chain.port';
import type {
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from '../../src/marketdata/option-snapshot.port';
import type { WorkingInstrument } from '../../src/marketdata/dimension-executor';
import { emptyStats } from '../../src/marketdata/sync-run.recorder';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

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
const EXPIRED = '2026-08-21'; // 已到期 (< FIXED_TODAY): 链根本不返回它, 对账也够不到

/** adapter 已归一化后的链合约行。缺省股数 500 = 港股 09988 实测值 (076 取证 §1)。 */
function chainRow(
  symbol: string,
  root: string,
  code: string,
  expiry: string,
  over: Partial<OptionContractStatic> = {},
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
    contractSize: 500,
    ...over,
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
    /**
     * 076: 库内每张合约的股数。**缺省 500 = 与 `chainRow` 同值**, 即「上一轮已回填过」的稳态
     * ⇒ 对账第三步零变动、零 finding, 既有各臂的 notice 断言因此不受影响。要造回填 / 更新
     * 形态的臂显式传 null / 别的值。
     */
    contractSize: number | null = 500,
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
        contractSize,
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

  const contractSizeOf = async (id: bigint): Promise<number | null> =>
    (await prisma.optionContract.findUniqueOrThrow({ where: { id } })).contractSize;

  /** 跑一轮链发现 (单票), 返本轮 stats。 */
  async function runChainSync(
    instId: bigint,
    code: string,
    chain: OptionChainPort,
  ): Promise<ReturnType<typeof emptyStats>> {
    const stats = emptyStats();
    await new SyncOptionContractUseCase(chain, prisma)
      .collect(
        [{ id: instId, market: 'hk', code } satisfies WorkingInstrument],
        { businessDate: FIXED_TODAY },
        stats,
      )
      .catch(() => undefined); // 差集轮末尾会上抛, 由各臂自行断言库侧结果
    return stats;
  }

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

    it('🚨 到期列仍在阶梯、列内个别 code 被 vendor 撤掉 → 只摘那几个 code, 同列其它行不动', async () => {
      const instId = await seedInstrument('09988');
      // 本臂钉的是**到期日级对账够不到**的那个形态: FAR_B 这一列 vendor 仍在给 (阶梯有、链也返回),
      // 只是列里少了 B2 / B3。
      // EVIDENCE: 2026-09-04 prod 实测 hk:09988 的 2026-09-11 列 —— vendor 认 24 个、库里 96 个,
      // 72 个已撤的码因「该列仍在阶梯」而逃过对账 (withdrawn_at 全库 0 行); 同轮 vendor 新给的
      // 87/88/89 档 12 行照常写入 ⇒ 加法执行、减法没有 (issue #342 / FutunnOpen/py-futu-api#261)。
      const b1 = await seedContract(instId, 'ALB', 'HK.ALBB1', FAR_B);
      const b2 = await seedContract(instId, 'ALB', 'HK.ALBB2', FAR_B);
      const b3 = await seedContract(instId, 'ALB', 'HK.ALBB3', FAR_B);

      const chain = stubChain(
        { 'hk:09988': [FAR_B] },
        { 'hk:09988': [chainRow('hk:09988', 'ALB', 'HK.ALBB1', FAR_B)] },
      );
      const stats = emptyStats();
      await new SyncOptionContractUseCase(chain, prisma).collect(
        [{ id: instId, market: 'hk', code: '09988' }],
        { businessDate: FIXED_TODAY },
        stats,
      );

      expect(await withdrawnAtOf(b1.id)).toBeNull();
      expect(await withdrawnAtOf(b2.id)).toBeInstanceOf(Date);
      expect(await withdrawnAtOf(b3.id)).toBeInstanceOf(Date);
      expect(stats.findings).toContainEqual(
        expect.objectContaining({
          kind: 'notice',
          step: 'option_contract_listing',
          detail: expect.objectContaining({ symbol: 'hk:09988', withdrawn: 2, restored: 0 }),
        }),
      );
    });

    it('🚨 已摘的码下一轮 vendor 仍不给 → 保持摘: 同列的 restore MUST NOT 把它清回来 (否则逐轮震荡)', async () => {
      const instId = await seedInstrument('09988');
      // B2 是上一轮摘的, 它的到期列 FAR_B **仍在**阶梯里 —— restore 谓词若停在到期日级
      // (`expiryDate in liveExpiries`), 这一轮就会把 B2 清回 null, 下一轮再摘, 逐轮反复。
      const b1 = await seedContract(instId, 'ALB', 'HK.ALBB1', FAR_B);
      const b2 = await seedContract(instId, 'ALB', 'HK.ALBB2', FAR_B, true);

      const chain = stubChain(
        { 'hk:09988': [FAR_B] },
        { 'hk:09988': [chainRow('hk:09988', 'ALB', 'HK.ALBB1', FAR_B)] },
      );
      const stats = emptyStats();
      await new SyncOptionContractUseCase(chain, prisma).collect(
        [{ id: instId, market: 'hk', code: '09988' }],
        { businessDate: FIXED_TODAY },
        stats,
      );

      expect(await withdrawnAtOf(b1.id)).toBeNull();
      expect(await withdrawnAtOf(b2.id)).toBeInstanceOf(Date);
      // 稳态零变动 ⇒ 无 notice (摘过的不再重复计数, 也没被误清)。
      expect(stats.findings.some((f) => f.kind === 'notice')).toBe(false);
    });

    it('🚨 已摘的码 vendor 单独认回来 (链重新返回该 code) → 清回 null, 自愈到合约级', async () => {
      const instId = await seedInstrument('09988');
      const b2 = await seedContract(instId, 'ALB', 'HK.ALBB2', FAR_B, true);

      const chain = stubChain(
        { 'hk:09988': [FAR_B] },
        { 'hk:09988': [chainRow('hk:09988', 'ALB', 'HK.ALBB2', FAR_B)] },
      );
      const stats = emptyStats();
      await new SyncOptionContractUseCase(chain, prisma).collect(
        [{ id: instId, market: 'hk', code: '09988' }],
        { businessDate: FIXED_TODAY },
        stats,
      );

      expect(await withdrawnAtOf(b2.id)).toBeNull();
      expect(stats.findings).toContainEqual(
        expect.objectContaining({ detail: expect.objectContaining({ restored: 1 }) }),
      );
    });

    /**
     * 🚨 076 T003: 每张股数的**回填 / 更新**只发生在这一步 (FR-006 / FR-007)。
     *
     * ## 为什么必须真库 (mock 顶不了)
     *
     * 链发现是纯 `createMany(skipDuplicates)` —— 部署那天已在库里的十几万行**永远不会**被
     * insert 路径碰到, 新列于是永远空着。要证的正是「既有行真的被改了、且只改该改的那些」:
     * mock prisma 的 `updateMany` 返一个我自己编的 count, 分不出「改对了行」与「改了整票」。
     * ③ 臂更是个否定命题 (链不干净这一轮**一行都不许动**), 在 mock 上退化成断言我自己的桩。
     */
    describe('每张合约的股数回填 / 更新 (076 T003)', () => {
      it('① 库内为空 (部署后首轮) + 本轮链给 500 → 回填 500, notice 记 filled', async () => {
        const instId = await seedInstrument('09988');
        const b1 = await seedContract(instId, 'ALB', 'HK.ALBB1', FAR_B, false, null);
        const b2 = await seedContract(instId, 'ALB', 'HK.ALBB2', FAR_B, false, null);

        const stats = await runChainSync(
          instId,
          '09988',
          stubChain(
            { 'hk:09988': [FAR_B] },
            {
              'hk:09988': [
                chainRow('hk:09988', 'ALB', 'HK.ALBB1', FAR_B),
                chainRow('hk:09988', 'ALB', 'HK.ALBB2', FAR_B),
              ],
            },
          ),
        );

        expect(await contractSizeOf(b1.id)).toBe(500);
        expect(await contractSizeOf(b2.id)).toBe(500);
        expect(stats.findings).toContainEqual({
          kind: 'notice',
          step: 'option_contract_size',
          detail: { symbol: 'hk:09988', filled: 2, changed: 0 },
        });
      });

      it('② 库内 500 + 本轮链改口 1000 (资本调整) → 更新到 1000, notice 记 changed', async () => {
        const instId = await seedInstrument('09988');
        const b1 = await seedContract(instId, 'ALB', 'HK.ALBB1', FAR_B, false, 500);

        const stats = await runChainSync(
          instId,
          '09988',
          stubChain(
            { 'hk:09988': [FAR_B] },
            {
              'hk:09988': [chainRow('hk:09988', 'ALB', 'HK.ALBB1', FAR_B, { contractSize: 1000 })],
            },
          ),
        );

        expect(await contractSizeOf(b1.id)).toBe(1000);
        // 🚨 filled 与 changed 分开记: 前者是首轮回填 (量级六位数, 属预期), 后者是「交易所改了
        // 这只票的股数」这条真信号 —— 合成一个数, 后者就永远淹在前者里。
        expect(stats.findings).toContainEqual({
          kind: 'notice',
          step: 'option_contract_size',
          detail: { symbol: 'hk:09988', filled: 0, changed: 1 },
        });
      });

      it('③ 🚨 链这轮有差集 → 股数一行不动、无 finding (MUST 只在 gap.ok 分支)', async () => {
        const instId = await seedInstrument('09988');
        const b1 = await seedContract(instId, 'ALB', 'HK.ALBB1', FAR_B, false, null);

        // 阶梯声明 FAR_A + FAR_B, 链窗口一条 FAR_A 都没返回 ⇒ gapCheck 差集 ⇒ 整轮不对账。
        const stats = await runChainSync(
          instId,
          '09988',
          stubChain(
            { 'hk:09988': [FAR_A, FAR_B] },
            { 'hk:09988': [chainRow('hk:09988', 'ALB', 'HK.ALBB1', FAR_B)] },
          ),
        );

        // 把这一步挪到 gap 判定之前, 一次链抖动就会拿残缺的本轮清单去写整票 —— 而写空的那批
        // 在读端表现为「两个数显示为空」, 与「还没回填」长得一模一样, 没有一处会红。
        expect(await contractSizeOf(b1.id)).toBeNull();
        expect(stats.findings.some((f) => f.kind === 'notice')).toBe(false);
      });

      it('④ 已到期的合约不回填 —— 一轮对账后仍是空 (Q1 裁决, 由 expiry 谓词天然排除)', async () => {
        const instId = await seedInstrument('09988');
        const dead = await seedContract(instId, 'ALB', 'HK.ALBOLD', EXPIRED, false, null);
        const b1 = await seedContract(instId, 'ALB', 'HK.ALBB1', FAR_B, false, null);

        const stats = await runChainSync(
          instId,
          '09988',
          stubChain(
            { 'hk:09988': [FAR_B] },
            { 'hk:09988': [chainRow('hk:09988', 'ALB', 'HK.ALBB1', FAR_B)] },
          ),
        );

        expect(await contractSizeOf(dead.id)).toBeNull();
        // 同轮未到期的那行照常回填 —— 没有这半条, 「仍是空」可以因为整步没跑而假绿。
        expect(await contractSizeOf(b1.id)).toBe(500);
        expect(stats.findings).toContainEqual({
          kind: 'notice',
          step: 'option_contract_size',
          detail: { symbol: 'hk:09988', filled: 1, changed: 0 },
        });
      });

      it('⑤ 库内 500 + 本轮判非标 (股数 null) → 回写 null: 库值 MUST 跟本轮供应方一致', async () => {
        const instId = await seedInstrument('09988');
        const b1 = await seedContract(instId, 'ALB', 'HK.ALBB1', FAR_B, false, 500);

        const stats = await runChainSync(
          instId,
          '09988',
          stubChain(
            { 'hk:09988': [FAR_B] },
            {
              'hk:09988': [
                chainRow('hk:09988', 'ALB', 'HK.ALBB1', FAR_B, {
                  isStandard: false,
                  contractSize: null,
                }),
              ],
            },
          ),
        );

        // 写手只有链发现这一处 ⇒ 库值 MUST 跟本轮供应方一致。留着那个 500 才是错的: 它会被
        // 读端乘进单笔权利金, 而非标合约的交割物根本不是「500 股」。
        expect(await contractSizeOf(b1.id)).toBeNull();
        expect(stats.findings).toContainEqual({
          kind: 'notice',
          step: 'option_contract_size',
          detail: { symbol: 'hk:09988', filled: 0, changed: 1 },
        });
      });
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

  /**
   * 🚨 076 T004: 快照轮拿供应方股数与库值**对账**, 不一致只留痕 (FR-008)。
   *
   * ## 为什么必须真库 (mock 顶不了)
   *
   * 本臂的核心是一个**否定命题**: 这一轮跑完, `option_contract.contract_size` 那一行**没被
   * 改**。mock prisma 上它退化成「我没给 update 写替身, 所以调了会炸」—— 那证的是「代码里
   * 没写那次调用」, 而真正要防的失败形态 (顺手 `update` 一下把库值刷成供应方值) 在 mock 上
   * 表现为一个我自己编的返回值, 断言不到。
   *
   * 股数的唯一写手是链发现的对账步 (本文件上面那个 describe) —— 两个写手会让库值在两个口径
   * 之间来回跳, 而不一致时没有任何判据看得见谁对。
   */
  describe('快照轮股数只比不写 (076 T004, 真库)', () => {
    /** hk 当地 22:00 —— 已过该市场 OI 定稿时刻 ⇒ `oi_as_of` 不必回问交易日历。 */
    const HK_EOD_NOW = new Date(`${FIXED_TODAY}T22:00:00+08:00`);
    const OPTION_CODE = 'HK.TCH261218P100000';

    /**
     * 一行过得了四条落库前硬门的期权快照。spot 取 700 ≫ K 100 ⇒ PUT 内在价值恒 0, 门 ④
     * 恒过 —— 抄一组过不了门的数值会让这行整批被拒, 「照常入库」那半条断言于是走不到。
     */
    function optionRow(code: string, contractSize: number | null): OptionSnapshotRow {
      return {
        code,
        isOption: true,
        underlyingCode: 'HK.00700',
        bid: '2.30',
        ask: '2.40',
        bidSize: '45',
        askSize: '60',
        last: '2.35',
        prevClose: '2.28',
        iv: '21.4',
        delta: '-0.31',
        gamma: '0.041',
        vega: '0.092',
        theta: '-0.058',
        rho: '0.011',
        openInterest: '3120',
        netOpenInterest: '-410',
        volume: '1204',
        turnover: '283940',
        vendorUpdateTime: new Date(`${FIXED_TODAY}T08:00:00Z`),
        greeksComplete: true,
        contractSize,
      };
    }

    /** 快照端口替身: 请求的每个合约一行 + 标的自身那行 (spot 的来源, 同批返回)。 */
    function stubSnapshot(vendorSize: number | null): OptionSnapshotPort {
      return {
        getSnapshots: async (q: OptionSnapshotQuery) => ({
          asOf: new Date(`${FIXED_TODAY}T08:10:00Z`),
          rows: [
            ...q.contractCodes.map((c) => optionRow(c, vendorSize)),
            {
              ...optionRow('HK.00700', null),
              isOption: false,
              underlyingCode: null,
              last: '700',
              bid: null,
              ask: null,
              delta: null,
              greeksComplete: null,
            },
          ],
        }),
      };
    }

    it('🚨 库内 500 / 快照报 1000 → notice 一条; 库值**仍是 500**, 且该行照常入库', async () => {
      const instId = await seedInstrument('00700');
      const contract = await seedContract(instId, 'TCH', OPTION_CODE, FAR_B, false, 500);
      const stats = emptyStats();

      await new SyncOptionSnapshotUseCase(
        stubSnapshot(1000),
        prisma,
        stubTradingCalendar(),
      ).collect(
        [{ id: instId, market: 'hk', code: '00700' } satisfies WorkingInstrument],
        { sessionDate: FIXED_TODAY, mode: 'eod', marketScope: ['hk'], now: HK_EOD_NOW },
        stats,
      );

      // ① 留痕: 一条 notice (🚫 不是 failure —— 它不改变任何采集结局)。
      const notices = stats.findings.filter(
        (f) => f.kind === 'notice' && f.step === 'option_contract_size_mismatch',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ detail: { symbol: 'hk:00700', mismatched: 1 } });
      expect(stats).toMatchObject({ ok: 1, failed: 0 });

      // ② 🚨 库值原封不动 —— 这是本臂唯一在 mock 上验不了的那半条。
      const after = await prisma.optionContract.findUniqueOrThrow({ where: { id: contract.id } });
      expect(after.contractSize).toBe(500);

      // ③ 该行照常入库 (留痕 MUST NOT 影响入库)。
      const snapshots = await prisma.optionDailySnapshot.findMany({
        where: { contractId: contract.id },
      });
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].sessionDate).toEqual(day(FIXED_TODAY));
    });
  });
});
