import { Logger } from '@nestjs/common';
import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../security/prisma.service.js';
import type { ExecutorInput, ExecutorSyncDimensionRow } from './dimension-executor.js';
import {
  OptionSnapshotBudgetExhaustedError,
  OptionSnapshotRejectedError,
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  type OptionSnapshotPort,
  type OptionSnapshotQuery,
  type OptionSnapshotRow,
} from './option-snapshot.port.js';
import { emptyStats } from './sync-run.recorder.js';
import { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import { stubTradingCalendar } from '../../test/_support/trading-calendar-stub';

/**
 * 逐日快照维度 use case 单测 (047 T016, Small —— mock port + mock prisma, 零容器)。
 *
 * 🚨 本文件盯的五条都是「盲写会踩、且踩了不会红」的坑:
 * ① **hard 依赖链发现** (FR-031): 合约表无行 ⇒ **零外呼**, 不是「请求了但返回空」
 * ② **`oi_as_of` = 上一交易日** (Guardrail 6 / plan D-DATA-4): 美股期权 OI 在**盘前**更新 ⇒
 *    T 日收盘后采的快照, 其 OI 是 **T−1 日**的。归到 `session_date` **永远不会红**, 但活跃度
 *    排名与 UI 的 asOf 全错一天
 * ③ **`quote_as_of` 取本批采集时刻**, 不是行内 vendor `update_time` (后者是最后成交时刻,
 *    停牌腿会把采集时刻说成上周)
 * ④ 硬门违规行**逐行**拒绝 + ERROR, 其余行照常入库 (整批回滚 = 当日唯一一次采集机会全丢)
 * ⑤ 批量上限切在调用方 (shim > 400 codes 直接 400, 绝不截断)
 */

/** 北京 06:00 = us 维度 cron 时刻; 入参就是它对应的 **us 业务日**。 */
const beijing6am = (usDate: string) => new Date(`${usDate}T22:00:00Z`);

const DIM = {
  dimensionKey: 'option_daily_snapshot',
  marketScope: ['us'],
  batchSize: 50,
} as unknown as ExecutorSyncDimensionRow;

function makeInput(usDate = '2026-09-18'): ExecutorInput {
  return { mode: 'delta', asOf: usDate, now: beijing6am(usDate) };
}

const PEP = { id: 1n, market: 'us', code: 'PEP' };
const VICI = { id: 2n, market: 'us', code: 'VICI' };

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const day = (s: string) => new Date(`${s}T00:00:00Z`);

/** code → 稳定合约 id (同一 code 反复取到同一个 id, 断言里可直接复用)。 */
const contractIds = new Map<string, bigint>();

/** 一行 `option_contract` (库内形态: Decimal 行权价 + Date 到期日)。 */
function contractRow(code: string, extra: Record<string, unknown> = {}) {
  if (!contractIds.has(code)) contractIds.set(code, BigInt(contractIds.size + 1));
  return {
    id: contractIds.get(code) as bigint,
    code,
    optionType: 'PUT',
    strikePrice: new Prisma.Decimal('130'),
    expiryDate: day('2026-09-18'),
    // T024a: 异常监控 ③ 的判定面 —— root 是 vendor 字面词根 (`VICI` vs 调整后的 `VICI1`)。
    root: 'PEP',
    isStandard: true,
    ...extra,
  };
}

/** 一行期权快照 (adapter 已归一化后的形态)。 */
function quoteRow(code: string, extra: Partial<OptionSnapshotRow> = {}): OptionSnapshotRow {
  return {
    code,
    isOption: true,
    underlyingCode: 'US.PEP',
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
    // vendor 时间戳 = 最后成交时刻, 与本批采集时刻是两回事 (p3b E33)。
    vendorUpdateTime: new Date('2026-09-18T20:00:00Z'),
    greeksComplete: true,
    ...extra,
  };
}

/** 标的自身那行 (spot 的来源, 与期权行同批返回)。 */
function underlyingRow(code = 'US.PEP', last: string | null = '148.21'): OptionSnapshotRow {
  return {
    ...quoteRow(code),
    isOption: false,
    underlyingCode: null,
    last,
    bid: null,
    ask: null,
    delta: null,
    greeksComplete: null,
  };
}

/** 本批采集时刻 (envelope `as_of`)。 */
const COLLECTED_AT = new Date('2026-09-19T04:31:07Z');

interface Harness {
  useCase: SyncOptionSnapshotUseCase;
  queries: OptionSnapshotQuery[];
  contractWhere: unknown[];
  createMany: ReturnType<typeof vi.fn>;
  calendar: ReturnType<typeof stubTradingCalendar>;
}

/**
 * @param contracts   每 instrumentId 的合约表内容 (默认空 = 链发现还没跑过)
 * @param rowsFor     每批返回的快照行 (默认: 请求的每个合约一行 + 标的一行)
 * @param prevTradingDay 交易日历里 `< session_date` 的最近一天 (null = 日历缺行)
 * @param listedContractCount 每 instrumentId 在库中的**全部**合约计数 (不带到期日过滤;
 *   默认 = `contracts` 的长度)。只在工作集为空时被读到 —— 它是「该标的无挂牌期权」与
 *   「有合约但全部已到期」的唯一分辨面 (#173)。
 */
function makeHarness(opts: {
  contracts?: Record<string, ReturnType<typeof contractRow>[]>;
  rowsFor?: (q: OptionSnapshotQuery) => OptionSnapshotRow[];
  prevTradingDay?: string | null;
  listedContractCount?: Record<string, number>;
  /**
   * T024a: 「已见过的非标 root」的**持久化载体**在库里的初值 —— 即已有过快照行的非标 root。
   * 本 harness 让 `createMany` 真的往里补本轮落的行, 于是「次日不重复报」不是测试手填一个
   * 数组, 而是**通路真的闭合**: 落库 → 下一轮读回。
   */
  snapshottedNonStandardRoots?: string[];
  /** #181: 传 `null` ⇒ 交易日历查不到已收盘 session（走 abandon 那一档）。 */
  lastClosedSession?: null;
  /** #181: 今天在日历里的三态 —— `non-trading` / `unknown` 会改变归属与盘中闸。 */
  calendarStatus?: 'trading' | 'non-trading' | 'unknown';
  /** #181: 今天的 session 形态（半日市收盘时刻提前）。 */
  todayKind?: 'whole' | 'half' | 'unknown';
}): Harness {
  const queries: OptionSnapshotQuery[] = [];
  const contractWhere: unknown[] = [];
  // 库内已有快照行的非标 root (跨轮次记忆); createMany 写入, 下一轮的 known 查询读出。
  const snapshottedRoots = new Set(opts.snapshottedNonStandardRoots ?? []);
  const contractById = new Map(
    Object.values(opts.contracts ?? {})
      .flat()
      .map((c) => [c.id, c] as const),
  );

  const port: OptionSnapshotPort = {
    getSnapshots: vi.fn(async (q: OptionSnapshotQuery) => {
      queries.push(q);
      const rows = opts.rowsFor
        ? opts.rowsFor(q)
        : [...q.contractCodes.map((c) => quoteRow(c)), underlyingRow()];
      return { asOf: COLLECTED_AT, rows };
    }),
  };

  const createMany = vi.fn(async (args: { data: { contractId: bigint }[] }) => {
    // 落库即入「记忆」—— 载体就是快照行本身 (无独立表), 见 use case 的 loadKnownNonStandardRoots。
    for (const row of args.data) {
      const c = contractById.get(row.contractId);
      if (c !== undefined && c.isStandard === false) snapshottedRoots.add(c.root as string);
    }
    return { count: args.data.length };
  });
  const prevDay = opts.prevTradingDay === undefined ? '2026-09-17' : opts.prevTradingDay;
  // #181: 归属判据把 `trading_day` 问**两种**问题, mock 必须能分辨 —— 否则「上一交易日」的
  // 答案会被当成「最近一个已收盘 session」, 让 session_date 整体偏一天而**测试照样绿**。
  //   · `lte 上界`    → 最近一个已收盘交易日 (= 本轮的 session_date)
  //   · `lt  session` → 它的上一交易日 (= oi_as_of)
  const calendar = stubTradingCalendar({ status: opts.calendarStatus ?? 'trading' });
  const prisma = {
    optionContract: {
      findMany: vi.fn(
        async (args: { where: { underlyingInstrumentId?: bigint; isStandard?: boolean } }) => {
          // T024a 的 known 集合查询 (非标 + 已有快照行), 与「取某票工作集」是两条不同的路径。
          if (args.where.isStandard === false) {
            return [...snapshottedRoots].map((root) => ({ root }));
          }
          contractWhere.push(args.where);
          return opts.contracts?.[String(args.where.underlyingInstrumentId)] ?? [];
        },
      ),
      // #173: 全部合约计数 (无到期日过滤) —— 与上面的工作集查询是两条不同的路径。
      count: vi.fn(async (args: { where: { underlyingInstrumentId: bigint } }) => {
        const id = String(args.where.underlyingInstrumentId);
        return opts.listedContractCount?.[id] ?? opts.contracts?.[id]?.length ?? 0;
      }),
    },
    optionDailySnapshot: { createMany },
    tradingDay: {
      findFirst: vi.fn(async (args: { where: { date: { lte?: Date; lt?: Date } } }) => {
        // `lte 上界` = 「最近一个已收盘交易日」。日历完整时它**就是上界本身** ⇒ 回显入参,
        // 而不是回一个常量 —— 回常量会让「换个业务日跑」的用例静默拿到别的 session。
        if (args.where.date.lte !== undefined) {
          return opts.lastClosedSession === null ? null : { date: args.where.date.lte };
        }
        return prevDay === null ? null : { date: day(prevDay) };
      }),
      findUnique: vi.fn(async () => ({ sessionKind: opts.todayKind ?? 'whole' })),
    },
  } as unknown as PrismaService;

  return {
    useCase: new SyncOptionSnapshotUseCase(port, prisma, calendar),
    queries,
    contractWhere,
    createMany,
    calendar,
  };
}

/** 所有 createMany 落库行拍平。 */
function persistedRows(createMany: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return createMany.mock.calls.flatMap(
    (c) => (c[0] as { data: Record<string, unknown>[] }).data ?? [],
  );
}

const PEP_CONTRACTS = { '1': [contractRow('US.PEP260918P130000')] };

/** 066 T09 的 hk 对照组 —— 词根是交易所助记符 (`TCH`), 不是标的数字代码。 */
const TCH = { id: 3n, market: 'hk', code: '00700' };
const TCH_CONTRACTS = { '3': [contractRow('HK.TCH260918P130000', { root: 'TCH' })] };
const HK_DIM = { ...DIM, marketScope: ['hk'] } as unknown as ExecutorSyncDimensionRow;

describe('SyncOptionSnapshotUseCase', () => {
  describe('🚨 hard 依赖链发现 (FR-031)', () => {
    it('合约表无行 → 一次外呼都不发 (不是「请求了但返回空」)', async () => {
      const h = makeHarness({ contracts: {} });
      const stats = emptyStats();

      const budgetExhausted = await h.useCase.run([PEP], DIM, stats, makeInput());

      expect(h.queries).toHaveLength(0);
      expect(budgetExhausted).toBe(false);
      // 无合约 ≠ 失败: 链发现还没轮到该票 (或该票无期权链), 计 skipped 跑绿。
      expect(stats).toMatchObject({ scanned: 1, ok: 0, failed: 0, skipped: 1 });
    });

    // 🚨 #173: 「零未到期合约」有两种成因、定性相反, 曾被压成同一条带问号的 WARN ——
    // 与上层冷启动对同一件事判「无挂牌期权, 港股常态、非故障」正好相反。066 开通港股后
    // 无期权标的从罕见变常态, 那条 WARN 会每晚每票复发一条, 把「链发现 stale」这条真信号稀释掉。
    it('库中零合约 → INFO「无挂牌期权」, 不抬 WARN (与冷启动层同一定性)', async () => {
      const h = makeHarness({ contracts: {} });
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      const logged = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('无挂牌期权');
      expect(logged).toContain('us:PEP');
      expect(warnSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('库中有合约但全部已到期 → 仍抬 WARN (链发现 stale 是真信号, MUST NOT 一起降级)', async () => {
      const h = makeHarness({ contracts: {}, listedContractCount: { '1': 3 } });
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('us:PEP');
      expect(warned).toContain('全部已到期');
      // 反向臂: 这一档**不得**落到「无挂牌期权」那句 INFO 上。
      expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('无挂牌期权');
      logSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('零工作集 (零锚) → 零外呼、零落库、跑绿 (state_branch 21)', async () => {
      const h = makeHarness({ contracts: PEP_CONTRACTS });
      const stats = emptyStats();

      await h.useCase.run([], DIM, stats, makeInput());

      expect(h.queries).toHaveLength(0);
      expect(h.createMany).not.toHaveBeenCalled();
      expect(stats).toMatchObject({ scanned: 0, failed: 0 });
    });

    it('工作集 = 该票「到期日 ≥ 当前 us 交易日」的全部合约 (FR-028a: ≥ 不是 >)', async () => {
      // 当日到期的合约当日仍可取快照 (官方「结束日期请输入今天或未来的日期」); 写成 `>`
      // 只在到期日当天整批静默丢腿。业务日期按 **us 时区** —— 用上海日会每周固定丢周五。
      const h = makeHarness({ contracts: PEP_CONTRACTS });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-06-12'));

      expect(h.contractWhere[0]).toMatchObject({
        underlyingInstrumentId: 1n,
        expiryDate: { gte: day('2026-06-12') },
      });
    });
  });

  /**
   * 🚨 066 T09 / `FR-016`：`oi_as_of` 的 `eod` 那一行**按市场分叉**，落库侧必须跟着分。
   *
   * 上面那条「`oi_as_of` = 上一交易日」是 **us 口径**（清算所 T+1 才发布）。hk 在 D 日收盘
   * 当晚就已定稿（2026-08-25 U2 实测），⇒ 同样走 `eod`，答案是 `session_date` 自己。
   *
   * 🚨 **这一格是三处同源里唯一真正写库的那处** —— 两个纯规则函数（`snapshot-session-
   * attribution` / `anchor-cold-start`）给出的 `oiAsOf` 只喂单测对表，`collect` 自己按
   * `spec.mode` 重新派生。只改规则层而漏了这里，单测全绿而**库里照旧偏一天**。
   */
  describe('🚨 oi_as_of 的 eod 路径按市场分叉 (066 T09, FR-016)', () => {
    /** hk 当地 2026-09-18 23:30（= 夜间轮的 23:30），该场已收盘、尚未跨日。 */
    const hkEodNight: ExecutorInput = {
      mode: 'delta',
      asOf: '2026-09-18',
      now: new Date('2026-09-18T15:30:00Z'),
    };

    it('🚨 hk 走 eod → oi_as_of = **session_date 自己**，不退到上一交易日', async () => {
      // `prevTradingDay` 刻意给了真值：分叉若没生效，这里会拿到 09-17 —— 断言正是要它拿不到。
      const h = makeHarness({ contracts: TCH_CONTRACTS, prevTradingDay: '2026-09-17' });
      await h.useCase.run([TCH], HK_DIM, emptyStats(), hkEodNight);

      const row = persistedRows(h.createMany)[0];
      expect(row.source).toBe('eod');
      expect(row.sessionDate).toEqual(day('2026-09-18'));
      expect(row.oiAsOf).toEqual(day('2026-09-18'));
      expect(row.oiAsOf).toEqual(row.sessionDate);
    });

    it('🚨🚨 hk 收盘后但 OI 未定稿（17:00）→ oi_as_of **退回上一交易日**，落库侧同样跟着时刻走', async () => {
      // 判据层已有同形断言（`snapshot-session-attribution.rules.spec.ts` 的 ②b）。这条钉的是
      // **写库侧**：`collect` 自己按 `spec` 重新派生 oi_as_of，只改判据层会「单测全绿而库里
      // 照旧偏一天」（见本 describe 的文档注释）。
      // 落点是**建锚冷启动**（用户行为触发，不受 cron 时刻约束），不是夜间轮。
      const h = makeHarness({ contracts: TCH_CONTRACTS, prevTradingDay: '2026-09-17' });
      await h.useCase.run([TCH], HK_DIM, emptyStats(), {
        mode: 'delta',
        asOf: '2026-09-18',
        now: new Date('2026-09-18T09:00:00Z'), // = hk 当地 17:00，晚于收盘、早于 21:30 定稿
      });

      const row = persistedRows(h.createMany)[0];
      // 🚨 `source` / `session_date` **逐点不变** —— 治的是 OI 标签，不是挡写。
      expect(row.source).toBe('eod');
      expect(row.sessionDate).toEqual(day('2026-09-18'));
      expect(row.oiAsOf).toEqual(day('2026-09-17'));
      expect(row.oiAsOf).not.toEqual(row.sessionDate);
    });

    it('🚨 同一形态下 us 必须仍差一天 —— 分叉是增量，不是把口径全局改了', async () => {
      const h = makeHarness({ contracts: PEP_CONTRACTS, prevTradingDay: '2026-09-17' });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-09-18'));

      const row = persistedRows(h.createMany)[0];
      expect(row.source).toBe('eod');
      expect(row.oiAsOf).toEqual(day('2026-09-17'));
      expect(row.oiAsOf).not.toEqual(row.sessionDate);
    });

    it('hk 的日历即使缺 `< session_date` 的行也不受影响（那条查询压根不发）', async () => {
      // us 侧同样的输入会走兜底 + 抬 ERROR（见上面那条）。hk 不查上一交易日 ⇒ 无兜底、无 ERROR。
      const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const h = makeHarness({ contracts: TCH_CONTRACTS, prevTradingDay: null });

      await h.useCase.run([TCH], HK_DIM, emptyStats(), hkEodNight);

      expect(persistedRows(h.createMany)[0].oiAsOf).toEqual(day('2026-09-18'));
      expect(errSpy).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  describe('🚨 三个时点列各自取值 (Guardrail 6 / plan D-DATA-4)', () => {
    it('oi_as_of = **上一交易日**, 不是 session_date', async () => {
      // 美股期权 OI 在**盘前时段**更新 ⇒ T 日收盘后采的快照, 其 OI 其实是 T−1 日的持仓量。
      // 把它归到 session_date 不会红, 但活跃度排名与 UI 的 asOf 全错一天。
      const h = makeHarness({ contracts: PEP_CONTRACTS, prevTradingDay: '2026-09-17' });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-09-18'));

      const row = persistedRows(h.createMany)[0];
      expect(row.sessionDate).toEqual(day('2026-09-18'));
      expect(row.oiAsOf).toEqual(day('2026-09-17'));
      expect(row.oiAsOf).not.toEqual(row.sessionDate);
    });

    it('跨周末: 周一的快照, oi_as_of 落上周五 (交易日历说了算, 不是「减一天」)', async () => {
      const h = makeHarness({ contracts: PEP_CONTRACTS, prevTradingDay: '2026-09-18' });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-09-21'));
      expect(persistedRows(h.createMany)[0].oiAsOf).toEqual(day('2026-09-18'));
    });

    it('交易日历缺行 → 兜底仍**不等于** session_date, 且抬 ERROR (不拿标签掩盖 vintage)', async () => {
      const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const h = makeHarness({ contracts: PEP_CONTRACTS, prevTradingDay: null });

      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-09-21'));

      const row = persistedRows(h.createMany)[0];
      expect(row.oiAsOf).not.toEqual(row.sessionDate);
      // 周一往前退一个工作日 = 上周五 (兜底是近似, 故必须响)。
      expect(row.oiAsOf).toEqual(day('2026-09-18'));
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('quote_as_of = 本批采集时刻 (envelope as_of), 不是行内 vendor update_time', async () => {
      const h = makeHarness({ contracts: PEP_CONTRACTS });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      const row = persistedRows(h.createMany)[0];
      expect(row.quoteAsOf).toEqual(COLLECTED_AT);
      expect(row.vendorUpdateTime).toEqual(new Date('2026-09-18T20:00:00Z'));
    });

    it('source = eod (FR-040 的来源维度本片就是活的)', async () => {
      const h = makeHarness({ contracts: PEP_CONTRACTS });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());
      expect(persistedRows(h.createMany)[0].source).toBe('eod');
    });
  });

  describe('🚨 落库前硬门逐行拒绝 (FR-043 / FR-044)', () => {
    it('违规行不入库, **同批其余行照常入库** (不整批回滚)', async () => {
      const h = makeHarness({
        contracts: {
          '1': [contractRow('US.PEP260918P130000'), contractRow('US.PEP260918P140000')],
        },
        rowsFor: (q) => [
          // 盘口交叉 (bid > ask) —— 不可能的真实报价。
          quoteRow(q.contractCodes[0], { bid: '9.90', ask: '2.40' }),
          quoteRow(q.contractCodes[1]),
          underlyingRow(),
        ],
      });
      const stats = emptyStats();

      await h.useCase.run([PEP], DIM, stats, makeInput());

      const rows = persistedRows(h.createMany);
      expect(rows.map((r) => r.contractId)).toEqual([contractRow('US.PEP260918P140000').id]);
      // 当日唯一一次采集机会: 一条脏行 MUST NOT 带走整批。
      expect(rows).toHaveLength(1);
      expect(stats.ok).toBe(1);
    });

    it('拒绝的行抬 ERROR 且带违规原因 (静默丢 = 数据缺口自我掩盖)', async () => {
      const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const h = makeHarness({
        contracts: PEP_CONTRACTS,
        rowsFor: (q) => [quoteRow(q.contractCodes[0], { delta: '0.31' }), underlyingRow()],
      });
      const stats = emptyStats();

      await h.useCase.run([PEP], DIM, stats, makeInput());

      expect(persistedRows(h.createMany)).toHaveLength(0);
      expect(errSpy).toHaveBeenCalled();
      // PUT 的 Δ 必须 ≤ 0 —— 原因串进 ERROR 文案, 运维不必回查原始 payload。
      expect(String(errSpy.mock.calls[0][0])).toMatch(/delta_sign/);
      // 留痕进 SyncRun 的审计明细通道 (同 recordSkippedWithReason 的复用), 不改判 failed。
      expect(JSON.stringify(stats.failedTargets)).toContain('US.PEP260918P130000');
      errSpy.mockRestore();
    });

    it('greeks 整块缺失的深实值腿照常入库 (缺失跳过对应的门, FR-007)', async () => {
      // 实值腿 bid 跌破内在价值 ⇒ IV 无解 ⇒ 五个 greeks 与 IV 一起没有, 实测 227/2150 行。
      // 在这里拒掉 = 决策带按 |Δ| 定义, 缺 Δ 的腿被筛没且无人知晓。
      const h = makeHarness({
        contracts: PEP_CONTRACTS,
        rowsFor: (q) => [
          quoteRow(q.contractCodes[0], {
            bid: '41.30',
            ask: '43.10',
            iv: null,
            delta: null,
            gamma: null,
            vega: null,
            theta: null,
            rho: null,
            greeksComplete: false,
          }),
          underlyingRow('US.PEP', '95.00'),
        ],
      });

      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      const row = persistedRows(h.createMany)[0];
      expect(row.delta).toBeNull();
      expect(row.greeksComplete).toBe(false);
    });

    it('标的 spot 来自同批的标的行 (不另发调用), 并进硬门当内在价值的输入', async () => {
      const h = makeHarness({ contracts: PEP_CONTRACTS });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      // 标的自身的 code 与合约同批请求 —— 端口入参里根本没有第二次调用的位置。
      expect(h.queries[0].underlyingSymbol).toBe('us:PEP');
      expect(persistedRows(h.createMany)[0].underlyingSpot).toBe('148.21');
    });

    it('🚨 非标合约的 ask 低于「用普通行权价算出的内在价值」→ 照常入库 (#186, FR-033)', async () => {
      // 2026-08-24 夜实拒 238 行的形态: 调整后合约交割的不是 100 股标的 ⇒ 那个「内在价值」
      // 不是它的。**这条钉的是通路**: `toGuardRow` 一旦不把 is_standard 递下去 (或写死 true),
      // 硬门就只能按标准合约判, 而 rules 层的单测全绿 —— 缺口正好落在两层之间。
      const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const ADJUSTED = 'US.VICI1260918P30000';
      const h = makeHarness({
        contracts: {
          '2': [
            contractRow(ADJUSTED, {
              strikePrice: new Prisma.Decimal('30'),
              root: 'VICI1',
              isStandard: false,
            }),
          ],
        },
        // PUT K=30 / spot 9.00 ⇒ 普通公式的内在价值 21.00 (下界 20.95), 而 ask 只有 3.60。
        rowsFor: (q) => [
          quoteRow(q.contractCodes[0], { underlyingCode: 'US.VICI', bid: '3.50', ask: '3.60' }),
          underlyingRow('US.VICI', '9.00'),
        ],
      });
      const stats = emptyStats();

      await h.useCase.run([VICI], DIM, stats, makeInput());

      // 🚨 先取证再 restore, 再断言 —— 断言失败时 `mockRestore()` 就跑不到了, 留着的那个
      // mock 会把**后面**的用例一起带红 (本条的定向变异实验里当场撞到过)。
      const errors = errSpy.mock.calls.map((c) => String(c[0]));
      warnSpy.mockRestore();
      errSpy.mockRestore();

      expect(errors).toEqual([]);
      expect(persistedRows(h.createMany)).toHaveLength(1);
      expect(stats.failedTargets).toEqual([]);
    });
  });

  describe('🚨 批量上限切在调用方 (shim > 400 codes 直接 400)', () => {
    it('401 个合约 → 切成两批, 每批合约数 ≤ 399 (标的自身占掉一个位)', async () => {
      const codes = Array.from(
        { length: 401 },
        (_, i) => `US.PEP260918P${String(130000 + i).padStart(6, '0')}`,
      );
      const h = makeHarness({ contracts: { '1': codes.map((c) => contractRow(c)) } });

      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      expect(h.queries).toHaveLength(2);
      for (const q of h.queries) {
        expect(q.contractCodes.length).toBeLessThanOrEqual(OPTION_SNAPSHOT_MAX_CONTRACT_CODES);
      }
      // 一个都不许被切丢 —— 被裁掉的尾巴在下游读作「那些合约今天没数据」。
      expect(h.queries.flatMap((q) => q.contractCodes)).toEqual(codes);
      expect(persistedRows(h.createMany)).toHaveLength(401);
    });
  });

  describe('幂等 (FR-037)', () => {
    it('落库走 createMany + skipDuplicates —— 同日重跑不产生重复行', async () => {
      const h = makeHarness({ contracts: PEP_CONTRACTS });
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());
      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      for (const call of h.createMany.mock.calls) {
        expect(call[0]).toMatchObject({ skipDuplicates: true });
      }
      // 幂等键 = (contract_id, session_date, source): 两轮写的是同一个键。
      const rows = persistedRows(h.createMany);
      expect(rows[0]).toMatchObject({
        contractId: rows[1].contractId,
        sessionDate: rows[1].sessionDate,
        source: rows[1].source,
      });
    });
  });

  describe('失败语义 (429 顺延 vs 400 失败)', () => {
    it('429 → budgetExhausted=true, 计 skipped 不计 failed, 剩余标的顺延', async () => {
      const h = makeHarness({
        contracts: { '1': [contractRow('US.PEP260918P130000')], '2': [contractRow('US.VICI1')] },
        rowsFor: () => {
          throw new OptionSnapshotBudgetExhaustedError('option-snapshot us:PEP');
        },
      });
      const stats = emptyStats();

      const budgetExhausted = await h.useCase.run([PEP, VICI], DIM, stats, makeInput());

      expect(budgetExhausted).toBe(true);
      // deferral ≠ failure: 记成 failed 会白白吃掉 worker 的重试次数。
      expect(stats.failed).toBe(0);
      expect(stats.skipped).toBe(2);
      expect(h.queries).toHaveLength(1);
    });

    it('400 (永久拒绝) → 计 failed 并继续下一只, 不顺延', async () => {
      const h = makeHarness({
        contracts: { '1': [contractRow('US.PEP260918P130000')], '2': [contractRow('US.VICI1')] },
        rowsFor: (q) => {
          if (q.underlyingSymbol === 'us:PEP') {
            throw new OptionSnapshotRejectedError('option-snapshot us:PEP');
          }
          return [
            quoteRow(q.contractCodes[0], { underlyingCode: 'US.VICI' }),
            underlyingRow('US.VICI'),
          ];
        },
      });
      const stats = emptyStats();

      const budgetExhausted = await h.useCase.run([PEP, VICI], DIM, stats, makeInput());

      expect(budgetExhausted).toBe(false);
      expect(stats).toMatchObject({ scanned: 2, ok: 1, failed: 1 });
      expect(JSON.stringify(stats.failedTargets)).toContain('us:PEP');
    });

    it('返回了不在本批请求内的 code → 该票 failed, 零落库 (批次错配比没落更难发现)', async () => {
      const h = makeHarness({
        contracts: PEP_CONTRACTS,
        rowsFor: () => [quoteRow('US.VICI260918P30000'), underlyingRow()],
      });
      const stats = emptyStats();

      await h.useCase.run([PEP], DIM, stats, makeInput());

      expect(stats.failed).toBe(1);
      expect(persistedRows(h.createMany)).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T024a: 异常监控接线 (FR-047/048/049)
  // ───────────────────────────────────────────────────────────────────────────

  describe('🚨 异常监控接线 (T024a, FR-047/048/049)', () => {
    /** 本轮跑出来的 WARN code 序列 (只认 `[option-anomaly]` 前缀, 与采集自身的 warn 分开)。 */
    function anomalyCodes(spy: { mock: { calls: unknown[][] } }): string[] {
      return spy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith('[option-anomaly]'))
        .map((m) => (/^\[option-anomaly\] (\w+)/.exec(m) as RegExpExecArray)[1]);
    }

    /** 全 greeks 齐活的一组值 (不想让某行进 ① 的判定结果时用)。 */
    const FULL_GREEKS = {
      iv: '21.4',
      delta: '-0.31',
      gamma: '0.041',
      vega: '0.092',
      theta: '-0.058',
    } as const;

    /** greeks 整块缺失 (vendor 对 IV 无解的腿就是这个形态)。 */
    const NO_GREEKS = {
      iv: null,
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
      rho: null,
      greeksComplete: false,
    } as const;

    const DEEP_ITM = 'US.PEP260918P200000';
    const OTM_NO_GREEKS = 'US.PEP260918P130000';
    const SHORT_DTE_HIGH_IV = 'US.PEP260919P125000';
    const NEW_NONSTANDARD = 'US.VICI1260918P30000';

    /**
     * 一批同时含四种形态的行: 深实值缺 greeks / 虚值缺 greeks / DTE=1 高 IV / 新非标 root。
     * 四行**全部过硬门**(否则被拒的行根本进不了判定面), 差别只在异常监控怎么看它们。
     */
    function anomalyHarness(knownRoots: string[] = []) {
      return makeHarness({
        snapshottedNonStandardRoots: knownRoots,
        contracts: {
          '1': [
            // 深实值 PUT (K=200 ≫ spot 148.21) —— IV 无解, greeks 整块缺失。数学固有现象。
            contractRow(DEEP_ITM, { strikePrice: new Prisma.Decimal('200') }),
            // 虚值 PUT 缺 greeks —— 同样是缺失, 但这一边是**真异常**。
            contractRow(OTM_NO_GREEKS),
            // 次日到期 (DTE=1) 的宽价差腿, IV 600% —— 属预期而非脏数据。
            contractRow(SHORT_DTE_HIGH_IV, {
              strikePrice: new Prisma.Decimal('125'),
              expiryDate: day('2026-09-19'),
            }),
          ],
          '2': [
            contractRow(NEW_NONSTANDARD, {
              strikePrice: new Prisma.Decimal('30'),
              root: 'VICI1',
              isStandard: false,
            }),
          ],
        },
        rowsFor: (q) => {
          const under = q.underlyingSymbol === 'us:PEP' ? 'US.PEP' : 'US.VICI';
          const spot = under === 'US.PEP' ? '148.21' : '30.00';
          const overrides: Record<string, Partial<OptionSnapshotRow>> = {
            // ask 必须 ≥ 内在价值 − 容差 (51.79 − 0.05), 否则被硬门拒 = 根本进不了判定面。
            [DEEP_ITM]: { bid: '51.00', ask: '52.10', ...NO_GREEKS },
            [OTM_NO_GREEKS]: { bid: '2.30', ask: '2.40', ...NO_GREEKS },
            [SHORT_DTE_HIGH_IV]: { bid: '0.05', ask: '0.10', ...FULL_GREEKS, iv: '600' },
            [NEW_NONSTANDARD]: { bid: '0.50', ask: '0.60', ...FULL_GREEKS },
          };
          return [
            ...q.contractCodes.map((c) => quoteRow(c, { underlyingCode: under, ...overrides[c] })),
            underlyingRow(under, spot),
          ];
        },
      });
    }

    it('四种形态一批跑完 → **只**出「虚值缺 greeks」+「新非标 root」两条 WARN', async () => {
      // 实值区缺 greeks 是数学固有现象 (MUST NOT 告警、MUST NOT 计入指标); DTE=1 的 600% IV
      // 是极短到期下最小跳动反解出来的, 属预期。两者若各报一条, 每个到期日固定假红一次。
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const h = anomalyHarness();

      await h.useCase.run([PEP, VICI], DIM, emptyStats(), makeInput('2026-09-18'));

      expect(persistedRows(h.createMany)).toHaveLength(4);
      expect(anomalyCodes(warnSpy)).toEqual(['otm_greeks_unavailable', 'new_nonstandard_root']);
      // 只有那一条虚值腿进了 ① 的计数 —— 深实值那条连分母都不进。
      const greeksWarn = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('otm_greeks_unavailable')) as string;
      expect(greeksWarn).toContain(OTM_NO_GREEKS);
      expect(greeksWarn).not.toContain(DEEP_ITM);
      warnSpy.mockRestore();
    });

    it('🚨 同一 root 第二轮不再报 —— known 集合由第一轮**落的快照行**喂回 (通路闭合)', async () => {
      // 这条是 T024a 存在的理由: T024 的 ③ 明写「已见过的 root 由调用方持久化后回传」,
      // 没有调用方时该语义不成立。载体 = 快照行本身 (非标 root + 已有快照 ⇒ 见过), 无新表。
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const h = anomalyHarness();

      await h.useCase.run([PEP, VICI], DIM, emptyStats(), makeInput('2026-09-18'));
      expect(anomalyCodes(warnSpy)).toContain('new_nonstandard_root');

      warnSpy.mockClear();
      await h.useCase.run([PEP, VICI], DIM, emptyStats(), makeInput('2026-09-21'));

      expect(anomalyCodes(warnSpy)).not.toContain('new_nonstandard_root');
      // 其余两条判据照常工作 —— 不重复报的只有 root 那一条。
      expect(anomalyCodes(warnSpy)).toEqual(['otm_greeks_unavailable']);
      warnSpy.mockRestore();
    });

    it('IV 离群在**长 DTE** 上照常报 (证明 ② 真接上了, 不是恒静默)', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const h = makeHarness({
        contracts: {
          '1': [contractRow('US.PEP261120P130000', { expiryDate: day('2026-11-20') })],
        },
        rowsFor: (q) => [
          quoteRow(q.contractCodes[0], { ...FULL_GREEKS, iv: '600' }),
          underlyingRow(),
        ],
      });

      await h.useCase.run([PEP], DIM, emptyStats(), makeInput('2026-09-18'));

      expect(anomalyCodes(warnSpy)).toEqual(['iv_outlier']);
      warnSpy.mockRestore();
    });

    it('零落库行 (零锚 / 合约表空) → 零 WARN, 不刷屏', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const h = makeHarness({ contracts: {} });

      await h.useCase.run([PEP], DIM, emptyStats(), makeInput());

      expect(anomalyCodes(warnSpy)).toEqual([]);
      warnSpy.mockRestore();
    });
  });
});

/**
 * #181 归属判据接线 —— 维度路径（`run()`）此前写死 `sessionDate = 当前日历日` + `eod`。
 *
 * 纯判定逻辑在 `snapshot-session-attribution.rules.spec.ts`；这里只盯三件**接线**才有的事：
 * ① 跨午夜时 `session_date` 仍归上一个已收盘 session（#181 的回归钉）
 * ② 盘中**零外呼**，且不是失败
 * ③ 日历判不出时放弃 + ERROR，而不是猜一个日子
 */
describe('SyncOptionSnapshotUseCase — 归属判据 (#181)', () => {
  /** 指定绝对时刻的 ExecutorInput（`makeInput` 只能给「北京 06:00」那一个时刻）。 */
  const inputAt = (iso: string): ExecutorInput => ({
    mode: 'delta',
    asOf: iso.slice(0, 10),
    now: new Date(iso),
  });

  it('🚨 跨过午夜执行 → session_date 仍是**上一个已收盘 session**，不是执行时刻的日历日', async () => {
    // 2026-09-19T05:00Z = ET 09-19 01:00（已过午夜、盘前）。改前这里会落 `2026-09-19` ——
    // 一个**还没开盘**的 session，且 createMany(skipDuplicates) 不可逆、还会挡掉次日真采集。
    const h = makeHarness({ contracts: PEP_CONTRACTS });
    const stats = emptyStats();

    await h.useCase.run([PEP], DIM, stats, inputAt('2026-09-19T05:00:00Z'));

    const row = persistedRows(h.createMany)[0];
    expect(row.sessionDate).toEqual(day('2026-09-18'));
    // 已进下一交易日盘前 ⇒ OI 已翻新 ⇒ 走 premarket_backfill，且 oi_as_of = session_date。
    expect(row.source).toBe('premarket_backfill');
    expect(row.oiAsOf).toEqual(day('2026-09-18'));
  });

  it('收盘当日盘后执行 → eod + oi_as_of = 上一交易日（既有行为逐点不变）', async () => {
    const h = makeHarness({ contracts: PEP_CONTRACTS });

    await h.useCase.run([PEP], DIM, emptyStats(), inputAt('2026-09-18T22:00:00Z'));

    const row = persistedRows(h.createMany)[0];
    expect(row.sessionDate).toEqual(day('2026-09-18'));
    expect(row.source).toBe('eod');
    expect(row.oiAsOf).toEqual(day('2026-09-17'));
  });

  it('🚨 盘中执行 → **零外呼**、零落库，计 skipped 而非 failed', async () => {
    // ET 09-18 11:00 = 15:00Z，美股盘中。此刻端点返的是盘中态，落成任何 session 的收盘都是脏数据。
    const h = makeHarness({ contracts: PEP_CONTRACTS });
    const stats = emptyStats();

    const budgetExhausted = await h.useCase.run([PEP], DIM, stats, inputAt('2026-09-18T15:00:00Z'));

    expect(h.queries).toHaveLength(0);
    expect(h.createMany).not.toHaveBeenCalled();
    expect(budgetExhausted).toBe(false);
    // 不是失败 —— 是「还没到能采的时刻」。
    expect(stats).toMatchObject({ failed: 0, skipped: 1 });
  });

  it('日历查不到已收盘 session → 放弃本轮 + ERROR，MUST NOT 猜一个日子', async () => {
    const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const h = makeHarness({ contracts: PEP_CONTRACTS, lastClosedSession: null });
    const stats = emptyStats();

    await h.useCase.run([PEP], DIM, stats, inputAt('2026-09-18T22:00:00Z'));

    expect(h.queries).toHaveLength(0);
    expect(h.createMany).not.toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain('判不出归属');
    expect(stats.failed).toBe(0);
    errSpy.mockRestore();
  });

  it('🚨 混市场 scope → 抛，MUST NOT 挑第一个（另一个市场的行会静默标错）', async () => {
    const h = makeHarness({ contracts: PEP_CONTRACTS });
    const mixed = { ...DIM, marketScope: ['us', 'hk'] } as unknown as ExecutorSyncDimensionRow;

    await expect(
      h.useCase.run([PEP], mixed, emptyStats(), inputAt('2026-09-18T22:00:00Z')),
    ).rejects.toThrow(/单市场 scope/);
  });
});
