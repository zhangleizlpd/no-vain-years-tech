import { Logger } from '@nestjs/common';
import { describe, it, expect, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service.js';
import type { ExecutorInput, ExecutorSyncDimensionRow } from './dimension-executor.js';
import type {
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from './option-snapshot.port.js';
import { emptyStats } from './sync-run.recorder.js';
import { SyncOptionOiSettleUseCase } from './sync-option-oi-settle.usecase.js';
import { stubTradingCalendar } from '../../test/_support/trading-calendar-stub';

/**
 * 轮2「OI 定稿回填」use case 单测 (073 T002, Small —— mock port + mock prisma, 零容器)。
 *
 * 🚨 本文件盯的四条都是「盲写会踩、且踩了不会红」的坑:
 * ① **定稿判据是入口闸** (plan §D3): `oiRefreshedAtEod` 返 false ⇒ 整轮**不写**, 而不是
 *    「写个近似值」。轮2 的 cron 恒排在 21:40, 静态看永远在定稿之后 —— 正因为如此, 漏掉这道
 *    闸在稳态下**永远不会红**, 而有人挪一次时刻就会把 D−1 的 OI 标成 D (数字与标签双错)。
 * ② **只写三列** (FR-007): `open_interest` / `net_open_interest` / `oi_as_of`。多写一列报价
 *    就是拿 21:40 的盘口盖掉 16:20 抢到的那份 —— 而抢那份正是本片存在的全部理由。
 * ③ **UPDATE MUST 限定 `source = 'eod'`** (Guardrail 6): 不限定会连美股仍在产的
 *    `premarket_backfill` 行一起改。
 * ④ **段 a 只碰已存在的行**: 工作集先查已存在集合再分流 (Guardrail 2), 不是「先全量写再全量改」。
 */

/** 港股当地墙上时钟 (HKT = UTC+8, 不实行夏令时) → 绝对时刻。 */
const hkt = (date: string, hhmm: string) => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  // ⚠️ `Date.UTC` 的月份是 0-indexed —— 直传会静默偏一个月, 而所有断言都只会说「日期不对」。
  return new Date(Date.UTC(y, mo - 1, d, h - 8, m));
};

const SESSION_DATE = '2026-09-01';

const DIM = {
  dimensionKey: 'hk_option_oi_settle',
  marketScope: ['hk'],
  batchSize: 50,
} as unknown as ExecutorSyncDimensionRow;

function makeInput(now: Date): ExecutorInput {
  return { mode: 'delta', asOf: SESSION_DATE, now };
}

const TCH = { id: 3n, market: 'hk', code: '00700' };

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const day = (s: string) => new Date(`${s}T00:00:00Z`);

/** code → 稳定合约 id (同一 code 反复取到同一个 id, 断言里可直接复用)。 */
const contractIds = new Map<string, bigint>();
function contractRow(code: string) {
  if (!contractIds.has(code)) contractIds.set(code, BigInt(contractIds.size + 1));
  return { id: contractIds.get(code) as bigint, code };
}

/** 一行期权快照 (adapter 已归一化后的形态)。轮2 只读其中两列 OI。 */
function quoteRow(code: string, extra: Partial<OptionSnapshotRow> = {}): OptionSnapshotRow {
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
    vendorUpdateTime: new Date(`${SESSION_DATE}T08:00:00Z`),
    greeksComplete: true,
    ...extra,
  };
}

/** 一次 `updateMany` 的入参 (段 a 的判定面: where 三段 + data 三列)。 */
interface RecordedUpdate {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface Harness {
  useCase: SyncOptionOiSettleUseCase;
  queries: OptionSnapshotQuery[];
  updates: RecordedUpdate[];
  /** 段 a 分流前那次「当日已有哪些 eod 行」的查询入参。 */
  existingWhere: unknown[];
}

/**
 * @param contracts     每 instrumentId 的合约表内容 (工作集; 默认空 = 链发现没跑过)
 * @param existing      当日已有 `source='eod'` 行的合约 code (段 a 的对象集)
 * @param premarketOnly 当日**只**有 `source='premarket_backfill'` 行的合约 code ——
 *   Guardrail 6 的反例组: 美股那侧仍在产这种行, 分流谓词漏掉 `source` 就会把它们捞进段 a。
 * @param rowsFor       每批返回的快照行 (默认: 请求的每个合约一行)
 */
function makeHarness(opts: {
  contracts?: Record<string, ReturnType<typeof contractRow>[]>;
  existing?: string[];
  premarketOnly?: string[];
  rowsFor?: (q: OptionSnapshotQuery) => OptionSnapshotRow[];
}): Harness {
  const queries: OptionSnapshotQuery[] = [];
  const updates: RecordedUpdate[] = [];
  const existingWhere: unknown[] = [];
  const allContracts = Object.values(opts.contracts ?? {}).flat();
  const idOf = (code: string) => allContracts.find((c) => c.code === code)?.id;
  // 库里当日的快照行 (按 source 分两类) —— 替身**按 source 过滤**, 于是「分流谓词漏掉
  // source」这件事在本文件里是可构造、可断言的, 而不是只能靠读代码。
  const snapshotRows = [
    ...(opts.existing ?? []).map((code) => ({ contractId: idOf(code), source: 'eod' })),
    ...(opts.premarketOnly ?? []).map((code) => ({
      contractId: idOf(code),
      source: 'premarket_backfill',
    })),
  ];

  const port: OptionSnapshotPort = {
    getSnapshots: vi.fn(async (q: OptionSnapshotQuery) => {
      queries.push(q);
      return {
        asOf: hkt(SESSION_DATE, '21:40'),
        rows: opts.rowsFor ? opts.rowsFor(q) : q.contractCodes.map((c) => quoteRow(c)),
      };
    }),
  };

  const updateMany = vi.fn((args: RecordedUpdate) => {
    updates.push(args);
    // Prisma 的 delegate 返回 PrismaPromise; 本替身直接返 thenable, `$transaction` 数组式
    // 与 `await` 两条路都吃得下。
    return Promise.resolve({ count: 1 });
  });

  const calendar = stubTradingCalendar({ status: 'trading' });
  const prisma = {
    optionContract: {
      findMany: vi.fn(async (args: { where: { underlyingInstrumentId?: bigint } }) => {
        return opts.contracts?.[String(args.where.underlyingInstrumentId)] ?? [];
      }),
    },
    optionDailySnapshot: {
      findMany: vi.fn(async (args: { where: { source?: string } }) => {
        existingWhere.push(args.where);
        return snapshotRows.filter((r) => r.source === args.where.source);
      }),
      updateMany,
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    tradingDay: {
      findFirst: vi.fn(async (args: { where: { date: { lte?: Date; lt?: Date } } }) => {
        if (args.where.date.lte !== undefined) return { date: args.where.date.lte };
        return { date: day('2026-08-31') };
      }),
      findUnique: vi.fn(async () => ({ sessionKind: 'whole' })),
    },
  } as unknown as PrismaService;

  return {
    useCase: new SyncOptionOiSettleUseCase(port, prisma, calendar),
    queries,
    updates,
    existingWhere,
  };
}

const TCH_CONTRACTS = {
  '3': [contractRow('HK.TCH260924P600000'), contractRow('HK.TCH260924C600000')],
};

describe('SyncOptionOiSettleUseCase (073 轮2 段 a: OI 定稿回填)', () => {
  describe('🚨 ① 定稿判据是入口闸 (plan §D3 / state_branch 8)', () => {
    it('定稿为真 (21:40 ≥ 21:30) → 三列被更新, 且 oi_as_of = session_date', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000', 'HK.TCH260924C600000'],
      });
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.updates).toHaveLength(2);
      for (const u of h.updates) {
        expect(u.data).toEqual({
          openInterest: '3120',
          netOpenInterest: '-410',
          oiAsOf: day(SESSION_DATE),
        });
      }
      expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0, skipped: 0, written: 2 });
    });

    it('🚨 定稿为假 (20:00 < 21:30) → 零外呼、零写入, 且落 ERROR 留痕', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000'],
      });
      const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '20:00')));

      expect(h.queries).toHaveLength(0);
      expect(h.updates).toHaveLength(0);
      // 「跑了但没采」与「采了零行」必须可分辨 (同 written 三态的判据)。
      expect(stats).toMatchObject({ scanned: 0, ok: 0, failed: 0, skipped: 1, written: 0 });
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('OI 尚未定稿');
      errSpy.mockRestore();
    });
  });

  describe('🚨 ②③ 只写三列, 且 where 限定 source = eod', () => {
    it('UPDATE 的 where 三段齐全 (contract_id + session_date + source=eod)', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000', 'HK.TCH260924C600000'],
      });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.updates.map((u) => u.where)).toEqual([
        {
          contractId: contractRow('HK.TCH260924P600000').id,
          sessionDate: day(SESSION_DATE),
          source: 'eod',
        },
        {
          contractId: contractRow('HK.TCH260924C600000').id,
          sessionDate: day(SESSION_DATE),
          source: 'eod',
        },
      ]);
    });

    it('🚨 只有 premarket_backfill 行的合约**不进**段 a —— 零外呼、零 UPDATE (Guardrail 6)', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000'],
        premarketOnly: ['HK.TCH260924C600000'],
      });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.queries.flatMap((q) => q.contractCodes)).toEqual(['HK.TCH260924P600000']);
      expect(h.updates.map((u) => u.where.contractId)).toEqual([
        contractRow('HK.TCH260924P600000').id,
      ]);
    });

    it('🚨 data 里**只有**三列 —— 报价 / greeks 一个字段都不出现 (SC-004)', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000', 'HK.TCH260924C600000'],
      });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      for (const u of h.updates) {
        expect(Object.keys(u.data).sort()).toEqual(['netOpenInterest', 'oiAsOf', 'openInterest']);
      }
    });
  });

  describe('🚨 ④ 段 a 只碰已存在的行 (Guardrail 2: 先查已存在集合再分流)', () => {
    it('已存在集合的查询同样带 source=eod + 当日 session_date', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS, existing: ['HK.TCH260924P600000'] });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.existingWhere[0]).toMatchObject({
        sessionDate: day(SESSION_DATE),
        source: 'eod',
      });
    });

    it('主轮没写过的合约不进段 a 的外呼批次与 UPDATE (它归段 b, 073 T003)', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS, existing: ['HK.TCH260924P600000'] });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.queries.flatMap((q) => q.contractCodes)).toEqual(['HK.TCH260924P600000']);
      expect(h.updates).toHaveLength(1);
    });

    it('该票当日一行都没有 → 段 a 零外呼 (无对象, 不是失败)', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS, existing: [] });
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.queries).toHaveLength(0);
      expect(h.updates).toHaveLength(0);
      expect(stats.written).toBe(0);
    });

    it('库中零合约 → 零外呼、计 skipped (hard 依赖链发现, 同主轮口径)', async () => {
      const h = makeHarness({ contracts: {} });
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.queries).toHaveLength(0);
      expect(stats).toMatchObject({ scanned: 1, ok: 0, skipped: 1, failed: 0 });
    });
  });

  describe('单市场 scope 守卫 (同主轮: 混 scope 没有单一答案)', () => {
    it('多市场 scope → 当场抛, 不挑第一个', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS });
      const mixed = { ...DIM, marketScope: ['hk', 'us'] } as unknown as ExecutorSyncDimensionRow;

      await expect(
        h.useCase.run([TCH], mixed, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40'))),
      ).rejects.toThrow(/单市场 scope/);
    });
  });
});
