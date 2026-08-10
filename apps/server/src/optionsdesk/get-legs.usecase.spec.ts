import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../security/prisma.service';
import { GetLegsUseCase } from './get-legs.usecase';
import { toLegTableResponse } from './optionsdesk.dto';

// 请求时刻 = 2026-08-04 ET 16:00 (= UTC 20:00) ⇒ 交易所的今天恒为 2026-08-04。
// 🚨 蓄意用一个「北京已是 08-05 凌晨」都不成立的时刻也无所谓 —— 基准由 marketDateFor(['us'])
// 决定, 本用例只需钉住那个日期; 时区基准本身由 trading-day-gate.spec.ts 承重。
const NOW = new Date('2026-08-04T20:00:00.000Z');

/**
 * **境内早晨**: 北京 2026-08-05 08:00 = ET 2026-08-04 20:00 —— 本地日历已翻到 08-05,
 * 而美股最近收的那一场仍是 08-04。T027a 的判别性时刻 (见文件末 FR-020 那个 describe)。
 */
const NOW_CN_MORNING = new Date('2026-08-05T00:00:00.000Z');
const SYMBOL = 'us:PEP';
const D = (v: string) => new Prisma.Decimal(v);
const date = (v: string) => new Date(`${v}T00:00:00.000Z`);

// V = 150 ⇒ W = 120; spot 132.40 落 [W, V) = 卖put区 (锚轴 K ≤ W); confidence 8 ⇒ L2;
// 水位 ≥2/3 ⇒ 意图矩阵输出「收租 · 深度」。
const anchorRow = {
  id: 1n,
  ticker: SYMBOL,
  v: D('150'),
  confidence: D('8'),
  vManual: null,
  lLevelManual: null,
  positionCapManual: null,
  positionBucketManual: 'gte_two_thirds',
};

interface LegFixture {
  code: string;
  strike: string;
  expiry: string;
  bid: string | null;
  delta: string | null;
  greeksComplete: boolean;
  openInterest: string;
  volume: string;
}

// 四条腿覆盖 verify 清单: 好/可接受档 · 死档 · greeks 缺失 · 建仓带。
const LEGS: LegFixture[] = [
  // 收租长腿 (DTE 164), 锚轴 K = W ⇒ 进收租 Tab; 年化 11.7% ⇒ 可接受。
  {
    code: 'C-A',
    strike: '120',
    expiry: '2027-01-15',
    bid: '6.00',
    delta: '-0.30',
    greeksComplete: true,
    openInterest: '900',
    volume: '40',
  },
  // 收租长腿但年化 1.1% ⇒ **死档** (FR-006: 在表内、排最后)。
  {
    code: 'C-B',
    strike: '100',
    expiry: '2027-01-15',
    bid: '0.50',
    delta: '-0.05',
    greeksComplete: true,
    openInterest: '500',
    volume: '10',
  },
  // **greeks 缺失** 的深实值腿 (FR-007: 在表内、不判档不着色)。
  {
    code: 'C-C',
    strike: '145',
    expiry: '2026-08-21',
    bid: '13.00',
    delta: null,
    greeksComplete: false,
    openInterest: '80',
    volume: '3',
  },
  // 建仓带 (|Δ| 0.45 ∈ [0.40,0.55] ∧ DTE 10 ≤ 14) ⇒ 周化口径, 周化 1.09% ⇒ 可接受。
  {
    code: 'C-D',
    strike: '130',
    expiry: '2026-08-14',
    bid: '2.00',
    delta: '-0.45',
    greeksComplete: true,
    openInterest: '300',
    volume: '120',
  },
];

function contractsOf(legs: LegFixture[]) {
  return legs.map((leg, i) => ({
    id: BigInt(i + 1),
    code: leg.code,
    expiryDate: date(leg.expiry),
    strikePrice: D(leg.strike),
  }));
}

function snapshotsOf(legs: LegFixture[], session = '2026-08-03') {
  return legs.map((leg, i) => ({
    contractId: BigInt(i + 1),
    sessionDate: date(session),
    source: 'eod',
    quoteAsOf: new Date('2026-08-03T20:15:00.000Z'),
    // 🚨 OI 归属 T−1 (2026-07-31, 08-03 的上一个交易日) —— 与 sessionDate 蓄意不同天。
    oiAsOf: date('2026-07-31'),
    bid: leg.bid === null ? null : D(leg.bid),
    ask: leg.bid === null ? null : D(leg.bid).plus(D('0.10')),
    // 挂牌量：无 bid ⇒ 无挂单 ⇒ 两侧同为 null（与价同生共死，🚫 不拿 0 冒充「没人挂」）。
    bidSize: leg.bid === null ? null : D('25'),
    askSize: leg.bid === null ? null : D('26'),
    delta: leg.delta === null ? null : D(leg.delta),
    openInterest: D(leg.openInterest),
    volume: D(leg.volume),
    underlyingSpot: D('132.40'),
    greeksComplete: leg.greeksComplete,
  }));
}

/**
 * 交易日历 fixture (T027a)。🚨 **蓄意含未来日** —— 真 `trading_day` 本就预填到未来, 而正是
 * 这几行让「拿本地 / UTC 今天当基准」的写法露馅: 境内早晨那个时刻取本地今天 (08-05) 会命中
 * 08-05 这一行, 当日快照 (08-04) 随之被误判陈旧。日历只填到 08-04 的话两种写法答案相同,
 * 断言就变成平凡绿。
 */
const TRADING_DAYS = ['2026-07-31', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];

/** 按 `date <= cutoff` 取最大交易日 —— 与 `last-closed-session.ts` 的真查询同语义。 */
function tradingDayFindFirst() {
  return vi.fn(async (args: { where: { market: string; date: { lte: Date } } }) => {
    const cutoff = args.where.date.lte.toISOString().slice(0, 10);
    const hit = [...TRADING_DAYS].reverse().find((d) => d <= cutoff);
    return hit === undefined ? null : { date: date(hit) };
  });
}

function makePrisma(overrides: Record<string, unknown> = {}) {
  const legs = LEGS;
  return {
    anchor: { findUnique: vi.fn().mockResolvedValue(anchorRow) },
    instrument: { findUnique: vi.fn().mockResolvedValue({ id: 42n }) },
    optionContract: { findMany: vi.fn().mockResolvedValue(contractsOf(legs)) },
    optionDailySnapshot: {
      findFirst: vi.fn().mockResolvedValue({ sessionDate: date('2026-08-03') }),
      findMany: vi.fn().mockResolvedValue(snapshotsOf(legs)),
    },
    earningsEvent: { findMany: vi.fn().mockResolvedValue([{ earningsDate: date('2026-08-12') }]) },
    tradingDay: { findFirst: tradingDayFindFirst() },
    ...overrides,
  };
}

function makeUseCase(prisma: ReturnType<typeof makePrisma>) {
  return new GetLegsUseCase(prisma as unknown as PrismaService);
}

describe('get-legs.usecase — 全量适格腿, 零分页零截断 (FR-005/008, Guardrail 7)', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('非标与已到期在 SQL 端就滤掉 —— 判据是 `到期日 > 当日`, 与完整性分母的 `≥` 故意不同', async () => {
    await makeUseCase(prisma).execute(SYMBOL, NOW);
    const where = prisma.optionContract.findMany.mock.calls[0][0].where;
    expect(where.isStandard).toBe(true); // FR-008 非标零出现 (采集端仍照常落库, FR-033)
    expect(where.optionType).toBe('PUT');
    // 🚨 Guardrail 7: 严格大于当日 —— 写成 gte 只在到期日当天露馅。
    expect(where.expiryDate).toEqual({ gt: date('2026-08-04') });
    expect(where.underlyingInstrumentId).toBe(42n);
  });

  it('落库多少条就返多少条 —— 无 take / skip / cursor 任何截断参数', async () => {
    const view = await makeUseCase(prisma).execute(SYMBOL, NOW);
    expect(view.legs).toHaveLength(LEGS.length);
    const args = prisma.optionContract.findMany.mock.calls[0][0];
    expect(args.take).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(prisma.optionDailySnapshot.findMany.mock.calls[0][0].take).toBeUndefined();
  });

  it('死档在结果里且**排最后**; greeks 缺失行也在结果里, 排在活档之后死档之前', async () => {
    const view = await makeUseCase(prisma).execute(SYMBOL, NOW);
    expect(view.legs.map((l) => l.code)).toEqual(['C-D', 'C-A', 'C-C', 'C-B']);
    expect(view.legs.at(-1)?.tier).toBe('dead');
  });

  it('greeks 缺失行不判档不着色 —— tier / Δ / σ 距三者同时为空 (FR-007, Guardrail 10)', async () => {
    const view = await makeUseCase(prisma).execute(SYMBOL, NOW);
    const gap = view.legs.find((l) => l.code === 'C-C');
    expect(gap?.greeksComplete).toBe(false);
    expect(gap?.tier).toBeNull();
    expect(gap?.absDelta).toBeNull();
    expect(gap?.sigmaDistance).toBeNull();
    // 🚨 但它**没有被筛掉**, 且财报标照打 (FR-006 死档同理)。
    expect(gap?.earningsMark?.mark).toBe('crosses_earnings');
  });
});

describe('get-legs.usecase — 派生请求时算 + 两个时点不同天 (FR-041/013, Guardrail 6)', () => {
  it('OI 的归属日与区块级 asOf 不是同一天, 两个时点都下发', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, NOW);
    expect(view.asOf).toEqual(date('2026-08-03'));
    expect(view.oiAsOf).toEqual(date('2026-07-31'));
    expect(view.oiAsOf).not.toEqual(view.asOf);
    expect(view.quoteAsOf?.toISOString()).toBe('2026-08-03T20:15:00.000Z');
    expect(view.source).toBe('eod');
  });

  it('DTE 基准是交易所的今天, 价格却来自上一场 session —— 这处错配是有意的, 不许「修」', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, NOW);
    // 2026-08-04 → 2026-08-14 = 10 天 (整数日历日, 含周末)。若改成按 asOf (08-03) 起算会是 11。
    expect(view.legs.find((l) => l.code === 'C-D')?.dteDays).toBe(10);
  });

  it('045 的 W / 四区间 / L 层复用而非重算, 意图走矩阵', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, NOW);
    expect(view.w.toString()).toBe('120');
    expect(view.zone).toBe('thin');
    expect(view.lLevel).toBe('L2');
    expect(view.positionBucket).toBe('gte_two_thirds');
    expect(view.intent).toBe('rent');
    expect(view.rentDepth).toBe('deep');
    expect(view.spot?.toString()).toBe('132.4');
  });

  it('每行标注自己的腿族口径, 档位按该口径判 (FR-018/019)', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, NOW);
    const build = view.legs.find((l) => l.code === 'C-D');
    const rent = view.legs.find((l) => l.code === 'C-A');
    expect(build?.basis).toBe('weekly');
    expect(build?.tier).toBe('acceptable');
    expect(rent?.basis).toBe('annualized');
    expect(rent?.tier).toBe('acceptable');
    // 折年在周化行上照常给出 (参照列), 但它**不是**该行的判定值。
    expect(build?.annualizedRate).not.toBeNull();
  });
});

describe('get-legs.usecase — 三个 Tab 各一套活跃度 (D-SOT-5 × D-API-1 的定案)', () => {
  it('每腿带 tabs 归属; 活跃度按 Tab **各排一次**, 不属于该 Tab 的位置为 null', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, NOW);
    const build = view.legs.find((l) => l.code === 'C-D');
    const rent = view.legs.find((l) => l.code === 'C-A');
    const gap = view.legs.find((l) => l.code === 'C-C');

    expect(build?.tabs).toEqual(['all', 'build']);
    expect(rent?.tabs).toEqual(['all', 'rent']);
    expect(gap?.tabs).toEqual(['all']); // 缺 Δ ⇒ 两个意图 Tab 都进不去, 但全腿 Tab 恒在
    // 全腿 Tab 里人人有名次; 建仓 Tab 只有 C-D 一条 ⇒ 它在那一套里必是 Top。
    expect(view.legs.every((l) => l.activityByTab.all !== null)).toBe(true);
    expect(build?.activityByTab.build?.isTopRanked).toBe(true);
    expect(build?.activityByTab.rent).toBeNull();
    expect(rent?.activityByTab.build).toBeNull();
    // 整数档优先: K = 120 是整数档。
    expect(rent?.activityByTab.all?.isRoundStrike).toBe(true);
  });

  it('同一到期日的多条腿共用**同一个**财报标对象 (Guardrail 11 的结构保证)', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, NOW);
    const a = view.legs.find((l) => l.code === 'C-A');
    const b = view.legs.find((l) => l.code === 'C-B'); // 死档, 但同到期日
    expect(a?.earningsMark).toBe(b?.earningsMark);
    expect(a?.earningsMark?.mark).toBe('covered');
  });
});

describe('get-legs.usecase — 缺口与故障是两件事', () => {
  it('无锚 → 404 (回 200 空壳会让「没建锚」与「建了锚但没数据」不可区分)', async () => {
    const prisma = makePrisma({ anchor: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(makeUseCase(prisma).execute(SYMBOL, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('链数据未就绪 → chain_not_ready + 空腿, 锚派生的那半边照常返回', async () => {
    const prisma = makePrisma({ instrument: { findUnique: vi.fn().mockResolvedValue(null) } });
    const view = await makeUseCase(prisma).execute(SYMBOL, NOW);
    expect(view.state).toBe('chain_not_ready');
    expect(view.legs).toEqual([]);
    expect(view.w.toString()).toBe('120');
    expect(view.lLevel).toBe('L2');
    // 无 spot ⇒ 无区间 ⇒ 意图 MUST NOT 猜一个档。
    expect(view.zone).toBeNull();
    expect(view.intent).toBe('pending');
  });

  it('跨 ctx 读故障 → read_failed 而不是 500, 且与 chain_not_ready 可区分', async () => {
    const prisma = makePrisma({
      optionContract: { findMany: vi.fn().mockRejectedValue(new Error('pg down')) },
    });
    const view = await makeUseCase(prisma).execute(SYMBOL, NOW);
    expect(view.state).toBe('read_failed');
    expect(view.legs).toEqual([]);
    expect(view.w.toString()).toBe('120');
  });
});

/**
 * T027a —— `state_branches` 第 3 条「快照非当日 ⇒ 全表照常 + 陈旧 asOf」的判据回归防线。
 *
 * 🚨 判据是 canonical §5 的**最近一个已收盘交易日**, 不是任何一方的「今天」。判在 server 是
 *    因为它要查交易日历 —— 客户端没有, 只能拿设备本地日期比, 而那对美股**恒为真** (境内本地
 *    日历已翻页、市场当天尚未收盘) ⇒ 每个读数恒显「已过时」, 该档位随之失去信息量。
 * 🚨 判别性靠两件事同时成立: ① `now` 注入的是**境内早晨**那个时刻 ② 日历 fixture **含未来日**
 *    (见 {@link TRADING_DAYS})。少任何一件, 「拿本地/UTC 今天当基准」的错写法都能蒙混过关。
 */
describe('get-legs.usecase — FR-020 新鲜度档 (T027a, 判据 = 最近一个已收盘交易日)', () => {
  const tableAt = async (session: string, now: Date, prismaOverrides = {}) => {
    const prisma = makePrisma({
      optionDailySnapshot: {
        findFirst: vi.fn().mockResolvedValue({ sessionDate: date(session) }),
        findMany: vi.fn().mockResolvedValue(snapshotsOf(LEGS, session)),
      },
      ...prismaOverrides,
    });
    return { res: toLegTableResponse(await makeUseCase(prisma).execute(SYMBOL, now)), prisma };
  };

  it('🚨 境内早晨 (本地已翻页、市场当日已收盘) + 当日快照 ⇒ CURRENT, **不判陈旧**', async () => {
    const { res, prisma } = await tableAt('2026-08-04', NOW_CN_MORNING);
    expect(res.asOf).toBe('2026-08-04');
    expect(res.asOfFreshnessTier).toBe('CURRENT');
    // 上界来自**市场当地收盘时刻**: ET 08-04 20:00 已过 16:00 ⇒ 08-04。取本地/UTC 今天会是
    // 08-05, 日历里 08-05 有行 ⇒ 上面那条立刻翻成 STALE。
    const where = prisma.tradingDay.findFirst.mock.calls[0][0].where;
    expect(where.market).toBe('us');
    expect(where.date.lte.toISOString().slice(0, 10)).toBe('2026-08-04');
  });

  it('快照停在上一个交易日 ⇒ STALE, 且**全表照常渲染** (陈旧不等于不可用)', async () => {
    const { res } = await tableAt('2026-08-03', NOW_CN_MORNING);
    expect(res.asOfFreshnessTier).toBe('STALE');
    expect(res.state).toBe('available');
    expect(res.legs).toHaveLength(LEGS.length);
  });

  it('交易日历查不到 ⇒ fail-open 判 CURRENT (宁可漏报一次, 不重演「全体恒显已过时」)', async () => {
    const { res } = await tableAt('2026-08-03', NOW_CN_MORNING, {
      tradingDay: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    expect(res.asOfFreshnessTier).toBe('CURRENT');
  });

  it('链未就绪 ⇒ asOf 为 null ⇒ UNAVAILABLE (不编造日期, 也不白查日历)', async () => {
    const prisma = makePrisma({ instrument: { findUnique: vi.fn().mockResolvedValue(null) } });
    const res = toLegTableResponse(await makeUseCase(prisma).execute(SYMBOL, NOW_CN_MORNING));
    expect(res.asOf).toBeNull();
    expect(res.asOfFreshnessTier).toBe('UNAVAILABLE');
    expect(prisma.tradingDay.findFirst).not.toHaveBeenCalled();
  });
});
