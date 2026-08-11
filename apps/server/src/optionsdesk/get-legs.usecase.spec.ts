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
  /** 缺省 = `bid + 0.10`(窄价差, 稳过流动性门槛); 显式给值才造得出宽价差反例。 */
  ask?: string;
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
  // 建仓召回集 (050: DTE 10 ∈ [1,49] ∧ 有效成本 128 < spot 132.40) ⇒ 周化口径,
  // 周化 1.09% ⇒ 可接受。(047 下它靠 |Δ| 0.45 ∈ [0.40,0.55] ∧ DTE ≤ 14 进建仓族, 判据已换代。)
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
    ask: leg.ask !== undefined ? D(leg.ask) : leg.bid === null ? null : D(leg.bid).plus(D('0.10')),
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

/**
 * 月度到期日判据 (T007) 查的是**另一段**日历: 窗口跨到链上最晚的到期日, 与上面那个「最近一个
 * 已收盘交易日」的窗口不重叠。两个候选日 (`2026-08-21` / `2027-01-15`, 分别是 08 月与次年 01
 * 月的第三个周五) 在这里都是**真交易日** —— 假日回退那条分支由 `leg-mark.rules.spec.ts` 承重
 * (纯函数), IT 再打一次真日历表; 本文件只验 use case 有没有把这条线接上。
 */
const MONTHLY_CALENDAR = ['2026-08-20', '2026-08-21', '2027-01-14', '2027-01-15'];

/** 按 `date <= cutoff` 取最大交易日 —— 与 `last-closed-session.ts` 的真查询同语义。 */
function tradingDayFindFirst() {
  return vi.fn(async (args: { where: { market: string; date: { lte: Date } } }) => {
    const cutoff = args.where.date.lte.toISOString().slice(0, 10);
    const hit = [...TRADING_DAYS].reverse().find((d) => d <= cutoff);
    return hit === undefined ? null : { date: date(hit) };
  });
}

function makePrisma(overrides: Record<string, unknown> = {}, legs: LegFixture[] = LEGS) {
  return {
    anchor: { findUnique: vi.fn().mockResolvedValue(anchorRow) },
    instrument: { findUnique: vi.fn().mockResolvedValue({ id: 42n }) },
    optionContract: { findMany: vi.fn().mockResolvedValue(contractsOf(legs)) },
    optionDailySnapshot: {
      findFirst: vi.fn().mockResolvedValue({ sessionDate: date('2026-08-03') }),
      findMany: vi.fn().mockResolvedValue(snapshotsOf(legs)),
    },
    earningsEvent: { findMany: vi.fn().mockResolvedValue([{ earningsDate: date('2026-08-12') }]) },
    tradingDay: {
      findFirst: tradingDayFindFirst(),
      findMany: vi.fn().mockResolvedValue(MONTHLY_CALENDAR.map((d) => ({ date: date(d) }))),
    },
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
    // 🚨 **这条断言在 050 翻转, 而翻转本身就是 US1-AS3 / FR-009**: C-C 缺 Δ, 047 下被 Δ 带挡在
    // 两个意图 Tab 之外; 050 下 Δ 退出召回判据 ⇒ 只看 DTE=17 ∈ [1,49] 与有效成本
    // 145 − 13 = 132 < spot 132.40 ⇒ 进建仓召回集。全腿 Tab 恒在, 这点没变。
    expect(gap?.tabs).toEqual(['all', 'build']);
    // 全腿 Tab 里人人有名次; 建仓 Tab 现有 C-C / C-D 两条 (Top N = 3 ⇒ 两条都是 Top)。
    expect(view.legs.every((l) => l.activityByTab.all !== null)).toBe(true);
    expect(build?.activityByTab.build?.isTopRanked).toBe(true);
    expect(build?.activityByTab.rent).toBeNull();
    expect(rent?.activityByTab.build).toBeNull();
    // 整数档优先: K = 120 是整数档。
    expect(rent?.activityByTab.all?.isRoundStrike).toBe(true);
  });

  it('月度链标: 到期日落该月月度日的腿带标, 周链腿不带 (FR-014, T007 接线)', async () => {
    const prisma = makePrisma();
    const view = await makeUseCase(prisma).execute(SYMBOL, NOW);

    // C-A / C-B 到期 2027-01-15 = 次年 1 月第三个周五; C-C 到期 2026-08-21 = 8 月第三个周五。
    expect(view.legs.find((l) => l.code === 'C-A')?.isMonthlyChain).toBe(true);
    expect(view.legs.find((l) => l.code === 'C-C')?.isMonthlyChain).toBe(true);
    // C-D 到期 2026-08-14 是周链 ⇒ 不带标。它证明这个标**不是恒 true**。
    expect(view.legs.find((l) => l.code === 'C-D')?.isMonthlyChain).toBe(false);

    // 🚨 Guardrail 7: 整段日历**一次查回**, 不是逐到期日查 (链上 3 个不同到期日)。
    expect(prisma.tradingDay.findMany).toHaveBeenCalledTimes(1);
    const where = prisma.tradingDay.findMany.mock.calls[0][0].where;
    expect(where.market).toBe('us');
    // 窗口下界 = 最早候选日 (2026-08-21) 往前 7 天; 上界 = 最晚候选日 (2027-01-15)。
    expect(where.date.gte.toISOString().slice(0, 10)).toBe('2026-08-14');
    expect(where.date.lte.toISOString().slice(0, 10)).toBe('2027-01-15');
  });

  it('同一到期日的多条腿共用**同一个**财报标对象 (Guardrail 11 的结构保证)', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, NOW);
    const a = view.legs.find((l) => l.code === 'C-A');
    const b = view.legs.find((l) => l.code === 'C-B'); // 死档, 但同到期日
    expect(a?.earningsMark).toBe(b?.earningsMark);
    expect(a?.earningsMark?.mark).toBe('covered');
  });
});

/**
 * T004 —— 两道门槛的**作用面不对称** (FR-005 / FR-006 / FR-008)。
 *
 * 🚨 两个数描述的不是同一件事: `removedByPremiumFloor` = 「移出响应」(三个 Tab 都看不到,
 * 真消失), `excludedFromIntentTabs` = 「仍在响应、只进全腿 Tab」(没消失)。故每条反例都
 * **同时**断言另一个数**不动** —— 只断言自己那个数的话, 把两者串台的实现照样能绿。
 *
 * 🚨 两条被权利金门槛挡下的反例 (`G-PENNY` / `G-NOBID`) 蓄意**同时**是宽价差 / 无 ask:
 * 若实现把流动性判据施加在权利金门槛**之前**(或对已移出的腿照样计数), `excludedFromIntentTabs`
 * 会跟着 +2 —— 那正是这两条 fixture 要绊的线。
 */
describe('get-legs.usecase — 两道门槛的作用面不对称, 计数互不串台 (FR-005/FR-006/FR-008)', () => {
  // spot 132.40 ⇒ 权利金门槛 = max(0.20, 132.40 × 0.0012 = 0.1589) = 0.20。
  // 全部反例都用 DTE 10 (2026-08-14) 且有效成本 < spot ⇒ 期限段与有效成本都不是它们出局的原因。
  const base = { delta: '-0.45', greeksComplete: true, openInterest: '300', volume: '120' };
  const ok: LegFixture = {
    code: 'G-OK',
    strike: '130',
    expiry: '2026-08-14',
    bid: '2.00',
    ...base,
  };
  /** 一分钱腿: bid 0.05 < 0.20 ⇒ 移出响应。价差 0.10/0.10 = 100% 是**串台绊线**。 */
  const penny: LegFixture = {
    code: 'G-PENNY',
    strike: '125',
    expiry: '2026-08-14',
    bid: '0.05',
    ask: '0.15',
    ...base,
  };
  /** 完全无 bid ⇒ 按「不满足权利金门槛」处置 (🚫 禁当 0)。无 ask ⇒ 流动性 fail-closed 绊线。 */
  const noBid: LegFixture = {
    code: 'G-NOBID',
    strike: '128',
    expiry: '2026-08-14',
    bid: null,
    ...base,
    delta: '-0.40',
  };
  /** 宽价差: 6.00/6.00 = 100% > 35% ⇒ 出意图 Tab, 但**留在响应与全腿 Tab**。 */
  const wide: LegFixture = {
    code: 'G-WIDE',
    strike: '126',
    expiry: '2026-08-14',
    bid: '3.00',
    ask: '9.00',
    ...base,
  };
  /** DTE 400 且宽价差 —— 它出意图 Tab 的原因是期限段, 不是流动性。 */
  const longWide: LegFixture = {
    code: 'G-LONG-WIDE',
    strike: '110',
    expiry: '2027-09-08',
    bid: '3.00',
    ask: '9.00',
    ...base,
  };

  const tableOf = (legs: LegFixture[]) => makeUseCase(makePrisma({}, legs)).execute(SYMBOL, NOW);

  it('权利金门槛挡下的腿从响应**整条移出**, 且只让 removedByPremiumFloor 动 (禁当 bid = 0)', async () => {
    const view = await tableOf([ok, penny, noBid]);

    // 三个 Tab 一律不出现 = 它压根不在 legs[] 里 (客户端按每腿的 tabs 过滤, 没有行就没有归属)。
    expect(view.legs.map((l) => l.code)).toEqual(['G-OK']);
    expect(view.gateCounts.removedByPremiumFloor).toBe(2);
    // 🚨 串台绊线: 这两条同时是宽价差 / 无 ask, 但它们已经不在响应里 ⇒ 不属于「流动性排除」。
    expect(view.gateCounts.excludedFromIntentTabs).toBe(0);
  });

  it('流动性门槛挡下的腿**仍在响应里**、只剩全腿 Tab, 且只让 excludedFromIntentTabs 动', async () => {
    const view = await tableOf([ok, wide]);

    const excluded = view.legs.find((l) => l.code === 'G-WIDE');
    expect(excluded).toBeDefined();
    expect(excluded?.tabs).toEqual(['all']);
    // 数据没消失: 报价 / 费率 / 档位照常在, 只是不进意图候选。
    expect(excluded?.bid?.toString()).toBe('3');
    expect(view.gateCounts.excludedFromIntentTabs).toBe(1);
    expect(view.gateCounts.removedByPremiumFloor).toBe(0);
    // 对照腿两个 Tab 都进 —— 证明宽价差那条不是被别的判据顺手挡掉的。
    expect(view.legs.find((l) => l.code === 'G-OK')?.tabs).toEqual(['all', 'build']);
  });

  it('期限段本就不合格的腿**不计入**流动性排除 —— 那个数是流动性信号, 不是「哪儿都没进」的总数', async () => {
    const view = await tableOf([ok, longWide]);

    expect(view.legs.find((l) => l.code === 'G-LONG-WIDE')?.tabs).toEqual(['all']);
    // DTE 400 两个意图段都够不着 ⇒ 它出局与流动性无关, 计进去会稀释掉这个数唯一的用途。
    expect(view.gateCounts.excludedFromIntentTabs).toBe(0);
    expect(view.gateCounts.removedByPremiumFloor).toBe(0);
  });

  it('两道门槛都不触发时两个数恒 0 —— 证明它们不是「恒计数」的摆设', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, NOW);

    expect(view.legs).toHaveLength(LEGS.length);
    expect(view.gateCounts).toEqual({ removedByPremiumFloor: 0, excludedFromIntentTabs: 0 });
  });

  it('链未就绪 → 两个数为 0 (没有链就没有腿被挡下, MUST NOT 留上一次的数)', async () => {
    const prisma = makePrisma({ instrument: { findUnique: vi.fn().mockResolvedValue(null) } });
    const view = await makeUseCase(prisma).execute(SYMBOL, NOW);

    expect(view.state).toBe('chain_not_ready');
    expect(view.gateCounts).toEqual({ removedByPremiumFloor: 0, excludedFromIntentTabs: 0 });
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
      // 🚨 覆盖整个 `tradingDay` 就必须连 `findMany` 一起给 —— 少给会让月度链标那次跨 ctx 读
      // 抛错、整屏降级成 read_failed, 而本用例验的是**新鲜度档**那条 fail-open 分支。
      tradingDay: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
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

/**
 * T008 —— 打标接线 (FR-016 / FR-018, plan D-MARK-3)。
 *
 * 数据集蓄意让**两条建仓腿的 OI / 成交量全链最低**: 于是它们在全腿 Tab 里排不进前三、在建仓
 * Tab 里却是全部成员 ⇒ 「每个 Tab 按自己的召回全量排名」这件事有了**可观测的差**。若排名基准
 * 退化成全链 (或退化成筛选后的子集), 这两条腿在建仓 Tab 的 `isTopRanked` 立刻翻。
 */
describe('get-legs.usecase — 打标零拦截 + 排名基准 = 该 Tab 召回全量 (FR-016/FR-018)', () => {
  const base = { greeksComplete: true, ask: undefined };
  // 建仓腿 (DTE 10, 有效成本 < spot 132.40); OI / Vol 全链最低。
  const buildA: LegFixture = {
    code: 'M-BUILD-A',
    strike: '130',
    expiry: '2026-08-14',
    bid: '2.00',
    delta: '-0.45',
    openInterest: '10',
    volume: '1',
    ...base,
  };
  const buildB: LegFixture = {
    code: 'M-BUILD-B',
    strike: '129',
    expiry: '2026-08-14',
    bid: '1.50',
    delta: '-0.10',
    openInterest: '12',
    volume: '2',
    ...base,
  };
  // 收租长腿 (DTE 164); OI / Vol 全链最高 ⇒ 它们占满全腿 Tab 的前三。
  const rentDeep: LegFixture = {
    code: 'M-RENT-DEEP',
    strike: '120',
    expiry: '2027-01-15',
    bid: '8.00',
    delta: '-0.10', // 落 deep 带 [0.05,0.15]
    openInterest: '900',
    volume: '90',
    ...base,
  };
  const rentModerate: LegFixture = {
    code: 'M-RENT-MODERATE',
    strike: '115',
    expiry: '2027-01-15',
    bid: '6.00',
    delta: '-0.25', // 落 moderate 带, **不在** deep 带内
    openInterest: '800',
    volume: '80',
    ...base,
  };
  const rentGapless: LegFixture = {
    code: 'M-RENT-NOGREEKS',
    strike: '110',
    expiry: '2027-01-15',
    bid: '4.00',
    delta: null,
    greeksComplete: false,
    openInterest: '700',
    volume: '70',
  };
  const MARK_LEGS: LegFixture[] = [buildA, buildB, rentDeep, rentModerate, rentGapless];

  /** 默认锚 ⇒ 卖put区 + L2 + 水位 ≥2/3 ⇒ 意图「收租 · 深度」, 带 = [0.05, 0.15]。 */
  const tableWithBucket = (positionBucketManual: string | null) =>
    makeUseCase(
      makePrisma(
        {
          anchor: {
            findUnique: vi.fn().mockResolvedValue({ ...anchorRow, positionBucketManual }),
          },
        },
        MARK_LEGS,
      ),
    ).execute(SYMBOL, NOW);

  it('推荐标随**标的级意图**判: 收租 · 深度 ⇒ 只有 |Δ| 落 deep 带的腿带标', async () => {
    const view = await tableWithBucket('gte_two_thirds');
    expect(view.intent).toBe('rent');
    expect(view.rentDepth).toBe('deep');

    const recommended = view.legs.filter((l) => l.isRecommended).map((l) => l.code);
    // |Δ| 0.10 两条 (一条建仓腿 + 一条收租腿) 都落 deep 带 —— 🚨 标**不随 Tab 变**:
    // 建仓 Tab 里的那条腿照样按收租的带判, 这正是 FR-011 要的（SC-005 的另一面）。
    expect(new Set(recommended)).toEqual(new Set(['M-BUILD-B', 'M-RENT-DEEP']));
    // moderate 带那条不带标; greeks 缺失那条恒不带标 (FR-013)。
    expect(view.legs.find((l) => l.code === 'M-RENT-MODERATE')?.isRecommended).toBe(false);
    expect(view.legs.find((l) => l.code === 'M-RENT-NOGREEKS')?.isRecommended).toBe(false);
  });

  it('🚨 打标零拦截: 水位从「已选」翻成「未选」⇒ 全表零推荐标, 而 Tab 成员集合**逐条不变**', async () => {
    const selected = await tableWithBucket('gte_two_thirds');
    const unselected = await tableWithBucket(null);

    expect(unselected.intent).toBe('pending');
    // 水位未选 ⇒ 一个推荐标都没有 (Guardrail 1: 🚫 MUST NOT 取三档并集替人做方向性假设)。
    expect(unselected.legs.every((l) => !l.isRecommended)).toBe(true);
    expect(selected.legs.some((l) => l.isRecommended)).toBe(true);
    // 🚨 判据: 同一份输入, 打标的输入变了而**成员关系一行不动** —— 打标 MUST NOT 参与筛选。
    const membership = (view: typeof selected) =>
      view.legs.map((l) => `${l.code}:${[...l.tabs].join('+')}`);
    expect(membership(unselected)).toEqual(membership(selected));
    expect(unselected.gateCounts).toEqual(selected.gateCounts);
  });

  it('🚨 排名基准 = 该 Tab 的召回全量: 全链最不活跃的两条腿在建仓 Tab 里仍是 Top', async () => {
    const view = await tableWithBucket('gte_two_thirds');
    const leg = (code: string) => view.legs.find((l) => l.code === code)!;

    // 建仓 Tab 只有两条成员 (< Top 3) ⇒ 两条都是 Top。
    expect(leg('M-BUILD-A').tabs).toContain('build');
    expect(leg('M-BUILD-A').activityByTab.build?.isTopRanked).toBe(true);
    expect(leg('M-BUILD-B').activityByTab.build?.isTopRanked).toBe(true);
    // 同两条腿在全腿 Tab (5 条成员) 里排不进前三 —— 名次是**候选集内的相对量**。
    expect(leg('M-BUILD-A').activityByTab.all?.isTopRanked).toBe(false);
    expect(leg('M-BUILD-B').activityByTab.all?.isTopRanked).toBe(false);
    // 若排名基准退化成「全链」, 上面两条 build 断言会翻成 false —— 那就是 Guardrail 3 那个坑。

    // 每个 Tab 拿到名次的行数 == 该 Tab 的成员数 (排名跑在成员集合上, 不多不少)。
    for (const tab of ['all', 'build', 'rent'] as const) {
      const members = view.legs.filter((l) => l.tabs.includes(tab));
      const ranked = view.legs.filter((l) => l.activityByTab[tab] !== null);
      expect(ranked.map((l) => l.code).sort()).toEqual(members.map((l) => l.code).sort());
    }
  });
});
