import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import { rebuildFactorChains } from '../../src/marketdata/marketdata-backfill.cli';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { CorporateActionPort } from '../../src/marketdata/corporate-action.port';
import type {
  CorporateActionDto,
  EodBarPoint,
  EodBarQuery,
} from '../../src/marketdata/marketdata.types';

const NOW = new Date('2026-06-03T12:00:00Z'); // 周三 (Asia/Shanghai 交易日)
const AS_OF = '2026-06-03';
const SYMBOL = 'cn:600519';

// 019 T008 复权因子版本化 IT → **020 T007 改写**: corp 执行捕获新除权 → transient vendor
// backward 拉取 (不落 DailyBar) → anchorFactorJumps per-event 跃变 → AdjustmentFactor
// upsert (只写 factorBackward)。四态: 新除权写入 (值 = 相邻两日比值之比) / 同标的同除权日
// 幂等 / 同日多事件单版本 / ex 日零值防御跳过。
describe('020 T007 因子跃变锚定 (corp 捕获 → transient → AdjustmentFactor)', () => {
  let prisma: PrismaService;

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

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
    await prisma.adjustmentFactor.deleteMany();
    await prisma.dailyBar.deleteMany();
    await prisma.corporateAction.deleteMany();
    await prisma.instrument.deleteMany();
    await prisma.syncRun.deleteMany();
  });

  /** 脚本化 vendor: 三口径 bar 按段因子生成 + 可配 corp actions。 */
  function scriptedVendor(opts: {
    actions: CorporateActionDto[];
    /** [tradeDate, noneClose][]; forward/backward = none × 段因子 (exDate 后 1.05/1.10, 前 1/1)。 */
    noneSeries: Array<[string, string]>;
    exDate: string;
  }): EodBarPort & CorporateActionPort {
    const bar = (tradeDate: string, adjust: EodBarPoint['adjust'], close: string): EodBarPoint => ({
      tradeDate,
      adjust,
      open: close,
      high: close,
      low: close,
      close,
      changePct: null,
      prevClose: null,
      volume: null,
      amount: null,
      turnoverRate: null,
    });
    return {
      async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
        if (query.symbol !== SYMBOL) return [];
        return opts.noneSeries
          .filter(([d]) => (!query.from || d >= query.from) && (!query.to || d <= query.to))
          .map(([d, none]) => {
            const n = new Prisma.Decimal(none);
            const post = d >= opts.exDate; // 段因子: exDate 起 forward 1.05 / backward 1.10。
            const close =
              query.adjust === 'none'
                ? n
                : query.adjust === 'forward'
                  ? n.mul(post ? '1.05' : '1')
                  : n.mul(post ? '1.10' : '1');
            return bar(d, query.adjust, close.toFixed(4));
          });
      },
      async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
        return symbol === SYMBOL ? opts.actions : [];
      },
    };
  }

  async function seedInstrumentWithNoneBars(
    noneSeries: Array<[string, string]>,
    changePcts: Record<string, string> = {},
  ): Promise<bigint> {
    const inst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      },
    });
    // 预置 none 口径行 (平日 eod 已同步形态 — 锚定的 none 权威源, 零 vendor 外呼)。
    await prisma.dailyBar.createMany({
      data: noneSeries.map(([d, close]) => ({
        instrumentId: inst.id,
        tradeDate: new Date(`${d}T00:00:00Z`),
        adjust: 'none',
        open: close,
        high: close,
        low: close,
        close,
        // 官方涨跌幅 = 涨跌幅复权法 (2-of-2 的独立见证) 的唯一输入; 缺失 → 只剩条款法 → unverified。
        changePct: changePcts[d] ?? null,
      })),
    });
    return inst.id;
  }

  function buildRegistry(vendor: EodBarPort & CorporateActionPort): DimensionExecutorRegistry {
    const mock = new MockMarketDataAdapter();
    return new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      vendor,
      mock,
      mock,
      vendor,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
  }

  const NONE_SERIES: Array<[string, string]> = [
    ['2026-06-01', '100.0000'],
    ['2026-06-02', '102.0000'],
    ['2026-06-03', '101.0000'],
  ];

  const runCorp = (registry: DimensionExecutorRegistry) =>
    registry.execute('corporate_action', { mode: 'delta', asOf: AS_OF, now: NOW });

  it('① 新除权 → 按事件条款写入因子 + 两法互证 verified, 零 DailyBar 写入 / 零 vendor 外呼', async () => {
    // 条款: 前收 100, 每股派息 2 ⇒ 理论除权价 98, f = 100/98 = 1.02040816…
    // 见证: 官方涨跌幅 = (102−98)/98 = 4.0816% ⇒ f' = 1.040816 × 100/102 = 1.020408 (一致)。
    const instId = await seedInstrumentWithNoneBars(NONE_SERIES, { '2026-06-02': '4.0816' });
    const vendor = scriptedVendor({
      exDate: '2026-06-02',
      noneSeries: NONE_SERIES,
      actions: [
        {
          symbol: SYMBOL,
          exDate: '2026-06-02',
          type: 'dividend',
          payload: { dividend: 2, currency: 'CNY' },
        },
      ],
    });
    const { stats } = await runCorp(buildRegistry(vendor));
    expect(stats.failed).toBe(0);

    const factors = await prisma.adjustmentFactor.findMany({ where: { instrumentId: instId } });
    expect(factors).toHaveLength(1);
    expect(factors[0].exDate).toEqual(new Date('2026-06-02T00:00:00Z'));
    expect(new Prisma.Decimal(factors[0].factorBackward).toFixed(6)).toBe('1.020408');
    expect(factors[0].source).toBe('event_terms');
    expect(factors[0].status).toBe('verified');
    // 锚定路径零 DailyBar 写入 (仅预置 3 根 none 行)。
    expect(await prisma.dailyBar.count({ where: { instrumentId: instId } })).toBe(3);
  });

  it('② 同标的同除权日幂等: 重跑 corp → 行数不变值不变 (uk upsert, FR-S04)', async () => {
    const instId = await seedInstrumentWithNoneBars(NONE_SERIES);
    const vendor = scriptedVendor({
      exDate: '2026-06-02',
      noneSeries: NONE_SERIES,
      actions: [{ symbol: SYMBOL, exDate: '2026-06-02', type: 'dividend', payload: {} }],
    });
    const registry = buildRegistry(vendor);
    await runCorp(registry);
    const first = await prisma.adjustmentFactor.findMany({ where: { instrumentId: instId } });
    await runCorp(registry); // 重跑: action 已存在 → 无新增 exDate, 不重锚; 即便重锚值同。
    const second = await prisma.adjustmentFactor.findMany({ where: { instrumentId: instId } });
    expect(second).toHaveLength(first.length);
    expect(new Prisma.Decimal(second[0].factorBackward).toFixed(8)).toBe(
      new Prisma.Decimal(first[0].factorBackward).toFixed(8),
    );
  });

  it('③ 同日多事件 (dividend+split 同 exDate) → 合并单因子版本 (spec edge case)', async () => {
    const instId = await seedInstrumentWithNoneBars(NONE_SERIES);
    const vendor = scriptedVendor({
      exDate: '2026-06-02',
      noneSeries: NONE_SERIES,
      actions: [
        { symbol: SYMBOL, exDate: '2026-06-02', type: 'dividend', payload: {} },
        { symbol: SYMBOL, exDate: '2026-06-02', type: 'split', payload: {} },
      ],
    });
    await runCorp(buildRegistry(vendor));
    expect(await prisma.corporateAction.count({ where: { instrumentId: instId } })).toBe(2);
    expect(await prisma.adjustmentFactor.count({ where: { instrumentId: instId } })).toBe(1);
  });

  it('④ 零值防御: 前收=0 → 两法皆不可解 → 落 1 + needs_review (留痕不静默丢事件, 不 throw)', async () => {
    // 换口径后语义变了: 旧口径靠 ex 日收盘算比值, ex 日脏数据即不可算; 条款法只依赖**前收**
    // (n₀ + P·q − d), ex 日收盘脏不影响条款 —— 真正致命的是前收为 0。
    // 且不再「跳过不写行」: 落 factorJump=1 (读时等价无事件) + needs_review, 事件本身留痕待审。
    const seriesWithZero: Array<[string, string]> = [
      ['2026-06-01', '0.0000'], // 前收脏数据 — 条款法分母基准不可用。
      ['2026-06-02', '100.0000'],
      ['2026-06-03', '101.0000'],
    ];
    const instId = await seedInstrumentWithNoneBars(seriesWithZero);
    const vendor = scriptedVendor({
      exDate: '2026-06-02',
      noneSeries: seriesWithZero,
      actions: [{ symbol: SYMBOL, exDate: '2026-06-02', type: 'dividend', payload: {} }],
    });
    const { stats } = await runCorp(buildRegistry(vendor));
    expect(stats.failed).toBe(0); // 防御降级, 不计维度 failed。
    const rows = await prisma.adjustmentFactor.findMany({ where: { instrumentId: instId } });
    expect(rows).toHaveLength(1);
    expect(new Prisma.Decimal(rows[0].factorBackward).toFixed(4)).toBe('1.0000');
    expect(rows[0].status).toBe('needs_review');
    expect(rows[0].source).toBe('unresolved');
  });

  // 019 T015 扫描节奏 + 批量调大 (US2 预算账载体): fundamental 批量分块请求数 =
  // ceil(n/batch) + corp 扫描 upsert 后未来 exDate 物化在场 (D2 前提, T001 ③ 校真)。
  describe('019 T015 批量分块 + 未来 exDate 物化', () => {
    it('fundamental 批量分块: 请求数 = ceil(n/batch) (seed batch_size=100, 3 标的 → 1 次)', async () => {
      for (const code of ['600519', '000001', '430047']) {
        await prisma.instrument.create({
          data: {
            market: 'cn',
            code,
            name: code,
            type: 'stock',
            currency: 'CNY',
            status: 'active',
          },
        });
      }
      const calls: string[][] = [];
      const fundamentalPort = {
        async getFundamentals(symbols: string[]) {
          calls.push(symbols);
          return [];
        },
      };
      const mock = new MockMarketDataAdapter();
      const registry = new DimensionExecutorRegistry(
        new SyncUniverseUseCase(mock, prisma),
        new SyncProfileUseCase(mock, prisma),
        mock,
        fundamentalPort as never,
        mock,
        mock,
        prisma,
        new SyncRunRecorder(prisma),
        new SyncTierRecalc(prisma),
      );
      const { stats } = await registry.execute('fundamental', {
        mode: 'delta',
        asOf: AS_OF,
        now: NOW,
      });
      expect(stats.failed).toBe(0);
      // seed batch_size = 100 (T015): 3 标的 → ceil(3/100) = 1 次批量调用含全部 symbol。
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(3);
    });

    it('未来 exDate 物化在场: corp 扫描 upsert 后 exDate > asOf 行可查 (D2 前提)', async () => {
      const inst = await prisma.instrument.create({
        data: {
          market: 'cn',
          code: '601318',
          name: '中国平安',
          type: 'stock',
          currency: 'CNY',
          status: 'active',
        },
      });
      const futureExDate = '2026-06-10'; // > asOf (06-03) — implemented 行提前可见 (T001 ③)。
      const corpPort: CorporateActionPort = {
        async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
          return symbol === 'cn:601318'
            ? [
                {
                  symbol,
                  exDate: futureExDate,
                  type: 'dividend',
                  payload: { status: 'implemented' },
                },
              ]
            : [];
        },
      };
      const mock = new MockMarketDataAdapter();
      const registry = new DimensionExecutorRegistry(
        new SyncUniverseUseCase(mock, prisma),
        new SyncProfileUseCase(mock, prisma),
        mock,
        mock,
        mock,
        corpPort,
        prisma,
        new SyncRunRecorder(prisma),
        new SyncTierRecalc(prisma),
      );
      const { stats } = await registry.execute('corporate_action', {
        mode: 'delta',
        asOf: AS_OF,
        now: NOW,
      });
      expect(stats.failed).toBe(0);
      // 未来 exDate 已物化 — eod D2 命中检查届时本地可查 (零外呼)。
      const future = await prisma.corporateAction.findMany({
        where: { instrumentId: inst.id, exDate: { gt: new Date(`${AS_OF}T00:00:00Z`) } },
      });
      expect(future).toHaveLength(1);
      expect(future[0].exDate).toEqual(new Date(`${futureExDate}T00:00:00Z`));
    });
  });

  // 019 T009 → 020 T009 → **2026-08-01 换口径**: `--factors` 不再拉 vendor backward 序列
  // 反推跃变 (该口径已证伪退役), 改为四张本地表 → 事件条款法 + 2-of-2 判定。
  // ⇒ 本 describe 的核心断言从「恰 1 次 backward transient」变成「**零 vendor 外呼**」。
  describe('020 T009 rebuildFactorChains (--factors 全量重算, 零 vendor 外呼)', () => {
    async function createInstrument(code: string): Promise<bigint> {
      const inst = await prisma.instrument.create({
        data: { market: 'cn', code, name: code, type: 'stock', currency: 'CNY', status: 'active' },
      });
      return inst.id;
    }

    /** 库内仅 none 行 (020 终态形态) + 两除权事件 (06-02 / 06-04 跳空日)。 */
    async function seedNoneOnlyHistory(): Promise<bigint> {
      const instId = await createInstrument('600519');
      const rows: Array<[string, string]> = [
        ['2026-06-01', '100.0000'],
        ['2026-06-02', '50.0000'], // ex1 除权跳空。
        ['2026-06-03', '50.0000'],
        ['2026-06-04', '20.0000'], // ex2 除权跳空。
      ];
      await prisma.dailyBar.createMany({
        data: rows.map(([d, close]) => ({
          instrumentId: instId,
          tradeDate: new Date(`${d}T00:00:00Z`),
          adjust: 'none',
          open: close,
          high: close,
          low: close,
          close,
        })),
      });
      // 条款侧: 除权跳空全部由派息解释 (100→50 派 50; 50→20 派 30) —— 换口径后因子由
      // 条款算出, payload 不再可以是空对象。
      await prisma.corporateAction.createMany({
        data: [
          ['2026-06-02', 50],
          ['2026-06-04', 30],
        ].map(([d, dividend]) => ({
          instrumentId: instId,
          exDate: new Date(`${d}T00:00:00Z`),
          type: 'dividend',
          payload: { dividend, currency: 'CNY' },
        })),
      });
      return instId;
    }

    it('仅 none 行 + 除权事件 → 全事件按条款锚定 + 二次跑幂等 (零 vendor 外呼)', async () => {
      const instId = await seedNoneOnlyHistory();
      expect(await rebuildFactorChains(prisma)).toBe(0);

      const chain = await prisma.adjustmentFactor.findMany({
        where: { instrumentId: instId },
        orderBy: { exDate: 'asc' },
      });
      // 条款: ex1 前收 100 派息 50 → f = 100/50 = 2; ex2 前收 50 派息 30 → f = 50/20 = 2.5。
      expect(
        chain.map((f) => [
          f.exDate.toISOString().slice(0, 10),
          new Prisma.Decimal(f.factorBackward).toFixed(2),
        ]),
      ).toEqual([
        ['2026-06-02', '2.00'],
        ['2026-06-04', '2.50'],
      ]);
      expect(chain.every((f) => f.source === 'event_terms')).toBe(true);
      // 零 DailyBar 写入 (仍仅 4 根 none 行)。
      expect(await prisma.dailyBar.count({ where: { instrumentId: instId } })).toBe(4);

      // 二次跑: 行数/值零变更 (uk upsert 幂等可重跑, US3 AS-2)。
      expect(await rebuildFactorChains(prisma)).toBe(0);
      const again = await prisma.adjustmentFactor.findMany({
        where: { instrumentId: instId },
        orderBy: { exDate: 'asc' },
      });
      expect(again).toHaveLength(2);
      expect(again.map((f) => new Prisma.Decimal(f.factorBackward).toFixed(8))).toEqual(
        chain.map((f) => new Prisma.Decimal(f.factorBackward).toFixed(8)),
      );
    });

    it('零除权史 → 零外呼零因子; 有除权史但无 none 基底 → 跳过零外呼 (先 backfill 后 --factors)', async () => {
      // 零除权史 (新上市): 无事件可锚, 读时换算按 1。
      const plainId = await createInstrument('000001');
      await prisma.dailyBar.create({
        data: {
          instrumentId: plainId,
          tradeDate: new Date('2026-06-03T00:00:00Z'),
          adjust: 'none',
          open: '50.0000',
          high: '50.0000',
          low: '50.0000',
          close: '50.0000',
        },
      });
      // 有除权史但 none 基底缺失 (冷启动顺序倒置): 无窗口可锚 → 跳过待补齐重跑。
      const noBaseId = await createInstrument('600036');
      await prisma.corporateAction.create({
        data: {
          instrumentId: noBaseId,
          exDate: new Date('2026-06-02T00:00:00Z'),
          type: 'dividend',
          payload: {},
        },
      });
      expect(await rebuildFactorChains(prisma)).toBe(0);
      expect(await prisma.adjustmentFactor.count()).toBe(0); // 双跳过 → 零因子。
    });

    // 「vendor 拉取失败 → partial」用例随口径退役: 本命令已零 vendor 外呼, 该失败模式不存在。
    // 剩余失败模式 (写库异常 → WARN 续跑 + 退出码 1) 在 marketdata-backfill.cli.spec 以可注入
    // 的 prisma stub 覆盖 —— 真 PG 上无法可靠制造单标的写失败。
  });

  // 019 T010 → **020 T008 改写 (写路径收窄, FR-A01)**: 三模式只落 none — D2 除权命中
  // 检查 (本地查零外呼, 019 机制零碰) → 平淡日恰 1 次 none; 命中 = none + transient 跃变
  // 锚定 (恰 2 次, SC-A03); backfill = none 区间 + 有除权史标的 backward transient (≤2 次)。
  describe('020 T008 eod 写路径收窄 (none 单口径 + transient 锚定)', () => {
    const FWD = '1.05';
    const BWD = '1.10';

    /** 多标的计数 vendor: series per symbol; forward/backward = none × 段因子 (exDate 起)。 */
    function countingVendor(
      series: Record<string, Array<[string, string]>>,
      exDateBySymbol: Record<string, string>,
    ): { port: EodBarPort; calls: Array<{ symbol: string; adjust: string }> } {
      const calls: Array<{ symbol: string; adjust: string }> = [];
      const port: EodBarPort = {
        async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
          calls.push({ symbol: query.symbol, adjust: query.adjust });
          const rows = series[query.symbol] ?? [];
          const exDate = exDateBySymbol[query.symbol];
          return rows
            .filter(([d]) => (!query.from || d >= query.from) && (!query.to || d <= query.to))
            .map(([d, none]) => {
              const n = new Prisma.Decimal(none);
              const post = exDate !== undefined && d >= exDate;
              const close =
                query.adjust === 'none'
                  ? n
                  : query.adjust === 'forward'
                    ? n.mul(post ? FWD : '1')
                    : n.mul(post ? BWD : '1');
              return {
                tradeDate: d,
                adjust: query.adjust,
                open: close.toFixed(4),
                high: close.toFixed(4),
                low: close.toFixed(4),
                close: close.toFixed(4),
                changePct: null,
                prevClose: null,
                volume: '1000',
                amount: null,
                turnoverRate: null,
              };
            });
        },
      };
      return { port, calls };
    }

    async function seedInstrument(code: string): Promise<bigint> {
      const inst = await prisma.instrument.create({
        data: { market: 'cn', code, name: code, type: 'stock', currency: 'CNY', status: 'active' },
      });
      return inst.id;
    }

    /** eod_bar 维度水位 (D2 窗口左界) 置前一日。 */
    async function setEodWatermark(d: string | null): Promise<void> {
      await prisma.syncDimension.update({
        where: { dimensionKey: 'eod_bar' },
        data: { lastWatermark: d === null ? null : new Date(`${d}T14:00:00Z`) },
      });
    }

    function buildEodRegistry(port: EodBarPort): DimensionExecutorRegistry {
      const mock = new MockMarketDataAdapter();
      return new DimensionExecutorRegistry(
        new SyncUniverseUseCase(mock, prisma),
        new SyncProfileUseCase(mock, prisma),
        port,
        mock,
        mock,
        mock,
        prisma,
        new SyncRunRecorder(prisma),
        new SyncTierRecalc(prisma),
      );
    }

    const runEod = (registry: DimensionExecutorRegistry, mode: 'delta' | 'backfill' = 'delta') =>
      registry.execute('eod_bar', {
        mode,
        asOf: AS_OF,
        now: NOW,
        ...(mode === 'backfill' ? { backfillHistoryDays: 5 } : {}),
      });

    it('① 平淡日: 每标的恰 1 次 none 调用 + 仅 none 1 行落库 (SC-A03 平淡日半 / FR-A01)', async () => {
      const instId = await seedInstrument('000001');
      await setEodWatermark('2026-06-02');
      const { port, calls } = countingVendor({ 'cn:000001': [[AS_OF, '101.0000']] }, {});
      const { stats } = await runEod(buildEodRegistry(port));
      expect(stats.failed).toBe(0);

      // 恰 1 次调用且 adjust=none, 零 forward/backward 外呼。
      expect(calls).toEqual([{ symbol: 'cn:000001', adjust: 'none' }]);

      // 仅 none 1 行落库 (020 T008: 推导段退役, 复权读时换算)。
      const bars = await prisma.dailyBar.findMany({ where: { instrumentId: instId } });
      expect(bars.map((b) => b.adjust)).toEqual(['none']);
      expect(new Prisma.Decimal(bars[0].close).toFixed(4)).toBe('101.0000');
    });

    it('② 除权命中日: 仅命中标的走命中路径 (transient 跃变锚定), 未命中标的仍只拉 none', async () => {
      const hitId = await seedInstrument('600519');
      const plainId = await seedInstrument('000001');
      await setEodWatermark('2026-06-02');
      // 前一交易日 none 行 (昨日 delta 已同步形态 — 跃变锚定的相邻日)。
      await prisma.dailyBar.create({
        data: {
          instrumentId: hitId,
          tradeDate: new Date('2026-06-02T00:00:00Z'),
          adjust: 'none',
          open: '100.0000',
          high: '100.0000',
          low: '100.0000',
          close: '100.0000',
        },
      });
      // 命中: 600519 exDate = asOf (06-03) ∈ (06-02, 06-03]。
      await prisma.corporateAction.create({
        data: {
          instrumentId: hitId,
          exDate: new Date(`${AS_OF}T00:00:00Z`),
          type: 'dividend',
          payload: { dividend: 9.0909, currency: 'CNY' }, // 100/(100−9.0909) = 1.10
        },
      });
      const { port, calls } = countingVendor(
        {
          'cn:600519': [
            ['2026-06-02', '100.0000'],
            [AS_OF, '101.0000'],
          ],
          'cn:000001': [[AS_OF, '50.0000']],
        },
        { 'cn:600519': AS_OF },
      );
      const { stats } = await runEod(buildEodRegistry(port));
      expect(stats.failed).toBe(0);

      const callsBySymbol = (s: string) => calls.filter((c) => c.symbol === s).map((c) => c.adjust);
      // 未命中: 恰 [none]。
      expect(callsBySymbol('cn:000001')).toEqual(['none']);
      // 🚨 命中标的也**只有 [none]** —— 换事件条款法后锚定零 vendor 外呼 (旧口径此处是
      // ['none','backward'], 那次额外的 backward 拉取正是失效口径的输入)。
      expect(callsBySymbol('cn:600519')).toEqual(['none']);
      // 零复权行写入 (transient 不落库)。
      expect(
        await prisma.dailyBar.count({ where: { instrumentId: hitId, adjust: { not: 'none' } } }),
      ).toBe(0);
      // 命中路径按条款锚定: f = 前收/(前收 − 派息) = 100/90.9091 = 1.10。
      const factors = await prisma.adjustmentFactor.findMany({ where: { instrumentId: hitId } });
      expect(factors).toHaveLength(1);
      expect(new Prisma.Decimal(factors[0].factorBackward).toFixed(2)).toBe('1.10');
      // 未命中标的零额外请求外的零因子写入。
      expect(await prisma.adjustmentFactor.count({ where: { instrumentId: plainId } })).toBe(0);
    });

    it('③ backfill 有除权史标的: 恰 1 次调用 (仅 none 区间) + 全事件因子在场 (SC-A03)', async () => {
      const instId = await seedInstrument('600519');
      await prisma.corporateAction.create({
        data: {
          instrumentId: instId,
          exDate: new Date('2026-06-02T00:00:00Z'),
          type: 'dividend',
          payload: { dividend: 9.0909, currency: 'CNY' }, // 100/(100−9.0909) = 1.10
        },
      });
      const { port, calls } = countingVendor(
        {
          'cn:600519': [
            ['2026-06-01', '100.0000'],
            ['2026-06-02', '50.0000'],
            [AS_OF, '51.0000'],
          ],
        },
        { 'cn:600519': '2026-06-02' },
      );
      const { stats } = await runEod(buildEodRegistry(port), 'backfill');
      expect(stats.failed).toBe(0);
      // 🚨 恰 1 次: 只剩 none 历史区间落库 —— 锚定改走本地四表, 零 vendor 外呼。
      expect(calls.map((c) => c.adjust)).toEqual(['none']);
      // none 单口径 3 日落库; backward 不落库 (transient)。
      expect(await prisma.dailyBar.count({ where: { instrumentId: instId } })).toBe(3);
      expect(await prisma.dailyBar.count({ where: { instrumentId: instId, adjust: 'none' } })).toBe(
        3,
      );
      // 全事件因子在场: f = 前收/(前收 − 派息) = 100/90.9091 = 1.10。
      const factors = await prisma.adjustmentFactor.findMany({ where: { instrumentId: instId } });
      expect(factors).toHaveLength(1);
      expect(new Prisma.Decimal(factors[0].factorBackward).toFixed(2)).toBe('1.10');
    });

    it('④ 水位 NULL (首跑): 空命中 → 全标的只拉 none, 不全量重拉历史复权', async () => {
      const instId = await seedInstrument('000001');
      await setEodWatermark(null);
      // 即便有窗内 exDate, 水位 NULL → 不进命中集 (历史复权归 backfill/corp 自愈)。
      await prisma.corporateAction.create({
        data: {
          instrumentId: instId,
          exDate: new Date(`${AS_OF}T00:00:00Z`),
          type: 'dividend',
          payload: {},
        },
      });
      const { port, calls } = countingVendor({ 'cn:000001': [[AS_OF, '50.0000']] }, {});
      const { stats } = await runEod(buildEodRegistry(port));
      expect(stats.failed).toBe(0);
      expect(calls.map((c) => c.adjust)).toEqual(['none']);
    });

    it('⑥ SC-S04 除权日链序端到端: 派生序 corp 先于 eod (T011 hard 边) → 因子先写后用 + 非除权标的零额外请求', async () => {
      // 派生序自真实 seed (T011 migration): corp 提至 eod 前, 两 hard 边链相邻。
      const edges = (await prisma.syncDependency.findMany({
        select: { upstream: true, downstream: true, mode: true },
      })) as { upstream: string; downstream: string; mode: 'hard' | 'soft' }[];
      const priorities = await prisma.syncDimension.findMany({
        select: { dimensionKey: true, priority: true },
      });
      const { deriveExecutionOrder } = await import('../../src/marketdata/sync-flow-assembler.js');
      const order = deriveExecutionOrder(
        edges,
        new Map(priorities.map((p) => [p.dimensionKey, p.priority])),
      );
      expect(order).toEqual([
        'universe',
        'profile',
        'fundamental',
        'financial',
        'corporate_action',
        'eod_bar',
        'hk_option_contract', // 066 T04
        'hk_option_daily_snapshot', // 066 T04
        'hk_underlying_iv_daily', // 066 T04
        'option_contract', // 047 (priority 5 撞 eod_bar → key 字典序: 'eod_bar' < 'option_contract')
        'option_daily_snapshot', // 047 (priority 5; hard 边 option_contract→option_daily_snapshot 要求两者相邻, 由 key 字典序天然满足)
        'underlying_iv_daily', // 046 (priority 5 撞 eod_bar → key 字典序: 'option_daily_snapshot' < 'underlying_iv_daily' < 'us_equity_bar')
        'us_equity_bar', // sellput-viz (priority 5 撞 eod_bar → key 字典序后置)
        'us_index_daily', // 046 (priority 5, 'us_equity_bar' < 'us_index_daily'; 无入边 ⇒ Kahn 里恒在 ready 集, 位置由 priority 定)
        // 039/040/041/042/043 港股维度 priority ≤4 均低于核心 6 维 → 派生序尾部 (不改 corp<eod 相对序);
        // 040 volatility(4)/hot_snapshot(3) 撞 039 short_selling(4)/connect_holding(3) → key 字典序后置;
        // 041 buyback(4)/equity_change(3)/shareholder_change(2)/allotment(1) 同 tier 撞值按 key 字典序插入;
        // 042 revenue_segment(4)/shareholder_snapshot(3)/employee(2) 同 tier 撞值按 key 字典序插入;
        // 043 industry_classification(2)/announcement(1) 同 tier 撞值按 key 字典序插入。
        'buyback', // 041 (priority 4, key 'buyback' < 'revenue_segment' < 'short_selling' 前置)
        'earnings_event', // 047 (priority 4 而非 5 —— 取 5 会插进 corporate_action→eod_bar 那条 hard 边中间, 见 seed migration 注释)
        'revenue_segment', // 042 (priority 4, 'earnings_event' < 'revenue_segment' < 'short_selling')
        'short_selling',
        'volatility', // 040 (撞 short_selling priority 4 → key 后置)
        'connect_holding',
        'equity_change', // 041 (priority 3, 'connect_holding' < 'equity_change' < 'hot_snapshot')
        'hot_snapshot', // 040 (撞 connect_holding priority 3 → key 后置)
        'shareholder_snapshot', // 042 (priority 3, 'hot_snapshot' < 'shareholder_snapshot')
        'employee', // 042 (priority 2, 'employee' < 'fund_holding' 前置)
        'fund_holding',
        'industry_classification', // 043 (priority 2, 'fund_holding' < 'industry_classification' < 'shareholder_change')
        'shareholder_change', // 041 (priority 2, 'fund_holding' < 'shareholder_change')
        'allotment', // 041 (priority 1, 'allotment' < 'fund_company_holding' 前置)
        'announcement', // 043 (priority 1, 'allotment' < 'announcement' < 'fund_company_holding')
        'fund_company_holding',
        'index_membership',
      ]);
      expect(edges).toContainEqual({
        upstream: 'corporate_action',
        downstream: 'eod_bar',
        mode: 'hard',
      });

      // 端到端 (派生序控形直调, worker 链序等价): corp 捕获新除权 → eod 命中锚定。
      const hitId = await seedInstrument('600519');
      const plainId = await seedInstrument('000001');
      await setEodWatermark('2026-06-02');
      // 前一交易日 none 行 (跃变锚定相邻日; corp 相位 ex 日 bar 未在 → 跳过, eod 相位补锚)。
      await prisma.dailyBar.create({
        data: {
          instrumentId: hitId,
          tradeDate: new Date('2026-06-02T00:00:00Z'),
          adjust: 'none',
          open: '100.0000',
          high: '100.0000',
          low: '100.0000',
          close: '100.0000',
        },
      });
      const { port, calls } = countingVendor(
        {
          'cn:600519': [
            ['2026-06-02', '100.0000'],
            [AS_OF, '101.0000'],
          ],
          'cn:000001': [[AS_OF, '50.0000']],
        },
        { 'cn:600519': AS_OF },
      );
      const corpPort: CorporateActionPort = {
        async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
          return symbol === 'cn:600519'
            ? [
                {
                  symbol,
                  exDate: AS_OF,
                  type: 'dividend',
                  // 条款: 前收 100 派息 9.0909 → f = 100/90.9091 = 1.10。
                  payload: { dividend: 9.0909, currency: 'CNY' },
                },
              ]
            : [];
        },
      };
      const mock = new MockMarketDataAdapter();
      const registry = new DimensionExecutorRegistry(
        new SyncUniverseUseCase(mock, prisma),
        new SyncProfileUseCase(mock, prisma),
        port,
        mock,
        mock,
        corpPort,
        prisma,
        new SyncRunRecorder(prisma),
        new SyncTierRecalc(prisma),
      );
      // 链序 = 派生序 (corp 先): corp 捕获 exDate + 重拉窗口; eod 后行命中重算 + 锚定。
      await registry.execute('corporate_action', { mode: 'delta', asOf: AS_OF, now: NOW });
      expect(await prisma.corporateAction.count({ where: { instrumentId: hitId } })).toBe(1);
      await registry.execute('eod_bar', { mode: 'delta', asOf: AS_OF, now: NOW });

      // 双点幂等收敛 (corp 相位跳过 → eod 相位补锚): 600519 跃变版本在场。
      const factors = await prisma.adjustmentFactor.findMany({ where: { instrumentId: hitId } });
      expect(factors).toHaveLength(1);
      expect(new Prisma.Decimal(factors[0].factorBackward).toFixed(2)).toBe('1.10');
      // none 单口径当夜在场 (两标的, 020 T008 写收窄)。
      for (const id of [hitId, plainId]) {
        const todays = await prisma.dailyBar.findMany({
          where: { instrumentId: id, tradeDate: new Date(`${AS_OF}T00:00:00Z`) },
        });
        expect(todays.map((b) => b.adjust)).toEqual(['none']);
      }
      // 非除权标的零额外请求: eod 面恰 1 次 none 调用 (corp 面对其零数据外呼)。
      expect(calls.filter((c) => c.symbol === 'cn:000001').map((c) => c.adjust)).toEqual(['none']);
    });

    it('⑤ backfill 零除权史标的: 恰 1 次 none 区间调用, 零 backward 外呼零因子 (analyze L2)', async () => {
      const instId = await seedInstrument('000001');
      const { port, calls } = countingVendor(
        {
          'cn:000001': [
            ['2026-06-01', '50.0000'],
            ['2026-06-02', '51.0000'],
            [AS_OF, '52.0000'],
          ],
        },
        {},
      );
      const { stats } = await runEod(buildEodRegistry(port), 'backfill');
      expect(stats.failed).toBe(0);
      // 无事件可锚 → 跳过 backward transient, 恰 1 次 none 区间调用。
      expect(calls.map((c) => c.adjust)).toEqual(['none']);
      expect(await prisma.dailyBar.count({ where: { instrumentId: instId } })).toBe(3); // 3 日 × none 1 行。
      expect(await prisma.adjustmentFactor.count({ where: { instrumentId: instId } })).toBe(0);
    });
  });
});
