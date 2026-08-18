import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../security/prisma.service';
import { GetLegsUseCase } from './get-legs.usecase';
import { ACTIVITY_TOP_RANK_COUNT } from './leg-derive.rules';
import { DISPLAY_LIMIT_BY_PERSPECTIVE } from './leg-rank.rules';
import { RETRIEVAL_CRITERION_KEYS } from './leg-recall.rules';
import { PrismaLegRetrievalAdapter } from './leg-retrieval.adapter';
import { toLegTableResponse, toRequestedPerspective, toRetrievalOverride } from './optionsdesk.dto';
import { lastClosedSessionCutoff } from '../marketdata/trading-day-gate';

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

/**
 * vendor 到期周期 (`marketdata.option_contract.expiration_cycle`) —— 月度链标的唯一判据输入。
 * 按**到期日**给: 它现实中就是到期日级属性, 这样写让 fixture 造不出「同一到期日两条腿标不一样」。
 */
const MONTHLY_EXPIRIES = new Set(['2026-08-21', '2027-01-15']);

function contractsOf(legs: LegFixture[]) {
  return legs.map((leg, i) => ({
    id: BigInt(i + 1),
    code: leg.code,
    expiryDate: date(leg.expiry),
    strikePrice: D(leg.strike),
    expirationCycle: MONTHLY_EXPIRIES.has(leg.expiry) ? 'MONTH' : 'WEEK',
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
    // 055 起检索 port 也带出 iv (平值 IV 曲线的输入)。本 spec 不断言它, 但**必须给** ——
    // 快照 mock 少一列会让适配器在取值时炸, 而 use case 的降级 try/catch 会把它兜成
    // `read_failed` + 空表: 一屏正常的空, 排查起来完全不像「mock 少了一列」。
    iv: D('28.5'),
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
 * 交易日历端口替身 —— 与 `DbTradingCalendarAdapter.lastClosedSession` **同语义**: 按市场当地
 * 收盘上界取 {@link TRADING_DAYS} 里的最大交易日。062 T010 起本 use case 不再直查
 * `trading_day`（判据收编进端口），故这里替的是端口而不是 prisma。
 */
function tradingCalendar(days: readonly string[] = TRADING_DAYS) {
  const lastClosedSession = vi.fn(async (market: string, now: Date) => {
    const cutoff = lastClosedSessionCutoff(market, now);
    return [...days].reverse().find((d) => d <= cutoff) ?? null;
  });
  return { classify: async (): Promise<'trading'> => 'trading', lastClosedSession };
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
    ...overrides,
  };
}

/**
 * 🚨 **052 起 use case 经检索 port 拿候选集, 但本文件蓄意注入 `PrismaLegRetrievalAdapter`
 * 而非假实现** —— 同一个 prisma mock 照常驱动全链路, 于是「SQL 端过滤了什么 / 取的是哪一期
 * 快照 / dedupe 取哪条」这批断言一条不用改, 仍然守着真实现。
 *
 * 假实现的用武之地在 `leg-retrieval.port.spec.ts` (脱离真库驱动召回判据, SC-009); 拿它替换
 * 这里会把本文件降级成「测我刚写的那份 mock」。
 */
function makeUseCase(
  prisma: ReturnType<typeof makePrisma>,
  calendar: ReturnType<typeof tradingCalendar> = tradingCalendar(),
) {
  const service = prisma as unknown as PrismaService;
  return new GetLegsUseCase(service, new PrismaLegRetrievalAdapter(service), calendar);
}

describe('get-legs.usecase — 全量适格腿, 零分页零截断 (FR-005/008, Guardrail 7)', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('非标与已到期在 SQL 端就滤掉 —— 判据是 `到期日 > 当日`, 与完整性分母的 `≥` 故意不同', async () => {
    await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);
    const where = prisma.optionContract.findMany.mock.calls[0][0].where;
    expect(where.isStandard).toBe(true); // FR-008 非标零出现 (采集端仍照常落库, FR-033)
    expect(where.optionType).toBe('PUT');
    // 🚨 Guardrail 7: 严格大于当日 —— 写成 gte 只在到期日当天露馅。
    expect(where.expiryDate).toEqual({ gt: date('2026-08-04') });
    expect(where.underlyingInstrumentId).toBe(42n);
  });

  it('落库多少条就返多少条 —— 无 take / skip / cursor 任何截断参数', async () => {
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);
    expect(view.legs).toHaveLength(LEGS.length);
    const args = prisma.optionContract.findMany.mock.calls[0][0];
    expect(args.take).toBeUndefined();
    expect(args.skip).toBeUndefined();
    expect(prisma.optionDailySnapshot.findMany.mock.calls[0][0].take).toBeUndefined();
  });

  it('死档与 greeks 缺失行都**在结果里** (不判档 / 判死 ≠ 被移出)', async () => {
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);
    // 🚨 **053 T003 起 `legs[]` 是精排序**, 不再是 047 的档位载体序 ⇒ 「死档排最后」那条随
    // 载体序一起退役 (它从 050 起就不是屏幕上的序 —— 客户端按 `tabOrder` 渲染, 而那是精排序)。
    // 留下来的实质是「不判档 / 判死都不影响成员集合」。
    expect(view.legs).toHaveLength(LEGS.length);
    expect(view.legs.find((l) => l.code === 'C-B')?.tier).toBe('dead');
    expect(view.legs.find((l) => l.code === 'C-C')?.tier).toBeNull();
  });

  it('greeks 缺失行不判档不着色 —— tier / Δ / σ 距三者同时为空 (FR-007, Guardrail 10)', async () => {
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);
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
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);
    expect(view.asOf).toEqual(date('2026-08-03'));
    expect(view.oiAsOf).toEqual(date('2026-07-31'));
    expect(view.oiAsOf).not.toEqual(view.asOf);
    expect(view.quoteAsOf?.toISOString()).toBe('2026-08-03T20:15:00.000Z');
    expect(view.source).toBe('eod');
  });

  it('DTE 基准是交易所的今天, 价格却来自上一场 session —— 这处错配是有意的, 不许「修」', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);
    // 2026-08-04 → 2026-08-14 = 10 天 (整数日历日, 含周末)。若改成按 asOf (08-03) 起算会是 11。
    expect(view.legs.find((l) => l.code === 'C-D')?.dteDays).toBe(10);
  });

  it('045 的 W / 四区间 / L 层复用而非重算, 意图走矩阵', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);
    expect(view.w.toString()).toBe('120');
    expect(view.zone).toBe('thin');
    expect(view.lLevel).toBe('L2');
    expect(view.positionBucket).toBe('gte_two_thirds');
    expect(view.intent).toBe('rent');
    expect(view.rentDepth).toBe('deep');
    expect(view.spot?.toString()).toBe('132.4');
  });

  it('🚨 053 FR-041: 口径跟**视角**走 —— 同一条腿在建仓视角周化、在全腿视角年化', async () => {
    const inBuild = await makeUseCase(makePrisma()).execute(SYMBOL, 'build', NOW);
    const inAll = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);
    const rent = (await makeUseCase(makePrisma()).execute(SYMBOL, 'rent', NOW)).legs.find(
      (l) => l.code === 'C-A',
    );

    // 判别性: **同一条腿 C-D** 两个视角两个口径、两个档 —— 若口径退回「按腿族反推」,
    // 全腿视角那条会跟着变成 weekly / acceptable 而立刻红。
    const buildLeg = inBuild.legs.find((l) => l.code === 'C-D');
    const allLeg = inAll.legs.find((l) => l.code === 'C-D');
    expect([buildLeg?.basis, buildLeg?.tier]).toEqual(['weekly', 'acceptable']);
    expect([allLeg?.basis, allLeg?.tier]).toEqual(['annualized', 'good']);
    expect([rent?.basis, rent?.tier]).toEqual(['annualized', 'acceptable']);
    // 折年在周化行上照常给出 (参照列), 但它**不是**该行的判定值。
    expect(buildLeg?.annualizedRate).not.toBeNull();
  });
});

describe('get-legs.usecase — 每次只作答一个视角 (053 FR-001/FR-002, D-API-1)', () => {
  it('🚨 三个视角各自只返回自己的腿, 且只带自己那一套活跃度 (另两格恒 null)', async () => {
    const viewOf = (perspective: 'all' | 'build' | 'rent') =>
      makeUseCase(makePrisma()).execute(SYMBOL, perspective, NOW);

    const all = await viewOf('all');
    const build = await viewOf('build');
    const rent = await viewOf('rent');

    // 成员集合逐视角不同 (三份相等的话下面的「只答一个视角」就是平凡绿)。
    // 🚨 C-C 缺 Δ 照样进建仓召回集 (050 FR-009: Δ 已退出召回判据) —— DTE=17 ∈ [1,49] 且
    // 有效成本 145 − 13 = 132 < spot 132.40。
    expect(all.legs.map((l) => l.code).sort()).toEqual(['C-A', 'C-B', 'C-C', 'C-D']);
    expect(build.legs.map((l) => l.code).sort()).toEqual(['C-C', 'C-D']);
    expect(rent.legs.map((l) => l.code).sort()).toEqual(['C-A', 'C-B']);

    for (const [perspective, view] of [
      ['all', all],
      ['build', build],
      ['rent', rent],
    ] as const) {
      // 视角原样回显 —— 三次飞行中的请求靠它认领各自的响应 (053 FR-005 / FR-008)。
      expect(view.perspective).toBe(perspective);
      // 活跃标是**本次视角候选集内**的相对量 ⇒ 每条成员都拿到了一份 (053 起只有这一份)。
      for (const leg of view.legs) {
        expect([leg.code, leg.activity]).not.toEqual([leg.code, null]);
      }
    }
    // 整数档优先: K = 120 是整数档 (证明那一格真的算过, 不是「填了个对象」)。
    expect(rent.legs.find((l) => l.code === 'C-A')?.activity?.isRoundStrike).toBe(true);
    // 建仓视角只有 C-C / C-D 两条, 各自独占一个到期日组 ⇒ 过了活跃标绝对线的那条是 Top。
    expect(build.legs.find((l) => l.code === 'C-D')?.activity?.isTopRanked).toBe(true);
  });

  it('月度链标: vendor 标 `MONTH` 的腿带标, 周链腿不带 (FR-014, #45 换源后接线)', async () => {
    const prisma = makePrisma();
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);

    // C-A / C-B 到期 2027-01-15、C-C 到期 2026-08-21, vendor 均标 `MONTH`。
    expect(view.legs.find((l) => l.code === 'C-A')?.isMonthlyChain).toBe(true);
    expect(view.legs.find((l) => l.code === 'C-C')?.isMonthlyChain).toBe(true);
    // C-D 到期 2026-08-14 标 `WEEK` ⇒ 不带标。它证明这个标**不是恒 true**。
    expect(view.legs.find((l) => l.code === 'C-D')?.isMonthlyChain).toBe(false);

    // 🚨 **零额外往返** (#45): 判据的输入随合约集那一次查询一并出来 —— 换源前这里还有一次
    // `tradingDay.findMany`。062 T010 后交易日历只经端口被问「最近一场已收盘交易日」这一下。
    expect(prisma).not.toHaveProperty('tradingDay');
    expect(prisma.optionContract.findMany).toHaveBeenCalledTimes(1);
  });

  it('同一到期日的多条腿共用**同一个**财报标对象 (Guardrail 11 的结构保证)', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);
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
  // spot 132.40 ⇒ 权利金门槛 = max(0.20, 132.40 × 0.0018 = 0.2383) = 0.2383 (T017 标定后)。
  // 全部反例都用 DTE 10 (2026-08-14) 且有效成本 < spot ⇒ 期限段与有效成本都不是它们出局的原因。
  const base = { delta: '-0.45', greeksComplete: true, openInterest: '300', volume: '120' };
  const ok: LegFixture = {
    code: 'G-OK',
    strike: '130',
    expiry: '2026-08-14',
    bid: '2.00',
    ...base,
  };
  /** 一分钱腿: bid 0.05 < 0.2383 ⇒ 移出响应。价差 0.10/0.10 = 100% 是**串台绊线**。 */
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

  const tableOf = (legs: LegFixture[], perspective: 'all' | 'build' | 'rent' = 'all') =>
    makeUseCase(makePrisma({}, legs)).execute(SYMBOL, perspective, NOW);

  it('权利金门槛挡下的腿从响应**整条移出**, 且只让 removedByPremiumFloor 动 (禁当 bid = 0)', async () => {
    const view = await tableOf([ok, penny, noBid]);

    // 它压根不在 legs[] 里 —— 「移出」是整条消失, 不是「某个视角看不到」。
    expect(view.legs.map((l) => l.code)).toEqual(['G-OK']);
    expect(view.gateCounts.removedByPremiumFloor).toBe(2);
    // 🚨 串台绊线: 这两条同时是宽价差 / 无 ask, 但它们已经不在响应里 ⇒ 不属于「流动性排除」。
    expect(view.gateCounts.excludedFromIntentTabs).toBe(0);
  });

  it('🚨 SC-012: 被流动性挡出建仓视角的腿, 在**全腿视角**逐条可达 (051 那个入口的回归防线)', async () => {
    const inBuild = await tableOf([ok, wide], 'build');
    const inAll = await tableOf([ok, wide], 'all');

    // 建仓视角: 它不在成员集里, 但排除数把「有腿被挡了」说出来了。
    expect(inBuild.legs.map((l) => l.code)).toEqual(['G-OK']);
    expect(inBuild.gateCounts.excludedFromIntentTabs).toBe(1);
    expect(inBuild.gateCounts.removedByPremiumFloor).toBe(0);

    // 🚨 全腿视角: 同一条腿在这里**必须找得到**, 且数据没消失 (报价 / 费率 / 档位照常在)。
    // 051 ship 的「点流动性排除数 → 切到全腿视角看被排除的腿」整条依赖这一点。
    const reachable = inAll.legs.find((l) => l.code === 'G-WIDE');
    expect(reachable).toBeDefined();
    expect(reachable?.bid?.toString()).toBe('3');
    // 全腿视角不设价差上界 (052 FR-010) ⇒ 它在这个视角下压根不算「被排除」。
    expect(inAll.gateCounts.excludedFromIntentTabs).toBe(0);
  });

  it('期限段本就不合格的腿**不计入**流动性排除 —— 那个数是流动性信号, 不是「哪儿都没进」的总数', async () => {
    const inBuild = await tableOf([ok, longWide], 'build');

    expect(inBuild.legs.map((l) => l.code)).toEqual(['G-OK']);
    // DTE 400 够不着建仓段 ⇒ 它出局与流动性无关 (两维同时挡下 ⇒ 边际口径下哪一维都不计它),
    // 计进去会稀释掉这个数唯一的用途。
    expect(inBuild.gateCounts.excludedFromIntentTabs).toBe(0);
    expect(inBuild.gateCounts.removedByPremiumFloor).toBe(0);
    // 它在全腿视角照常可达 —— 「没进意图视角」与「消失了」始终是两件事。
    expect((await tableOf([ok, longWide], 'all')).legs.map((l) => l.code)).toContain('G-LONG-WIDE');
  });

  it('两道门槛都不触发时两个数恒 0 —— 证明它们不是「恒计数」的摆设', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);

    expect(view.legs).toHaveLength(LEGS.length);
    expect(view.gateCounts).toEqual({ removedByPremiumFloor: 0, excludedFromIntentTabs: 0 });
  });

  it('链未就绪 → 两个数为 0 (没有链就没有腿被挡下, MUST NOT 留上一次的数)', async () => {
    const prisma = makePrisma({ instrument: { findUnique: vi.fn().mockResolvedValue(null) } });
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);

    expect(view.state).toBe('chain_not_ready');
    expect(view.gateCounts).toEqual({ removedByPremiumFloor: 0, excludedFromIntentTabs: 0 });
  });
});

describe('get-legs.usecase — 缺口与故障是两件事', () => {
  it('无锚 → 404 (回 200 空壳会让「没建锚」与「建了锚但没数据」不可区分)', async () => {
    const prisma = makePrisma({ anchor: { findUnique: vi.fn().mockResolvedValue(null) } });
    await expect(makeUseCase(prisma).execute(SYMBOL, 'all', NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('链数据未就绪 → chain_not_ready + 空腿, 锚派生的那半边照常返回', async () => {
    const prisma = makePrisma({ instrument: { findUnique: vi.fn().mockResolvedValue(null) } });
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);
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
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);
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
  const tableAt = async (
    session: string,
    now: Date,
    calendar: ReturnType<typeof tradingCalendar> = tradingCalendar(),
  ) => {
    const prisma = makePrisma({
      optionDailySnapshot: {
        findFirst: vi.fn().mockResolvedValue({ sessionDate: date(session) }),
        findMany: vi.fn().mockResolvedValue(snapshotsOf(LEGS, session)),
      },
    });
    return {
      res: toLegTableResponse(await makeUseCase(prisma, calendar).execute(SYMBOL, 'all', now)),
      calendar,
    };
  };

  it('🚨 境内早晨 (本地已翻页、市场当日已收盘) + 当日快照 ⇒ CURRENT, **不判陈旧**', async () => {
    const { res, calendar } = await tableAt('2026-08-04', NOW_CN_MORNING);
    expect(res.asOf).toBe('2026-08-04');
    expect(res.asOfFreshnessTier).toBe('CURRENT');
    // 基准按**市场 + 请求时刻**问端口, 收盘上界由端口内的纯函数按交易所时区求 (ET 08-04
    // 20:00 已过 16:00 ⇒ 08-04)。拿本地/UTC 今天当基准会是 08-05, 日历里 08-05 有行 ⇒
    // 上面那条立刻翻成 STALE。
    expect(calendar.lastClosedSession).toHaveBeenCalledWith('us', NOW_CN_MORNING);
  });

  it('快照停在上一个交易日 ⇒ STALE, 且**全表照常渲染** (陈旧不等于不可用)', async () => {
    const { res } = await tableAt('2026-08-03', NOW_CN_MORNING);
    expect(res.asOfFreshnessTier).toBe('STALE');
    expect(res.state).toBe('available');
    expect(res.legs).toHaveLength(LEGS.length);
  });

  it('基准不可判定 (日历缺行 / 上界落在覆盖声明之外) ⇒ fail-open 判 CURRENT (宁可漏报一次, 不重演「全体恒显已过时」)', async () => {
    // 062 T010 起端口把两种「基准不可信」合流成同一个 `null` —— 调用方的处置本就相同。
    const { res } = await tableAt('2026-08-03', NOW_CN_MORNING, tradingCalendar([]));
    expect(res.asOfFreshnessTier).toBe('CURRENT');
  });

  it('链未就绪 ⇒ asOf 为 null ⇒ UNAVAILABLE (不编造日期, 也不白查日历)', async () => {
    const prisma = makePrisma({ instrument: { findUnique: vi.fn().mockResolvedValue(null) } });
    const calendar = tradingCalendar();
    const res = toLegTableResponse(
      await makeUseCase(prisma, calendar).execute(SYMBOL, 'all', NOW_CN_MORNING),
    );
    expect(res.asOf).toBeNull();
    expect(res.asOfFreshnessTier).toBe('UNAVAILABLE');
    expect(calendar.lastClosedSession).not.toHaveBeenCalled();
  });
});

/**
 * T008 —— 打标接线 (FR-016 / FR-018, plan D-MARK-3)。
 *
 * 数据集蓄意让**两条建仓腿的 OI / 成交量全链最低**, 且它们与三条收租腿**分属两个到期日**。
 *
 * 🚨 **052 T009 起这份数据的判别性换了来源** (FR-023 分组维度: 候选集 → 到期日): 分组之后
 * 「同一条腿换个 Tab 换名次」只在**同一到期日的成员数跨 Tab 不同**时可见, 而本数据的两个到期日
 * 与两个意图 Tab 恰好一一对应 ⇒ 建仓腿在全腿 / 建仓两个 Tab 里归属相同, 这是分组语义的直接
 * 后果, **不是**排名基准退化。Guardrail 3 (「MUST NOT 把 `markActivity` 挪到筛选之后」) 改由
 * 本 describe 末尾那条「拿到名次的行数 == 本次视角成员数」守 —— 挪到筛选后被筛掉的腿会留下
 * `activity` 为 `null` 的成员, 那条立刻红。
 * 📌 「换候选集就换归属」这条 047 语义在 `leg-derive.rules.spec.ts` 有专门断言, 不在此重复。
 */
describe('get-legs.usecase — 打标零拦截 + 排名基准 = 该 Tab 召回全量 (FR-016/FR-018)', () => {
  const base = { greeksComplete: true, ask: undefined };
  // 建仓腿 (DTE 10, 有效成本 < spot 132.40); OI / Vol 全链最低 —— 但**仍在活跃标绝对线之上**
  // (052 FR-024): 线下的腿一个标都不发, 那样这份数据对「排名」这件事就没有任何分辨力了。
  const buildA: LegFixture = {
    code: 'M-BUILD-A',
    strike: '130',
    expiry: '2026-08-14',
    bid: '2.00',
    delta: '-0.45',
    openInterest: '120',
    volume: '5',
    ...base,
  };
  const buildB: LegFixture = {
    code: 'M-BUILD-B',
    strike: '129',
    expiry: '2026-08-14',
    bid: '1.50',
    delta: '-0.10',
    openInterest: '130',
    volume: '6',
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
  const tableWithBucket = (
    positionBucketManual: string | null,
    perspective: 'all' | 'build' | 'rent' = 'all',
  ) =>
    makeUseCase(
      makePrisma(
        {
          anchor: {
            findUnique: vi.fn().mockResolvedValue({ ...anchorRow, positionBucketManual }),
          },
        },
        MARK_LEGS,
      ),
    ).execute(SYMBOL, perspective, NOW);

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
    // 🚨 判据: 同一份输入, 打标的输入变了而**成员集合与序一行不动** —— 打标 MUST NOT 参与筛选。
    const membership = (view: typeof selected) => view.legs.map((l) => l.code);
    expect(membership(unselected)).toEqual(membership(selected));
    expect(unselected.gateCounts).toEqual(selected.gateCounts);
  });

  it('🚨 排名基准 = 该视角的召回全量: 全链最不活跃的两条腿在建仓视角里仍是 Top', async () => {
    const view = await tableWithBucket('gte_two_thirds', 'build');
    const leg = (code: string) => view.legs.find((l) => l.code === code)!;

    // 建仓视角只有两条成员 (< Top 3) ⇒ 两条都是 Top。它们的 OI / Vol 全链最低 ——
    // 排名基准若退回「全链」, 这两条一个标都拿不到。
    expect(view.legs.map((l) => l.code).sort()).toEqual(['M-BUILD-A', 'M-BUILD-B']);
    expect(leg('M-BUILD-A').activity?.isTopRanked).toBe(true);
    expect(leg('M-BUILD-B').activity?.isTopRanked).toBe(true);

    // 拿到名次的行数 == 成员数 (排名跑在成员集合上, 不多不少) —— 把 `markActivity` 挪到
    // 任何一道筛选之后, 被筛掉的腿会留下 `activity` 为 null 的成员而立刻红。
    for (const perspective of ['all', 'build', 'rent'] as const) {
      const view = await tableWithBucket('gte_two_thirds', perspective);
      const ranked = view.legs.filter((l) => l.activity !== null);
      expect([perspective, ranked.length]).toEqual([perspective, view.legs.length]);
      expect(view.legs.length).toBeGreaterThan(0);
    }
  });

  it('🚨 052 FR-023: 全腿 Tab 的标**逐到期日**发, 不是全堆在流动性最好的那个到期日', async () => {
    const view = await tableWithBucket('gte_two_thirds');
    const marked = view.legs.filter((l) => l.activity?.isTopRanked).map((l) => l.code);

    // 047 候选集口径下全腿 Tab 的 3 个标会被三条收租腿 (OI 900/800/700) 全占,
    // 两条 08-14 的建仓腿一个标没有 —— 抽掉分组维度这条立刻红。
    expect(marked).toContain('M-BUILD-A');
    expect(marked).toContain('M-BUILD-B');
    expect(marked.length).toBeGreaterThan(ACTIVITY_TOP_RANK_COUNT);
  });
});

/**
 * T012 —— 精排接线 + 视角级档位 (FR-021a / FR-023 / FR-024, plan D-RANK-3/D-API)。
 * 🚨 **053 T003 重排**: 047 的 `tabOrder` 已退役 —— `legs[]` **自己就是**那份有序列表
 * (053 FR-005: 同一个顺序下发两份表达必 drift, 而两份各自都渲染得出来)。
 *
 * 默认数据集在 050 判据下的归属与费率:
 *
 * | 腿    | DTE | 视角归属       | 周化   | 年化    |
 * | ----- | --- | -------------- | ------ | ------- |
 * | `C-C` | 17  | all + build    | 4.06%  | 211.5%  |
 * | `C-D` | 10  | all + build    | 1.09%  | 57.0%   |
 * | `C-A` | 164 | all + rent     | —      | 11.7%   |
 * | `C-B` | 164 | all + rent     | —      | 1.1%    |
 *
 * 🚨 这份数据的判别性在于 **精排序 (费率键) 与 047 的 legacy 档位载体序逐行不同** ——
 * 「`legs[]` 悄悄退回档位序」一旦发生, 下面那条断言立刻红。
 */
describe('get-legs.usecase — 单视角有序列表 + 视角级档位 (FR-021a/FR-023/FR-024, T012)', () => {
  it('每个视角按**该视角口径**的折算费率降序, 且 `legs[]` 自己就是那份序 (053 FR-005)', async () => {
    const orderOf = async (perspective: 'all' | 'build' | 'rent') =>
      (await makeUseCase(makePrisma()).execute(SYMBOL, perspective, NOW)).legs.map((l) => l.code);

    // 年化: C-C 211% > C-D 57% > C-A 11.7% > C-B 1.1%。
    // 🚨 **052 FR-020 起全腿视角实值沉底**: C-C 的行权价 145 **高于** spot 132.40 ⇒ 它那 211%
    // 年化绝大部分是内在价值 (公式退化产物), 从首位掉到末位。其余三条**逐条保持费率降序**
    // —— 这条断言的判别性就在这里: 若沉底键失效, 它会回到 `['C-C', ...]` 而立刻红。
    // 🚫 它**没有被移出** (FR-006 / SC-006): 四条腿一条不少, 只是序变了。
    expect(await orderOf('all')).toEqual(['C-D', 'C-A', 'C-B', 'C-C']);
    // 建仓视角走周化 —— 单调变换 ⇒ 与年化同序, 但成员只有两条 (且 2 < 分档降级阈值 ⇒ 纯费率降序)。
    expect(await orderOf('build')).toEqual(['C-C', 'C-D']);
    expect(await orderOf('rent')).toEqual(['C-A', 'C-B']);
  });

  it('🚨 `legs[]` 是**精排序**而非 047 的 legacy 档位载体序 (053 FR-005 的语义翻转)', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);

    // 判别性: 同一份数据在 legacy 键 (档位 → 到期日 → 行权价 → code) 下是 C-D · C-A · C-C · C-B
    // —— 与精排序**逐行不同**。有人把那个 `legs.sort()` 装回来, 这两条立刻红。
    expect(view.legs.map((l) => l.code)).toEqual(['C-D', 'C-A', 'C-B', 'C-C']);
    expect(view.legs.map((l) => l.code)).not.toEqual(['C-D', 'C-A', 'C-C', 'C-B']);
  });

  it('🚨 FR-023 / 053 FR-041: 档位跟**视角**走, 同一条腿两个视角判出不同档; 全腿视角恒年化', async () => {
    const legIn = async (perspective: 'all' | 'build' | 'rent', code: string) =>
      (await makeUseCase(makePrisma()).execute(SYMBOL, perspective, NOW)).legs.find(
        (l) => l.code === code,
      );

    // 同一条腿 C-D: 建仓视角按周化 1.09% ⇒ acceptable; 全腿视角按年化 57% ⇒ good。
    const buildLeg = await legIn('build', 'C-D');
    const allLeg = await legIn('all', 'C-D');
    expect(buildLeg?.tier).toBe('acceptable');
    expect(allLeg?.tier).toBe('good');
    // 🚨 全腿视角例外恒年化 —— 它混着 10 天与 164 天的腿, 拿周化档界判长腿会让整列全是死档。
    expect((await legIn('all', 'C-A'))?.tier).toBe('acceptable');
    expect((await legIn('rent', 'C-A'))?.tier).toBe('acceptable');
    // `basis` 与 `tier` 同源 —— 两处不同源就会 drift 且两边都有值。
    expect([buildLeg?.basis, buildLeg?.tier]).toEqual(['weekly', 'acceptable']);
    expect([allLeg?.basis, allLeg?.tier]).toEqual(['annualized', 'good']);
  });

  it('greeks 缺失的腿不判档不着色 (FR-007) —— 但照常在成员集里、照常参与排序', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'build', NOW);
    const gap = view.legs.find((l) => l.code === 'C-C');

    // 它**在**建仓召回集里 (050 下 Δ 退出召回), 但费率会骗人 ⇒ 不判档。
    expect(gap).toBeDefined();
    expect(gap?.tier).toBeNull();
    // 但它照常参与排序 —— 不判档不等于不排 (费率算得出来)。
    expect(view.legs[0].code).toBe('C-C');
  });

  it('链未就绪 → 列表是空数组 (不是 undefined, 客户端不必特判)', async () => {
    const prisma = makePrisma({ instrument: { findUnique: vi.fn().mockResolvedValue(null) } });
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);

    expect(view.state).toBe('chain_not_ready');
    expect(view.legs).toEqual([]);
  });

  it('🚨 SC-006: 同一输入连续两次调用, 有序列表逐行相同', async () => {
    const useCase = makeUseCase(makePrisma());
    const first = await useCase.execute(SYMBOL, 'all', NOW);
    const second = await useCase.execute(SYMBOL, 'all', NOW);

    expect(second.legs.map((l) => l.code)).toEqual(first.legs.map((l) => l.code));
  });
});

/**
 * T014 —— 契约增量过 wire (`FR-027` / `FR-019b`, plan D-API)。
 *
 * 🚨 **本 describe 的判据全在 `toLegTableResponse` 之后**: 上面几个 describe 断的是 view (use
 * case 的返回值), 而客户端拿到的是 DTO 映射后的对象 —— 少接一个字段, view 层的断言**一条都不
 * 会红**。这层是那个缺口的唯一防线。
 */
describe('optionsdesk.dto — 六个新字段过 wire (FR-027/FR-019b, T014)', () => {
  const responseOf = async (
    legs: LegFixture[] = LEGS,
    overrides: Record<string, unknown> = {},
    perspective: 'all' | 'build' | 'rent' = 'all',
  ) =>
    toLegTableResponse(
      await makeUseCase(makePrisma(overrides, legs)).execute(SYMBOL, perspective, NOW),
    );

  /**
   * 🚨 **053 T003 的核心断言** (`FR-002` / `FR-005` / `SC-002`): 收窄后的契约里 by-tab 结构
   * **一个都不许剩**。判据取「键名整表扫」而不是逐个 `toBeUndefined()` —— 后者要求先想到那个
   * 键叫什么, 而**漏想到的那个正是会留下来的那个**。
   */
  it('🚨 SC-002: 顶层与每腿的 by-tab 结构残留为零 (契约侧那一半)', async () => {
    const res = await responseOf();

    const byTabish = (obj: object) =>
      Object.keys(obj).filter((k) => /ByTab$|^tabOrder$|^tabs$/.test(k));
    expect(byTabish(res)).toEqual([]);
    for (const leg of res.legs) expect([leg.code, byTabish(leg)]).toEqual([leg.code, []]);
  });

  it('🚨 legs[] 就是有序列表本身 (tabOrder 已退役) —— 客户端 MUST 按下标序呈现', async () => {
    // 052 FR-020: 全腿视角实值沉底 (C-C 的 K=145 > spot 132.40) —— 见上方排序那条断言。
    const order = async (perspective: 'all' | 'build' | 'rent') =>
      (await responseOf(LEGS, {}, perspective)).legs.map((l) => l.code);
    expect(await order('all')).toEqual(['C-D', 'C-A', 'C-B', 'C-C']);
    expect(await order('build')).toEqual(['C-C', 'C-D']);
    expect(await order('rent')).toEqual(['C-A', 'C-B']);
  });

  it('🚨 `perspective` 原样回显 —— 迟到的响应靠它认领 (FR-005 / FR-008)', async () => {
    for (const perspective of ['all', 'build', 'rent'] as const) {
      expect((await responseOf(LEGS, {}, perspective)).perspective).toBe(perspective);
    }
  });

  it('🚨 四个计数字段过 wire: matchedCount / memberCount / displayLimit / K 触及数', async () => {
    const res = await responseOf();

    // 未覆盖任何条件 ⇒ 两个数相等 (FR-009); 四条腿一条不少 ⇒ 未触发截断。
    expect([res.matchedCount, res.memberCount]).toEqual([4, 4]);
    expect(res.legs).toHaveLength(4);
    // 🚨 **未触发截断时 `displayLimit` 也照常下发** (FR-015): 只在截断时下发会让「链规模逼近
    // 阈值」恰恰观测不到, 而那正是本字段要防的静默。
    expect(res.displayLimit).toBe(DISPLAY_LIMIT_BY_PERSPECTIVE.all);
    expect(res.candidateCapDropped).toBe(0);
  });

  it('🚫 Guardrail 11: 实际显示条数与「其余 N−D」MUST NOT 下发 (两者都可现算)', async () => {
    const res = await responseOf();

    const keys = Object.keys(res);
    expect(keys).not.toContain('displayedCount');
    expect(keys).not.toContain('remainingCount');
    // 现算路径存在且自洽 —— 断言的是「够用」, 与上面「不下发」合起来才成立。
    expect(res.matchedCount - res.legs.length).toBe(0);
  });

  it('🚨 顶层 gateCounts 两个数各自过 wire —— 不合并成总数, 不串台', async () => {
    // 一分钱腿 (bid 0.05 < 门槛) 整条移出; 宽价差腿 (3.00/9.00) 只出意图视角、全腿仍可达。
    const penny: LegFixture = { ...LEGS[3], code: 'W-PENNY', bid: '0.05', ask: '0.15' };
    const wide: LegFixture = { ...LEGS[3], code: 'W-WIDE', bid: '3.00', ask: '9.00' };
    const res = await responseOf([LEGS[3], penny, wide], {}, 'build');

    // 两个数不等 ⇒ 「把两个字段接反」会红 (相等的话接反照样绿)。
    // 053 FR-005: 分视角那份已收窄掉 —— 一次只判一个视角, 标量就是「建仓自己的排除数」。
    expect(res.gateCounts).toEqual({ removedByPremiumFloor: 1, excludedFromIntentTabs: 1 });
    // 语义不对称的机械体现: 被权利金挡下的那条**哪个视角都没有**, 被价差挡下的只是不在
    // 意图视角里 —— 切到全腿视角照样查得到 (SC-012)。
    expect(res.legs.map((l) => l.code)).toEqual(['C-D']);
    const inAll = await responseOf([LEGS[3], penny, wide], {}, 'all');
    expect(inAll.legs.map((l) => l.code).sort()).toEqual(['C-D', 'W-WIDE']);
    // 全腿视角不受流动性门槛约束 ⇒ 它那份恒 0 (标量在这里不再是「两个意图的合计」)。
    expect(inAll.gateCounts.excludedFromIntentTabs).toBe(0);
  });

  it('顶层 basis 标量下发本次视角的口径 —— 客户端不必硬编码 FR-023 的映射', async () => {
    const res = await responseOf();

    // 它与每腿的 `tier` 必须是同一套口径: 建仓走周化档界, 全腿视角例外恒年化。
    const inBuild = await responseOf(LEGS, {}, 'build');
    const buildLeg = inBuild.legs.find((l) => l.code === 'C-D');
    const allLeg = res.legs.find((l) => l.code === 'C-D');
    expect([inBuild.basis, buildLeg?.tier]).toEqual(['weekly', 'acceptable']);
    expect([res.basis, allLeg?.tier]).toEqual(['annualized', 'good']);
    expect((await responseOf(LEGS, {}, 'rent')).basis).toBe('annualized');
  });

  it('每腿 isRecommended / isMonthlyChain / tier / activity 逐条过 wire', async () => {
    const res = await responseOf();

    // 收租 · 深度 ⇒ 只有 |Δ| 0.05 落 deep 带 [0.05,0.15] 的 C-B 带标 (恒 false 会红)。
    expect(res.legs.filter((l) => l.isRecommended).map((l) => l.code)).toEqual(['C-B']);
    // 月度链: 2026-08-21 与 2027-01-15 由 vendor 标 `MONTH`; 2026-08-14 (C-D) 标 `WEEK`。
    expect(
      res.legs
        .filter((l) => l.isMonthlyChain)
        .map((l) => l.code)
        .sort(),
    ).toEqual(['C-A', 'C-B', 'C-C']);
    expect(res.legs.find((l) => l.code === 'C-A')?.tier).toBe('acceptable');
    // 活跃标收窄成单份且**真的算过** —— 映射时忘接会留下 null 而这条立刻红。
    expect(res.legs.find((l) => l.code === 'C-A')?.activity?.isRoundStrike).toBe(true);
  });

  /**
   * 053 T004 —— 两个新派生列过 wire (`FR-032`, plan D-COL-1)。
   *
   * 🚨 **两者都在服务端算一次并下发**, 客户端零计算 (ADR-0064 不变量 ③): 合约乘数是市场规则,
   * `relativeSpread` 更是**召回层挡腿用的那同一个数** —— 各算一份的话「这条腿为什么被挡了」
   * 在屏幕上再也对不上账, 而两个数都显示得出来。
   */
  it('🚨 FR-032: 单笔权利金 = bid × 合约乘数, 相对价差复用召回层那一份, 两者定标下发', async () => {
    const res = await responseOf();
    const leg = (code: string) => res.legs.find((l) => l.code === code);

    // C-A: bid 6.00 ⇒ 单笔权利金 600.00 (金额定标 2 位, 同 turnover)。
    expect(leg('C-A')?.contractPremium).toBe('600.00');
    // C-B: bid 0.50 ⇒ 50.00。两条不等 ⇒ 「接成常量 / 接错行」都会红。
    expect(leg('C-B')?.contractPremium).toBe('50.00');
    // 🚨 判别性: 它 **MUST NOT** 等于 bid 本身 —— 忘了乘那一下是最容易发生的失败形态,
    // 而屏幕上那一列照样有数、照样是个合理的价格。
    expect(leg('C-A')?.contractPremium).not.toBe(leg('C-A')?.bid);

    // 相对价差是**无量纲比例**, 定标 4 位 (与 criteria 里的 relativeSpreadMax 同口径, 两处要能直接比)。
    // C-A: bid 6.00 / ask 6.10 (fixture 默认 +0.10) ⇒ mid 6.05 ⇒ 0.10 / 6.05 = 0.016528…
    expect(leg('C-A')?.relativeSpread).toBe('0.0165');
    // C-B: bid 0.50 / ask 0.60 ⇒ mid 0.55 ⇒ 0.10 / 0.55 = 0.181818…。两条不等 ⇒ 「接成常量」会红。
    expect(leg('C-B')?.relativeSpread).toBe('0.1818');
  });

  it('🚨 FR-032: 有 ask 时相对价差 = (ask − bid) / mid, 与召回层挡腿用的是同一个数', async () => {
    // bid 3.00 / ask 9.00 ⇒ mid 6.00 ⇒ (9 − 3) / 6 = 1.0000, 远超流动性阈值 0.35。
    const wide: LegFixture = { ...LEGS[3], code: 'W-WIDE', bid: '3.00', ask: '9.00' };
    const inAll = await responseOf([LEGS[3], wide], {}, 'all');
    expect(inAll.legs.find((l) => l.code === 'W-WIDE')?.relativeSpread).toBe('1.0000');

    // 🚨 同源判别性: 上屏的这个数正是把它挡出意图视角的那个数 —— 两者若各算一份, 下面这条
    // 「屏上 > 阈值 且 它确实被挡了」的对账就不再成立, 而两个数各自都出得来。
    const inBuild = await responseOf([LEGS[3], wide], {}, 'build');
    expect(inBuild.legs.map((l) => l.code)).not.toContain('W-WIDE');
    expect(inBuild.gateCounts.excludedFromIntentTabs).toBe(1);
  });

  it('🚫 FR-019b: 特征集 MUST NOT 下发 —— 顶层与每腿都零 feature 字段', async () => {
    const res = await responseOf();

    const featureish = (obj: object) => Object.keys(obj).filter((k) => /feature/i.test(k));
    expect(featureish(res)).toEqual([]);
    for (const leg of res.legs) expect([leg.code, featureish(leg)]).toEqual([leg.code, []]);
  });

  it('链未就绪的空壳也带齐新顶层字段 (客户端不必为空态特判 undefined)', async () => {
    const res = await responseOf(LEGS, {
      instrument: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    expect(res.state).toBe('chain_not_ready');
    expect(res.legs).toEqual([]);
    expect(res.gateCounts).toEqual({ removedByPremiumFloor: 0, excludedFromIntentTabs: 0 });
    // 口径常量与有没有链无关 —— 空态下照常回显本次视角那一档。
    expect(res.basis).toBe('annualized');
    expect(res.perspective).toBe('all');
    // 🚨 阈值**与链无关**, 空态照样如实回显 (FR-015): 它是该视角的配置而不是本次的结果 ——
    // 空态给 null 会让客户端把「不设阈值」与「没链」读成同一件事。
    expect(res.displayLimit).toBe(DISPLAY_LIMIT_BY_PERSPECTIVE.all);
    expect([res.matchedCount, res.memberCount, res.candidateCapDropped]).toEqual([0, 0, 0]);
  });
});

/**
 * T010 —— 检索条件的系统默认值下发 + 用户覆盖 (052 `FR-011`–`FR-016` / `FR-029`, plan D-CRIT-1)。
 *
 * 🚨 本组守的是**接线**: 默认值由召回层从链自身解出 (成色上界要行权价网格、权利金下限要 spot),
 * use case 只负责把 `override` 递下去、把条件全景端上来。判据本身的边界在
 * `leg-recall.rules.spec.ts` 逐维度验，不在这里重复。
 */
describe('get-legs.usecase — 检索条件下发与覆盖 (052 T010)', () => {
  it('🚨 053 FR-005: 只下发**本次视角**那一份条件全景 (恒发三份的前提已被 FR-019b 作废)', async () => {
    for (const perspective of ['all', 'build', 'rent'] as const) {
      const view = await makeUseCase(makePrisma()).execute(SYMBOL, perspective, NOW);
      expect(view.criteria.defaults).toBeDefined();
      // 未覆盖 ⇒ effective 逐字等于 defaults, 六维三态全 default。
      expect(view.criteria.effective).toEqual(view.criteria.defaults);
      for (const key of RETRIEVAL_CRITERION_KEYS) {
        expect([perspective, key, view.criteria.outcomes[key]]).toEqual([
          perspective,
          key,
          { state: 'default', excludedCount: 0 },
        ]);
      }
    }
    // 判别性: 三视角的默认值本就不同 —— 若下发的不是请求的那一份, 下面两条会互换而红。
    // 依赖 spot 的两项确实解出来了 (FR-011: 客户端拿不到这两个数)。
    const all = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);
    const rent = await makeUseCase(makePrisma()).execute(SYMBOL, 'rent', NOW);
    expect(all.criteria.defaults.premiumMin).not.toBeNull();
    expect(all.criteria.defaults.strikeMax).toBeNull();
    expect(rent.criteria.defaults.strikeMax).not.toBeNull();
  });

  it('🚨 链未就绪 ⇒ 六维全 null, MUST NOT 猜一个默认值 (spec Edge Case「spot 缺失」)', async () => {
    const prisma = makePrisma({ instrument: { findUnique: vi.fn().mockResolvedValue(null) } });
    const view = await makeUseCase(prisma).execute(SYMBOL, 'all', NOW);
    expect(view.state).toBe('chain_not_ready');
    for (const key of RETRIEVAL_CRITERION_KEYS) {
      expect(view.criteria.defaults[key]).toBeNull();
    }
  });

  it('用户覆盖只作用于请求的那个视角, 且计数只出在被收窄的维度上 (FR-029)', async () => {
    const plain = await makeUseCase(makePrisma()).execute(SYMBOL, 'rent', NOW);
    // 收租段 `[30,365]` → `[1,50]`: 上界收窄踢掉 C-A / C-B (DTE 164), 下界放宽放进 C-D (DTE 10)
    // ⇒ 成员**有进有出**, 而三态照样唯一 (判据是「是否产生排除」, 见 `CriterionState`)。
    const narrowed = await makeUseCase(makePrisma()).execute(SYMBOL, 'rent', NOW, {
      perspective: 'rent',
      criteria: { dteBand: { min: 1, max: 50 } },
    });

    expect(plain.legs.map((l) => l.code)).toEqual(['C-A', 'C-B']);
    expect(narrowed.legs.map((l) => l.code)).toEqual(['C-D']);
    expect(narrowed.criteria.outcomes.dteBand).toEqual({ state: 'narrowed', excludedCount: 2 });
    // 🚫 未被动过的维度不出计数 —— 默认值本身就摆在控件里, 第二次告知是噪音。
    expect(narrowed.criteria.outcomes.strikeMax.state).toBe('default');
    // 🚨 覆盖只作用一个视角 (052 FR-015): 同一发覆盖打到建仓视角上时它照常走自己的默认段 ——
    // 覆盖没有渗过去。053 起「另两个视角」由**另外两次请求**各自作答, 不再挤在一份响应里。
    const otherPerspective = await makeUseCase(makePrisma()).execute(SYMBOL, 'build', NOW, {
      perspective: 'rent',
      criteria: { dteBand: { min: 1, max: 50 } },
    });
    expect(otherPerspective.criteria.outcomes.dteBand.state).toBe('default');
    expect(otherPerspective.criteria.defaults.dteBand).toEqual({ min: 1, max: 49 });
  });

  it('🚨 FR-026: 放宽条件使候选集变大 ⇒ 活跃标与排序按新候选集重算 (定义如此)', async () => {
    const plain = await makeUseCase(makePrisma()).execute(SYMBOL, 'build', NOW);
    // 建仓段放宽到含 DTE 164 ⇒ 两条收租长腿也进建仓候选 (有效成本 120−6 / 100−0.5 均 < spot)。
    const widened = await makeUseCase(makePrisma()).execute(SYMBOL, 'build', NOW, {
      perspective: 'build',
      criteria: { dteBand: { min: 1, max: 365 } },
    });
    expect(widened.legs.length).toBeGreaterThan(plain.legs.length);
    expect(widened.criteria.outcomes.dteBand).toEqual({ state: 'widened', excludedCount: 0 });
    // 排名基准 = 当前条件下的召回集 ⇒ 活跃标的分母跟着变: 原本进建仓的腿在更大的候选集里重排。
    const legOf = (v: typeof plain, code: string) => v.legs.find((l) => l.code === code)!;
    expect(legOf(plain, 'C-D').activity).not.toBeNull();
    expect(legOf(widened, 'C-D').activity).not.toBeNull();
  });
});

/**
 * T011 —— 契约层：查询串 → 覆盖，以及三组字段的下发 (052 `FR-011` / `FR-029`, plan §V)。
 */
describe('optionsdesk.dto — 检索条件的请求与响应契约 (052 T011)', () => {
  it('无任何条件参数 ⇒ null (首屏 / 「复位」走的就是这条路径)', () => {
    // 🚨 053 起 `perspective` 必填 ⇒ 「只给视角不给条件」就是首屏那一发, 它 MUST NOT 被记成
    // 一次全维度覆盖 (否则每次切视角都会显示一排「当前条件之外还有 N 条」)。
    expect(toRetrievalOverride({ perspective: 'rent' })).toBeNull();
    expect(toRetrievalOverride({ perspective: 'all' })).toBeNull();
  });

  it('🚨 053 FR-001: `perspective` 决定作答视角, 取值原样透出 (MUST NOT 在这里再判一次三值)', () => {
    for (const perspective of ['all', 'build', 'rent'] as const) {
      expect(toRequestedPerspective({ perspective })).toBe(perspective);
    }
  });

  it('🚨 缺键 = 未覆盖, 空串 = 覆盖为「不限」—— 两者三态不同', () => {
    expect(toRetrievalOverride({ perspective: 'rent', strikeMax: '' })?.criteria).toEqual({
      strikeMax: null,
    });
    expect(
      toRetrievalOverride({ perspective: 'rent', strikeMax: '138' })?.criteria.strikeMax,
    ).toBeInstanceOf(Prisma.Decimal);
    expect(
      'strikeMax' in (toRetrievalOverride({ perspective: 'rent', strikeMin: '' })?.criteria ?? {}),
    ).toBe(false);
  });

  it('🚨 `0` MUST NOT 被真值判断吞成「没动过」—— 它是一个合法的下限值', () => {
    const override = toRetrievalOverride({ perspective: 'rent', oiMin: '0', volMin: '0' });
    expect(override?.criteria.livenessMin).toEqual({ oi: 0, volume: 0 });
  });

  it('🚨 活性两个值 MUST 成对 —— 只给一端即 400 (一个维度、一对数，同 DTE 段)', () => {
    expect(() => toRetrievalOverride({ perspective: 'rent', oiMin: '50' })).toThrow(
      BadRequestException,
    );
    expect(() => toRetrievalOverride({ perspective: 'rent', volMin: '50' })).toThrow(
      BadRequestException,
    );
    expect(
      toRetrievalOverride({ perspective: 'rent', oiMin: '50', volMin: '5' })?.criteria.livenessMin,
    ).toEqual({ oi: 50, volume: 5 });
  });

  it('🚨 DTE 段两端 MUST 成对 —— 只给一端即 400 (半个区间不是合法维度值)', () => {
    expect(() => toRetrievalOverride({ perspective: 'rent', dteMin: '30' })).toThrow(
      BadRequestException,
    );
    expect(() => toRetrievalOverride({ perspective: 'rent', dteMax: '365' })).toThrow(
      BadRequestException,
    );
    expect(
      toRetrievalOverride({ perspective: 'rent', dteMin: '30', dteMax: '365' })?.criteria.dteBand,
    ).toEqual({ min: 30, max: 365 });
    // 两端都空 ⇒ 覆盖为不限。
    expect(
      toRetrievalOverride({ perspective: 'rent', dteMin: '', dteMax: '' })?.criteria.dteBand,
    ).toBeNull();
  });

  it('🚨 三组字段**逐维度**下发, 六项一个不少 (T011 的验收口径是穷举不是泛指)', async () => {
    const responseFor = async (perspective: 'all' | 'build' | 'rent') =>
      toLegTableResponse(await makeUseCase(makePrisma()).execute(SYMBOL, perspective, NOW));
    for (const perspective of ['all', 'build', 'rent'] as const) {
      const panel = (await responseFor(perspective)).criteria;
      for (const key of RETRIEVAL_CRITERION_KEYS) {
        expect(panel.defaults).toHaveProperty(key);
        expect(panel.effective).toHaveProperty(key);
        expect([perspective, key, panel.outcomes[key]]).toEqual([
          perspective,
          key,
          { state: 'default', excludedCount: 0 },
        ]);
      }
    }
    // Decimal 一律定标 string (与 spot / w 同口径); 计数量纲是 number。
    const rent = (await responseFor('rent')).criteria.defaults;
    const all = (await responseFor('all')).criteria.defaults;
    expect(typeof rent.strikeMax).toBe('string');
    expect(rent.dteBand).toEqual({ min: 30, max: 365 });
    expect(all.dteBand).toBeNull();
    expect(all.relativeSpreadMax).toBeNull();
  });
});

/**
 * 053 T002 —— 表达层截断 + 三个计数 (FR-004 / FR-009 – FR-012 / FR-015 / FR-019c,
 * plan D-ORDER-1 / D-LIMIT-1)。
 *
 * 🚨 **截断分支靠注入小阈值走遍, 而不是造几百条腿** (SC-006 / Guardrail 7): 合成 fixture 测
 * 出来的是「slice 能不能跑」, 注入小阈值测的是「真实链上截断截的是不是排序尾部」。
 */
describe('get-legs.usecase — 表达层截断与三个计数 (053 T002)', () => {
  it('未触发截断: 全部腿在表内, 且 `displayLimit` 与 `matchedCount` **照常下发** (FR-015)', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);
    expect(view.legs).toHaveLength(LEGS.length);
    expect(view.matchedCount).toBe(LEGS.length);
    // 🚨 只在截断时下发阈值会让「链规模逼近阈值」恰恰观测不到 —— 而那正是 FR-015 要防的静默。
    expect(view.displayLimit).toBe(DISPLAY_LIMIT_BY_PERSPECTIVE.all);
    // K 的触及是**保险丝熔断**不是判据挡下 ⇒ 它既不进 gateCounts 也不是第四条常规计数。
    expect(view.candidateCapDropped).toBe(0);
  });

  it('🚨 注入小阈值 → 截到阈值, 且截掉的是**排序尾部** (前 D 条逐条相同, Guardrail 8)', async () => {
    const full = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW);
    const cut = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW, null, 2);

    expect(full.legs).toHaveLength(4);
    expect(cut.legs).toHaveLength(2);
    // 判别性在这一行: 条数对是任何一种截法都满足的, 「前 2 条逐条相同」才排除得掉「从中间
    // 截 / 按别的键重排后再截」。053 起 `legs[]` 自己就是那份有序列表 ⇒ 直接逐行比。
    const codes = (v: typeof full) => v.legs.map((l) => l.code);
    expect(codes(cut)).toEqual(codes(full).slice(0, 2));
    expect(cut.displayLimit).toBe(2);
    // `matchedCount` 取**截断前**的条数 ⇒ 「其余 N−D 条未显示」算得出来 (D 与它的差都不下发)。
    expect(cut.matchedCount).toBe(full.matchedCount);
  });

  it('恰等于阈值不截, 严格大于才截 (Edge Case: 恰等于时「其余 0 条未显示」不该出现)', async () => {
    const equal = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW, null, 4);
    expect(equal.legs).toHaveLength(4);
    expect(equal.matchedCount).toBe(4);

    const over = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW, null, 3);
    expect(over.legs).toHaveLength(3);
    expect(over.matchedCount).toBe(4);
  });

  it('注入 `null` (不设该视角阈值) → 零截断, 阈值原样回显 (FR-013 的显式登记形态)', async () => {
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'all', NOW, null, null);
    expect(view.legs).toHaveLength(LEGS.length);
    expect(view.displayLimit).toBeNull();
  });

  it('📌 未覆盖任何条件 → `memberCount === matchedCount` (三视角逐个, FR-009)', async () => {
    for (const perspective of ['all', 'build', 'rent'] as const) {
      const view = await makeUseCase(makePrisma()).execute(SYMBOL, perspective, NOW);
      expect([perspective, view.memberCount]).toEqual([perspective, view.matchedCount]);
      expect([perspective, view.matchedCount]).toEqual([perspective, view.legs.length]);
    }
  });

  it('🚨 收窄后 `memberCount > matchedCount`, 且它**不是**边际计数加总 (Guardrail 12)', async () => {
    // 收租段 `[30,365]` → `[1,50]`: 上界收窄踢掉 C-A / C-B, 下界放宽放进 C-D ⇒ 有进有出。
    const view = await makeUseCase(makePrisma()).execute(SYMBOL, 'rent', NOW, {
      perspective: 'rent',
      criteria: { dteBand: { min: 1, max: 50 } },
    });

    expect(view.matchedCount).toBe(1);
    // 🚨 判别性: 边际口径的加总在这里给出 `1 + 2 = 3`, 而无覆盖口径的真值是 **2** ——
    // 放宽那一端放进来的 C-D 本来就不在默认候选集里。两个数都出得来、都不会红。
    expect(view.criteria.outcomes.dteBand.excludedCount).toBe(2);
    expect(view.memberCount).toBe(2);
    expect(view.memberCount).toBeGreaterThan(view.matchedCount);
  });

  it('🚨 `memberCount` 零额外 DB 往返 —— 检索只调 1 次, 三张表各查 1 次 (Guardrail 13)', async () => {
    const prisma = makePrisma();
    const service = prisma as unknown as PrismaService;
    const adapter = new PrismaLegRetrievalAdapter(service);
    const retrieveSpy = vi.spyOn(adapter, 'retrieveCandidates');

    // 🚨 **必须带覆盖** —— 无覆盖时实现直接短路, 「只查一次」是平凡真; 只有第二趟判定真的
    // 跑起来, 这条断言才在守「第二次判定用的是同一批已在内存的行」。
    const view = await new GetLegsUseCase(service, adapter, tradingCalendar()).execute(
      SYMBOL,
      'rent',
      NOW,
      {
        perspective: 'rent',
        criteria: { dteBand: { min: 1, max: 50 } },
      },
    );

    expect(view.memberCount).toBeGreaterThan(view.matchedCount);
    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    expect(prisma.optionContract.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.optionDailySnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.optionDailySnapshot.findFirst).toHaveBeenCalledTimes(1);
  });
});
