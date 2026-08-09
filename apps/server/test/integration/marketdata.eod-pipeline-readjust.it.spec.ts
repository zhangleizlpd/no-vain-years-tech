import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/security/prisma.service';
import { MockMarketDataAdapter } from '../../src/marketdata/mock-market-data.adapter';
import { SyncRunRecorder } from '../../src/marketdata/sync-run.recorder';
import { SyncTierRecalc } from '../../src/marketdata/sync-tier-recalc';
import { SyncUniverseUseCase } from '../../src/marketdata/sync-universe.usecase';
import { SyncProfileUseCase } from '../../src/marketdata/sync-profile.usecase';
import { DimensionExecutorRegistry } from '../../src/marketdata/dimension-executor';
import type { EodBarPort } from '../../src/marketdata/eod-bar.port';
import type { CorporateActionPort } from '../../src/marketdata/corporate-action.port';
import type { EodBarPoint, EodBarQuery } from '../../src/marketdata/marketdata.types';

const TRADING_DAY = new Date('2026-06-03T12:00:00Z'); // 周三
const TARGET = '2026-06-03';
const EX_DATE = '2026-06-02';
const PRE_EX = '2026-06-01'; // ex-date 前一交易日 (跃变锚定的相邻日)。
// floor = targetDate - 730d (复刻 executor subtractDays 口径)。
const FLOOR = (() => {
  const dt = new Date(`${TARGET}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() - 730);
  return dt.toISOString().slice(0, 10);
})();
const d = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** corp adapter: 600519 返指定行动列表。 */
function corpReturning(
  actions: { exDate: string; type: string; dividend?: number }[],
): CorporateActionPort {
  return {
    getCorporateActions: async (symbol) =>
      symbol === 'cn:600519'
        ? actions.map((a) => ({
            symbol,
            exDate: a.exDate,
            type: a.type,
            // 换事件条款法后因子由条款算出 (前收 100 派 50 → f = 100/50 = 2), payload 不能再是空对象。
            payload: a.dividend === undefined ? {} : { dividend: a.dividend, currency: 'CNY' },
          }))
        : [],
  };
}

/** transient 锚定 vendor: backward 跨除权连续 (PRE_EX/EX_DATE/TARGET 全 100), 窗口过滤。 */
function backwardVendor(): { port: EodBarPort; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(
    async (q: EodBarQuery): Promise<EodBarPoint[]> =>
      [PRE_EX, EX_DATE, TARGET]
        .filter((date) => (!q.from || date >= q.from) && (!q.to || date <= q.to))
        .map((date) => ({
          tradeDate: date,
          adjust: q.adjust,
          open: '100',
          high: '100',
          low: '100',
          close: '100',
          changePct: null,
          prevClose: null,
          volume: null,
          amount: null,
          turnoverRate: null,
        })),
  );
  return { port: { getBars: spy }, spy };
}

// 016 T013 → 017 PR-7 → **020 T007 改写 (行为契约变更是本 feature 本体)**: corp 捕获新增
// action 不再重拉/覆盖 forward/backward 行 (reAdjustBars 退役) — 改 1 次 vendor backward
// **transient** 拉取 (lookback 全窗, 不落 DailyBar) + DB none 行 → anchorFactorJumps
// per-event 跃变 → AdjustmentFactor upsert (只写 factorBackward)。none/既有物化行零触碰;
// 失败 WARN 不阻塞, 下次触发幂等补锚 (FR-A05/clarify ④)。
describe('020 T007 corp-action triggered transient 跃变锚定 (零 DailyBar 写入)', () => {
  let prisma: PrismaService;
  let instrumentId: bigint;

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
    const inst = await prisma.instrument.create({
      data: {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        type: 'stock',
        currency: 'CNY',
        status: 'active',
      },
      select: { id: true },
    });
    instrumentId = inst.id;
    // none 行 (锚定的 DB 侧权威源): ex 前 100 → ex 日 50 (除权跳空)。
    for (const [date, close] of [
      [PRE_EX, '100'],
      [EX_DATE, '50'],
      [TARGET, '51'],
    ] as const) {
      await prisma.dailyBar.create({
        data: {
          instrumentId,
          tradeDate: d(date),
          adjust: 'none',
          open: close,
          high: close,
          low: close,
          close,
        },
      });
    }
    // 存量物化复权行 decoy (close=100): 020 后死数据 — 锚定路径必须零触碰 (PR-3 清退)。
    for (const adjust of ['forward', 'backward']) {
      await prisma.dailyBar.create({
        data: {
          instrumentId,
          tradeDate: d(PRE_EX),
          adjust,
          open: '100',
          high: '100',
          low: '100',
          close: '100',
        },
      });
    }
  });

  async function runCorp(eodBar: EodBarPort, corp: CorporateActionPort): Promise<void> {
    const mock = new MockMarketDataAdapter();
    const registry = new DimensionExecutorRegistry(
      new SyncUniverseUseCase(mock, prisma),
      new SyncProfileUseCase(mock, prisma),
      eodBar,
      mock,
      mock,
      corp,
      prisma,
      new SyncRunRecorder(prisma),
      new SyncTierRecalc(prisma),
    );
    await registry.execute('corporate_action', { mode: 'delta', asOf: TARGET, now: TRADING_DAY });
  }

  it('① 新增 corp-action → **零 vendor 外呼**按条款锚定 + 零 DailyBar 写入', async () => {
    const { port, spy } = backwardVendor();
    const barsBefore = await prisma.dailyBar.findMany({ orderBy: { id: 'asc' } });
    await runCorp(port, corpReturning([{ exDate: EX_DATE, type: 'dividend', dividend: 50 }]));

    // corp-action 落库。
    expect(await prisma.corporateAction.count()).toBe(1);
    // 🚨 零 vendor 调用 —— 旧口径此处恰 1 次 backward transient 拉取 (那正是失效口径的输入)。
    expect(spy).not.toHaveBeenCalled();
    // 条款锚定: f = 前收/(前收 − 派息) = 100/50 = 2。
    const factors = await prisma.adjustmentFactor.findMany({ where: { instrumentId } });
    expect(factors).toHaveLength(1);
    expect(factors[0].exDate).toEqual(d(EX_DATE));
    expect(new Prisma.Decimal(factors[0].factorBackward).toFixed(8)).toBe('2.00000000');
    // 零 DailyBar 写入/删除: none + 存量 decoy 行逐行不变 (transient 不落库)。
    const barsAfter = await prisma.dailyBar.findMany({ orderBy: { id: 'asc' } });
    expect(barsAfter.map((b) => [b.id, b.adjust, b.close.toString()])).toEqual(
      barsBefore.map((b) => [b.id, b.adjust, b.close.toString()]),
    );
  });

  it('② 锚定幂等: 同数据连跑两次 → 单因子行, 值稳定', async () => {
    const corp = corpReturning([{ exDate: EX_DATE, type: 'dividend', dividend: 50 }]);
    await runCorp(backwardVendor().port, corp);
    const first = await prisma.adjustmentFactor.findMany({ where: { instrumentId } });
    await runCorp(backwardVendor().port, corp); // 重跑: action 已存在 → 无新增不重锚; 即便重锚值同。
    const second = await prisma.adjustmentFactor.findMany({ where: { instrumentId } });
    expect(second).toHaveLength(1);
    expect(new Prisma.Decimal(second[0].factorBackward).toFixed(8)).toBe(
      new Prisma.Decimal(first[0].factorBackward).toFixed(8),
    );
  });

  it('③ 无新增 corp-action (已存在) → 零 vendor 外呼零锚定', async () => {
    await prisma.corporateAction.create({
      data: { instrumentId, exDate: d(EX_DATE), type: 'dividend', payload: {} },
    });
    const { port, spy } = backwardVendor();
    await runCorp(port, corpReturning([{ exDate: EX_DATE, type: 'dividend', dividend: 50 }]));

    expect(spy).not.toHaveBeenCalled(); // 无新增 → 不锚。
    expect(await prisma.adjustmentFactor.count()).toBe(0);
  });

  it('④ 范围上限: 老 ex-date (2020) 落在 lookback floor 之外 → 不重锚 (不全量回溯)', async () => {
    const { port, spy } = backwardVendor();
    await runCorp(port, corpReturning([{ exDate: '2020-01-01', type: 'dividend', dividend: 1 }]));

    expect(spy).not.toHaveBeenCalled(); // 换口径后锚定零 vendor 外呼。
    // floor 语义从「vendor 拉取窗口起点」变成「重算哪些事件的起点」—— 2020 事件在窗外,
    // 不进本轮重算 (防老票 ~6yr 全量回溯)。存量行原样保留, 本用例库内本就无因子 → 0。
    expect(FLOOR > '2020-01-01').toBe(true);
    expect(await prisma.adjustmentFactor.count()).toBe(0);
  });

  it('⑤ vendor 挂掉不再阻塞锚定 (锚定已零外呼); corp 落库 + 因子照常写', async () => {
    // 旧口径下 vendor throw ⇒ 锚定失败 ⇒ 因子待下次补锚。换事件条款法后锚定只读本地四表,
    // vendor 健康度与因子链彻底解耦 —— 这是换口径的直接收益, 用例语义随之反转。
    const failing: EodBarPort = {
      getBars: async () => {
        throw new Error('vendor down');
      },
    };
    await runCorp(failing, corpReturning([{ exDate: EX_DATE, type: 'dividend', dividend: 50 }]));
    const runs = await prisma.syncRun.findMany({ where: { syncType: 'sync:corporate_action' } });
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    expect(await prisma.corporateAction.count()).toBe(1);
    // 🚨 因子**照常写出** (旧口径此处为 0)。
    const first = await prisma.adjustmentFactor.findMany();
    expect(first).toHaveLength(1);
    expect(new Prisma.Decimal(first[0].factorBackward).toFixed(2)).toBe('2.00');

    // 下次触发 (同标的新事件) → 窗内历史事件一并重算 (乱序零级联, 幂等)。
    await runCorp(
      backwardVendor().port,
      corpReturning([
        { exDate: EX_DATE, type: 'dividend', dividend: 50 },
        { exDate: TARGET, type: 'split' }, // 新增 → 触发锚定。
      ]),
    );
    const factors = await prisma.adjustmentFactor.findMany({ orderBy: { exDate: 'asc' } });
    expect(factors.map((f) => f.exDate)).toEqual([d(EX_DATE), d(TARGET)]);
    expect(new Prisma.Decimal(factors[0].factorBackward).toFixed(8)).toBe('2.00000000');
  });
});
