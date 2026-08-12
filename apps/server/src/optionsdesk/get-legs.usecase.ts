import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { resolveEffectiveAnchorValues } from './anchor-cascade';
import {
  classifyZone,
  computeW,
  parseAnchorTicker,
  type AnchorZone,
  type LLevel,
} from './anchor.rules';
import {
  crossesEarnings,
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
import {
  MONTHLY_EXPIRY_LOOKBACK_DAYS,
  isRecommended,
  monthlyExpiryCandidates,
  resolveMonthlyExpiries,
} from './leg-mark.rules';
import {
  BASIS_BY_TAB,
  computeRankingFeatures,
  layeredRanker,
  rankLegs,
  rateDescendingRanker,
  type RankingContext,
  type RankingLegInput,
} from './leg-rank.rules';
import { coarseRank } from './leg-coarse.rules';
import { RECALL_CANDIDATE_CAP, relativeSpread, type LegIntentTab } from './leg-recall.rules';
import {
  LEG_RETRIEVAL_PORT,
  type LegCandidate,
  type LegRetrievalPort,
  type LegRetrievalResult,
} from './leg-retrieval.port';
import {
  classifyLegTier,
  type LegBasis,
  type LegTier,
  type LegTierVerdict,
} from './leg-tier.rules';
import { LEG_TABS, earningsLegFamilyFor, type LegTab } from './leg-tab.rules';

/**
 * 047 US2/US3/US4 — 意图 Tab 选约表读端 (FR-002/003/005/008/013/019/041/053/054,
 * plan D-API-1 / D-API-2 / D-ARCH-1)。范式 = ADR-0043 扁平 + 贫血: 文件平铺、数据是裸 Prisma
 * row、直注 `PrismaService` 无 repository、不变量全在四个 `*.rules.ts` 纯函数里。
 *
 * 🚨 **一次返全量适格腿, 零分页零 top-N 截断** (FR-005): 三个 Tab 是**同一份派生结果**的三种
 * 视图 ⇒ 分三次请求会让三个 Tab 的 `asOf` 与档位口径可能不一致。客户端按每腿的 `tabs` 过滤,
 * MUST NOT 自己重算成员判据 (判据单点在 `leg-recall.rules.ts`)。
 *
 * 🚨 **Guardrail 7 —— 这里是 `>` 而 T021 完整性分母是 `≥`, 两处判据故意不同**: 本端点滤的是
 * 「已到期腿不可交易」(到期日 **>** 当日), 完整性分母认的是「当日到期的合约当日仍可取快照」
 * (到期日 **≥** 当日)。统一成一个必坏一头, 且只在到期日当天才看得出来。
 *
 * 🚨 **两个时点不是同一天** (Guardrail 6 / FR-013): 报价列的时点是 `quote_as_of`, **OI 列的
 * 时点是 `oi_as_of`** —— 美股期权 OI 在盘前更新 ⇒ 收盘后采的快照, 其 OI 归属 T−1 日。
 * ⇒ 响应把两个时点分开下发, 呈现侧 OI 列 MUST 用 `oiAsOf`。
 *
 * 🚨 **052 起本文件是五层的编排入口, 不再是召回层本身** (ADR-0064 / plan D-LAYER-1): 期权链的
 * 检索与召回判据整块移到 `leg-retrieval.port.ts` 的实现之后, 本文件经 port 拿候选集。留在这里的
 * 跨 ctx 读只剩**打标与呈现的输入** (`earnings_event` 财报日 / `trading_day` 月度到期日与最近
 * 已收盘 session), 它们不是召回。
 *
 * 🚨 **跨 ctx 只读直查** (D-ARCH-1 / catalog Q7-B): 上述读全部走 `PrismaService` 直查 +
 * `CROSS-CONTEXT-READ` 注释 (`check-server-moat.ts` 机器强制), **零 `@Inject()` marketdata 的
 * use case** (Q7-C), 跨 ctx 写永远禁。**MUST NOT import `marketdata/*.rules.ts`** (Guardrail 14,
 * ESLint disallow): spot 直接取快照行里 vendor 给的标的价, **不走复权换算**。
 *
 * 🚨 **派生一律请求时算** (FR-041): W / 四区间 / L 层 / 愿卖锚**复用 045 `anchor.rules.ts`**,
 * 本文件一个区间系数都不算 (Guardrail 13); 费率 / σ 距 / 活跃度 / 成交额走 047 三个纯函数。
 * DTE 由检索层按注入时钟算 (基准恒为**交易所的今天**), 本文件直接用候选行上的值。
 *
 * 🚨 **一处有意的口径错配, 禁「修」**: 价格来自**上一场 session** 的 EOD 快照, DTE 从**当前**
 * ET 日期起算。决策是前瞻的, 改成快照日基准会系统性多算一天; 代价是同屏必须有显式 `asOf`。
 *
 * 复杂度: 一次检索 (port 内 3 次跨 ctx 查询) + 两次打标输入查询 (该票财报日 / 交易日历) +
 * 单票 `O(n log n)` (n = 候选数, 实测上界 730; `n log n` 项 = legacy 档位排序, 与三个 Tab
 * **各自**一次活跃度排名 + 一次精排), 财报分组打标 `O(k log E)` (k = 不同到期日数)。
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
   *
   * 📌 **050 起它是 legacy 标量**: 档位跟 Tab 走 (`FR-023`) ⇒ 真身是 {@link tierByTab}。本字段
   * 保留是因为契约只加不删 (`FR-027`), 判据 = 「进建仓召回集 → 周化, 否则年化」(D-RANK-3)。
   */
  tier: LegTier | null;
  /**
   * 每个 Tab 各自口径下的档位 (`FR-023`, plan D-RANK-3) —— 建仓 Tab 走周化档界、收租与全腿走
   * 年化。同一条腿在两个 Tab 判出不同档是**定义如此**。
   *
   * 🚨 **不属于该 Tab 的格恒 `null`** —— 不在那个候选集里就没有那个候选集的档位。与 `tier` 的
   * `null` (缺 greeks / 无 bid ⇒ 不判档) 是两个原因、同一个值, 呈现侧都是「不着色」。
   */
  tierByTab: Readonly<Record<LegTab, LegTier | null>>;
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

  /** 本腿在哪几个 Tab 里 (客户端据此过滤, 判据单点在 `leg-recall.rules.ts`)。 */
  tabs: readonly LegTab[];
  /**
   * 推荐标 (FR-011) —— 这条腿的 `|Δ|` 落在**标的级意图**对应的带内。
   *
   * 🚨 **随意图判, 不随当前 Tab 变**: 收租意图下打开建仓 Tab 会看到推荐标数为 0, 那是**正确
   * 信号**不是 bug (SC-005)。greeks 缺失恒 `false` (FR-013), 但该腿**照常在召回集里**。
   */
  isRecommended: boolean;
  /**
   * 到期日是不是该月的**月度到期日** (FR-014) —— 月度链的流动性通常显著好于周链。
   *
   * 判据是「该月第三个周五; 该日非交易日则取其前一交易日」, 取自**交易日历**
   * (`leg-mark.rules.ts` 的两个纯函数)。🚫 MUST NOT 简化成「是不是周五」。
   */
  isMonthlyChain: boolean;
  /** 财报标; 建仓域恒 `null` (与「无日期」是两个值)。同一到期日的腿共用同一个对象。 */
  earningsMark: EarningsMarkVerdict | null;
  /** greeks 是否齐全 (FR-007 的「数据不全」标注)。`false` 的行**照常在表内**。 */
  greeksComplete: boolean;
}

/**
 * 两道门槛各自挡下多少条 (FR-008) —— 「有腿消失了」必须可见且**可行动**。
 *
 * 🚨 **两个数语义不对称, 命名不可互换、更不可合并成一个总数**: 一分钱腿是废腿 (不用管),
 * 价差宽是该注意的流动性信号 (该看看), 两类的处置完全不同。🚫 MUST NOT 换成 `filteredOut`
 * 这类同时暗示两种语义的容器名 —— 用户看到「滤除 12 条」会以为那 12 条不见了。
 */
export interface LegGateCounts {
  /**
   * 被**权利金门槛**从响应里整条移出的条数 (FR-005) —— 这些腿三个 Tab 都看不到, 是真正的
   * 「数据消失」。本项**部分推翻 047 FR-005**「任何腿至少在一个 Tab 里可见」, 而它是这笔
   * 取舍的**唯一**补偿 ⇒ 呈现侧 MUST NOT 省略。
   */
  removedByPremiumFloor: number;
  /**
   * 被**流动性门槛**排除出建仓 / 收租的条数 (FR-006) —— 这些腿**仍在响应里、仍在全腿 Tab
   * 可见**, 没有消失。
   *
   * 📌 期限段本就不合格的腿 (如 DTE=400) **不计入**: 它不是被门槛挡下的, 算进去会让这个数
   * 失去它唯一的用途 —— 提示该注意的流动性信号。
   */
  excludedFromIntentTabs: number;
  /**
   * 上一项**按意图视角拆开**的两个数 (051 FR-006a) —— 空态文案要按「**该视角自己的**排除数」
   * 分支 (051 FR-009), 而标量做不到这件事: 建仓视角空而标量 = 20 时, 那 20 条可能全是被排除
   * 出**收租**的, 据此说「有 20 条被挡了, 去全腿看」对建仓视角**是错的且不会红** (数字真实、
   * 文案通顺, 只是指向了别的视角的腿)。
   *
   * 🚨 **与标量并存而非替换** (契约只加不删), 且 **`标量 ≠ build + rent`**: `[30,49]` 是两段
   * 刻意的重叠区, 一条落其中且被挡下的腿在标量记 1 次、在这两个数里**各**记 1 次 ⇒ 恒有
   * `标量 ≤ build + rent`。判据取**不等式**, 取等号会在重叠区红错方向。
   *
   * 📌 **不拆「全腿」那一档**: 全腿 Tab 不受流动性门槛约束 (FR-006), 恒不会因它变空 ——
   * 这也是 {@link LegIntentTab} 把 `all` 排除在类型之外的理由。
   * 📌 **权利金门槛那个数不拆视角**: 被它挡下的腿已整条移出响应, 三视角一律。两个计数在这一点
   * 上的不对称, 与它们语义上的不对称是同一件事。
   */
  excludedFromIntentTabsByTab: Readonly<Record<LegIntentTab, number>>;
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
  /**
   * 每个 Tab 一份**有序的合约代码列表** (FR-021a) —— 精排在 server 完成, 客户端 MUST 按它
   * 呈现、MUST NOT 自行重排。腿本体仍只下发一份 (MUST NOT 按 Tab 复制)。
   *
   * 🚨 **与每腿的 `tabs` 同源派生** (Guardrail 9): 两处表达的是同一个成员关系, 各算一份必
   * drift —— 而**两边都算得出结果**, 于是 drift 时没有任何一处会红。
   *
   * 🚫 它**不是** `legs[]` 的新排序: 后者的档位键是 legacy 载体顺序 (旧客户端仍按它渲染),
   * 一行不许动 (Guardrail 10)。
   */
  tabOrder: Readonly<Record<LegTab, string[]>>;
  /** 两道门槛各自挡下多少条 (FR-008) —— 语义不对称, 见 {@link LegGateCounts}。 */
  gateCounts: LegGateCounts;
  /**
   * 触及召回层候选上限时被切掉多少条 (052 FR-028)。未触及恒 `0`。
   *
   * 🚨 **它蓄意不进 {@link LegGateCounts}** —— 那三个数是「判据挡下了什么」, 而这一个是「保险丝
   * 熔断了」。混进去会让「腿少了」的两种成因在一个结构里失去区分, 而它们的处置完全不同: 前者
   * 调条件, 后者调 K 或缩范围。
   */
  candidateCapDropped: number;
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

  constructor(
    private readonly prisma: PrismaService,
    // 召回层的数据来源接缝 (ADR-0064 决策 4)。🚫 **不是**跨 ctx 注入对方 use case (Q7-C 仍成立)
    // —— port 的实现住在本 ctx 内, 它自己直查 marketdata 表并带 `CROSS-CONTEXT-READ`。
    @Inject(LEG_RETRIEVAL_PORT) private readonly retrieval: LegRetrievalPort,
  ) {}

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
      // 三份列表恒有值 (空数组而非 undefined) —— 「这个 Tab 没有腿」与「没有这个 Tab」是两件事,
      // 客户端不必为空态特判。
      tabOrder: emptyTabOrder(),
      // 没有链就没有腿被挡下 —— 三个数取 0 而非 null: 它们是计数不是「未知」。
      gateCounts: {
        removedByPremiumFloor: 0,
        excludedFromIntentTabs: 0,
        excludedFromIntentTabsByTab: { build: 0, rent: 0 },
      },
      // 没有链就没有候选可切 —— 取 0 而非 null (它是计数不是「未知」, 同上面三个数)。
      candidateCapDropped: 0,
    });

    const parsed = parseAnchorTicker(symbol);
    if (parsed === null) return empty('chain_not_ready');

    try {
      // 召回经检索 port (FR-031): 三视角一次全要 —— 它们是同一份派生结果的三种视图 (047 FR-005),
      // 分三次请求会让三个 Tab 的 `asOf` 与档位口径可能不一致。拆成每视角独立请求归 053。
      const retrieval = await this.retrieval.retrieveCandidates({
        symbol,
        now,
        perspectives: LEG_TABS,
        // 候选上限 (052 FR-027): 保险丝, 与表达层给用户看几条**是两个数** —— 后者归 053。
        candidateCap: RECALL_CANDIDATE_CAP,
      });
      if (retrieval === null) return empty('chain_not_ready');
      const chain = retrieval.chain;

      // 🚫 **MUST NOT 传省略 `now`** —— 默认值会让本端点的注入时钟对新鲜度基准失效 (测试里
      // 钉住的那个「境内早晨」时刻就不再成立), 与 T006a 对 `daysToExpiry` 的同一条纪律同源。
      const lastClosedSession = await resolveLastClosedSessionForTicker(this.prisma, symbol, now);

      const zone = classifyZone(effective.v, chain.spot);
      const { intent, rentDepth } = classifyIntent(zone, effective.lLevel, positionBucket);
      // 粗排层 (FR-004): 多路召回的合并去重槽位, **当前恒等** —— 位置先占住, 由 ADR-0064
      // sunset #1 (多路召回落地) 触发它转实体。串在这里让五层的调用链在编排面上读得出来。
      const pool = coarseRank(retrieval.candidates);

      const earningsDates = await this.readEarningsDates(parsed, chain.marketDate);
      const monthlyExpiries = await this.readMonthlyExpiries(parsed.market, pool);

      return {
        ...empty('available'),
        // 触及候选上限的留痕 (052 FR-028): 随候选集从召回层一路上浮, 不经日志。
        candidateCapDropped: retrieval.droppedByCandidateCap,
        asOf: chain.sessionDate,
        quoteAsOf: chain.quoteAsOf,
        oiAsOf: chain.oiAsOf,
        lastClosedSession,
        source: chain.source,
        spot: chain.spot,
        zone,
        intent,
        rentDepth,
        // `legs` 与 `gateCounts` 同源产出 —— 计数是**召回层**过门槛那一步的副产品 (052 起随候选集
        // 一并从 port 出来), 分两处算必 drift 且两边都算得出数。
        ...this.deriveLegs(
          symbol,
          retrieval,
          pool,
          earningsDates,
          monthlyExpiries,
          effective.v,
          intent,
          rentDepth,
        ),
      };
    } catch (err) {
      this.logger.warn(`选约表跨 ctx 读降级 (${symbol}, 锚派生照常返回): ${String(err)}`);
      return empty('read_failed');
    }
  }

  /**
   * 该票前向视野内的财报日 —— **打标输入, 不是召回** (故 052 起留在本文件而非检索 port)。
   *
   * 📌 按 `(market, code)` 走关系过滤而不再复用检索层解析出的标的 id: 让本读与 port 无耦合
   * (换 port 实现不牵动它), 代价是一次带子查询的等值命中 —— 唯一键前缀, 非全表扫。
   */
  private async readEarningsDates(
    parsed: { market: string; code: string },
    marketDate: string,
  ): Promise<string[]> {
    // CROSS-CONTEXT-READ: marketdata.earnings_event 只读直查 (Q7-B) —— 该标的前向视野内的财报
    // 日, 供 T026 分组打标。零写、零 @Inject() 对方 use case (Q7-C)。
    const earnings = await this.prisma.earningsEvent.findMany({
      where: {
        instrument: { market: parsed.market, code: parsed.code },
        earningsDate: { gte: utcMidnight(marketDate) },
      },
      select: { earningsDate: true },
    });
    return earnings.map((e) => dateOnlyOf(e.earningsDate));
  }

  /**
   * 该链上哪些到期日是**月度到期日** (FR-014 / FR-015, plan D-MARK-2)。
   *
   * 🚨 **一次查回整段日历, MUST NOT 逐到期日查** (Guardrail 7): 链上到期日几十个, 逐个查是
   * 几十次往返。窗口 = `[最早候选日 − MONTHLY_EXPIRY_LOOKBACK_DAYS, 最晚候选日]`, 下界的外扩
   * 量与假日回退的最大距离**是同一个常量** —— 不同步的话会出现「窗口里没查到、回退逻辑却敢
   * 用」的缝。
   *
   * 复杂度: 1 次范围查询 (`(market, date)` 唯一键前缀命中) + `O(m log m)` 排序。
   */
  private async readMonthlyExpiries(
    market: string,
    pool: readonly LegCandidate[],
  ): Promise<Set<string>> {
    const candidates = monthlyExpiryCandidates(pool.map(({ leg }) => dateOnlyOf(leg.expiryDate)));
    // 空链在检索层就已挡下, 这条是纯函数契约的兜底 —— 零候选就别白发一次查询。
    if (candidates.length === 0) return new Set();

    const from = new Date(
      utcMidnight(candidates[0]).getTime() - MONTHLY_EXPIRY_LOOKBACK_DAYS * MS_PER_DAY,
    );
    // CROSS-CONTEXT-READ: marketdata.trading_day 只读直查 (catalog Q7-B) —— 月度到期日的假日
    // 回退判据取自交易日历, 读法同 `last-closed-session.ts:39`。零写; marketdata 不知道锚表
    // 存在 (方向铁律)。
    const days = await this.prisma.tradingDay.findMany({
      where: { market, date: { gte: from, lte: utcMidnight(candidates[candidates.length - 1]) } },
      select: { date: true },
    });
    return resolveMonthlyExpiries(
      candidates,
      days.map((d) => dateOnlyOf(d.date)),
    );
  }

  /**
   * 逐腿派生 + 分组打标 + 三套活跃度 + 统一档位排序 (FR-008 的两个门槛计数随候选集从检索层带入)。
   *
   * 顺序是语义决定的: 财报打标发生在**分档之前** (FR-006 死档照常打标, 与档位正交);
   * 活跃度排名发生在**Tab 归属之后** (排名是候选集内的相对量, D-SOT-5)。
   *
   * 🚨 **052 起本函数零成员判据** (ADR-0064 不变量: 判据单点在召回层): 进来的每条都已是候选,
   * 每条的 `tabs` 也已判定。🚫 在这里补一条 `filter` = 给召回开第二个判据点, 而它**不会红**
   * —— 返回的腿数量与数值全都正常, 只是少了一批。要改成员集合就改 `leg-recall.rules.ts`。
   */
  private deriveLegs(
    symbol: string,
    retrieval: LegRetrievalResult,
    pool: readonly LegCandidate[],
    earningsDates: string[],
    monthlyExpiries: ReadonlySet<string>,
    v: Prisma.Decimal,
    intent: LegIntent,
    rentDepth: RentDepth | null,
  ): Pick<LegTableView, 'legs' | 'gateCounts' | 'tabOrder'> {
    const expiryKeys = pool.map(({ leg }) => dateOnlyOf(leg.expiryDate));
    // 打标的腿族解析器要 DTE, 而解析器是同步回调 ⇒ 先按到期日索引好 (值由检索层按注入时钟算)。
    const dteByExpiry = new Map<string, number>();
    for (const { leg } of pool) {
      const key = dateOnlyOf(leg.expiryDate);
      if (!dteByExpiry.has(key)) dteByExpiry.set(key, leg.dteDays);
    }

    // 🚨 Guardrail 11: 财报标按 `(标的, 到期日)` 算一次再贴回, 腿族解析器只吃到期日 ⇒
    // 「同一到期日必同标」是结构保证, 逐行算这条路根本走不通。
    const calendar = earningsCalendarContext(symbol, retrieval.chain.marketDate, earningsDates);
    const marks = earningsMarksByExpiry(calendar, expiryKeys, (expiryDate) =>
      earningsLegFamilyFor(intent, dteByExpiry.get(expiryDate) ?? 0),
    );

    const legs = pool.map(({ leg: row, tabs }) => {
      const { code, expiryDate, dteDays, strike } = row;
      const delta = row.delta === null ? null : Math.abs(row.delta);
      const { absDelta, sigmaDistance } = deriveDeltaColumns(row.greeksComplete ? delta : null);
      // 🚨 050 召回入参里**没有** `absDelta` (FR-009): Δ 已降级为打标量, 拿不到这个量就不可能
      // 拿它做召回判据。`absDelta` 在本函数内仍照常派生 —— 它服务判档门 (greeks 缺失不判档)
      // 与呈现列, 那两处与召回无关。
      // 现役标量 `basis` 的新判据 (plan D-RANK-3): 进建仓召回集 → 周化, 否则年化。
      // 🚫 MUST NOT 为喂这个 legacy 字段而把刚删掉的 Δ 带成员判据再养活一份。
      const basis: LegBasis = tabs.includes('build') ? 'weekly' : 'annualized';
      const rateOf = (premium: Prisma.Decimal | null, on: LegBasis): Prisma.Decimal | null => {
        const r = premium === null ? null : computeLegRates({ strike, premium, dteDays });
        return r === null ? null : on === 'weekly' ? r.weeklyRate : r.annualizedRate;
      };
      // 🚫 greeks 缺失行 MUST NOT 走判档 (FR-007) —— 筛除归调用方, `classifyLegTier` 认一个数
      // 就该给一个档, 不在纯函数里特判。
      const verdictOn = (on: LegBasis): LegTierVerdict | null => {
        const rate = rateOf(row.bid, on);
        return rate === null || absDelta === null
          ? null
          : classifyLegTier(rate, on, rateOf(row.ask, on));
      };
      const rates =
        row.bid === null ? null : computeLegRates({ strike, premium: row.bid, dteDays });
      const verdict = verdictOn(basis);

      return {
        code,
        strike,
        expiryDate,
        dteDays,
        bid: row.bid,
        ask: row.ask,
        bidSize: row.bidSize,
        askSize: row.askSize,
        basis,
        periodRate: rates?.periodRate ?? null,
        weeklyRate: rates?.weeklyRate ?? null,
        annualizedRate: rates?.annualizedRate ?? null,
        tier: verdict?.tier ?? null,
        tierByTab: tierByTabOf(tabs, verdictOn),
        askRate: verdict?.askRate ?? null,
        // 无 bid ⇒ 有效成本无定义 —— 🚫 MUST NOT 拿 `K − 0` 冒充 (那是「白拿股票」的意思)。
        effectiveCost: row.bid === null ? null : computeEffectiveCost(strike, row.bid),
        effectiveCostVsWPct:
          row.bid === null ? null : computeEffectiveCostVsWPct(v, strike, row.bid),
        absDelta,
        sigmaDistance,
        openInterest: row.openInterest,
        volume: row.volume,
        turnover: computeTurnover(row.volume, row.bid),
        activityByTab: emptyActivity(),
        tabs,
        // 🚨 打标**零拦截** (FR-018): 下面两个标只是往腿上贴属性, MUST NOT 参与 `tabs` 的判定
        // —— `tabs` 在召回层已经定死, 打标改不了任何 Tab 的成员集合。
        isRecommended: isRecommended(intent, rentDepth, absDelta),
        // 月度链标是**到期日级**的属性 —— 同一到期日的腿必同标, 与财报标同一个结构保证。
        isMonthlyChain: monthlyExpiries.has(dateOnlyOf(expiryDate)),
        earningsMark: marks.get(dateOnlyOf(expiryDate)) ?? null,
        greeksComplete: row.greeksComplete,
      } satisfies LegView;
    });

    // 三个 Tab **各跑一次**排名 —— 同一条腿在不同 Tab 的候选集里名次不同是**定义如此**
    // (D-SOT-5), 故 MUST NOT 只算一次全链排名再复用。
    //
    // 🚨 **排名基准 = 该 Tab 的召回全量成员, 且这一步 MUST 落在召回之后** (FR-016 / Guardrail 3):
    // 最自然的写法是「先筛再排名」(少算一些), 那样写出来照样能跑、数字照样有, **只是全错** ——
    // 名次是候选集内的相对量, 基准少了几行, 每一行的名次都变了。本片没有筛选 ⇒ 召回集 == 排名
    // 基准; P3 加筛选时 MUST NOT 把 `markActivity` 挪到筛选之后。
    const rankingContext: RankingContext = { spot: retrieval.chain.spot };
    const tabOrder = emptyTabOrder();
    for (const tab of LEG_TABS) {
      // 🚨 Guardrail 9: 成员集合在这里求值**一次**, 活跃度排名、特征集、有序列表三者共用它
      // ⇒ `tabOrder[t]` 与每腿的 `tabs` 不可能 drift (各算一份的话两边都算得出结果)。
      const members = legs.filter((leg) => leg.tabs.includes(tab));
      const activity = markActivity(members);
      members.forEach((leg, i) => {
        (leg.activityByTab as Record<LegTab, ActivityMark | null>)[tab] = activity[i];
      });

      // 🚨 顺序骨架恒为 **排名 → 筛选 → 截断** (FR-024)。本片不实装后两步 (归 P3), 但它们的
      // 位置已经定死在这一行**之后** —— 挪到前面会让每一行的名次与特征值都变 (基准少了几行),
      // 而**数字照样有、照样落 `[0,1]`**。
      const features = computeRankingFeatures(
        rankingContext,
        members.map((leg, i) => rankingInputOf(leg, tab, activity[i], rankingContext.spot)),
      );
      // 精排 (052 FR-017 / FR-020): 意图视角走**分层** (流动性档 → 档内费率 → 打平带内长期
      // 优先, 候选数不足自动降级); 全腿视角保持费率降序 —— 它是参照视角, 分档会把「同一条链
      // 上收益怎么分布」这件事遮掉。
      tabOrder[tab] =
        tab === 'all'
          ? rankLegs(members, features, rateDescendingRanker)
          : rankLegs(members, features, layeredRanker(members.length));
    }

    // 统一档位键 (FR-019), 死档沉底 (FR-006); 同档内按到期日升序 → 行权价降序。
    //
    // 🚨 **050 起这是 legacy 载体顺序, 一行不许动** (Guardrail 10): 有了 `tabOrder` 之后它确实
    // 不再承载语义, 但旧客户端 (P2 未上) 仍按它渲染 —— 改了会看起来乱, 而**这不是编译期能发现
    // 的**。新消费方一律走 `tabOrder`; 退役时机由 P3 在 P2 切过去之后评估。
    legs.sort(
      (a, b) =>
        tierOrder(a.tier) - tierOrder(b.tier) ||
        a.expiryDate.getTime() - b.expiryDate.getTime() ||
        b.strike.comparedTo(a.strike) ||
        a.code.localeCompare(b.code),
    );

    return {
      legs,
      tabOrder,
      // 三个计数随候选集从召回层一并出来 (052) —— 它们是过门槛那一步的副产品, 在这里重算
      // 就成了第二份判据, 而两份都算得出数、drift 时都不会红。
      gateCounts: {
        removedByPremiumFloor: retrieval.removedByPremiumFloor,
        excludedFromIntentTabs: retrieval.excludedFromIntentTabs,
        excludedFromIntentTabsByTab: retrieval.excludedFromIntentTabsByTab,
      },
    };
  }
}

function tierOrder(tier: LegTier | null): number {
  return tier === null ? UNCLASSIFIED_ORDER : TIER_ORDER[tier];
}

function emptyActivity(): Record<LegTab, ActivityMark | null> {
  return { all: null, build: null, rent: null };
}

function emptyTabOrder(): Record<LegTab, string[]> {
  return { all: [], build: [], rent: [] };
}

/**
 * per-Tab 档位 (FR-023, plan D-RANK-3)。`O(Tab 数)` = `O(1)`。
 *
 * 🚨 **非成员恒 `null`** —— 不在那个候选集里就没有那个候选集的档位。
 * 📌 判定值仍恒为 `bid` 口径费率, 换的只是**档界**所依的口径 (047 D-SOT-1 那条纪律一字不改)。
 */
function tierByTabOf(
  tabs: readonly LegTab[],
  verdictOn: (basis: LegBasis) => LegTierVerdict | null,
): Record<LegTab, LegTier | null> {
  const tierByTab = {} as Record<LegTab, LegTier | null>;
  for (const tab of LEG_TABS) {
    tierByTab[tab] = tabs.includes(tab) ? (verdictOn(BASIS_BY_TAB[tab])?.tier ?? null) : null;
  }
  return tierByTab;
}

/**
 * 已派生好的腿 → 精排层的**原始量入参** (FR-019)。`O(1)`。
 *
 * 🚨 **费率按该 Tab 的口径取** (`BASIS_BY_TAB`) —— 顺序上两个口径同序 (单调变换), 但特征值是
 * 要留给将来加权用的, 拿错口径会让「同一项特征在三个 Tab 语义不同」这件事悄悄成立。
 *
 * 📌 三个布尔项各有出处、都是**已算好的结论**: `isDeltaInIntentBand` = 推荐标 (随标的级意图,
 * `leg-mark.rules.ts`), `isTopRanked` / `isRoundStrike` = 该 Tab 的活跃度标记 (候选集内相对量),
 * `crossesEarnings` = 财报标读出 (FR-017: 本片 MUST NOT 改动其算法)。
 */
function rankingInputOf(
  leg: LegView,
  tab: LegTab,
  activity: ActivityMark,
  spot: Prisma.Decimal,
): RankingLegInput {
  return {
    rate: BASIS_BY_TAB[tab] === 'weekly' ? leg.weeklyRate : leg.annualizedRate,
    effectiveCost: leg.effectiveCost,
    relativeSpread: relativeSpread(leg.bid, leg.ask),
    openInterest: leg.openInterest,
    volume: leg.volume,
    turnover: leg.turnover,
    absDelta: leg.absDelta,
    dteDays: leg.dteDays,
    // 成色 (052 FR-020): 行权价相对 spot 的折价。派生放在这里而不是特征层, 因为特征层拿不到
    // 行权价 —— 那是身份键 (`LegIdentity`), 进了特征入参就等于允许按身份算特征。
    // spot ≤ 0 是脏数据 ⇒ 判 `null` 走「缺失」那条路, 🚫 MUST NOT 除下去产 ±Infinity。
    strikeDiscount: spot.lessThanOrEqualTo(0) ? null : spot.minus(leg.strike).div(spot),
    isMonthlyChain: leg.isMonthlyChain,
    isRoundStrike: activity.isRoundStrike,
    isDeltaInIntentBand: leg.isRecommended,
    crossesEarnings: crossesEarnings(leg.earningsMark),
    isTopRanked: activity.isTopRanked,
  };
}

const MS_PER_DAY = 86_400_000;

/** `@db.Date` 的 UTC 午夜 Date → `YYYY-MM-DD`。 */
function dateOnlyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `@db.Date` 比较用的 UTC 午夜 Date。 */
function utcMidnight(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}
