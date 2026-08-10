import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { daysToExpiry, marketDateFor } from '../marketdata/trading-day-gate';
import { resolveEffectiveAnchorValues } from './anchor-cascade';
import {
  classifyZone,
  computeW,
  parseAnchorTicker,
  type AnchorZone,
  type LLevel,
} from './anchor.rules';
import {
  earningsCalendarContext,
  earningsMarksByExpiry,
  type EarningsMarkVerdict,
} from './earnings-mark.rules';
import { ANCHOR_NOT_FOUND_FOR_SYMBOL } from './get-underlying-detail.usecase';
import { resolveLastClosedSessionForTicker } from './last-closed-session';
import {
  classifyIntent,
  resolvePositionBucket,
  type LegIntent,
  type PositionBucket,
  type PositionBucketSource,
  type RentDepth,
} from './intent-matrix.rules';
import {
  computeEffectiveCost,
  computeEffectiveCostVsWPct,
  computeLegRates,
  computeTurnover,
  deriveDeltaColumns,
  markActivity,
  type ActivityMark,
} from './leg-derive.rules';
import { classifyLegTier, type LegBasis, type LegTier } from './leg-tier.rules';
import {
  LEG_TABS,
  earningsLegFamilyFor,
  isBuildLeg,
  legTabs,
  type LegTab,
  type LegTabContext,
} from './leg-tab.rules';

/**
 * 047 US2/US3/US4 — 意图 Tab 选约表读端 (FR-002/003/005/008/013/019/041/053/054,
 * plan D-API-1 / D-API-2 / D-ARCH-1)。范式 = ADR-0043 扁平 + 贫血: 文件平铺、数据是裸 Prisma
 * row、直注 `PrismaService` 无 repository、不变量全在四个 `*.rules.ts` 纯函数里。
 *
 * 🚨 **一次返全量适格腿, 零分页零 top-N 截断** (FR-005): 三个 Tab 是**同一份派生结果**的三种
 * 视图 ⇒ 分三次请求会让三个 Tab 的 `asOf` 与档位口径可能不一致。客户端按每腿的 `tabs` 过滤,
 * MUST NOT 自己重算成员判据 (判据单点在 `leg-tab.rules.ts`)。
 *
 * 🚨 **Guardrail 7 —— 这里是 `>` 而 T021 完整性分母是 `≥`, 两处判据故意不同**: 本端点滤的是
 * 「已到期腿不可交易」(到期日 **>** 当日), 完整性分母认的是「当日到期的合约当日仍可取快照」
 * (到期日 **≥** 当日)。统一成一个必坏一头, 且只在到期日当天才看得出来。
 *
 * 🚨 **两个时点不是同一天** (Guardrail 6 / FR-013): 报价列的时点是 `quote_as_of`, **OI 列的
 * 时点是 `oi_as_of`** —— 美股期权 OI 在盘前更新 ⇒ 收盘后采的快照, 其 OI 归属 T−1 日。
 * ⇒ 响应把两个时点分开下发, 呈现侧 OI 列 MUST 用 `oiAsOf`。
 *
 * 🚨 **跨 ctx 只读直查** (D-ARCH-1 / catalog Q7-B): 三张 marketdata 表 (`option_contract` /
 * `option_daily_snapshot` / `earnings_event`) 全部走 `PrismaService` 直查 + `CROSS-CONTEXT-READ`
 * 注释 (`check-server-moat.ts` 机器强制), **零 `@Inject()` marketdata 的 use case** (Q7-C),
 * 跨 ctx 写永远禁。**MUST NOT import `marketdata/*.rules.ts`** (Guardrail 14, ESLint disallow):
 * spot 直接取快照行里 vendor 给的标的价, **不走复权换算**。
 *
 * 🚨 **派生一律请求时算** (FR-041): W / 四区间 / L 层 / 愿卖锚**复用 045 `anchor.rules.ts`**,
 * 本文件一个区间系数都不算 (Guardrail 13); 费率 / σ 距 / 活跃度 / 成交额走 047 三个纯函数。
 * DTE 走 `marketdata/trading-day-gate.ts` 的 `daysToExpiry` —— 基准恒为**交易所的今天**。
 *
 * 🚨 **一处有意的口径错配, 禁「修」**: 价格来自**上一场 session** 的 EOD 快照, DTE 从**当前**
 * ET 日期起算。决策是前瞻的, 改成快照日基准会系统性多算一天; 代价是同屏必须有显式 `asOf`。
 *
 * 复杂度: 三次跨 ctx 查询 (合约集 / 最近一期快照 / 该票财报日) + 单票 `O(n log n)`
 * (n = 该票当日快照行数, 实测上界 730; `n log n` 项 = 排序与三个 Tab 各一次活跃度排名),
 * 财报分组打标 `O(k log E)` (k = 不同到期日数)。
 */

/** 选约表区块状态 (FR-013: 缺口显式化, 与「有数据但是空的」不可混为一谈)。 */
export const LEG_TABLE_STATES = [
  /** 拿到了当日 (或最近一期) 全链快照。 */
  'available',
  /**
   * 链数据未就绪 —— 该标的还没进 `Instrument` / 还没采到合约或快照 / 快照缺标的价。
   * 与 `read_failed` **蓄意分开**: 前者是事实 (采集还没轮到), 后者是故障。
   */
  'chain_not_ready',
  /** 跨 ctx 读失败降级 —— 锚派生的那半边照常返回 (照抄 046 的降级纪律)。 */
  'read_failed',
] as const;

export type LegTableState = (typeof LEG_TABLE_STATES)[number];

/** 单腿投影 —— 全部为**裸值**, 呈现文案 (「挂 OCO」/「死档剔除」等) 归客户端。 */
export interface LegView {
  /** vendor 合约代码 (行身份)。 */
  code: string;
  strike: Prisma.Decimal;
  /** 到期日 (`@db.Date` 读出的 UTC 午夜)。 */
  expiryDate: Date;
  /** 请求时 DTE (整数日历日, 到期日当天 = 0; 本端点只返 > 0 的腿)。 */
  dteDays: number;

  bid: Prisma.Decimal | null;
  ask: Prisma.Decimal | null;
  /**
   * 买 / 卖盘挂牌量 (`@db.Decimal(20,0)` 的整数计数, 同 OI / Vol 走 `number` 而非 string
   * —— 它们是**张数不是金额**, 没有精度可丢)。
   *
   * 🚫 **MUST NOT 参与任何判定**: 档位恒由 `bid` 价定 (FR-018), 挂牌量只作同屏参照 ——
   * 与 `askRate` 同类。呈现侧也 MUST NOT 给它上档位色, 否则会被读成「量也参与判档」。
   */
  bidSize: number | null;
  askSize: number | null;
  /** 本行口径 (FR-019: 全腿 Tab 内每行显式标注其腿族口径)。 */
  basis: LegBasis;
  /** 期间 / 周化 / 年化费率 (分母恒为准备金 `K − P`); 无 bid 或 `K − P ≤ 0` → 全 `null`。 */
  periodRate: Prisma.Decimal | null;
  weeklyRate: Prisma.Decimal | null;
  annualizedRate: Prisma.Decimal | null;
  /**
   * 四档; **greeks 缺失行恒 `null`** (FR-007: 不判档不着色) —— 它们的费率算得出来但会骗人
   * (99.5% 是深实值腿, 折年可达 307%)。无 bid 亦 `null` (没有判定值就没有档)。
   */
  tier: LegTier | null;
  /** 薄档带出的 `ask` 口径费率 (D-SOT-2); 其余档恒 `null`, **不参与判定**。 */
  askRate: Prisma.Decimal | null;

  effectiveCost: Prisma.Decimal | null;
  /** 有效成本相对 W 的位置, **百分数** (费率是小数比例 —— 两者故意不同量纲, 别统一)。 */
  effectiveCostVsWPct: Prisma.Decimal | null;
  /** `|Δ|` 真值与 σ 距 —— 同源派生, 要么同时有值要么同时为空 (Guardrail 10)。 */
  absDelta: number | null;
  sigmaDistance: number | null;

  openInterest: number | null;
  volume: number | null;
  turnover: Prisma.Decimal | null;
  /** 三个 Tab **各一套**活跃度标记 (排名是候选集内的相对量, 换 Tab 归属就变, D-SOT-5)。 */
  activityByTab: Readonly<Record<LegTab, ActivityMark | null>>;

  /** 本腿在哪几个 Tab 里 (客户端据此过滤, 判据单点在 `leg-tab.rules.ts`)。 */
  tabs: readonly LegTab[];
  /** 财报标; 建仓域恒 `null` (与「无日期」是两个值)。同一到期日的腿共用同一个对象。 */
  earningsMark: EarningsMarkVerdict | null;
  /** greeks 是否齐全 (FR-007 的「数据不全」标注)。`false` 的行**照常在表内**。 */
  greeksComplete: boolean;
}

export interface LegTableView {
  symbol: string;
  state: LegTableState;
  /** 区块级 `asOf` = 快照归属交易日 (FR-013)。 */
  asOf: Date | null;
  /** 本批报价的实际采集时刻 (同批次内取最新一条)。 */
  quoteAsOf: Date | null;
  /** 🚨 **OI 的归属交易日** —— 与上面两个不是同一天 (Guardrail 6)。OI 列 MUST 用它。 */
  oiAsOf: Date | null;
  /**
   * 该市场**最近一个已收盘交易日** (`YYYY-MM-DD`) —— 区块级 `asOf` 新鲜度档的**基准**
   * (T027a, canonical `cross-timezone-date-semantics.md` §5)。判据本身在
   * `marketdata/freshness-tier.ts`, 档位在 DTO 层合成 (同 046 的分工)。
   *
   * 🚨 **判在 server 是因为它要查交易日历** —— 客户端没有, 只能拿设备本地日期比, 而那对美股
   * **恒为真** (境内本地日历已翻页、市场当天尚未收盘) ⇒ 每个读数恒显「已过时」, 该档位随之
   * 失去信息量。🚫 MUST NOT 换成宿主本地日期或 UTC 日期。
   *
   * 日历查不到 ⇒ `null` ⇒ `freshnessTier` fail-open 判 `CURRENT`。
   */
  lastClosedSession: string | null;
  /** 快照来源 (`eod` / `premarket_backfill`, FR-040) —— 「靠兜底续命」要看得见。 */
  source: string | null;
  /** vendor 随链下发的标的价, **未复权** (Guardrail 14)。 */
  spot: Prisma.Decimal | null;

  /** 以下四项 = 045 `anchor.rules.ts` 的派生, 本文件不重算。 */
  w: Prisma.Decimal;
  zone: AnchorZone | null;
  lLevel: LLevel;
  /** 手选水位档 (FR-017); `null` = 未选, **是常驻分支不是过渡态**。 */
  positionBucket: PositionBucket | null;
  /** 上一项的来源标 + 手选时刻 —— 与档位同时有值或同时为 `null` (T028 写端同口径)。 */
  positionBucketSource: PositionBucketSource | null;
  positionBucketSetAt: Date | null;
  intent: LegIntent;
  rentDepth: RentDepth | null;

  legs: LegView[];
}

/** 排序键: 统一**档位**键 (FR-019 禁跨族数值直比)。死档恒沉底 (FR-006)。 */
const TIER_ORDER: Readonly<Record<LegTier, number>> = {
  good: 0,
  acceptable: 1,
  thin: 2,
  dead: 4,
};

/** 未判档 (greeks 缺失 / 无 bid) 排在三个活档之后、死档之前 —— 「不知道」不等于「已判死」。 */
const UNCLASSIFIED_ORDER = 3;

@Injectable()
export class GetLegsUseCase {
  private readonly logger = new Logger(GetLegsUseCase.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param symbol canonical `market:code`。
   * @param now 请求时刻 (注入以便测试钉住基准)。🚫 MUST NOT 在下游改成算好的 `today` 字符串。
   * @throws NotFoundException 该 symbol 尚未建锚 (同 046 详情端: 回 200 空壳会让「没建锚」与
   *   「建了锚但没数据」在客户端不可区分)。
   */
  async execute(symbol: string, now: Date = new Date()): Promise<LegTableView> {
    // 🚫 蓄意**不**转成 045 的 `AnchorRow`: 那个 interface 没有 T002 新加的水位两列, 而本端点
    // 正要读它 —— 给它补字段会连带打红一批手写 AnchorRow 的 mock 工厂 (Surgical Edits)。
    const row = await this.prisma.anchor.findUnique({ where: { ticker: symbol } });
    if (row === null) {
      throw new NotFoundException({
        code: ANCHOR_NOT_FOUND_FOR_SYMBOL,
        message: `${ANCHOR_NOT_FOUND_FOR_SYMBOL}: ${symbol} 尚未建锚`,
      });
    }

    const effective = resolveEffectiveAnchorValues(
      { v: row.v, confidence: row.confidence },
      {
        vManual: row.vManual,
        lLevelManual: row.lLevelManual as LLevel | null,
        positionCapManual: row.positionCapManual,
      },
    );
    const w = computeW(effective.v);
    // 档位 + 来源标 + 手选时刻走**写端同一个函数** (T028), 免得读写两侧各写一份判定而漂移。
    const bucket = resolvePositionBucket(row.positionBucketManual, row.positionBucketSetAt);
    const positionBucket = bucket.bucket;
    const empty = (state: LegTableState): LegTableView => ({
      symbol,
      state,
      asOf: null,
      quoteAsOf: null,
      oiAsOf: null,
      // 无 `asOf` 就没有可判的东西 (恒 `UNAVAILABLE`) ⇒ 不白跑一次日历查询。
      lastClosedSession: null,
      source: null,
      spot: null,
      w,
      zone: null,
      lLevel: effective.lLevel,
      positionBucket,
      positionBucketSource: bucket.source,
      positionBucketSetAt: bucket.setAt,
      // 无 spot 就没有区间 ⇒ 也就没有意图 (MUST NOT 猜一个档, FR-017 同款纪律)。
      intent: 'pending',
      rentDepth: null,
      legs: [],
    });

    const parsed = parseAnchorTicker(symbol);
    if (parsed === null) return empty('chain_not_ready');

    try {
      const chain = await this.readChain(parsed, marketDateFor(['us'], now));
      if (chain === null) return empty('chain_not_ready');

      // 🚫 **MUST NOT 传省略 `now`** —— 默认值会让本端点的注入时钟对新鲜度基准失效 (测试里
      // 钉住的那个「境内早晨」时刻就不再成立), 与 T006a 对 `daysToExpiry` 的同一条纪律同源。
      const lastClosedSession = await resolveLastClosedSessionForTicker(this.prisma, symbol, now);

      const zone = classifyZone(effective.v, chain.spot);
      const { intent, rentDepth } = classifyIntent(zone, effective.lLevel, positionBucket);
      const tabContext: LegTabContext = { zone, w, rentDepth };

      return {
        ...empty('available'),
        asOf: chain.sessionDate,
        quoteAsOf: chain.quoteAsOf,
        oiAsOf: chain.oiAsOf,
        lastClosedSession,
        source: chain.source,
        spot: chain.spot,
        zone,
        intent,
        rentDepth,
        legs: this.deriveLegs(symbol, chain, tabContext, effective.v, intent, now),
      };
    } catch (err) {
      this.logger.warn(`选约表跨 ctx 读降级 (${symbol}, 锚派生照常返回): ${String(err)}`);
      return empty('read_failed');
    }
  }

  /**
   * 三张 marketdata 表的只读直查 —— **合约集 → 最近一期快照 → 该票财报日**。
   * 取「最近一期」而非「今天那期」: 当日尚未采到 ≠ 没有数据, 由呈现侧按 `asOf` 标陈旧。
   */
  private async readChain(
    parsed: { market: string; code: string },
    today: string,
  ): Promise<ChainSnapshot | null> {
    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚 ticker → 标的 id
    // 寻址, 读法同 `get-underlying-detail.usecase.ts`。零写、零 @Inject() 对方 use case (Q7-C)。
    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
      select: { id: true },
    });
    if (instrument === null) return null;

    // CROSS-CONTEXT-READ: marketdata.option_contract 只读直查 (Q7-B) —— 该标的的**适格**认沽
    // 合约集。两个过滤都在 SQL 端: `is_standard` (FR-008 非标不进选约表, 但采集侧照常落库
    // FR-033) + 到期日 **>** 当日 (FR-028a 已到期腿不可交易; 🚨 与 T021 完整性分母的 `≥`
    // 故意不同, Guardrail 7)。本片呈现面只含认沽, 采集侧的 CALL 照常在库里 (plan D-DATA-3)。
    const contracts = await this.prisma.optionContract.findMany({
      where: {
        underlyingInstrumentId: instrument.id,
        optionType: 'PUT',
        isStandard: true,
        expiryDate: { gt: utcMidnight(today) },
      },
      select: { id: true, code: true, expiryDate: true, strikePrice: true },
    });
    if (contracts.length === 0) return null;

    const contractIds = contracts.map((c) => c.id);
    // CROSS-CONTEXT-READ: marketdata.option_daily_snapshot 只读直查 (Q7-B) —— 先定位最近一期
    // 交易日, 再整批取该期。两步而非一次拉全史: 本表是全库增长最快的表 (约 6.4M 行/年)。
    const latest = await this.prisma.optionDailySnapshot.findFirst({
      where: { contractId: { in: contractIds } },
      orderBy: { sessionDate: 'desc' },
      select: { sessionDate: true },
    });
    if (latest === null) return null;

    // CROSS-CONTEXT-READ: marketdata.option_daily_snapshot 只读直查 (Q7-B) —— 该期全部行。
    // 幂等键第三段是**来源** (FR-040) ⇒ 同一合约同一交易日可能有 eod 与 premarket_backfill
    // 两行, 按 `quote_as_of` 取新的那条 (下面 dedupe)。
    const snapshots = await this.prisma.optionDailySnapshot.findMany({
      where: { contractId: { in: contractIds }, sessionDate: latest.sessionDate },
    });
    const freshest = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      const key = snapshot.contractId.toString();
      const kept = freshest.get(key);
      if (kept === undefined || snapshot.quoteAsOf.getTime() > kept.quoteAsOf.getTime()) {
        freshest.set(key, snapshot);
      }
    }
    if (freshest.size === 0) return null;

    const rows: ChainRow[] = [];
    for (const contract of contracts) {
      const snapshot = freshest.get(contract.id.toString());
      if (snapshot !== undefined) rows.push({ contract, snapshot });
    }
    // 标的价缺失 = 这批快照本身有问题 ⇒ 显式「未就绪」。🚫 蓄意**不**拿锚表的 last_close 顶上:
    // 那会让「链坏了」看起来像正常, 正是本仓反复吃亏的那类静默。
    const spot = rows.map((r) => r.snapshot.underlyingSpot).find((v) => v !== null) ?? null;
    if (rows.length === 0 || spot === null) return null;

    const newest = rows.reduce((a, b) =>
      b.snapshot.quoteAsOf.getTime() > a.snapshot.quoteAsOf.getTime() ? b : a,
    ).snapshot;

    // CROSS-CONTEXT-READ: marketdata.earnings_event 只读直查 (Q7-B) —— 该标的前向视野内的财报
    // 日, 供 T026 分组打标。全市场表按 `instrument_id` 前缀命中唯一键, 非全表扫。
    const earnings = await this.prisma.earningsEvent.findMany({
      where: { instrumentId: instrument.id, earningsDate: { gte: utcMidnight(today) } },
      select: { earningsDate: true },
    });

    return {
      sessionDate: latest.sessionDate,
      quoteAsOf: newest.quoteAsOf,
      oiAsOf: newest.oiAsOf,
      source: newest.source,
      spot,
      today,
      rows,
      earningsDates: earnings.map((e) => dateOnlyOf(e.earningsDate)),
    };
  }

  /**
   * 逐腿派生 + 分组打标 + 三套活跃度 + 统一档位排序。
   *
   * 顺序是语义决定的: 财报打标发生在**分档之前** (FR-006 死档照常打标, 与档位正交);
   * 活跃度排名发生在**Tab 归属之后** (排名是候选集内的相对量, D-SOT-5)。
   */
  private deriveLegs(
    symbol: string,
    chain: ChainSnapshot,
    tabContext: LegTabContext,
    v: Prisma.Decimal,
    intent: LegIntent,
    now: Date,
  ): LegView[] {
    // DTE **先整批算完再打标** —— 打标的腿族解析器要用它, 而解析器是同步回调, 拿不到还没
    // 填进去的值。合约数百行但到期日只有几十个 ⇒ 按到期日缓存, `daysToExpiry` 每个日期算一次。
    const expiryKeys = chain.rows.map((r) => dateOnlyOf(r.contract.expiryDate));
    const dteByExpiry = new Map<string, number>();
    for (const row of chain.rows) {
      const key = dateOnlyOf(row.contract.expiryDate);
      if (!dteByExpiry.has(key)) {
        dteByExpiry.set(key, daysToExpiry({ expiry: row.contract.expiryDate, now }));
      }
    }

    // 🚨 Guardrail 11: 财报标按 `(标的, 到期日)` 算一次再贴回, 腿族解析器只吃到期日 ⇒
    // 「同一到期日必同标」是结构保证, 逐行算这条路根本走不通。
    const calendar = earningsCalendarContext(symbol, chain.today, chain.earningsDates);
    const marks = earningsMarksByExpiry(calendar, expiryKeys, (expiryDate) =>
      earningsLegFamilyFor(intent, dteByExpiry.get(expiryDate) ?? 0),
    );

    const legs = chain.rows.map(({ contract, snapshot }) => {
      const dteDays = dteByExpiry.get(dateOnlyOf(contract.expiryDate)) ?? 0;
      const delta = snapshot.delta === null ? null : Math.abs(snapshot.delta.toNumber());
      const { absDelta, sigmaDistance } = deriveDeltaColumns(
        snapshot.greeksComplete ? delta : null,
      );
      const tabInput = { absDelta, dteDays, strike: contract.strikePrice };
      const basis: LegBasis = isBuildLeg(tabInput) ? 'weekly' : 'annualized';
      const rateOf = (premium: Prisma.Decimal | null): Prisma.Decimal | null => {
        const r =
          premium === null
            ? null
            : computeLegRates({ strike: contract.strikePrice, premium, dteDays });
        return r === null ? null : basis === 'weekly' ? r.weeklyRate : r.annualizedRate;
      };
      const rates =
        snapshot.bid === null
          ? null
          : computeLegRates({ strike: contract.strikePrice, premium: snapshot.bid, dteDays });
      const bidRate = rateOf(snapshot.bid);
      // 🚫 greeks 缺失行 MUST NOT 走判档 (FR-007) —— 筛除归调用方, `classifyLegTier` 认一个数
      // 就该给一个档, 不在纯函数里特判。
      const verdict =
        bidRate === null || absDelta === null
          ? null
          : classifyLegTier(bidRate, basis, rateOf(snapshot.ask));

      return {
        code: contract.code,
        strike: contract.strikePrice,
        expiryDate: contract.expiryDate,
        dteDays,
        bid: snapshot.bid,
        ask: snapshot.ask,
        bidSize: decimalToNumber(snapshot.bidSize),
        askSize: decimalToNumber(snapshot.askSize),
        basis,
        periodRate: rates?.periodRate ?? null,
        weeklyRate: rates?.weeklyRate ?? null,
        annualizedRate: rates?.annualizedRate ?? null,
        tier: verdict?.tier ?? null,
        askRate: verdict?.askRate ?? null,
        // 无 bid ⇒ 有效成本无定义 —— 🚫 MUST NOT 拿 `K − 0` 冒充 (那是「白拿股票」的意思)。
        effectiveCost:
          snapshot.bid === null ? null : computeEffectiveCost(contract.strikePrice, snapshot.bid),
        effectiveCostVsWPct:
          snapshot.bid === null
            ? null
            : computeEffectiveCostVsWPct(v, contract.strikePrice, snapshot.bid),
        absDelta,
        sigmaDistance,
        openInterest: decimalToNumber(snapshot.openInterest),
        volume: decimalToNumber(snapshot.volume),
        turnover: computeTurnover(decimalToNumber(snapshot.volume), snapshot.bid),
        activityByTab: emptyActivity(),
        tabs: legTabs(tabContext, tabInput),
        earningsMark: marks.get(dateOnlyOf(contract.expiryDate)) ?? null,
        greeksComplete: snapshot.greeksComplete,
      } satisfies LegView;
    });

    // 三个 Tab **各跑一次**排名 —— 同一条腿在不同 Tab 的候选集里名次不同是**定义如此**
    // (D-SOT-5), 故 MUST NOT 只算一次全链排名再复用。
    for (const tab of LEG_TABS) {
      const members = legs.filter((leg) => leg.tabs.includes(tab));
      const activity = markActivity(members);
      members.forEach((leg, i) => {
        (leg.activityByTab as Record<LegTab, ActivityMark | null>)[tab] = activity[i];
      });
    }

    // 统一档位键 (FR-019), 死档沉底 (FR-006); 同档内按到期日升序 → 行权价降序 ——
    // 🚫 蓄意**不**按费率排: 全腿 Tab 混着两个口径的行, 跨族比数值正是 FR-004 要防的事。
    // 每个 Tab 自己的排序键 (周化 bid 降序 / 绝对收益率降序) 归客户端 (D-API-1 / D-SOT-4)。
    return legs.sort(
      (a, b) =>
        tierOrder(a.tier) - tierOrder(b.tier) ||
        a.expiryDate.getTime() - b.expiryDate.getTime() ||
        b.strike.comparedTo(a.strike) ||
        a.code.localeCompare(b.code),
    );
  }
}

interface ChainRow {
  contract: { id: bigint; code: string; expiryDate: Date; strikePrice: Prisma.Decimal };
  snapshot: {
    contractId: bigint;
    quoteAsOf: Date;
    oiAsOf: Date;
    source: string;
    bid: Prisma.Decimal | null;
    ask: Prisma.Decimal | null;
    bidSize: Prisma.Decimal | null;
    askSize: Prisma.Decimal | null;
    delta: Prisma.Decimal | null;
    openInterest: Prisma.Decimal | null;
    volume: Prisma.Decimal | null;
    underlyingSpot: Prisma.Decimal | null;
    greeksComplete: boolean;
  };
}

interface ChainSnapshot {
  sessionDate: Date;
  quoteAsOf: Date;
  oiAsOf: Date;
  source: string;
  spot: Prisma.Decimal;
  today: string;
  rows: ChainRow[];
  earningsDates: string[];
}

function tierOrder(tier: LegTier | null): number {
  return tier === null ? UNCLASSIFIED_ORDER : TIER_ORDER[tier];
}

function emptyActivity(): Record<LegTab, ActivityMark | null> {
  return { all: null, build: null, rent: null };
}

/** `Decimal(20,0)` 的计数列 → number (OI / Vol 是计数不是金额, 排名与呈现都按 number)。 */
function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/** `@db.Date` 的 UTC 午夜 Date → `YYYY-MM-DD`。 */
function dateOnlyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `@db.Date` 比较用的 UTC 午夜 Date。 */
function utcMidnight(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}
