import { Logger } from '@nestjs/common';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { MarketdataSyncConfig } from '../config/marketdata.config.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../security/prisma.service.js';
import type { ExecutorInput, ExecutorSyncDimensionRow } from './dimension-executor.js';
import {
  OptionSnapshotCoverageCheck,
  type OptionCoverageReport,
} from './option-snapshot-coverage.check.js';
import {
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  OptionSnapshotBudgetExhaustedError,
} from './option-snapshot.port.js';
import type {
  OptionSnapshotPort,
  OptionSnapshotQuery,
  OptionSnapshotRow,
} from './option-snapshot.port.js';
import { emptyStats } from './sync-run.recorder.js';
import { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
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

/**
 * code → 稳定合约 id (同一 code 反复取到同一个 id, 断言里可直接复用)。
 *
 * 形状是**主轮工作集的全集**而不是轮2 自己那两列 —— 段 b 直调
 * `SyncOptionSnapshotUseCase.collect`, 它要读行权价 / 买卖方向 / 非标标记喂硬门。
 * 全为 PUT + 行权价远低于 spot ⇒ 门 ④ (无套利下界) 恒过, 本文件的红只会来自轮2 自己的逻辑。
 */
const contractIds = new Map<string, bigint>();
function contractRow(code: string, strike = '600') {
  if (!contractIds.has(code)) contractIds.set(code, BigInt(contractIds.size + 1));
  return {
    id: contractIds.get(code) as bigint,
    code,
    optionType: 'PUT',
    strikePrice: new Prisma.Decimal(strike),
    expiryDate: day('2026-09-24'),
    root: 'TCH',
    isStandard: true,
  };
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

/** 标的自身那行 (spot 的来源, 与期权行同批返回; 段 b 的硬门 ④ 要读它)。 */
function underlyingRow(): OptionSnapshotRow {
  return {
    ...quoteRow('HK.00700'),
    isOption: false,
    underlyingCode: null,
    // 远高于两个行权价 ⇒ PUT 内在价值恒 0, 门 ④ 恒过。
    last: '700',
    bid: null,
    ask: null,
    delta: null,
    greeksComplete: null,
  };
}

/** 轮2 收尾那次覆盖率判定的返回 —— 只有 `status` / `degraded` 参与 `alertIfDegraded`。 */
function coverageReport(status: 'ok' | 'degraded'): OptionCoverageReport {
  const degraded =
    status === 'degraded'
      ? [
          {
            instrumentId: TCH.id,
            symbol: 'hk:00700',
            expected: 2,
            covered: 1,
            missingContractCodes: ['HK.TCH260924C600000'],
            degraded: true,
          },
        ]
      : [];
  return {
    market: 'hk',
    sessionDate: SESSION_DATE,
    baselineDate: '2026-08-31',
    threshold: 1,
    status,
    expected: 2,
    covered: status === 'degraded' ? 1 : 2,
    underlyings: degraded,
    degraded,
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
  /** 工作集 (`option_contract.findMany`) 查询入参 —— 验软下架过滤。 */
  contractWhere: { underlyingInstrumentId?: bigint; withdrawnAt?: null }[];
  /** 段 b 真正落库的行 (替身已按唯一键模拟 `skipDuplicates`)。 */
  inserted: Record<string, unknown>[];
  /** 段 b 递给 `createMany` 的原始 data (含被幂等键挡掉的那些)。 */
  createManyArgs: { data: Record<string, unknown>[]; skipDuplicates?: boolean }[];
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
  /** 轮2 收尾那次覆盖率判定的结论 (T008)。不传 ⇒ 不装覆盖率检查 (等价于早期形态)。 */
  coverage?: 'ok' | 'degraded';
}): Harness {
  const queries: OptionSnapshotQuery[] = [];
  const updates: RecordedUpdate[] = [];
  const existingWhere: unknown[] = [];
  const contractWhere: { underlyingInstrumentId?: bigint; withdrawnAt?: null }[] = [];
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
        rows: opts.rowsFor
          ? opts.rowsFor(q)
          : [...q.contractCodes.map((c) => quoteRow(c)), underlyingRow()],
      };
    }),
  };

  const updateMany = vi.fn((args: RecordedUpdate) => {
    updates.push(args);
    // Prisma 的 delegate 返回 PrismaPromise; 本替身直接返 thenable, `$transaction` 数组式
    // 与 `await` 两条路都吃得下。
    return Promise.resolve({ count: 1 });
  });

  const inserted: Record<string, unknown>[] = [];
  const createManyArgs: { data: Record<string, unknown>[]; skipDuplicates?: boolean }[] = [];
  const createMany = vi.fn(
    async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
      createManyArgs.push(args);
      // 🚨 替身**真的模拟唯一键** `(contract_id, session_date, source)` —— 否则「主轮已写的
      // 合约不被重写」这条只能靠读代码, 而它恰恰是段 b 最容易踩坏的那条 (#306 的 555× 放大)。
      const admitted = args.skipDuplicates
        ? args.data.filter(
            (r) =>
              !snapshotRows.some((s) => s.contractId === r.contractId && s.source === r.source),
          )
        : args.data;
      inserted.push(...admitted);
      for (const r of admitted) {
        snapshotRows.push({ contractId: r.contractId as bigint, source: String(r.source) });
      }
      return { count: admitted.length };
    },
  );

  const calendar = stubTradingCalendar({ status: 'trading' });
  const prisma = {
    optionContract: {
      findMany: vi.fn(async (args: { where: { underlyingInstrumentId?: bigint } }) => {
        contractWhere.push(args.where);
        return opts.contracts?.[String(args.where.underlyingInstrumentId)] ?? [];
      }),
      count: vi.fn(async (args: { where: { underlyingInstrumentId: bigint } }) => {
        return opts.contracts?.[String(args.where.underlyingInstrumentId)]?.length ?? 0;
      }),
    },
    optionDailySnapshot: {
      findMany: vi.fn(async (args: { where: { source?: string } }) => {
        existingWhere.push(args.where);
        return snapshotRows.filter((r) => r.source === args.where.source);
      }),
      updateMany,
      createMany,
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

  // 🚨 段 b 的执行体注**真**的 `SyncOptionSnapshotUseCase` (同一份 port + prisma 替身), 不是
  // spy —— 本文件要证的「不重写已有行 / 补出的是完整行」全在它的落库形态里, 换成 spy 就只能
  // 断言「调了它」, 而那句话对这两条一点保护都没有。
  const collector = new SyncOptionSnapshotUseCase(port, prisma, calendar);

  // 🚨 只把**读库那半段** (`evaluate`) 换成剧本; `alertIfDegraded` 走真实现 —— 「升不升
  // ERROR」正是 T008 的被测面, 换成 spy 就只能断言「调了那个方法」而不是「真的响了」。
  // (体例照抄 `option-snapshot-remediation.spec.ts` 的同一处。)
  let coverage: OptionSnapshotCoverageCheck | undefined;
  if (opts.coverage !== undefined) {
    coverage = new OptionSnapshotCoverageCheck(prisma, {
      optionCoverageThreshold: 1,
    } as unknown as MarketdataSyncConfig);
    const status = opts.coverage;
    vi.spyOn(coverage, 'evaluate').mockImplementation(async () => coverageReport(status));
  }

  return {
    useCase: new SyncOptionOiSettleUseCase(port, prisma, calendar, collector, coverage),
    queries,
    updates,
    existingWhere,
    contractWhere,
    inserted,
    createManyArgs,
  };
}

/** `Logger.prototype.error` / `.warn` 的 spy —— 只关心第一个实参 (日志正文)。 */
type LogSpy = { mock: { calls: unknown[][] } };

/** 某个 spy 收到的全部日志正文拼成一段, 供 `toContain` 判定。 */
const loggedBy = (spy: LogSpy): string => spy.mock.calls.map((c) => String(c[0])).join('\n');

/** 覆盖率告警**没有**落在 WARN 那一档 —— 阶梯退役后它只许出现在 ERROR 上。 */
function warnsHaveNoCoverageAlert(spy: LogSpy): boolean {
  return !loggedBy(spy).includes('逐合约覆盖率跌破阈值');
}

const TCH_CONTRACTS = {
  '3': [contractRow('HK.TCH260924P600000'), contractRow('HK.TCH260924C600000')],
};

describe('SyncOptionOiSettleUseCase (073 轮2 段 a: OI 定稿回填)', () => {
  // 🚨 用例内的 `err.mockRestore()` **不够**: 断言一旦抛出, 那行就不执行, 而
  // `vi.spyOn` 对已被 spy 的方法返回**同一个 mock** ⇒ 下一个用例拿到的是带着上一个用例
  // 调用历史的 spy, 于是「不该出现的那条日志」凭空出现。
  // 2026-09-01 实撞: T008 的变异臂里, 一条本该只红两个用例的变异红了三个 —— 第三个是被
  // 上一个用例的日志污染的。**恒真的清理必须挂在 afterEach 上, 不能靠 happy path 那一行。**
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('🚨 工作集排除软下架合约 (withdrawn_at, #334 后续)', () => {
    it('工作集查询带 withdrawnAt: null —— 与主轮同口径, 死码不进轮2 批', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000', 'HK.TCH260924C600000'],
      });
      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));
      const workingSet = h.contractWhere.find((w) => w.underlyingInstrumentId !== undefined);
      expect(workingSet).toMatchObject({ withdrawnAt: null });
    });
  });

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

      // `queries[0]` = 段 a 的批次 (段 b 随后还会为补漏重打整条链, 见下面的 describe)。
      expect(h.queries[0].contractCodes).toEqual(['HK.TCH260924P600000']);
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

      expect(h.queries[0].contractCodes).toEqual(['HK.TCH260924P600000']);
      expect(h.updates).toHaveLength(1);
    });

    it('该票当日一行都没有 → 段 a 零 UPDATE (无对象), 整票转段 b', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS, existing: [] });
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.updates).toHaveLength(0);
      // 段 b 把两条全补出来 ⇒ written 记的是段 b 的落库行数, 不是 0。
      expect(stats.written).toBe(2);
    });

    it('库中零合约 → 零外呼、计 skipped (hard 依赖链发现, 同主轮口径)', async () => {
      const h = makeHarness({ contracts: {} });
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.queries).toHaveLength(0);
      expect(stats).toMatchObject({ scanned: 1, ok: 0, skipped: 1, failed: 0 });
    });
  });

  describe('🚨 批与批彼此隔离 (与主轮 syncUnderlying 同源)', () => {
    it('段 a 中间批失败 → 后续批照常采, 只丢中毒那一批 (整票仍计 failed)', async () => {
      // 2026-09-02 prod 实形: 主轮与轮2 **同一颗**码 (`HK.ALB260904C103000` → 502) 各挂一次,
      // 两处批循环都没有 try/catch ⇒ 该票剩余批全不跑。修在两处, 判据同源。
      const codes = Array.from(
        { length: 2 * OPTION_SNAPSHOT_MAX_CONTRACT_CODES + 1 },
        (_, i) => `HK.TCH260924P${String(600000 + i).padStart(6, '0')}`,
      );
      let call = 0;
      const h = makeHarness({
        contracts: { '3': codes.map((c) => contractRow(c)) },
        existing: codes,
        rowsFor: (q) => {
          call++;
          if (call === 2) throw new Error('502 未知股票 HK.TCH260924P600399');
          return [...q.contractCodes.map((c) => quoteRow(c)), underlyingRow()];
        },
      });
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      // 第 3 批仍被请求 (改前是 2 —— 异常冲出了 refreshOpenInterest)
      expect(h.queries).toHaveLength(3);
      expect(h.updates).toHaveLength(OPTION_SNAPSHOT_MAX_CONTRACT_CODES + 1);
      // 整票仍失败: 吞掉它 = 把硬失败降级成静默的部分成功
      expect(stats.failed).toBe(1);
      expect(JSON.stringify(stats.findings)).toContain('未知股票');
    });

    it('🚨 429 落在中间批 → 立刻顺延, MUST NOT 继续打后续批 (批级容错不适用于限频)', async () => {
      const codes = Array.from(
        { length: 2 * OPTION_SNAPSHOT_MAX_CONTRACT_CODES + 1 },
        (_, i) => `HK.TCH260924P${String(600000 + i).padStart(6, '0')}`,
      );
      let call = 0;
      const h = makeHarness({
        contracts: { '3': codes.map((c) => contractRow(c)) },
        existing: codes,
        rowsFor: (q) => {
          call++;
          if (call === 2) throw new OptionSnapshotBudgetExhaustedError('option-snapshot hk:00700');
          return [...q.contractCodes.map((c) => quoteRow(c)), underlyingRow()];
        },
      });
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      // 继续打第 3 批 = 无视顺延信号, 只会把同一个 429 再要一遍并白吃 worker 的重试次数
      expect(h.queries).toHaveLength(2);
      expect(stats.failed).toBe(0);
      expect(stats.skipped).toBe(1);
    });
  });

  describe('🚨 段 b: 主轮整行缺失的合约补整行 (073 T003, FR-009/FR-010)', () => {
    it('① 主轮已写的合约**不被重写** —— 幂等键挡住, 报价列一个字节都没动', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS, existing: ['HK.TCH260924P600000'] });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      // `createMany` 递进去的是整条链 (collect 的粒度是标的), 但真正落库的只有缺的那条。
      expect(h.createManyArgs.every((a) => a.skipDuplicates === true)).toBe(true);
      expect(h.inserted.map((r) => r.contractId)).toEqual([contractRow('HK.TCH260924C600000').id]);
    });

    it('② 主轮缺失的合约补出**完整行** (报价 + greeks + 三个时点列)', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS, existing: ['HK.TCH260924P600000'] });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.inserted).toHaveLength(1);
      expect(h.inserted[0]).toMatchObject({
        contractId: contractRow('HK.TCH260924C600000').id,
        sessionDate: day(SESSION_DATE),
        // 🚨 段 b MUST 落 eod —— 新开一个 source 会让唯一键不再碰撞, 平行写出第二条整链。
        source: 'eod',
        // hk 的 OI 收盘当晚定稿 ⇒ 补出来的行 oi_as_of 与段 a 的 UPDATE 同值。
        oiAsOf: day(SESSION_DATE),
        quoteAsOf: hkt(SESSION_DATE, '21:40'),
        bid: '2.30',
        ask: '2.40',
        delta: '-0.31',
        openInterest: '3120',
        underlyingSpot: '700',
      });
    });

    it('③ 主轮整场零行 → 段 b 走全量兜底 (state_branch 11)', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS, existing: [] });
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.inserted.map((r) => r.contractId).sort()).toEqual(
        [contractRow('HK.TCH260924P600000').id, contractRow('HK.TCH260924C600000').id].sort(),
      );
      // 该票只被数一次: 循环记 scanned, ok / skipped 交给 collect。
      expect(stats).toMatchObject({ scanned: 1, ok: 1, failed: 0, written: 2 });
    });

    it('🚨 ④ 两段处理的合约 id 集合**交集为空** (Guardrail 2)', async () => {
      const h = makeHarness({ contracts: TCH_CONTRACTS, existing: ['HK.TCH260924P600000'] });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      const segA = new Set(h.updates.map((u) => String(u.where.contractId)));
      const segB = new Set(h.inserted.map((r) => String(r.contractId)));
      expect(segA.size).toBeGreaterThan(0);
      expect(segB.size).toBeGreaterThan(0);
      expect([...segA].filter((id) => segB.has(id))).toEqual([]);
    });

    it('主轮一行不缺 → 段 b **零外呼**, 一次 createMany 都不发', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000', 'HK.TCH260924C600000'],
      });

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      expect(h.createManyArgs).toHaveLength(0);
      // 只有段 a 那一次批次调用。
      expect(h.queries).toHaveLength(1);
    });
  });

  /**
   * 073 T008 告警**一级制** (FR-014 / FR-021, plan §D5)。
   *
   * 退役两级补救之后, 港股这条线上不再有「① 级只 WARN 挂着等 ②」那条阶梯 —— 轮2 是最后一次
   * 机会, 不达标就**直接 ERROR**。
   *
   * 🚨 两条 ERROR **各管一件事, 不可合并**:
   * · 覆盖率不达标 ⇒ 行**缺**了 (FR-014 / FR-021);
   * · 轮2 自身失败 ⇒ 行**在**但 OI **没回填**。覆盖率判据数的是「这个合约今天有没有行」
   *   (`option-snapshot-coverage.check.ts` 的 `collected.has(row.contractId)`), 它对 OI 新鲜度
   *   **完全无输出** ⇒ 主轮成功而轮2 失败时它恒判 ok, 靠它一条会**静默**。
   */
  describe('🚨 073 T008 告警一级制 (FR-014 / FR-021)', () => {
    const errorsOf = loggedBy;

    it('① 覆盖率达标 ∧ 轮2 全成功 → **静默** (每日一次的检查天然不重复告警)', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000', 'HK.TCH260924C600000'],
        coverage: 'ok',
      });
      const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('🚨 ② 轮2 之后覆盖率仍不达标 → **ERROR**, 不是 WARN (阶梯已退役)', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000', 'HK.TCH260924C600000'],
        coverage: 'degraded',
      });
      const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      expect(errorsOf(err)).toContain('逐合约覆盖率跌破阈值');
      // 🚨 判的是「响在 ERROR 那一档」: 旧阶梯把同一件事记在 WARN 上等第二级, 而第二级已经没了。
      expect(warnsHaveNoCoverageAlert(warn)).toBe(true);
      err.mockRestore();
      warn.mockRestore();
    });

    it('🚨 ③ 主轮成功 (覆盖率达标) ∧ 轮2 失败 → 仍 ERROR + 落 findings, **不静默**', async () => {
      // 🚨 这条是覆盖率判据**够不到**的那一格: 行都在 (主轮写的), 缺的是 OI 回填,
      //    而覆盖率数的是行存在 ⇒ 只靠它, 轮2 整轮挂掉也一声不吭。
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000', 'HK.TCH260924C600000'],
        coverage: 'ok',
        rowsFor: () => {
          throw new Error('futu shim 502');
        },
      });
      const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const stats = emptyStats();

      await h.useCase.run([TCH], DIM, stats, makeInput(hkt(SESSION_DATE, '21:40')));

      expect(stats.failed).toBe(1);
      expect(stats.findings).toHaveLength(1);
      expect(errorsOf(err)).toContain('OI 回填未完成');
      err.mockRestore();
    });

    it('🚨 ④ 两轮双失败 (行缺 + 轮2 挂) → 两条 ERROR 各报各的 (FR-021)', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000'],
        coverage: 'degraded',
        rowsFor: () => {
          throw new Error('futu shim 502');
        },
      });
      const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '21:40')));

      const logged = errorsOf(err);
      expect(logged).toContain('OI 回填未完成');
      expect(logged).toContain('逐合约覆盖率跌破阈值');
      err.mockRestore();
    });

    it('🚨 定稿判据为假 → 整轮短路, **不**跑覆盖率判定 (什么都没做就不该判它)', async () => {
      const h = makeHarness({
        contracts: TCH_CONTRACTS,
        existing: ['HK.TCH260924P600000'],
        coverage: 'degraded',
      });
      const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await h.useCase.run([TCH], DIM, emptyStats(), makeInput(hkt(SESSION_DATE, '20:00')));

      const logged = errorsOf(err);
      expect(logged).toContain('OI 尚未定稿');
      expect(logged).not.toContain('逐合约覆盖率跌破阈值');
      err.mockRestore();
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
