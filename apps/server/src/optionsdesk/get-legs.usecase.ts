import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import type { PriceKind } from '../marketdata/marketdata.types';
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
  computeContractPremium,
  computeEffectiveCost,
  computeEffectiveCostVsWPct,
  computeLegRates,
  computeTurnover,
  deriveDeltaColumns,
  markActivity,
  type ActivityMark,
} from './leg-derive.rules';
import { dateOnlyOf, utcMidnight } from './date-only';
import { isRecommended, monthlyChainExpiries } from './leg-mark.rules';
import {
  BASIS_BY_TAB,
  DISPLAY_LIMIT_BY_PERSPECTIVE,
  allLegsRanker,
  computeRankingFeatures,
  layeredRanker,
  rankLegs,
  truncateToDisplayLimit,
  type RankingContext,
  type RankingLegInput,
} from './leg-rank.rules';
import { coarseRank } from './leg-coarse.rules';
import {
  RECALL_CANDIDATE_CAP,
  RETRIEVAL_CRITERION_KEYS,
  crossedRemovalsWithinCriteria,
  isCrossedQuote,
  relativeSpread,
  type CriterionOutcome,
  type PerspectiveCriteria,
  type RetrievalCriteria,
  type RetrievalCriterionKey,
  type RetrievalOverride,
} from './leg-recall.rules';
import {
  LEG_RETRIEVAL_PORT,
  type LegCandidate,
  type LegChainRow,
  type LegRetrievalPort,
  type LegRetrievalResult,
  type RealtimeChainDegradeKind,
} from './leg-retrieval.port';
import {
  cleanFwdChain,
  marchEvidence,
  type FwdLadderLeg,
  type MarchAuditEntry,
} from './leg-fwd-chain.rules';
import {
  marchSelect,
  resolveMarchParams,
  type MarchMode,
  type MarchParams,
  type MarchVerdict,
} from './leg-march.rules';
import { optionsdeskConfig, type OptionsdeskConfig } from '../config/optionsdesk.config';
import {
  classifyLegTier,
  type LegBasis,
  type LegTier,
  type LegTierVerdict,
} from './leg-tier.rules';
import { earningsLegFamilyFor, type LegTab } from './leg-tab.rules';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';

/**
 * 047 US2/US3/US4 — 意图 Tab 选约表读端 (FR-002/003/005/008/013/019/041/053/054,
 * plan D-API-1 / D-API-2 / D-ARCH-1)。范式 = ADR-0043 扁平 + 贫血: 文件平铺、数据是裸 Prisma
 * row、直注 `PrismaService` 无 repository、不变量全在四个 `*.rules.ts` 纯函数里。
 *
 * 🚨 **053 起一次请求只作答一个视角** (053 FR-001 / FR-002, plan D-API-1): 047 的「一次返全量、
 * 三个 Tab 共用一份响应」整条**作废** (053 FR-019b) —— `perspective` 从「覆盖作用于谁」升为
 * 「**决定本次返回哪个视角**」。拆请求自带的两个新问题 (跨业务日一致性 / 单视角失败隔离) 由
 * 客户端承接 (053 FR-020 / FR-022); 服务端这边只保证**每次作答都是自洽的一份**。
 * 📌 **端点仍是同一个, 🚫 MUST NOT 开三个**: 三视角的链级元数据 (`asOf` / `spot` / `intent` /
 * `w` / `zone` / 水位) 逐字相同, 拆端点会让同一份派生在三处各写一遍。
 * 📌 客户端 MUST NOT 自己重算成员判据 (判据单点在 `leg-recall.rules.ts`)。
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
 * 单票 `O(n log n)` (n = 候选数, 实测上界 730; `n log n` 项 = legacy 档位排序, 与**本次视角**
 * 一次活跃度排名 + 一次精排), 财报分组打标 `O(k log E)` (k = 不同到期日数)。
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
   * **单笔权利金** = `bid × 合约乘数` (053 `FR-032`) —— 卖出一张实际收到多少钱。
   *
   * 🚨 **服务端算并下发, 🚫 MUST NOT 由客户端乘一次** (ADR-0064 不变量 ③): 合约乘数是市场规则
   * 不是合约属性, 服务端已持有那一份 (成交额在用它)。判据在 `leg-derive.rules.ts`。
   */
  contractPremium: Prisma.Decimal | null;
  /**
   * **相对价差** `(ask − bid) / mid` (053 `FR-032`) —— 与召回层流动性判据**同一个派生值**
   * (`leg-recall.rules.ts` 的 `relativeSpread`, 阈值 `LIQUIDITY_MAX_RELATIVE_SPREAD` 用的就是它)。
   *
   * 🚨 **复用不是新造**: 上屏的数与挡腿的数各算一份的话, 「这条腿为什么被挡了」在屏幕上就再也
   * 对不上账 —— 而两个数都显示得出来。任一侧缺报价 / `mid ≤ 0` → `null`。
   */
  relativeSpread: Prisma.Decimal | null;
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
   * 四档, **本次视角的口径下判出**(`FR-023` / 053 `FR-041`, plan D-RANK-3): 建仓走周化档界、
   * 收租与全腿走年化。同一条腿在两个视角判出不同档是**定义如此** —— 那三份现在由三次请求各
   * 算各的, 而不是一次响应里带三份 (053 `FR-005` 把 `tierByTab` 收窄成本字段)。
   *
   * **greeks 缺失行恒 `null`** (FR-007: 不判档不着色) —— 它们的费率算得出来但会骗人
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
  /**
   * **本次视角**候选集内的活跃度标记 (排名是候选集内的相对量, 换视角归属就变, D-SOT-5)。
   *
   * 📌 053 `FR-005` 把 `activityByTab` 收窄成本字段: 拆请求之后另两格结构上没有可判的东西,
   * 下发三格里两格恒 `null` 只是把「本次答的是哪个视角」这件事重复表达了一遍。
   */
  activity: ActivityMark | null;

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
  /**
   * **本行数值的时间口径** (064 `FR-009`) —— 复用 marketdata 既有 `PriceKind`, 原样从检索层
   * 的 `LegChainRow.priceKind` 带上来, 本层**零加工**。
   *
   * 🚨 **逐行成立, 🚫 MUST NOT 由区块级那一个数代言**: 实时源返回集里少几个合约是常态
   * (停牌 / 刚摘牌), 那几行保留收盘值并各自标 `'eod_close'`。整页统一标实时与整页统一降级
   * **都渲染得出一张完整的表**, 只有逐行标才分得出来。
   */
  priceKind: PriceKind;
  /** 068 带标 —— 原样从 `LegChainRow.bandStatus` 带上来, 本层零加工 (呈现语义, 判据在检索层)。 */
  bandStatus: 'in' | 'out' | null;
  /**
   * 071 宽价差机会标 —— 原样从候选集的 `RecallCandidate.wideSpreadOpportunity` 带上来,
   * 本层**零加工**。语义 = 「这条腿是从点差维度的机会支进来的」。
   *
   * 🚨 **🚫 MUST NOT 在这里由 `relativeSpread` 与档界重算**: 那就是同一判据两处各一份, 而
   * 两边都算得出布尔、都不会红 (ADR-0064 不变量 ③ / 052 FR-003)。判据单点在
   * `leg-recall.rules.ts` 的 `isWideSpreadOpportunity`。
   * 📌 与 {@link LegView.bandStatus} 各自独立: 带标答「Δ 落不落意图带」, 本标答「怎么进来的」,
   * 可同时成立 (071 FR-011)。
   */
  wideSpreadOpportunity: boolean;
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
   * 被**流动性门槛**排除出**本次视角**的条数 (FR-006 / 051 FR-006a) —— 这些腿**仍在链上、
   * 仍在全腿视角可见**, 没有消失。空态文案按它分支 (051 FR-009)。
   *
   * 🚨 **053 起它就是「该视角自己的数」** (`FR-005` 把 `excludedFromIntentTabsByTab` 收窄掉):
   * 一次请求只判定一个视角 ⇒ 051 那个「全表标量」与「该视角的数」在结构上已经是同一个数。
   * 拆请求之前两者必须并存, 是因为一份响应要同时服务三个视角, 而在建仓视角上报全表标量
   * **是错的且不会红** (数字真实、文案通顺, 只是指向了别的视角的腿)。
   *
   * 📌 期限段本就不合格的腿 (如 DTE=400) **不计入**: 它不是被门槛挡下的, 算进去会让这个数
   * 失去它唯一的用途 —— 提示该注意的流动性信号。
   * 📌 **全腿视角恒 `0`**: 它不受流动性门槛约束 (FR-006), 那是召回层的 `LegIntentTab` 把
   * `all` 排除在类型之外的同一个理由。
   */
  excludedFromIntentTabs: number;
}

/** 069 每 K 净链小结 (plan D3「段内/净链/剔/并/标」五计数, 弹层题头的数据源)。 */
export interface LegMarchSummaryView {
  /** 段内进入清链的档数 = 收租候选 + 护栏剔除腿 (带外横档是非候选, 不计)。 */
  readonly ladderCount: number;
  /** 净链节点数 (合并段计 1)。 */
  readonly netChainCount: number;
  /** 被剔出净链的档数 (#1 报价异常 + #13 不可算 + #2 凹陷弹出)。 */
  readonly removedCount: number;
  /** 共线并段除名档数 (#4)。 */
  readonly mergedCount: number;
  /** 劣档标数 (凹 #2 / 陈 #3 / 并 #4, 只标不删口径 —— 与 removed 是两个口径, 可重叠)。 */
  readonly markedCount: number;
}

/**
 * 069 每 K 行军判决 + 逐档审计 (FR-009 / FR-014)。**行上叠加标注, 不改行序** (FR-018) ——
 * 判决作用于**候选集** (表达层截断前), 表内被截掉的档在弹层仍可解释。
 */
export interface LegMarchStrikeView {
  readonly strike: Prisma.Decimal;
  readonly verdict: MarchVerdict;
  /** `verdict === 'recommended'` 时 = 推荐档 DTE, 其余恒 null。 */
  readonly recommendedDteDays: number | null;
  readonly summary: LegMarchSummaryView;
  /** 逐档一条 (FR-014 零无原因排除), DTE 升序; 文案格式化归 mobile (Guardrail 6)。 */
  readonly audits: readonly MarchAuditEntry[];
}

export interface LegTableView {
  symbol: string;
  /**
   * **本次作答的视角**, 原样回显 (053 `FR-005` 新增)。
   *
   * 🚨 回显而不是让客户端记着自己问了什么: 三个视角是三次飞行中的请求, 迟到的那一发要靠它
   * 认领 (`FR-008`) —— 靠调用点记忆的话, 覆盖错了**照样渲染得出来一张表**。
   */
  perspective: LegTab;
  state: LegTableState;
  /** 区块级 `asOf` = 快照归属交易日 (FR-013)。 */
  asOf: Date | null;
  /**
   * **区块级**时间口径 (064 `FR-009` / `FR-010`) —— 本批腿整体处于哪个档。
   *
   * 🚨 它决定 {@link quoteAsOf} 在契约面上的**序列化粒度**: 实时档出时刻、收盘档出交易日
   * (`optionsdesk.dto.ts` 的 `toLegTableResponse`)。📌 与逐行的 {@link LegView.priceKind}
   * **不是同一个数** —— 部分合约未返回时链级是 `'realtime'` 而那几行是 `'eod_close'`。
   * 📌 链未就绪 / 跨 ctx 读降级时恒 `'eod_close'`: 没有取到任何实时值就 MUST NOT 自称实时,
   * 而值域只有两个 (🚫 禁为「说不清」新造第三个枚举值)。
   */
  priceKind: PriceKind;
  /**
   * **本该给实时却没给成** (064 `FR-010` / `FR-011`, T007a) —— 检索层如实上报, 本层零加工。
   *
   * 🚨 🚫 MUST NOT 由 {@link priceKind} 或 `realtime` 入参反推 (语义与充要条件见
   * `LegChainMeta.realtimeDegrade`): 正常收盘档与「盘中源挂了」在 `priceKind` 上是同一个值,
   * 反推出来的那个标**在两种情形下都渲染得出来**, 而它们恰恰是本 feature 要分开的两件事。
   * 📌 链未就绪 / 跨 ctx 读降级时恒 `null`: 那时连闸都没判过, 说不出「本该外呼」。
   */
  realtimeDegrade: RealtimeChainDegradeKind | null;
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

  /**
   * **该视角、已精排、已截断**的腿 (053 `FR-002` / `FR-004`, plan D-API-1)。
   *
   * 🚨 **数组顺序就是呈现顺序** —— 053 `FR-005` 据此**删掉**了 047 的 `tabOrder`: 再下发一份
   * 有序 code 列表是同一信息的第二份表达, 必 drift 而**两边都渲染得出来**。客户端 MUST 按本
   * 数组的下标序呈现、MUST NOT 自行重排。
   * 🚫 **实际显示条数不另发** (Guardrail 11): 它恒等于 `legs.length`, 「其余 N−D 条」由
   * {@link matchedCount} 减它现算。
   */
  legs: LegView[];
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
  /**
   * 本次条件下**该视角**的成员数 —— 表达层截断**之前**的条数 (053 FR-005 / FR-015)。
   *
   * 🚨 **实际显示条数 `D` 蓄意不下发** (053 Guardrail 11): 它恒等于 `legs.length`, 「其余
   * `N − D` 条」同样可现算 —— 下发第二份必 drift, 而两个数都读得出来、都不会红。
   * ⚠️ **触及候选上限 `K` 时本数会静默失真** (FR-019c): 它算在已被 `K` 砍过的集合上 ⇒
   * {@link candidateCapDropped} 非零时, 表达层 MUST 说明本数可能不完整。
   */
  matchedCount: number;
  /**
   * **无覆盖口径**下该视角的成员数 (053 FR-009) —— 未覆盖任何条件时恒 `=== matchedCount`,
   * 此时区块头 MUST NOT 并列显示两个相等的数。
   *
   * 📌 它由检索层对**同一批已取回的链行**再判一次得出 (零额外 DB 往返), 本文件不重算 ——
   * 被当前条件挡下的行在这里结构上取不回来 (见 `LegRetrievalResult.memberCount`)。
   */
  memberCount: number;
  /**
   * 本次生效的表达层截断阈值 `N`; `null` = 不设该视角阈值 ⇒ 零截断 (053 FR-011 / FR-013)。
   *
   * 🚨 **未触发截断时也照常下发** (FR-015): 只在截断时下发会让「链规模逼近阈值」恰恰观测不到,
   * 而那正是本字段要防的静默。逼近度 `matchedCount / displayLimit` 由此随时可算 ⇒ 🚫 MUST NOT
   * 为它新增 `isNearLimit` 之类的派生布尔 (下发第二份必 drift)。
   */
  displayLimit: number | null;
  /**
   * **本次视角**的检索条件全景 (052 FR-011 / FR-029): 控件填 `defaults`, 结果按 `effective`,
   * 仅 `narrowed` 的维度出计数。
   *
   * 🚨 **053 起只下发一份** (`FR-005` 把 `criteriaByTab` 收窄成本字段): 052 之所以恒发三份,
   * 前提是「客户端本地切视角时不发请求」—— 而那条承诺已由 `FR-019b` 整条作废, 切视角就是一次
   * 新请求, 新请求自带它那一份。
   * 🚨 **默认值 MUST 由服务端解出** (FR-011 / Guardrail 6): 行权价上界与权利金下限都依赖 spot,
   * 客户端自算就是同一判据两处各一份 —— 而两边都算得出数, 漂移只在换日那一刻才看得见。
   */
  criteria: PerspectiveCriteria;
  /**
   * 069 每 K 行军判决与审计 (FR-009 / FR-014), 按行权价升序。
   *
   * 🚨 **只在「收租视角 ∧ us 市场锚」有值, 其余恒 `null`** (070 FR-001 门控放宽, P4): 069 的
   * 「实时开态才有判决」整条作废 —— 离线档 (含实时请求整体回落收盘档) 随本片点亮, 处置口径由
   * 召回层按 `chain.priceKind` 分派 (剔→标, plan §D1)。hk 锚收租 / 建仓 / 全腿恒 `null`
   * (069 参数系 us 标定; 建仓行军与接货目标反向) —— `null` 表达「本视角/本市场没有这个概念」,
   * 不是「算了但为空」。
   */
  march: LegMarchStrikeView[] | null;
  /**
   * 070 行军模式**被动标示** (FR-009 的 view 半, 契约面归 DTO): φ=意图档界 / θ=年化 argmax,
   * 值来自 server config (`optionsdeskConfig.marchMode`), UI 不暴露切换。**链级唯一** —— 模式
   * 是一次请求一个, 挂逐 K 冗余且给「同响应两模式」留不可能态 (plan §D2)。
   *
   * 🚨 与 {@link march} 同生共死: `march === null` 时恒 `null` —— 没有判决就没有模式可标,
   * 独立有值等于把 config 泄漏成语义, 而客户端拿它换文案时照样渲染得出来。
   */
  marchMode: MarchMode | null;
}

@Injectable()
export class GetLegsUseCase {
  private readonly logger = new Logger(GetLegsUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    // 召回层的数据来源接缝 (ADR-0064 决策 4)。🚫 **不是**跨 ctx 注入对方 use case (Q7-C 仍成立)
    // —— port 的实现住在本 ctx 内, 它自己直查 marketdata 表并带 `CROSS-CONTEXT-READ`。
    @Inject(LEG_RETRIEVAL_PORT) private readonly retrieval: LegRetrievalPort,
    // CROSS-CONTEXT-SYNC: optionsdesk → marketdata 交易日历读端口 (ADR-0062 的唯一 module 边)。
    // 只取「最近一场已收盘交易日」当陈旧度基准 —— 062 T010 起该判据多了「覆盖声明」一维,
    // 自己直查会漂 (漂了只让档位悄悄错一档, 不报错)。零写。
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
    // 069 行军选档旋钮 (clarify Q3): φ 档界选择 + θ 模式, server 配置 only、UI 不暴露。
    @Inject(optionsdeskConfig.KEY) private readonly optionsdesk: OptionsdeskConfig,
  ) {}

  /**
   * @param symbol canonical `market:code`。
   * @param perspective **本次要作答的视角** (053 FR-001) —— 必填而非可选: 给默认值就等于让
   *   「忘传视角」静默退回某一个视角, 而那时腿数、名次、档位全都正常, 只是答的不是问的那个
   *   视角。缺参在 controller 层已被 `ValidationPipe` 挡成 400 (`optionsdesk.dto.ts`)。
   * @param now 请求时刻 (注入以便测试钉住基准)。🚫 MUST NOT 在下游改成算好的 `today` 字符串。
   * @param override 用户对**某一个视角**检索条件的覆盖 (052 FR-012); 省略 ⇒ 全走系统默认值
   *   (这正是「复位」与首屏走的路径 —— 客户端**不回传默认值**, 那会让默认值变成两处各算一份)。
   * @param displayLimit 本次的表达层截断阈值 `N` (053 FR-011), 默认取该视角的常量; `null` =
   *   不设该视角阈值 ⇒ 零截断。
   *   🚨 **可注入是 FR-014 / SC-006 的落地手段, 不是为了给调用方开配置口子**: 意图视角的候选
   *   规模远小于全腿视角 ⇒ 截断分支很可能在真实数据上**结构性永不触发**; 注入一个小阈值后,
   *   **同一批真实数据**就能走遍截断的每一条分支。🚫 MUST NOT 改用合成 fixture 造几百条腿 ——
   *   那测的是「slice 能不能跑」而不是「真实链上截断对不对」。
   *   📌 HTTP 面**不暴露它** (053 FR-005 的字段表里没有这一项), 它只在进程内可注入。
   * @param realtime 本次是否走**盘中实时档** (064 `FR-015`, plan D6)。**默认关 (fail-closed)**
   *   —— 今天只有 authed controller 传 `true`; 将来新增任何读路径, 它默认就是不外呼的。
   *   🚫 MUST NOT 在本方法内部按鉴权状态 / 请求来源推断: 隐式推断会让「将来加一种访问方式」
   *   静默改变外呼行为, 而那一刻没有任何断言会红。
   *   📌 传 `true` 也**不保证**拿到实时值 —— 非交易时段 / 源不可达 / 基准陈旧一律逐档回落,
   *   结局由每行与链级的 `priceKind` 如实上报。
   * @throws NotFoundException 该 symbol 尚未建锚 (同 046 详情端: 回 200 空壳会让「没建锚」与
   *   「建了锚但没数据」在客户端不可区分)。
   */
  async execute(
    symbol: string,
    perspective: LegTab,
    now: Date = new Date(),
    override: RetrievalOverride | null = null,
    displayLimit: number | null = DISPLAY_LIMIT_BY_PERSPECTIVE[perspective],
    realtime = false,
  ): Promise<LegTableView> {
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
      perspective,
      state,
      asOf: null,
      // 一个实时值都没取到 ⇒ MUST NOT 自称实时 (值域只有两个, 禁为「说不清」造第三个)。
      priceKind: 'eod_close',
      // 🚨 空壳恒 `null` (T007a): 链都没就绪 / 跨 ctx 读挂了, 连闸都没判过 ⇒ 说不出「本该外呼」。
      // 🚫 MUST NOT 借这个字段表达「链读失败」—— 那是 `state` 的职责, 两个字段各答各的问题。
      realtimeDegrade: null,
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
      // 空数组而非 undefined ——「这个视角没有腿」与「没答这个视角」是两件事, 客户端不必特判。
      legs: [],
      // 没有链就没有腿被挡下 —— 两个数取 0 而非 null: 它们是计数不是「未知」。
      gateCounts: { removedByPremiumFloor: 0, excludedFromIntentTabs: 0 },
      // 没有链就没有候选可切 —— 取 0 而非 null (它是计数不是「未知」, 同上面三个数)。
      candidateCapDropped: 0,
      // 没有链就没有成员 —— 同上, 两个数取 0 而非 null。
      matchedCount: 0,
      memberCount: 0,
      // 🚨 阈值**与链无关**, 空态照样如实回显 (FR-015): 它是该视角的配置而不是本次的结果,
      // 空态给 null 会让客户端把「不设阈值」与「没链」读成同一件事。
      displayLimit,
      // 🚫 没有 spot 就**解不出**依赖它的条件, MUST NOT 猜一个默认值填进去 (spec Edge Case):
      // 六维全 `null` 表达的是「没有值」, 不是「不限」—— 这一屏本来就没有表可看 (`state` 已说明)。
      criteria: unresolvedCriteria(),
      // 069: 空壳恒 null —— 连链都没有, 更没有判决 (与「收租但整梯无可成交」是两回事)。
      march: null,
      // 070: 与 march 同生共死 —— 无判决就无模式标示。
      marchMode: null,
    });

    const parsed = parseAnchorTicker(symbol);
    if (parsed === null) return empty('chain_not_ready');

    try {
      // 召回经检索 port (FR-031)。🚨 **053 起只要请求的那一个视角** (053 FR-001): 拆的是 HTTP
      // 请求不是 port 调用 —— `retrieveCandidates` 每请求仍**只调 1 次**, DB 的 3x 是三个 HTTP
      // 请求各查一遍的结果, 不是单请求内查三遍。
      // 🚫 **port 签名一字不改** (053 FR-003): `perspectives` 是 052 就立好的入参, 本片只是第一
      // 个真的传非全集的调用方 —— 改签名等于把当时留好的接缝白留。
      const retrieval = await this.retrieval.retrieveCandidates({
        symbol,
        now,
        perspectives: [perspective],
        // 候选上限 (052 FR-027): 保险丝, 与表达层给用户看几条**是两个数** —— 后者归 053。
        candidateCap: RECALL_CANDIDATE_CAP,
        override,
        // 064 `FR-015`: 实时开关**由调用方显式传到底** —— 本方法只是把它原样传下去, 不加工。
        // 🚫 MUST NOT 省略它靠默认值兜 (port 上蓄意没有默认值), 更 MUST NOT 从鉴权状态或请求
        // 来源推断: 那会让「将来加一种访问方式」静默改变外呼行为。
        realtime,
      });
      if (retrieval === null) return empty('chain_not_ready');
      const chain = retrieval.chain;

      // 🚫 **MUST NOT 传省略 `now`** —— 默认值会让本端点的注入时钟对新鲜度基准失效 (测试里
      // 钉住的那个「境内早晨」时刻就不再成立), 与 T006a 对 `daysToExpiry` 的同一条纪律同源。
      const lastClosedSession = await resolveLastClosedSessionForTicker(this.calendar, symbol, now);

      const zone = classifyZone(effective.v, chain.spot);
      const { intent, rentDepth } = classifyIntent(zone, effective.lLevel, positionBucket);
      // 粗排层 (FR-004): 多路召回的合并去重槽位, **当前恒等** —— 位置先占住, 由 ADR-0064
      // sunset #1 (多路召回落地) 触发它转实体。串在这里让五层的调用链在编排面上读得出来。
      const pool = coarseRank(retrieval.candidates);

      const earningsDates = await this.readEarningsDates(parsed, chain.marketDate);
      // 月度链标零 I/O (#45): 判据读的是随合约行一并出来的 vendor 到期周期, 不再查交易日历。
      const monthlyExpiries = monthlyChainExpiries(pool.map(({ leg }) => leg));

      return {
        ...empty('available'),
        // 触及候选上限的留痕 (052 FR-028): 随候选集从召回层一路上浮, 不经日志。
        candidateCapDropped: retrieval.droppedByCandidateCap,
        // 无覆盖口径的成员数 (053 FR-009): 同样随候选集上浮 —— 被当前条件挡下的链行只存在于
        // 检索层内部, 在这里重算取不回那些行 (🚫 更不许为它多查一次库)。
        memberCount: retrieval.memberCount,
        // 条件全景与候选集**同源** (052 FR-011): 默认值由召回层从链自身解出 (成色上界要行权价
        // 网格、权利金下限要 spot), 计数是同一次成员判定的副产品 —— 在这里重算必 drift。
        // 📌 召回层照旧产三份 (它的出参形状归 052, `FR-044` 钉死零改动), 契约面只取本次那一份。
        criteria: retrieval.criteriaByTab[perspective],
        asOf: chain.sessionDate,
        // 064 `FR-009`: 链级档位由检索层如实上报, 本层原样带出 —— 🚫 MUST NOT 在这里按
        // 「传了 realtime 吗」反推: 传 true 也可能整体回落, 反推出来的那个档照样渲染得出来。
        priceKind: chain.priceKind,
        // 064 T007a: 链级降级标同样**原样带出** —— 🚫 MUST NOT 在这里按 `priceKind` 或
        // `realtime` 入参反推 (判据要交易日历, 那是检索层才有的东西)。
        realtimeDegrade: chain.realtimeDegrade,
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
          perspective,
          retrieval,
          pool,
          earningsDates,
          monthlyExpiries,
          effective.v,
          intent,
          rentDepth,
          displayLimit,
        ),
        // 069 行军选档 (FR-009) → 070 门控放宽 (FR-001, P4): 「收租视角 ∧ us 市场锚」——
        // 档位退出门控, 只决定召回层的处置口径 (剔→标按 chain.priceKind 分派, plan §D1);
        // 实时请求整体回落收盘档随离线口径一并点亮 (回落态呈现即收盘档语义)。hk 恒 null
        // (069 四参数系 us 收盘分布标定, clarify 裁决)。判决仍在**排序旁路**装配: 吃的是
        // 候选集 (截断前), 不碰 legs 行序 (FR-013 / 069 FR-018)。
        ...this.marchBlock(perspective, parsed.market, retrieval, pool),
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
   * 070 行军判决块 (FR-001 门控放宽): `收租 ∧ us` 有值, 其余恒双 null。
   *
   * 🚨 **门控不看档位** —— 处置口径 (剔→标) 已在召回层按 `chain.priceKind` 落定 (plan §D1),
   * 判决对两档吃的是同一批候选 + 同一份留痕; 🚫 MUST NOT 在这里按 `realtime` 入参或档位再设
   * 一道闸 (反推档位正是 usecase 上方那条既有禁令要拦的)。
   * 🚨 `marchMode` 与 `march` 同出同 null: 分开产出会让「无判决但有模式标示」这个不可能态
   * 变成可能, 而它渲染得出来。
   */
  private marchBlock(
    perspective: LegTab,
    market: string,
    retrieval: LegRetrievalResult,
    pool: readonly LegCandidate[],
  ): Pick<LegTableView, 'march' | 'marchMode'> {
    if (perspective !== 'rent' || market !== 'us') return { march: null, marchMode: null };
    return {
      march: assembleMarchByStrike(
        pool,
        retrieval.removedByCrossedQuote,
        retrieval.criteriaByTab.rent.effective,
        resolveMarchParams(this.optionsdesk.marchPhiTier, this.optionsdesk.marchMode),
      ),
      marchMode: this.optionsdesk.marchMode,
    };
  }

  /**
   * 逐腿派生 + 分组打标 + **本次视角**一套活跃度 + 统一档位排序 (FR-008 的两个门槛计数随候选集
   * 从检索层带入)。
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
    perspective: LegTab,
    retrieval: LegRetrievalResult,
    pool: readonly LegCandidate[],
    earningsDates: string[],
    monthlyExpiries: ReadonlySet<string>,
    v: Prisma.Decimal,
    intent: LegIntent,
    rentDepth: RentDepth | null,
    displayLimit: number | null,
  ): Pick<LegTableView, 'legs' | 'gateCounts' | 'matchedCount'> {
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

    // 🚨 **本次口径由视角定, 不再由 `tabs` 反推** (053 FR-041 的落地): 候选集只对
    // `perspective` 一个视角判定过 ⇒ `tabs.includes('build')` 与 `perspective === 'build'` 逐字
    // 等价, 而后者读得出「口径跟视角走」这件事。全腿视角恒年化的例外仍由 `BASIS_BY_TAB` 单点持有。
    const basis: LegBasis = BASIS_BY_TAB[perspective];
    const legs = pool.map(({ leg: row, wideSpreadOpportunity }) => {
      const { code, expiryDate, dteDays, strike } = row;
      const delta = row.delta === null ? null : Math.abs(row.delta);
      const { absDelta, sigmaDistance } = deriveDeltaColumns(row.greeksComplete ? delta : null);
      // 🚨 050 召回入参里**没有** `absDelta` (FR-009): Δ 已降级为打标量, 拿不到这个量就不可能
      // 拿它做召回判据。`absDelta` 在本函数内仍照常派生 —— 它服务判档门 (greeks 缺失不判档)
      // 与呈现列, 那两处与召回无关。
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
        // 两个派生值都在**服务端单点**算 (053 FR-032): 前者服务端已持有合约乘数, 后者直接复用
        // 召回层那一份判据函数 —— 客户端各算一份就是同一判据两处落点 (ADR-0064 不变量 ③)。
        contractPremium: computeContractPremium(row.bid),
        relativeSpread: relativeSpread(row.bid, row.ask),
        bidSize: row.bidSize,
        askSize: row.askSize,
        basis,
        periodRate: rates?.periodRate ?? null,
        weeklyRate: rates?.weeklyRate ?? null,
        annualizedRate: rates?.annualizedRate ?? null,
        // 📌 判定值恒为 `bid` 口径费率, 跟视角走的只是**档界**所依的口径 (047 D-SOT-1 一字不改)。
        tier: verdict?.tier ?? null,
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
        // 排名要以**整个候选集**为分母 ⇒ 逐腿这一趟只占位, 真值在下面一次性贴回。
        activity: null as ActivityMark | null,
        // 🚨 打标**零拦截** (FR-018): 下面两个标只是往腿上贴属性, MUST NOT 参与成员判定 ——
        // 候选归属在召回层已经定死, 打标改不了本视角的成员集合。
        isRecommended: isRecommended(intent, rentDepth, absDelta),
        // 月度链标是**到期日级**的属性 —— 同一到期日的腿必同标, 与财报标同一个结构保证。
        isMonthlyChain: monthlyExpiries.has(dateOnlyOf(expiryDate)),
        earningsMark: marks.get(dateOnlyOf(expiryDate)) ?? null,
        greeksComplete: row.greeksComplete,
        bandStatus: row.bandStatus,
        // 071: 机会标随候选集原样带出 —— 判据在召回层单点, 本层零重算 (见 `LegView`)。
        wideSpreadOpportunity,
        // 064 `FR-009`: 逐行档位原样带出 —— 🚫 MUST NOT 拿链级那个数填 (部分缺失时两者不同)。
        priceKind: row.priceKind,
      } satisfies LegView;
    });

    // 🚨 **053 起排名只跑本次视角一遍** (053 FR-001): 原来的 `for (const tab of LEG_TABS)` 三次
    // 循环退化为一次 —— 同一条腿在不同视角的候选集里名次不同仍是**定义如此** (D-SOT-5), 只是
    // 那三份现在由**三次 HTTP 请求**各算各的, 而不是一次请求里算三遍。
    //
    // 🚨 **排名基准 = 该视角的召回全量成员, 且这一步 MUST 落在召回之后** (FR-016 / Guardrail 3):
    // 最自然的写法是「先筛再排名」(少算一些), 那样写出来照样能跑、数字照样有, **只是全错** ——
    // 名次是候选集内的相对量, 基准少了几行, 每一行的名次都变了。
    // 🚫 **MUST NOT 在这里补一个「筛选」段** (053 Guardrail 1): 六维条件已由 052 并入召回层,
    // 排名基准就是当前条件下的召回集; 再筛一次就是第二条成员判据路径。
    const rankingContext: RankingContext = { spot: retrieval.chain.spot };
    // 候选集只对 `perspective` 一个视角判定过 ⇒ 每条候选的视角归属恒为 `[perspective]` ⇒
    // 「按 Tab 取成员」那句 `filter` 是恒等, 随之退役 (053 起每腿的 `tabs` 也不再下发)。
    const members = legs;
    // 分组键与月度链标 / 财报标同源 (052 FR-023): 三处都走 `dateOnlyOf`, 传 `Date` 或全串
    // 会把同一到期日拆成一腿一组 —— 那时**每条腿都是组内第一**, 而结果照样有。
    const activity = markActivity(
      members.map((leg) => ({
        strike: leg.strike,
        expiryKey: dateOnlyOf(leg.expiryDate),
        openInterest: leg.openInterest,
        volume: leg.volume,
      })),
    );
    members.forEach((leg, i) => {
      leg.activity = activity[i];
    });

    const features = computeRankingFeatures(
      rankingContext,
      members.map((leg, i) => rankingInputOf(leg, perspective, activity[i], rankingContext.spot)),
    );
    // 精排 (052 FR-017 / FR-020): 意图视角走**分层** (流动性档 → 档内费率 → 打平带内长期
    // 优先, 候选数不足自动降级); 全腿视角保持费率降序 —— 它是参照视角, 分档会把「同一条链
    // 上收益怎么分布」这件事遮掉。
    const ordered =
      perspective === 'all'
        ? rankLegs(members, features, allLegsRanker)
        : rankLegs(members, features, layeredRanker(members.length));

    // 🚨 **表达层截断落在精排之后, 顺序不可换** (053 FR-004 / FR-010, plan D-ORDER-1): 先截再
    // 排会让「截掉的是排序尾部」这句话不成立, 而截出来的条数照样对、屏幕上照样有一张表。
    // 🚫 **MUST NOT 在这里补一条成员判据** (053 Guardrail 1) —— 截断的判据是**名次**不是六维
    // 条件, 后者已由 052 单点在召回层。
    // 📌 `matchedCount` 取**截断前**的条数: 表达层要用它算「其余 N−D 条未显示」, 而 `D` 与那个
    // 差值都不下发 (Guardrail 11, 两者都可现算)。
    const matchedCount = ordered.length;
    const displayed = truncateToDisplayLimit(ordered, displayLimit);

    // 🚨 **`legs[]` 就是那份有序列表** (053 FR-005): 047 的 `tabOrder` 随之退役 —— 同一个顺序
    // 下发两份表达必 drift, 而**两份各自都渲染得出来**, 于是没有一处会红。腿本体按有序 code
    // 逐个取回 ⇒ 顺序与截断天然同集, 不存在「有名次没有腿」的缝。`O(n)`。
    const byCode = new Map(legs.map((leg) => [leg.code, leg]));
    return {
      legs: displayed.map((code) => byCode.get(code)!),
      matchedCount,
      // 两个计数随候选集从召回层一并出来 (052) —— 它们是过门槛那一步的副产品, 在这里重算
      // 就成了第二份判据, 而两份都算得出数、drift 时都不会红。
      // 📌 召回层照旧同时产标量与分视角两份 (`FR-044` 钉死它零改动); 一次只判一个视角之后
      // 两者结构上恒等 ⇒ 契约面只留标量 (053 FR-005)。
      gateCounts: {
        removedByPremiumFloor: retrieval.removedByPremiumFloor,
        excludedFromIntentTabs: retrieval.excludedFromIntentTabs,
      },
    };
  }
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

/**
 * 链未就绪时的条件全景 —— 六维全 `null` + 三态全 `default` (052 spec Edge Case「spot 缺失」)。
 *
 * 🚫 **MUST NOT 拿一个假 spot 现算一份默认值填进去**: 那会让「解不出」看起来像「解出来正好是
 * 这些值」, 而客户端照样能把它填进控件、照样能点搜。
 */
function unresolvedCriteria(): PerspectiveCriteria {
  const blank: RetrievalCriteria = {
    strikeMax: null,
    strikeMin: null,
    dteBand: null,
    premiumMin: null,
    livenessMin: null,
    relativeSpreadMax: null,
  };
  const outcomes = {} as Record<RetrievalCriterionKey, CriterionOutcome>;
  for (const key of RETRIEVAL_CRITERION_KEYS)
    outcomes[key] = { state: 'default', excludedCount: 0 };
  return { defaults: blank, effective: blank, outcomes };
}

/**
 * 069 按 K 分组装配行军判决 (plan D2 接线点的纯函数半)。`O(n log n)` (按 K 分桶 + 逐 K 清链
 * 行军; n = 候选数)。
 *
 * · 输入三路: 收租候选 (带外横档拆出记 #12, 非候选不进净链) + 护栏剔除腿 (#1, 只收「若非
 *   交叉本会是收租成员」的那批 —— 判据**复用** `failedCriteria` 单点, 不另写第二份成员谓词)
 *   + 全部经 T002–T005 管道。
 * · FR-014 恰一条: 净链上带 #3 (绝对支配) 标的档同时会被行军给出条目 —— 清链家族**优先**
 *   (疑似陈旧比「合格非停点」更有行动价值), 行军条目对已有清链条目的档让位。
 * · 全梯被护栏剔空的 K 照样出判决 (净链空 ⇒ untradable, clarify Q2), 逐档 #1 就位。
 */
function assembleMarchByStrike(
  pool: readonly LegCandidate[],
  crossedLegs: readonly LegChainRow[],
  rentCriteria: RetrievalCriteria,
  params: MarchParams,
): LegMarchStrikeView[] {
  interface StrikeBucket {
    readonly strike: Prisma.Decimal;
    readonly ladder: FwdLadderLeg[];
    readonly extraAudits: MarchAuditEntry[];
    crossedCount: number;
  }
  const buckets = new Map<string, StrikeBucket>();
  const bucketOf = (strike: Prisma.Decimal): StrikeBucket => {
    const key = strike.toString();
    const existing = buckets.get(key);
    if (existing !== undefined) return existing;
    const created: StrikeBucket = { strike, ladder: [], extraAudits: [], crossedCount: 0 };
    buckets.set(key, created);
    return created;
  };

  for (const { leg } of pool) {
    // 070 剔→标: 收盘口径下交叉腿保留在 pool (照常成行), 但 MUST NOT 进 fwd 阶梯 —— 净链除名
    // 与 #1 审计归下方护栏留痕那一路 (进这里会双计 `ladderCount` 且拿交叉价污染 fwd)。判据仍
    // 是 `isCrossedQuote` 单点; 实时口径下交叉腿结构上不在 pool, 本分支恒不触发。
    if (isCrossedQuote(leg.bid, leg.ask)) continue;
    const bucket = bucketOf(leg.strike);
    if (leg.bandStatus === 'out') {
      // #12 带外横档: 保留比价、非候选 ⇒ 进审计不进净链。带下限不随行下发 ⇒ 证据只带 |Δ|
      // (bandFloor 恒 null, 「不知道」不伪造)。
      bucket.extraAudits.push({
        category: 'band_out',
        dteDays: leg.dteDays,
        mergedIntoDteDays: null,
        evidence: marchEvidence({
          absDelta: leg.delta === null ? null : new Prisma.Decimal(Math.abs(leg.delta)),
        }),
      });
      continue;
    }
    bucket.ladder.push({
      dteDays: leg.dteDays,
      bid: leg.bid,
      ask: leg.ask,
      openInterest: leg.openInterest,
    });
  }

  // 审计面只收「若非交叉本会是收租成员」的剔除腿 —— 作用域判定住召回层
  // (crossedRemovalsWithinCriteria, 守卫 #7: 成员判据单点), 本层只消费结果。
  for (const leg of crossedRemovalsWithinCriteria('rent', rentCriteria, crossedLegs)) {
    const bucket = bucketOf(leg.strike);
    bucket.crossedCount += 1;
    bucket.extraAudits.push({
      category: 'crossed_quote',
      dteDays: leg.dteDays,
      mergedIntoDteDays: null,
      evidence: marchEvidence({ bid: leg.bid, ask: leg.ask }),
    });
  }

  const views = [...buckets.values()].map((bucket): LegMarchStrikeView => {
    const clean = cleanFwdChain(bucket.strike, bucket.ladder);
    const decision = marchSelect(clean.chain, params);
    const cleanDtes = new Set(clean.audits.map((a) => a.dteDays));
    const audits = [
      ...bucket.extraAudits,
      ...clean.audits,
      ...decision.audits.filter((a) => !cleanDtes.has(a.dteDays)),
    ]
      // 合并段内成员当选停点时 (段内回退), 其 #4 条目让位 —— 推荐档零条目 (FR-014)。
      .filter((a) => a.dteDays !== decision.recommendedDteDays)
      .sort((a, b) => a.dteDays - b.dteDays);
    const countOf = (...categories: MarchAuditEntry['category'][]) =>
      clean.audits.filter((a) => categories.includes(a.category)).length;
    return {
      strike: bucket.strike,
      verdict: decision.verdict,
      recommendedDteDays: decision.recommendedDteDays,
      summary: {
        ladderCount: bucket.ladder.length + bucket.crossedCount,
        netChainCount: clean.chain.length,
        removedCount: bucket.crossedCount + countOf('quote_missing', 'concave_dominated'),
        mergedCount: countOf('collinear_merged'),
        markedCount: countOf('concave_dominated', 'absolute_dominated', 'collinear_merged'),
      },
      audits,
    };
  });
  views.sort((a, b) => a.strike.comparedTo(b.strike));
  return views;
}
