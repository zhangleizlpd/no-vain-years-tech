import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type OptionContract, type OptionDailySnapshot } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { exchangeCalendarDate } from '../marketdata/session-clock';
import { daysToExpiry } from '../marketdata/trading-day-gate';
import {
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
  type OptionSnapshotRow,
} from '../marketdata/option-snapshot.port';
import { MARKET_STATE_PORT, type MarketStatePort } from '../marketdata/market-state.port';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import { computeW, parseAnchorTicker, type LLevel } from './anchor.rules';
import { resolveEffectiveAnchorValues } from './anchor-cascade';
import { INTRADAY_FRESHNESS_SECONDS, isIntradayFresh } from './intraday-spot.rules';
import {
  WINDOW_SUPPORTED_MARKETS,
  bootstrapWindowFor,
  withinWindow,
  type LegWindow,
} from './leg-window.rules';
import { type LegTab } from './leg-tab.rules';
import {
  BUILD_RECALL_DTE,
  RENT_RECALL_DTE,
  recallCandidates,
  type LegIntentTab,
  type RecallContext,
} from './leg-recall.rules';
import {
  DELTA_BAND_BY_INTENT,
  MONEYNESS_PAD_RATIO,
  resolveDeltaSurfaceWindow,
  withinDeltaBand,
  type DeltaFaceRow,
} from './leg-delta-surface.rules';
import type {
  LegChainMeta,
  LegChainQuery,
  LegChainRow,
  LegChainSnapshot,
  LegRetrievalPort,
  LegRetrievalQuery,
  LegRetrievalResult,
  RealtimeChainDegradeKind,
  RealtimeDegradeKind,
} from './leg-retrieval.port';

/**
 * {@link PrismaLegRetrievalAdapter} 内部的取链产出 —— 快照 + 本次实际用过的窗 (064 T004b)。
 *
 * 🚨 窗**不上浮到 port 出参**: 它是「该问哪些合约此刻的价」这件事的内部细节, 对调用方零语义。
 * 068 起它只服务圈码 (召回第一段); 064 的绊线已随覆盖范式退役 (窗漏腿的守卫改由标定回放承担)。
 * 收盘档 / 基准不可用时恒为 `null`: 没发生实时取数就没有窗。
 */
interface LoadedChain {
  readonly snapshot: LegChainSnapshot;
  readonly window: LegWindow | null;
}

/**
 * {@link PrismaLegRetrievalAdapter.resolveWindow} 的出参 —— 窗 + **它是按哪一刻的基准定的**
 * (064 T006)。
 *
 * 🚨 `basisAt` 不是为了算窗, 是为了在窗定不出来时说得出**为什么**: `FR-023` 的
 * `window_basis_stale` 要带基准时刻与判据阈值, 而「陈旧」与「整列还没写过」在响应里长得一模一样
 * (都是一张收盘档的表)。只报一个 `null` 的话, 聚合出来的那条曲线分不出「熔断传导过来了」还是
 * 「这只锚今天根本没进过 tick」。
 */
interface ResolvedBasis {
  /** 窗基准 spot (三级降级产物); 三级全落空 ⇒ `null` (调用方标 `window_basis_stale` 回落)。 */
  readonly spot: Prisma.Decimal | null;
  /** 基准的采集时刻 (一级 = tick 时刻, 二级 = 补发批 `asOf`); 锚不存在 / 该列从未写过 ⇒ `null`。 */
  readonly basisAt: Date | null;
}

/**
 * **这条链的基线来自哪一批** —— 库内那期收盘快照, 还是这一次实时取回的那一批。
 *
 * 🚨 **颗粒度是「整条链」而不是「单个空格」, 这是本类型存在的全部理由**: 单元格级的「空就补」
 * 看起来更省事, 但两批 OI 的**归属日不同** —— 库内那期若只有 `eod` 行 (当日盘前兜底没跑),
 * 它的 `oi_as_of` 是 T−2; 而此刻实时取回的 OI 已在盘前翻新, 归属 T−1。逐格填就会把一个 T−1
 * 的数放进一张标着 T−2 的表里, **整页渲染正常、数字真实、只是差一天**。
 * ⇒ 一条链的 OI 要么整批来自库内、要么整批来自实时批, 两者的归属日各自由构造对齐。
 *
 * 本值同时决定两件**同源**的事 (故是一个参数而不是两个):
 * | | `db_snapshot` | `realtime_batch` |
 * | --- | --- | --- |
 * | 整体回落时落到哪 | 收盘档 (值一个不动) | **未就绪 `null`** —— 没有收盘档可落 |
 * | OI 由谁写 | 库内 (`FR-004` 原文不动) | 同一批实时 |
 */
type ChainBaseline = 'db_snapshot' | 'realtime_batch';

/** {@link PrismaLegRetrievalAdapter.toLegRows} 用到的合约列 —— 链的**骨架**, 与报价无关。 */
type ChainContractRow = Pick<
  OptionContract,
  'code' | 'expiryDate' | 'strikePrice' | 'expirationCycle'
>;

/**
 * {@link ChainBaseline} 为 `realtime_batch` 时链级 `source` 的取值 —— 与库内那两个
 * (`eod` / `premarket_backfill`) 并列的第三种「这批数从哪来」。
 *
 * 📌 呈现侧**零改动**: `underlying-detail-screen.tsx` 的判据是 `source !== 'eod'` 就渲
 * 「来源 {source}」—— 于是这条链会如实标出「它没有收盘档基线」, 那正是用户该看见的一句话,
 * 不是需要藏起来的实现细节。
 */
const REALTIME_BASELINE_SOURCE = 'realtime';

/**
 * 实时报价的**请求级超时** (064 `FR-011`「源不可达 / 超时」那半, plan D3)。
 *
 * 取值 = `SC-002` 的端到端预算 (P95 ≤ 1.5 s) 的两倍: 等到这个数, 用户已经比预算多等了一倍,
 * 再等下去不如给他一张**标着收盘档**的表。上界之下的正常往返实测 0.35–0.41 s (p0 线上 285 codes),
 * 留了近一个数量级的余量 ⇒ 不会把「慢但正常」误判成故障。
 *
 * 🚨 **本片只有这一个时间阈值, 🚫 MUST NOT 顺手加断路器** (Guardrail 1): 熔断住在 061 的 tick,
 * 经「停写盘中价 → 基准判陈旧」传导过来。两套状态必然不同步。
 */
const REALTIME_SNAPSHOT_TIMEOUT_MS = 3_000;

/**
 * 本片**特有**的三类失败 (064 `FR-023`, plan D11) —— 每类一条结构化 warn 的**类别字段**值域。
 *
 * | 类别 | 什么时候 | 附带的判据 |
 * | --- | --- | --- |
 * | `partial_miss` | 部分合约未在返回集 | 缺失条数 / 本次问了多少条 |
 * | `window_over_cap` | 窗内条数超单批上限 | 窗内条数 / 上限 |
 * | `window_basis_stale` | 定窗基准缺失或陈旧 | 基准时刻 / 新鲜度阈值 |
 *
 * 🚨 **通道级健康 MUST NOT 由本片回答** (plan D11): 复用 061 的观测面, 本片**不新建心跳、
 * 不新建健康指标**。理由是判据本身 —— 本片**按需触发**, 「没人看就没数据」的指标当哨兵会把
 * 「今天没人开选约表」读成「通道挂了」; 061 的 tick 每 30 秒主动探一次, 它才是这条通道的哨兵。
 *
 * 🚨 **只装本片特有的那三类**: 两闸判定失败 / 源不可达 / 超时那几条是 `FR-011` 的通用降级,
 * 它们照常留 warn 但**不进这个值域** —— 混进来的话「本片特有的失败有多少」这个数就再也问不出
 * 来了, 而聚合出来的图照样画得出来 (`SC-010`)。
 * 📌 T007a 起**枚举本身住在 port 上** ({@link RealtimeDegradeKind}, 契约与日志同源): 这里用
 * `Extract` 取它的子集, 于是「留痕只装三类」是**编译期**保证 —— 把 `source_unavailable` 传进
 * {@link PrismaLegRetrievalAdapter.warnDegraded} 会当场不过 tsc, 而不是等 `SC-010` 那条反例来抓。
 */
type RealtimeDegradeLogKind = Extract<
  RealtimeDegradeKind,
  'partial_miss' | 'window_over_cap' | 'window_basis_stale'
>;

/**
 * 两闸的判定结果 (064 T007a) —— **三态**, 🚫 MUST NOT 退回布尔。
 *
 * 🚨 `'closed'` 与 `'unknown'` 对**外呼**的结局相同 (都不发), 对**降级标**的结局却相反:
 * 前者是正常休市 (恒 `null`), 后者是「不知道此刻该不该给实时」(算降级)。合成一个布尔就等于
 * 把这两件事在响应里再次坍缩成一个 —— 那正是 T007a 要拆开的那一处。
 */
type RealtimeGate = 'open' | 'closed' | 'unknown';

/**
 * 三类留痕的行首 tag —— 日志聚合按它捞行、按 `kind` 分组。🚫 MUST NOT 在第二处手写这个串
 * (聚合器与产出方各写一份, 改一处就静默漏掉一半的行)。
 */
/** 068 FR-013 窗规模观测 (analyze G2) —— 正常规模也留痕, IT 与运维靠它读窗码数。 */
export const WINDOW_SIZE_LOG_TAG = '[068] window-size';

export const REALTIME_DEGRADE_LOG_TAG = '[064] realtime-degraded';

/**
 * 实时报价取回超时 —— 与读取口自己的失败语义 (`OptionSnapshotBudgetExhaustedError` 等) 并列,
 * 但**属于调用方**: 是「我不等了」而不是「vendor 说不行」, 两者在日志里必须分得开。
 */
class RealtimeSnapshotTimeoutError extends Error {
  constructor(ms: number, what: string) {
    super(`[064] 实时报价取回超时 (${ms} ms), 本次回落收盘档: ${what}`);
    this.name = 'RealtimeSnapshotTimeoutError';
  }
}

/**
 * 052 检索 port 的 **Prisma 实现** (plan D-PORT-1) —— 整块承接 050 `get-legs.usecase.ts` 里的
 * `readChain`: 三张 marketdata 表的只读直查 + 逐腿 DTE + 召回判据。
 *
 * 🚨 **跨 ctx 只读直查** (catalog Q7-B / ADR-0043 §5): 每处 `prisma.<他 ctx 表>.find*` 上方
 * MUST 带 `// CROSS-CONTEXT-READ:` (`check-server-moat.ts` 机器强制); 跨 ctx **写**永远禁,
 * 零 `@Inject()` marketdata 的 use case (Q7-C)。**MUST NOT import `marketdata/*.rules.ts`**
 * (ADR-0053, ESLint `boundaries` 是绊线): spot 直接取快照行里 vendor 给的标的价, 不走复权换算。
 *
 * 🚨 **判据一条都不在本文件里** —— 成员判定全部经 `leg-recall.rules.ts` 的层入口
 * {@link recallCandidates}。假实现共用同一个入口, 于是「换实现 ⇒ 判据不变」是结构保证而非约定;
 * 反过来说, 在这里补一条 `filter` 就等于给召回开了第二个判据点, 而它**不会红**。
 *
 * 🚨 **064 起本文件多一件事: 盘中实时报价的尾部覆盖** (plan D6)。插点是 {@link loadChain} 的
 * **尾部** —— 组装 `legs` 之后、`return` 之前。理由与 055 抽出 `loadChain` 的理由是同一条: 它是
 * `retrieveCandidates` 与 `retrieveChain` 的**共同根**, 插在这里两个 port 方法自动读到同一批行、
 * 同一个报价时刻 (064 FR-017 由此是**结构保证**而非纪律)。
 * 🚫 **MUST NOT 挪到 `recallCandidates` 之后再插一层** —— 那时候选集已经按收盘值筛过一轮,
 * 「按此刻的口径召回」这句话当场不成立, 而候选表照样渲染得出来。
 * 🚫 **MUST NOT 在 Prisma 事务里等这次外呼** (split-tx 心智): 本方法根本不开事务, 保持如此。
 *
 * 复杂度: 3 次跨 ctx 查询 (合约集 / 最近一期 / 该期全量) + `O(n)` 逐腿判据 (n = 该票当日快照
 * 行数, 实测上界 730)。DTE 按到期日缓存 —— 合约数百行但到期日只有几十个。
 * 📌 **有覆盖时多一趟 `O(n)` 纯 CPU 判定** (053 FR-009 的 `memberCount`): 查询次数不变。
 * 📌 **实时档多一次外呼 + 一趟 `O(n)` 覆盖**: 查询次数不变, 外呼次数每请求恒 1 (064 SC-003)。
 */
@Injectable()
export class PrismaLegRetrievalAdapter implements LegRetrievalPort {
  private readonly logger = new Logger(PrismaLegRetrievalAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的期权快照**读取口** (port token + interface, 非
    // use case —— catalog Q7-C 的放行判据见 064 plan D1)。强一致同步读: 这一屏要的就是**此刻**
    // 的盘口, 落表已来不及, 且本片零落库 (064 FR-019)。方向仍单向: marketdata 对本 ctx 零感知。
    // 🚨 **可空**: 解析不到 (或本次未开实时) 时行为与 064 之前**逐字节相同** —— 关态是默认态
    // (FR-016), 🚫 MUST NOT 让它变成一条「没配就报错」的硬依赖。
    // 🚫 **MUST NOT 换成采集口 `OPTION_SNAPSHOT_PORT`**: 那个 token 的意图是「产出必然被持久
    // 化」(054 逐 port 核过 consumer, 全是写手), 读路径复用它会让那条结构性保证当场变成假话。
    @Optional()
    @Inject(OPTION_SNAPSHOT_READ_PORT)
    private readonly snapshots: OptionSnapshotPort | null = null,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的市场时段端口 (port token + interface, 同上)。
    // vendor 原始状态串**不出对方 adapter**, 本 ctx 只见归一后的三态 —— 值域知识不复制过来
    // (`market-state.port.ts` 文件头; 复制过去两处必漂移, 而漂移表现为盘前 / 夜盘照样外呼)。
    // 🚨 **与 061 的 tick 共用同一个白名单口径**, 🚫 MUST NOT 在本 ctx 再判一次「哪些状态算常规」。
    @Optional()
    @Inject(MARKET_STATE_PORT)
    private readonly marketState: MarketStatePort | null = null,
    // CROSS-CONTEXT-SYNC: 注入 marketdata 的交易日历**读**端口 (同上)。与时段闸**取交集**:
    // 两者答的是两件事 (此刻开不开市 / 今天是不是交易日), 少一个都会在某类日子上放行外呼。
    @Optional()
    @Inject(TRADING_CALENDAR_PORT)
    private readonly tradingCalendar: TradingCalendarPort | null = null,
  ) {}

  async retrieveCandidates(query: LegRetrievalQuery): Promise<LegRetrievalResult | null> {
    // 068 两段式 dispatch: 实时 ∧ 单意图视角 ∧ 读取口在绑 ⇒ 窄召回; 其余一律收盘档。
    if (query.realtime && this.snapshots !== null) {
      const intent = this.soleIntentView(query.perspectives);
      if (intent !== null) return this.retrieveRealtimeNarrow(query, intent, this.snapshots);
    }
    // 离线 / 全腿 / 防御性多视角 / 读取口未绑定 ⇒ 收盘档 (零 vendor 外呼, FR-014 / Q1 裁决)。
    return this.retrieveClosing(query, null);
  }

  /**
   * 收盘档装配 —— 离线正路与实时回落**共用**: 走离线唯一路径 {@link loadChainWithWindow}
   * (`realtime` 恒 `false` ⇒ 零外呼), 回落时附既有降级标 (值域零扩张, 068 Q2 裁决)。
   */
  private async retrieveClosing(
    query: LegRetrievalQuery,
    degrade: RealtimeChainDegradeKind | null,
  ): Promise<LegRetrievalResult | null> {
    const loaded = await this.loadChainWithWindow({
      symbol: query.symbol,
      now: query.now,
      realtime: false,
    });
    if (loaded === null) return null;
    const { chain, legs } = loaded.snapshot;
    const w = await this.resolveW(query.symbol);
    if (w === null) return null;
    const context: RecallContext = { spot: chain.spot, w };
    const outcome = recallCandidates(
      context,
      query.perspectives,
      legs,
      query.candidateCap,
      query.override,
    );
    return {
      chain: degrade === null ? chain : { ...chain, realtimeDegrade: degrade },
      ...outcome,
      // 053 FR-009: 无覆盖口径的成员数 —— 语义与三条禁忌见 `LegRetrievalResult.memberCount`。
      memberCount:
        query.override === null
          ? outcome.candidates.length
          : recallCandidates(context, query.perspectives, legs, query.candidateCap).candidates
              .length,
    };
  }

  /** 窄召回只服务单意图视角 (068 Q1 裁决); 其余形态 fail-closed 到收盘档 (FR-014)。 */
  private soleIntentView(perspectives: readonly LegTab[]): LegIntentTab | null {
    if (perspectives.length !== 1) return null;
    const only = perspectives[0];
    return only === 'build' || only === 'rent' ? only : null;
  }

  /**
   * 068 (ADR-0068 P2) —— 实时**窄召回**主装配, 两段式。
   *
   * 第一段 (选码): 闸 → #286 guard → 三级基准 (D3) → 昨日 Δ 面库内批读 (零外呼) →
   * K-梯形窗 (`leg-delta-surface.rules.ts` 单点) → 圈码; 整面无 Δ / 零快照期 ⇒ bootstrap
   * 宽窗 (FR-004 唯一矩形场景)。
   * 第二段 (判腿): 同批实时值组链 → 与离线档**同一个** {@link recallCandidates} 入口 (FR-005),
   * 判腿后按同批实时 Δ 打 `bandStatus` (呈现语义, 不进成员判定)。
   *
   * 🚨 回落面全走 {@link retrieveClosing} + 既有降级标 —— 值域零扩张 (Q2 裁决)。
   * 🚨 骨架 (K / 到期日 / 周期 / OI / `oiAsOf`) 取库内最近一期 (D4「DB 只出骨架 + OI」);
   * 报价七值 + Δ + iv **只认实时批** —— 缺行 ⇒ 整条不进第二段且不污染门槛计数
   * (混合口径是 064 四缺口之一, 🚫 MUST NOT 复活)。
   *
   * 复杂度: 2 闸调用 + ≤2 次外呼 (补发 ≤1 + 主批 1) + 4 次库内查询 + `O(n)` 组链。
   */
  private async retrieveRealtimeNarrow(
    query: LegRetrievalQuery,
    intent: LegIntentTab,
    snapshots: OptionSnapshotPort,
  ): Promise<LegRetrievalResult | null> {
    const parsed = parseAnchorTicker(query.symbol);
    if (parsed === null) return null;
    // ⚠️ 写死 'us' 沿 #274 (与 loadChainWithWindow 同款已知缺陷, 🚫 不顺手修)。
    const marketDate = exchangeCalendarDate('us', query.now);
    const target = { symbol: query.symbol, market: parsed.market, marketDate, now: query.now };

    const gate = await this.resolveRealtimeGate(target);
    if (gate === 'closed') return this.retrieveClosing(query, null);
    if (gate === 'unknown') return this.retrieveClosing(query, 'gate_unknown');
    // #286: guard 在闸**之后**、定窗之前 —— 挪到闸前 = 休市时段天天见降级。
    if (!(WINDOW_SUPPORTED_MARKETS as readonly string[]).includes(parsed.market)) {
      this.logger.warn(
        `${REALTIME_DEGRADE_LOG_TAG} ${query.symbol} 市场 '${parsed.market}' 未支持窗派生, 零外呼回落收盘档 (#286)`,
      );
      return this.retrieveClosing(query, 'source_unavailable');
    }
    const basis = await this.resolveWindowBasis(target);
    if (basis.spot === null) {
      this.warnDegraded('window_basis_stale', query.symbol, {
        basisAt: basis.basisAt === null ? null : basis.basisAt.toISOString(),
        freshnessSeconds: INTRADAY_FRESHNESS_SECONDS,
      });
      return this.retrieveClosing(query, 'window_basis_stale');
    }
    const w = await this.resolveW(query.symbol);
    if (w === null) return null;

    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (Q7-B) —— 同离线共同根, 蓄意独立成路
    // (Guardrail 1: 离线零改动是结构性的, 🚫 不与 loadChainWithWindow 共函数体)。
    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
      select: { id: true },
    });
    if (instrument === null) return null;
    // CROSS-CONTEXT-READ: marketdata.option_contract 只读直查 (Q7-B) —— 适格认沽合约集。
    const contracts = await this.prisma.optionContract.findMany({
      where: {
        underlyingInstrumentId: instrument.id,
        optionType: 'PUT',
        isStandard: true,
        expiryDate: { gt: utcMidnight(marketDate) },
      },
      select: { id: true, code: true, expiryDate: true, strikePrice: true, expirationCycle: true },
    });
    if (contracts.length === 0) return null;

    // 意图 DTE 段过滤 —— 段语义单点在召回常量 (窗只圈段内, FR-002)。
    const seg = intent === 'rent' ? RENT_RECALL_DTE : BUILD_RECALL_DTE;
    const dteByExpiry = new Map<string, number>();
    const dteOf = (expiry: Date): number => {
      const key = expiry.toISOString().slice(0, 10);
      let dte = dteByExpiry.get(key);
      if (dte === undefined) {
        dte = daysToExpiry({ expiry, now: query.now, exchange: parsed.market });
        dteByExpiry.set(key, dte);
      }
      return dte;
    };
    const inSegment = contracts.filter((c) => {
      const dte = dteOf(c.expiryDate);
      return dte >= seg.min && dte <= seg.max;
    });

    const contractIds = inSegment.map((c) => c.id);
    let latest: { sessionDate: Date } | null = null;
    if (contractIds.length > 0) {
      // CROSS-CONTEXT-READ: marketdata.option_daily_snapshot 只读直查 (Q7-B) —— 最近一期定位
      // (昨日 Δ 面的归属期)。
      latest = await this.prisma.optionDailySnapshot.findFirst({
        where: { contractId: { in: contractIds } },
        orderBy: { sessionDate: 'desc' },
        select: { sessionDate: true },
      });
    }
    let snapRows: OptionDailySnapshot[] = [];
    if (latest !== null) {
      // CROSS-CONTEXT-READ: marketdata.option_daily_snapshot 只读直查 (Q7-B) —— 该期全量 =
      // 昨日 Δ 面 + OI 骨架; 同合约多来源按 quote_as_of 取新 (与离线 dedupe 同口径)。
      snapRows = await this.prisma.optionDailySnapshot.findMany({
        where: { contractId: { in: contractIds }, sessionDate: latest.sessionDate },
      });
    }
    const freshest = new Map<string, (typeof snapRows)[number]>();
    for (const row of snapRows) {
      const key = row.contractId.toString();
      const kept = freshest.get(key);
      if (kept === undefined || row.quoteAsOf.getTime() > kept.quoteAsOf.getTime()) {
        freshest.set(key, row);
      }
    }
    const previousSpot =
      [...freshest.values()].map((row) => row.underlyingSpot).find((v) => v !== null) ?? null;

    // 第一段选码: Δ 面 → K-梯形窗; 无面 ⇒ bootstrap (次日有面自动转梯形, 无第二个判据点)。
    // 🚨 昨日 `underlyingSpot` 只作 moneyness 折算分母 (Guardrail 3), 🚫 MUST NOT 当今日基准。
    const surface =
      previousSpot === null
        ? ({ kind: 'bootstrap' } as const)
        : resolveDeltaSurfaceWindow({
            faceRows: inSegment.map(
              (c): DeltaFaceRow => ({
                strike: c.strikePrice,
                expiryDate: c.expiryDate,
                delta: freshest.get(c.id.toString())?.delta ?? null,
              }),
            ),
            previousSpot,
            spot: basis.spot,
            band: DELTA_BAND_BY_INTENT[intent],
            pad: MONEYNESS_PAD_RATIO,
            w: intent === 'rent' ? w : null,
          });
    let windowed: typeof inSegment;
    if (surface.kind === 'bootstrap') {
      const wide = bootstrapWindowFor(parsed.market, basis.spot);
      windowed = inSegment.filter(
        (c) =>
          c.strikePrice.greaterThanOrEqualTo(wide.strikeMin) &&
          c.strikePrice.lessThanOrEqualTo(wide.strikeMax),
      );
    } else {
      const ks = new Set(surface.windowKs.map((k) => k.toString()));
      windowed = inSegment.filter((c) => ks.has(c.strikePrice.toString()));
    }
    this.logger.log(
      `${WINDOW_SIZE_LOG_TAG} ${query.symbol} ${intent} codes=${windowed.length} shape=${surface.kind}`,
    );
    if (windowed.length > OPTION_SNAPSHOT_MAX_CONTRACT_CODES) {
      this.warnDegraded('window_over_cap', query.symbol, {
        windowed: windowed.length,
        cap: OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
      });
      return this.retrieveClosing(query, 'window_over_cap');
    }

    // 一次批取 (FR-013: 主批恒 1; 零码 ⇒ 零外呼, 空态由第二段自然产出)。
    let batch: OptionSnapshotBatch | null = null;
    if (windowed.length > 0) {
      batch = await this.fetchQuotes(
        snapshots,
        target,
        windowed.map((c) => c.code),
      );
      if (batch === null) return this.retrieveClosing(query, 'source_unavailable');
    }

    // 组链。spot / quoteAsOf 取批内标的行与信封 (与腿报价同批同刻, 067 axis 输入同源)。
    const quoteByCode = new Map<string, OptionSnapshotRow>();
    let spot = basis.spot;
    let quoteAsOf = basis.basisAt ?? query.now;
    if (batch !== null) {
      for (const row of batch.rows) {
        if (row.isOption) quoteByCode.set(row.code, row);
        else spot = vendorDecimal(row.last) ?? spot;
      }
      quoteAsOf = batch.asOf;
    }
    const band = DELTA_BAND_BY_INTENT[intent];
    const skeleton = this.toLegRows(
      windowed.map((c) => ({ contract: c, snapshot: freshest.get(c.id.toString()) ?? null })),
      query.now,
      parsed.market,
    );
    const answered: LegChainRow[] = [];
    let missing = 0;
    for (const leg of skeleton) {
      const quote = quoteByCode.get(leg.code);
      const bid = quote === undefined ? null : vendorDecimal(quote.bid);
      const ask = quote === undefined ? null : vendorDecimal(quote.ask);
      // 买卖价皆空 ⇒ 整行按「未取到实时」处理 (064 同款判据) —— 窄路径下没有收盘值可落。
      if (quote === undefined || (bid === null && ask === null)) {
        missing += 1;
        continue;
      }
      const deltaDec = vendorDecimal(quote.delta);
      answered.push({
        ...leg,
        bid,
        ask,
        bidSize: vendorNumber(quote.bidSize),
        askSize: vendorNumber(quote.askSize),
        delta: deltaDec === null ? null : deltaDec.toNumber(),
        iv: vendorNumber(quote.iv),
        volume: vendorNumber(quote.volume),
        greeksComplete: quote.greeksComplete ?? false,
        priceKind: 'realtime',
        bandStatus: deltaDec === null ? null : withinDeltaBand(deltaDec, band) ? 'in' : 'out',
      });
    }
    if (missing > 0) {
      this.warnDegraded('partial_miss', query.symbol, { missing, requested: windowed.length });
    }

    // 链级 meta = 骨架期; 零快照期沿实时基线归属口径 (sessionDate = 交易所今天,
    // oiAsOf = 最近已收盘交易日, 日历答不出 ⇒ 放弃不猜)。
    let sessionDate: Date;
    let oiAsOf: Date;
    let source: string;
    if (latest !== null && freshest.size > 0) {
      const newest = [...freshest.values()].reduce((a, b) =>
        b.quoteAsOf.getTime() > a.quoteAsOf.getTime() ? b : a,
      );
      sessionDate = latest.sessionDate;
      oiAsOf = newest.oiAsOf;
      source = newest.source;
    } else {
      if (this.tradingCalendar === null) return null;
      const lastClosed = await this.tradingCalendar.lastClosedSession(parsed.market, query.now);
      if (lastClosed === null) return null;
      sessionDate = utcMidnight(marketDate);
      oiAsOf = utcMidnight(lastClosed);
      source = REALTIME_BASELINE_SOURCE;
    }
    const chain: LegChainMeta = {
      marketDate,
      sessionDate,
      quoteAsOf,
      oiAsOf,
      source,
      spot,
      priceKind: 'realtime',
      realtimeDegrade: null,
    };

    // 第二段: 同一判据入口, 仅输入换实时值 (FR-005 / branch 11)。
    const context: RecallContext = { spot, w };
    const outcome = recallCandidates(
      context,
      query.perspectives,
      answered,
      query.candidateCap,
      query.override,
    );
    return {
      chain,
      ...outcome,
      memberCount:
        query.override === null
          ? outcome.candidates.length
          : recallCandidates(context, query.perspectives, answered, query.candidateCap).candidates
              .length,
    };
  }

  /**
   * 067 plan D2 —— 愿买价 W: 收租成色上界锚定轴 `axis = min(spot, W)` 的另一半输入。
   *
   * 🚨 **W 派生零第二份** (FR-002): 必经 `resolveEffectiveAnchorValues` (v_manual 优先语义
   * 单点) + `computeW` (`W_COEFFICIENT` 单点), 🚫 MUST NOT 在这里手写 COALESCE 或自乘系数。
   * 每次检索现查现算 (spec Edge Case 2: v_manual 改后下一次检索即生效, 无缓存滞留)。
   *
   * 🚨 **`anchor` 是本 ctx 自有表, 这次读是 intra-ctx** —— 🚫 MUST NOT 挂 `CROSS-CONTEXT-READ`
   * (同 {@link resolveWindow} 头上那条: 假注释会让 `check-server-moat` 的注释审计链失真)。
   * 📌 +1 次 ticker 唯一索引点查, 亚毫秒级, 不动 p95 预算; select 只取
   * `resolveEffectiveAnchorValues` 所需五列。
   *
   * 锚行缺失 ⇒ `null` (调用方按「链未就绪」返, 与既有形态同, 🚫 不造新错误态): 两个读端在进
   * port 之前已对未建锚标的 404 (`ANCHOR_NOT_FOUND_FOR_SYMBOL`), 本分支结构上够不到 ——
   * fail-closed 而非猜一个轴 (spec Edge Case 3「W 恒可派生」的前提正是锚在)。
   */
  private async resolveW(symbol: string): Promise<Prisma.Decimal | null> {
    const anchor = await this.prisma.anchor.findUnique({
      where: { ticker: symbol },
      select: {
        v: true,
        confidence: true,
        vManual: true,
        lLevelManual: true,
        positionCapManual: true,
      },
    });
    if (anchor === null) return null;
    const effective = resolveEffectiveAnchorValues(
      { v: anchor.v, confidence: anchor.confidence },
      {
        vManual: anchor.vManual,
        lLevelManual: anchor.lLevelManual as LLevel | null,
        positionCapManual: anchor.positionCapManual,
      },
    );
    return computeW(effective.v);
  }

  /**
   * 055 T005 —— 整条链, **不进召回**。查询与 {@link retrieveCandidates} 完全同一批
   * ({@link loadChain} 单点), 差别只在这里不把结果喂进 `recallCandidates`。
   */
  retrieveChain(query: LegChainQuery): Promise<LegChainSnapshot | null> {
    return this.loadChain(query);
  }

  /** {@link loadChainWithWindow} 的窄出口 —— 窗是内部细节, 不出这个类。 */
  private async loadChain(query: LegChainQuery): Promise<LegChainSnapshot | null> {
    const loaded = await this.loadChainWithWindow(query);
    return loaded === null ? null : loaded.snapshot;
  }

  /**
   * 三张 marketdata 表的只读直查 + 逐腿 DTE —— **两个 port 方法的共同根**。
   *
   * 🚨 抽出来是为了让「候选集与整条链读的是同一批行」成为结构保证: 各查一份的话, 两边照样都
   * 查得出数据, 只是可能落在不同的快照期上 —— 而那时报表的骨架与选约表的候选集会对不上, 且
   * 界面上一切正常。
   *
   * ## 🚨 两个基线, 按「库内那期在不在」二选一 (见 {@link ChainBaseline})
   *
   * `latest !== null` ⇒ 库内快照当基线, 实时值走尾部覆盖 (064 原样);
   * `latest === null` ⇒ **这一批实时自己就是基线** ({@link loadRealtimeBaselineChain})。
   *
   * 后者改写了 064 的 `state_branch` 9 (「库内无任何链快照行 ⇒ 维持未就绪, MUST NOT 靠实时值
   * 单独成链」)。改的理由是那条分支盖住了一个真实缺口: 盘中建的新锚, 合约链**当场就补上了**
   * (冷启动第一相不受盘中判据约束), 缺的只有「上一交易日的收盘快照」—— 而那份快照盘中根本取
   * 不到 (vendor 的 snapshot 接口不吃时间参数), 要等当晚收盘轮。于是整个美股交易时段里, 这只
   * 锚的选约表与链报表都是「未就绪」, 而此刻的真实盘口一直是可取的。
   * 📌 那条禁令**当时是对的**: 064 没有把 OI 与归属日在实时基线下的口径定下来, 靠实时值成链
   * 就会得到一张归属日说不清的表。本片把口径定死 (整批 OI 同源 + `oiAsOf` 取最近已收盘交易日)
   * 之后, 禁令的前提才消失。
   */
  private async loadChainWithWindow(query: LegChainQuery): Promise<LoadedChain | null> {
    // 064 T003: `query.realtime` 是**每次请求**的显式开关 (`FR-015` fail-closed, 无默认值)。
    const parsed = parseAnchorTicker(query.symbol);
    if (parsed === null) return null;
    // ⚠️ **写死 `'us'` 是已知缺陷, 跟踪在 #274** —— `parsed.market` 就在上一行, 但换基准会改变
    // 用户可见的腿集合 (它喂 `expiryDate > marketDate` 这道 FR-028a 过滤 + 返回的 `chain.marketDate`),
    // 先要答「港股当天到期、尚未收盘的腿该不该滤掉」这个语义问题。#263 只参数化了同文件的 DTE
    // 基准 (`toLegRows`), 🚫 MUST NOT 顺手把这一行一起改掉 —— 两处判据面不同, 证据面也不同。
    const marketDate = exchangeCalendarDate('us', query.now);

    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚 ticker → 标的 id
    // 寻址, 读法同 `get-underlying-detail.usecase.ts`。零写、零 @Inject() 对方 use case (Q7-C)。
    const instrument = await this.prisma.instrument.findUnique({
      where: { market_code: { market: parsed.market, code: parsed.code } },
      select: { id: true },
    });
    if (instrument === null) return null;

    // CROSS-CONTEXT-READ: marketdata.option_contract 只读直查 (Q7-B) —— 该标的的**适格**认沽
    // 合约集。两个过滤都在 SQL 端: `is_standard` (047 FR-008 非标不进选约表, 但采集侧照常落库
    // FR-033) + 到期日 **>** 当日 (047 FR-028a 已到期腿不可交易; 🚨 与完整性分母的 `≥` 故意
    // 不同, 047 Guardrail 7)。本片呈现面只含认沽, 采集侧的 CALL 照常在库里。
    const contracts = await this.prisma.optionContract.findMany({
      where: {
        underlyingInstrumentId: instrument.id,
        optionType: 'PUT',
        isStandard: true,
        expiryDate: { gt: utcMidnight(marketDate) },
      },
      // `expirationCycle` 是月度链标的判据输入 (#45) —— **同一次查询多带一列**, 零额外往返。
      select: { id: true, code: true, expiryDate: true, strikePrice: true, expirationCycle: true },
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
    // 🚨 库内一期都没有 ⇒ 换基线, 不再直接判「未就绪」(见方法头「两个基线」段)。
    if (latest === null) {
      return this.loadRealtimeBaselineChain(query, parsed.market, marketDate, contracts);
    }

    // CROSS-CONTEXT-READ: marketdata.option_daily_snapshot 只读直查 (Q7-B) —— 该期全部行。
    // 幂等键第三段是**来源** (047 FR-040) ⇒ 同一合约同一交易日可能有 eod 与 premarket_backfill
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

    const rows: { contract: (typeof contracts)[number]; snapshot: (typeof snapshots)[number] }[] =
      [];
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

    const legs = this.toLegRows(rows, query.now, parsed.market);

    const chain: LegChainMeta = {
      marketDate,
      sessionDate: latest.sessionDate,
      quoteAsOf: newest.quoteAsOf,
      oiAsOf: newest.oiAsOf,
      source: newest.source,
      spot,
      priceKind: 'eod_close',
      // 064 T007a: 库内读出来的那一份**不是降级** —— 降级标只由本方法尾部的 overlay 按「本该
      // 外呼却没给成」写上。🚫 MUST NOT 在这里按 `query.realtime` 预填: 那就是让它与开关
      // 互相推导, 而开关为真时最常见的结局恰恰是**正常的**收盘档 (非交易时段)。
      realtimeDegrade: null,
    };
    // 🚨 **overlay 的插点就在这里** —— `legs` 已组装、`return` 之前, 见类文件头。关态 (或读取口
    // 未绑定) 时**一行都不执行**, 结果与 064 之前逐字节相同 (FR-016 / SC-005)。
    // 🚨 这两条**都不算降级** (T007a): 未开实时是调用方的选择; 读取口整个没绑定则连闸都没判过,
    // 「本该外呼」这个前提结构上不成立。📌 mock 档下读取口是**绑定着的**降级实现 (见 T002), 但
    // 那条路轮不到它: `MARKET_STATE_PORT` 经 `collectionPort` 注册, mock 下是 054 的拒绝壳 ⇒
    // `resolveRealtimeGate()` 一调即抛, 判 `'unknown'` 后**在发起 fetch 之前**就 fail-closed,
    // 于是 mock 档实际标的是 `gate_unknown` 而非 `source_unavailable` (T012 契约冒烟实跑证实)。
    // 🚫 MUST NOT 在这里预置一个降级标充数。
    if (!query.realtime || this.snapshots === null) {
      return { snapshot: { chain, legs }, window: null };
    }
    return this.overlayRealtimeQuotes(
      this.snapshots,
      { symbol: query.symbol, market: parsed.market, marketDate, now: query.now },
      chain,
      legs,
      'db_snapshot',
    );
  }

  /**
   * `contract ⋈ snapshot?` → 腿行 —— **两个基线共用的唯一装配点**。
   *
   * 🚨 `snapshot === null` = {@link ChainBaseline} 为 `realtime_batch` 时的**骨架行**: 报价列
   * 与 OI 全空、`greeksComplete` 取 `false`, 由 {@link applyRealtimeBatch} 逐行填上。
   * 🚫 **MUST NOT 为骨架另写一份字面量**: 两份字面量必漂移, 而漂移的表现是「某一列在新锚上
   * 永远是空的」—— 那张表照样渲染得出来, 没有任何断言会红。
   *
   * 🚨 `market` 必填 (#263): DTE 基准是**该锚所属交易所的今天**。此前 `daysToExpiry` 内部写死
   * `'us'`, 而 `IMPORTABLE_MARKETS` 含 `hk` 且本方法所在的 `db_snapshot` 基线路径**不经过**
   * `bootstrapWindowFor` 那道「未支持市场即抛」的闸 ⇒ 港股锚一路用美股基准算完、不会红。港股与宿主
   * 同为 UTC+8, 北京上午 ET 尚未翻日 ⇒ 那段窗口里每条腿的 `dteDays` 恒偏 1 天, 而建仓腿
   * `DTE ≤ 14` / 收租腿 `DTE ∈ [150,365]` 两条带判据直接读它。
   *
   * 复杂度 `O(n)`。DTE 按到期日缓存: 合约数百行、到期日只有几十个 ⇒ `daysToExpiry` 每个日期
   * 只算一次 (基准 `market` 单次调用内恒定, 故仍可只按到期日做键)。
   */
  private toLegRows(
    rows: readonly { contract: ChainContractRow; snapshot: OptionDailySnapshot | null }[],
    now: Date,
    market: string,
  ): LegChainRow[] {
    const dteByExpiry = new Map<string, number>();
    return rows.map(({ contract, snapshot }) => {
      const key = contract.expiryDate.toISOString().slice(0, 10);
      let dteDays = dteByExpiry.get(key);
      if (dteDays === undefined) {
        dteDays = daysToExpiry({ expiry: contract.expiryDate, now, exchange: market });
        dteByExpiry.set(key, dteDays);
      }
      return {
        code: contract.code,
        expiryDate: contract.expiryDate,
        dteDays,
        strike: contract.strikePrice,
        bid: snapshot?.bid ?? null,
        ask: snapshot?.ask ?? null,
        bidSize: numberOf(snapshot?.bidSize ?? null),
        askSize: numberOf(snapshot?.askSize ?? null),
        delta: numberOf(snapshot?.delta ?? null),
        // 🚫 原样带出, 不换算 —— 见 `LegChainRow.iv`。
        iv: numberOf(snapshot?.iv ?? null),
        openInterest: numberOf(snapshot?.openInterest ?? null),
        volume: numberOf(snapshot?.volume ?? null),
        // 骨架恒 `false` —— 「没有这批数」与「有但不全」在下游同归 (都不判档), 而此处**没有
        // 任何一批 greeks 可描述**, 标成 `true` 就是凭空担保。实时基线下它由 overlay 改写。
        greeksComplete: snapshot?.greeksComplete ?? false,
        // 🚫 vendor 原样带出, 不归一化大小写、不回落默认值 —— 判据是白名单 `=== 'MONTH'`,
        // 在这里「顺手」规整会让「vendor 换了取值」这件事在打标层看不出来 (`leg-mark.rules.ts`)。
        expirationCycle: contract.expirationCycle,
        // 064 T003: 库里读出来的就是收盘档 —— 这里是**唯一**的落点, 实时档由
        // {@link overlayRealtimeQuotes} 逐行改写 (T004a)。🚫 MUST NOT 在下游任何一层「补标」:
        // 补标点有第二个,「这个数是什么时候的」就有两个答案, 而两个答案都渲染得出来。
        priceKind: 'eod_close',
        // 068: 带标只在实时窄路径由同批实时 Δ 打; 库内读出的收盘档恒无带语义。
        bandStatus: null,
      };
    });
  }

  /**
   * **实时独载基线** —— 库内一期快照都没有时, 这一批实时报价**自己就是基线**
   * (改写 064 `state_branch` 9, 理由见 {@link loadChainWithWindow} 方法头)。
   *
   * 触发形态实际上只有一个: **盘中新建的锚**。冷启动第一相 (链发现 + 日线) 不受盘中判据约束
   * ⇒ 合约表当场就有行; 第二相的期权快照撞盘中闸落 `intraday_skipped` ⇒ 快照表零行, 要等当晚
   * 收盘轮。于是整个美股交易时段里这只锚都答「未就绪」, 而此刻的真实盘口一直取得到。
   *
   * 🚨 **`oiAsOf` 取最近一个已收盘交易日, 与实时 OI 的归属由构造对齐**: 美股期权 OI 盘前更新、
   * 盘中冻结 ⇒ 此刻取回的那个数归属的正是上一场收盘 (与 marketdata
   * `resolveSnapshotAttribution` 在
   * 同一时点上的取值逐字相同)。日历答不出这一天 ⇒ **放弃, 不猜** —— 猜错就是一整页 OI 顶着
   * 错误的归属日, 而整页渲染正常。
   * 🚨 **`sessionDate` 取交易所的今天**: 屏上的报价列全部来自此刻, 归属**正在进行的这一场**。
   * 🚫 MUST NOT 退回上一场 —— 那会让区块级 `asOf` 与它标注的那批数差一整天。新鲜度档因此判
   * `CURRENT`(`freshness-tier.ts` 是 `asOf >= lastClosedSession`), 与它文件头写明的「夜间管线
   * 刚落库完最新一场时 asOf 可以比上界还新」同属一档, 不是新开的口子。
   * 🚨 **拿不到实时值 ⇒ 仍返 `null`(未就绪)**: 四条整体回落路径 (两闸不成立 / 基准陈旧 /
   * 源不可达 / 标的现价缺失) 在本基线下都没有收盘档可落, 结局与本片上线前**逐字节相同**。
   * 🚫 MUST NOT 端出一张全空的表 —— 那与「链坏了」在屏上分不开。
   *
   * 📌 **本基线下的呈现面窄一圈, 且是窗的形状**: 窗是 `strike ∈ [0.7, 1.05] × spot` ∧
   * `DTE ∈ [两视角召回段的并集]`, 窗外的腿这一次**根本没被问过价** ⇒ 整条不呈现。影响只落在
   * **全腿视角** (它本就不设 DTE 段与行权价上界); 两个意图视角的召回段本就是窗的来源, 收不窄。
   * 🚨 **收租的成色上界不受影响, 这点是算出来的不是指望的**: 上界 = `min{K ≥ axis}` 与
   * `axis × (1 + 0.03)` 取严 (067 起 `axis = min(spot, W)` ≤ spot), 而窗的行权价上沿是
   * `spot × 1.05` ⇒ 比例项恒 ≤ 窗沿。网格密时结构项落在窗内、原样保留; 网格疏到窗内无档时
   * 结构项在两个集合上分别是「窗外那一档」与 `null`, 而两者与比例项取严后**同为比例项**
   * ⇒ 逐点等价。📌 067 后多出一个数值角落: axis 深低于窗下沿 (W < 0.7 × spot) 时结构项可能落
   * 在窗外更低处, 上界**数值**可差 < 3% —— 但那时两个值都低于窗内全部行权价, 收租**成员集**
   * 仍逐点相同 (差只出现在下发的默认值上, 且该域正是「太贵 ⇒ 默认空」的空态域)。
   * 📌 窗外的腿在本基线下不进候选池 (068 起绊线已整体退役)。可接受
   * —— 它守的是包络的**长期**漂移, 而本基线是**当天自愈**的过渡态 (当晚收盘轮写完基线, 次日
   * 即走库内那条路)。🚫 MUST NOT 因此把窗外的空行留在结果里充数。
   *
   * 复杂度: 1 次日历调用 + overlay 那一趟 (1 次自有表点查 + ≤1 次外呼 + `O(n)`)。DB 查询次数
   * 比库内基线**少一次** —— 该期全量那一查跳过了。
   */
  private async loadRealtimeBaselineChain(
    query: LegChainQuery,
    market: string,
    marketDate: string,
    contracts: readonly ChainContractRow[],
  ): Promise<LoadedChain | null> {
    // 关态 / 读取口未绑定 ⇒ 压根没有第二个数据源, 结局同 064 之前 (零外呼 + 未就绪)。
    if (!query.realtime || this.snapshots === null) return null;
    // 🚫 归属日不猜 (见方法头)。日历端口未绑定时两闸本就判 `unknown` ⇒ 两条路殊途同归。
    if (this.tradingCalendar === null) return null;
    const oiAsOf = await this.tradingCalendar.lastClosedSession(market, query.now);
    if (oiAsOf === null) return null;

    const legs = this.toLegRows(
      contracts.map((contract) => ({ contract, snapshot: null })),
      query.now,
      market,
    );
    const chain: LegChainMeta = {
      marketDate,
      sessionDate: utcMidnight(marketDate),
      oiAsOf: utcMidnight(oiAsOf),
      source: REALTIME_BASELINE_SOURCE,
      // 🚨 下面两格是**占位**: 它们由 {@link applyRealtimeBatch} 成功那一支整体改写, 而失败的
      // 每一支都返 `null` ⇒ 结构上逃不出去 (有反例钉死这一点)。
      // 🚨 取值蓄意选**荒谬值而不是看着合理的数**: 万一哪天真漏出去, `spot = 0` 会让权利金门槛
      //    当场崩、时刻显示 1970 —— 一眼可见; 填个「合理」的数则会渲染出一张看起来正常的错表。
      quoteAsOf: new Date(0),
      spot: new Prisma.Decimal(0),
      priceKind: 'eod_close',
      realtimeDegrade: null,
    };
    const loaded = await this.overlayRealtimeQuotes(
      this.snapshots,
      { symbol: query.symbol, market, marketDate, now: query.now },
      chain,
      legs,
      'realtime_batch',
    );
    if (loaded === null) return null;

    // 🚨 **没拿到实时值的行整条丢弃** —— 本基线下它们没有任何可回落的值。留着的话它们会被权利金
    // 门槛挡下并计进 `removedByPremiumFloor`, 屏上于是出现「被权利金门槛移出 N 条」, 而那 N 条
    // **根本没被问过价**: 一个真实、可读、且完全错的数。
    // 📌 判据取 `priceKind` 而非「bid 是不是空」: 前者是 overlay 的判决 (窗外 / 停牌 / 买卖价
    //    皆空 三种情形它都留 `eod_close`), 后者会把「vendor 说此刻确实没有买价」也一并算进来。
    const quoted = loaded.snapshot.legs.filter((leg) => leg.priceKind === 'realtime');
    if (quoted.length === 0) return null;
    return { snapshot: { chain: loaded.snapshot.chain, legs: quoted }, window: loaded.window };
  }

  /**
   * 实时取数的**两闸交集** (064 `FR-011` / `state_branch` 3, plan D3) —— 复用 061 已 ship 的
   * 那两个端口, 判据一个字不重写。
   *
   * | 闸 | 答的问题 | 关掉时的结局 |
   * | --- | --- | --- |
   * | {@link MarketStatePort} | **此刻**是不是常规连续交易时段 | 盘前 / 盘后 / 夜盘 / 闭市不外呼 |
   * | {@link TradingCalendarPort} | **今天**是不是交易日 | 节假日不外呼 |
   *
   * 🚨 **取交集不是洁癖**: 少了日历闸, 节假日里 vendor 报的时段状态未必翻转; 少了时段闸,
   * 交易日的凌晨照样外呼。两种漏法都**只多烧配额、结果照样渲染得出来**。
   * 🚨 **`unknown` 落在放行侧** (062 的判据): 「日历还没填到这一天」不是「今天不是交易日」——
   * 写成 `!== 'trading'` 就是把 062 修掉的那个 closed-world 病原样犯回去。
   * 🚨 **任何一闸自身出故障 ⇒ fail-closed 不外呼** (同 061 tick 的处置): 不知道开没开市就去问价,
   * 等于把白名单判据作废。🚫 MUST NOT 猜「大概开着」。
   *
   * 🚨 **出参是三态而不是布尔** (064 T007a): 「闸说没开市」与「闸自己坏了」对外呼的结局相同,
   * 对**用户**却是两件事 —— 前者天天如此 (收盘档是常态), 后者是「我们不知道此刻该不该给实时」。
   * 只有分得开, 链级降级标才敢在前者上恒 `null` (见 {@link LegChainMeta.realtimeDegrade})。
   *
   * 复杂度: 1 次市场状态调用 + 1 次日历判定, 均为 `O(1)`。
   */
  private async resolveRealtimeGate(target: {
    readonly symbol: string;
    readonly market: string;
    readonly marketDate: string;
  }): Promise<RealtimeGate> {
    // 两个端口任一未绑定 ⇒ 判不了闸 ⇒ 不外呼, 且**不是**「今天休市」(可空注入的默认结局与故障
    // 时一致: 都是「不知道」)。
    if (this.marketState === null || this.tradingCalendar === null) return 'unknown';
    try {
      const sessions = await this.marketState.getMarketSessions();
      const session = sessions.find((state) => state.market === target.market)?.session;
      if (session !== 'regular') return 'closed';
      const calendar = await this.tradingCalendar.classify(target.market, target.marketDate);
      return calendar === 'non-trading' ? 'closed' : 'open';
    } catch (error) {
      this.logger.warn(
        `实时档闸判定失败, 本次 fail-closed 走收盘档 (064 FR-011): ${target.symbol} — ` +
          describeError(error),
      );
      return 'unknown';
    }
  }

  /**
   * 一次带**请求级超时**的实时取数 (064 `FR-011`「源不可达 / 超时」)。失败一律 `null`,
   * 调用方据此整体回落收盘档。
   *
   * 🚨 **本片只有超时, 🚫 MUST NOT 新建断路器** (plan D3 / Guardrail 1): 熔断住在 061 的 tick
   * (`sync-anchor-intraday.ts`, 阈值 `INTRADAY_CIRCUIT_THRESHOLD`), 它保护的是每 30 秒一拍的
   * scheduler; 上游熔断经「停写盘中价 → 基准判陈旧」传导到这里, **不需要本片有第二套状态**。
   * 两套阈值必然不同步, 而不同步的表现是「一边说熔断了、一边照常外呼」。
   * 🚨 **按类型分流**: mock 档下读取口抛的 `RealtimeOptionSnapshotUnavailableError` 走的也是这条
   * 路 —— 它是「本环境没有实时源」而非故障, 落收盘档正是 dev 想要的形态 (故只记一行 warn)。
   */
  private async fetchQuotes(
    port: OptionSnapshotPort,
    target: { readonly symbol: string },
    contractCodes: string[],
  ): Promise<OptionSnapshotBatch | null> {
    try {
      return await withTimeout(
        port.getSnapshots({ underlyingSymbol: target.symbol, contractCodes }),
        REALTIME_SNAPSHOT_TIMEOUT_MS,
        `${target.symbol} (${contractCodes.length} codes)`,
      );
    } catch (error) {
      this.logger.warn(
        `实时报价取回失败, 整体回落收盘档 (064 FR-011): ${target.symbol} — ${describeError(error)}`,
      );
      return null;
    }
  }

  /**
   * 本次实时取数的**候选范围** (064 `FR-005` / `FR-006` / plan D4 / D5)。基准缺失或已被
   * 061 的新鲜度闸判陈旧 ⇒ `null`, 调用方据此整体回落收盘档 (`state_branch` 14)。
   *
   * 🚨 **`anchor` 是本 ctx 自有表, 这次读是 intra-ctx** —— 🚫 MUST NOT 在它上方挂
   * `CROSS-CONTEXT-READ`: 那等于在代码里留一条「anchor 归别的 ctx」的**假注释**, 而本仓的
   * 护城河审计链完全靠这类注释承载 (`check-server-moat.ts` 按 import 来源与表归属判 ctx)。
   *
   * 🚨 **基准与判据用的现价是两个数, 🚫 MUST NOT 合并** (plan D5): 这里的基准只圈「问哪些合约」,
   * 容得下一个采集周期 (≤30 s) 的滞后; 判据与表头吃的那个必须与腿报价**同刻**, 它随本批一起回来
   * ({@link overlayRealtimeQuotes} 里的 `isOption: false` 那行)。拿这个去喂判据 =「按此刻筛」不成立;
   * 拿那个来定窗 = 得先发一次请求才能知道该请求哪些合约。
   *
   * 复杂度: 1 次自有表点查 + `O(1)` 派生。
   */
  private async resolveWindowBasis(target: {
    readonly symbol: string;
    readonly now: Date;
  }): Promise<ResolvedBasis> {
    const anchor = await this.prisma.anchor.findUnique({
      where: { ticker: target.symbol },
      select: { intradayPrice: true, intradayAt: true },
    });
    // 一级: 盘中基准新鲜 (068 FR-006 / state_branch 4)。
    // 🚨 新鲜度闸复用 061 的单点 {@link isIntradayFresh} —— 🚫 MUST NOT 在这里再判一次「多久算旧」:
    // 两处阈值必漂移, 而漂移的表现是「窗按一个已经没人维护的价定出来」, 结果照样渲染得出来。
    if (
      anchor !== null &&
      anchor.intradayPrice !== null &&
      isIntradayFresh(anchor.intradayAt, target.now)
    ) {
      return { spot: anchor.intradayPrice, basisAt: anchor.intradayAt };
    }
    // 二级: 实时补一发 (068 FR-006 / state_branch 5) —— 空码批只取标的自身那行。
    // 🚫 MUST NOT 新造 TTL 缓存 (第二个会漂移的 spot 真相源); 补发至多一次 (FR-013 预算)。
    if (this.snapshots !== null) {
      const batch = await this.fetchQuotes(this.snapshots, target, []);
      const last = batch?.rows.find((row) => !row.isOption)?.last ?? null;
      if (batch !== null && last !== null) {
        return { spot: new Prisma.Decimal(last), basisAt: batch.asOf };
      }
    }
    // 三级: 显式落空 (state_branch 6) —— 🚫 MUST NOT 拿昨收定窗 (陈旧轴), 调用方零再外呼回落。
    return { spot: null, basisAt: anchor?.intradayAt ?? null };
  }

  /**
   * 用**此刻**的报价覆盖库内收盘档 —— 七个值 + 描述其中两个的那一个标 (064 FR-001 / FR-002)。
   *
   * 🚨 **写入面 = 七个值**: `bid` / `ask` / `bidSize` / `askSize` / `delta` / `iv` / `volume`。
   * 派生量 (成交额 / 单笔权利金 / 价差及其相对值) 由下游从这七个值现算 ⇒ 自动成为实时口径,
   * 🚫 MUST NOT 为它们另设覆盖路径 (FR-003: 派生量有第二个来源就等于同一个数在两处各算一份)。
   * 🚨 **外加 `greeksComplete` —— 它不是第八个值, 是描述 `delta` / `iv` 这两格的标**, 故必须
   * 跟着那两格一起翻。留着库内那个, 就是让一个标去描述**一批已经不在屏上的数**, 两个方向都坏
   * 且都渲染得出来:
   * · 昨收深实值腿 IV 无解 (库内 `false`)、此刻实时给全了 ⇒ `get-legs.usecase.ts` 的
   *   `deriveDeltaColumns(greeksComplete ? delta : null)` 把值掐掉 ⇒ Δ 与 σ 距空着、不判档不
   *   着色 (FR-007 的「数据不全」形态被误触发), 而数据就在手里;
   * · 昨收齐全 (库内 `true`)、此刻实时的 Δ/IV 皆空 ⇒ 契约上下发「greeks 齐全」而两格是 `null`。
   * 📌 与下面 OI 那条**判据相反且不冲突**: OI 盘中冻结 ⇒ 此刻取回的与库内**是同一个数**, 覆不
   * 覆盖都一样, 故按 FR-004 不纳入; `greeksComplete` 描述的两格**已经被换掉了**, 不跟就是错的。
   * 🚨 **持仓量在库内基线下恒取库内** (FR-004 / plan D8)。依据是实测: 美股期权 OI 盘前更新、
   * 盘中冻结 ⇒ 此刻取回的与库内是同一个数。
   * ⚠️ **这条保证的强度在实时独载基线落地时降了一档, 记在这里免得被误读**: 064 原实现让
   * `openInterest` **根本不出现在下面的字面量里**, 于是「不被覆盖」是编译期事实; 现在它出现了,
   * 只是按 {@link ChainBaseline} 分两支 —— 「库内基线下不被覆盖」自此由**反例测试**承载
   * (`optionsdesk-064.overlay.it.spec.ts` 的 `FR-004` / `SC-006`: 实时批喂与库内不同的 OI, 断言
   * 两档逐字节相同)。换来的是「一条链的 OI 只有一个来源」这件事在**两个基线上都成立**, 而
   * 「空就填」那种写法两头都保不住。
   * 🚨 `netOpenInterest` / `oiAsOf` 的编译期保证**原样保留**: 它们根本不在 {@link LegChainRow}
   * 上。🚫 MUST NOT 为了与 OI「对称」把它们纳入再跳过。
   * 🚨 **不自己解信封**: 经读取口拿已解析好的 `OptionSnapshotBatch` (信封单点已由 PR #116 收口)。
   * 若发现自己在写第二处 `res?.rows` / `as_of` 解析, 说明走错了路。
   *
   * 📌 返回集里**库内不存在的合约直接忽略** (`state_branch` 10, 盘中新挂 —— 本片不在盘中重跑
   * 链发现, 次日收盘采集自然补上): 按库内 `legs` 逐条去查返回集, 多出来的那些结构上够不着。
   *
   * 🚨 **问的只是窗内那批** (064 T004b): `contractCodes` 由 {@link resolveWindow} 圈出,
   * 🚫 MUST NOT 把整条链一股脑塞进去 —— 单批有硬上限 (`OPTION_SNAPSHOT_MAX_CONTRACT_CODES`),
   * 超了 shim **整批 400 拒绝**。窗外的腿照常留在结果里, 只是带着收盘档的价 (逐行档位, FR-009)。
   * 🚨 **表头 / 链级 spot 取返回集里 `isOption: false` 那行** (`FR-006a`) —— 🚫 MUST NOT 用
   * {@link resolveWindow} 那个定窗基准: 判据吃的数与呈现的数必须与腿报价同刻, 否则「按此刻筛」
   * 这句话当场不成立, 而两个数都渲染得出来。
   *
   * 🚨 **四条降级路径全部收在这一段** (064 T005 / `FR-011`): 两闸不成立 / 基准不可用 / 取回失败
   * 三条**整体**回落收盘档 (原样返回 `legs`, 一个值都不动), 第四条 (部分合约未返回 · 单腿关键
   * 报价为空) 由 {@link applyRealtimeBatch} **逐行**处理。🚫 MUST NOT 回落成 0 / 清空既有值:
   * 0 在买卖价上读作「有人挂到 0」, 与「没取到」是两件事, 而两者在屏上都显示得出来。
   *
   * 复杂度: ≤1 次外呼 + `O(m)` 建索引 + `O(n)` 逐腿覆盖 (m = 返回行数, n = 库内腿数)。
   */
  private async overlayRealtimeQuotes(
    port: OptionSnapshotPort,
    target: {
      readonly symbol: string;
      readonly market: string;
      readonly marketDate: string;
      readonly now: Date;
    },
    chain: LegChainMeta,
    legs: readonly LegChainRow[],
    baseline: ChainBaseline,
  ): Promise<LoadedChain | null> {
    /**
     * 整体回落路径的共同落点 —— 值一个不动, 只在 meta 上说清**本该给实时却没给成**没有。
     *
     * 🚨 `null` 那一支与关态**逐字节相同** (`realtimeDegrade` 在 `chain` 上已是 `null`, 展开
     * 不改键序也不改值); 非 `null` 那一支只多这一个字段的取值。
     *
     * 🚨 **`realtime_batch` 基线下没有收盘档可落 ⇒ 一律 `null`(未就绪)**: 那时 `legs` 是一批
     * 报价全空的骨架, 端出去与「链坏了」在屏上分不开; 而 `chain` 上的 `spot` / `quoteAsOf`
     * 还是占位值 —— 本支是它们**唯一**可能的逃逸口, 堵死在这里。
     */
    const eodClose = (realtimeDegrade: RealtimeChainDegradeKind | null): LoadedChain | null =>
      baseline === 'realtime_batch'
        ? null
        : { snapshot: { chain: { ...chain, realtimeDegrade }, legs }, window: null };

    // ① 非常规交易状态 / 当日非交易日 ⇒ **零外呼** (`state_branch` 3)。
    // 🚨 `'closed'` 是**正常收盘档**, 降级标恒 `null` —— 北京白天美股休市, 天天如此。给它刷上
    // 降级 = 造一个永远为真的告警, 真出事那天它也就不再有人看 (T007a 的核心反例)。
    // 🚨 `'unknown'` 相反: 外呼同样没发, 但我们**不知道**此刻该不该发 ⇒ 如实标降级。
    const gate = await this.resolveRealtimeGate(target);
    if (gate === 'closed') return eodClose(null);
    if (gate === 'unknown') return eodClose('gate_unknown');

    // ①b 该市场尚无候选范围派生能力 ⇒ **零外呼**整体回落。`bootstrapWindowFor` 对未支持市场
    // MUST throw (FR-008, 判据本身正确且不动), 但在读路径上放它抛会一路冒到 use case 的宽
    // catch 判成 `read_failed` —— 把「该市场还没接实时」呈现成「读故障」, 整表打红。
    // 🚨 **必须在闸之后判**: 闸 `'closed'` 时是正常收盘档 (降级标恒 `null`), 挪到闸前会让
    // 港股用户在休市时段天天看见降级 —— T007a「永远为真的告警」的翻版。
    // 📌 语义与 mock 档「本环境无实时源」同类 ⇒ 复用 `source_unavailable`, 🚫 不新造第四态
    // (扩值域要动契约与呈现, 归 P2 的 market 参数化整体处理)。
    if (!(WINDOW_SUPPORTED_MARKETS as readonly string[]).includes(target.market)) {
      this.logger.warn(
        `市场 '${target.market}' 尚未支持实时候选范围派生, 本次整体回落收盘档 (064 FR-011): ` +
          target.symbol,
      );
      return eodClose('source_unavailable');
    }

    // ② 定窗基准缺失 / 陈旧 ⇒ 窗无从定起 ⇒ 整体回落, 仍是零外呼 (`state_branch` 14)。
    // 🚫 MUST NOT 退而用收盘价定出一个窗来: 那是拿昨天的边界去圈今天的合约, 且外表看不出来。
    const basis = await this.resolveWindowBasis(target);
    const basisAt = basis.basisAt;
    const window = basis.spot === null ? null : bootstrapWindowFor(target.market, basis.spot);
    if (window === null) {
      this.warnDegraded('window_basis_stale', target.symbol, {
        basisAt: basisAt === null ? null : basisAt.toISOString(),
        // 🚫 阈值取 061 的派生单点, MUST NOT 在留痕里手写第二个 90 —— 调参那天日志会开始骗人。
        freshnessSeconds: INTRADAY_FRESHNESS_SECONDS,
      });
      return eodClose('window_basis_stale');
    }

    // ③ 窗内条数超单批上限 ⇒ **整体回落 + 零外呼** (`FR-018` / `state_branch` 7, plan §分批)。
    // 🚫 **MUST NOT 截断到前 `OPTION_SNAPSHOT_MAX_CONTRACT_CODES` 条**: 少一截的候选集**外表
    // 完全正常** —— 被裁掉的那批带着收盘档的价照常渲染, 用户无从知道自己看的是一个残缺的口径。
    // fail-closed 至少把整表都标成收盘档, 那是说得清的一句话。
    // 🚫 MUST NOT 在本 ctx 再写一个 399 / 400 —— 上限单点在 `option-snapshot.port.ts`
    // (它是 `shim 400 上限 − 标的自身那行`, 两处各写一份会在改批量那天静默撞 400 整批被拒)。
    const windowed = legs.filter((leg) => withinWindow(leg, window));
    if (windowed.length > OPTION_SNAPSHOT_MAX_CONTRACT_CODES) {
      this.warnDegraded('window_over_cap', target.symbol, {
        windowCodes: windowed.length,
        cap: OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
      });
      return eodClose('window_over_cap');
    }
    const contractCodes = windowed.map((leg) => leg.code);

    // ④ 源不可达 / 超时 ⇒ 整体回落 (`state_branch` 4)。**闸已判开** ⇒ 这一路必是降级:
    // 北京 22:00 美股盘中源挂了, 界面若与正常盘后长得一样, 用户就又一次拿着昨天的盘口做决定。
    const batch = await this.fetchQuotes(port, target, contractCodes);
    if (batch === null) return eodClose('source_unavailable');

    // ⑤ 标的现价缺失 ⇒ 显式「未就绪」(`state_branch` 6 / FR-012), 🚫 MUST NOT 拿收盘价顶替:
    // 顶替会让「链坏了」看起来像正常, 正是本仓反复吃亏的那类静默。
    const applied = applyRealtimeBatch(chain, legs, batch, baseline);
    if (applied === null) return null;
    this.reportPartialMiss(target.symbol, contractCodes, batch);
    return { snapshot: applied, window };
  }

  /**
   * 问了但没回来的那几条 (064 `FR-023` `partial_miss`, `state_branch` 5)。零缺失 ⇒ 不留痕。
   *
   * 🚨 判据是「**请求里有、返回集里没有**」而不是「这一行没被覆盖」: 后者会把
   * `state_branch` 11 (行回来了但买卖价皆空) 一并算进来, 而那是另一回事 —— vendor 给了这一行、
   * 只是此刻没有盘口。两者混成一个数, 「实时源今天漏了多少合约」就再也问不出来。`O(m + n)`。
   */
  private reportPartialMiss(
    symbol: string,
    requested: readonly string[],
    batch: OptionSnapshotBatch,
  ): void {
    const returned = new Set(batch.rows.filter((row) => row.isOption).map((row) => row.code));
    const missing = requested.filter((code) => !returned.has(code)).length;
    if (missing === 0) return;
    this.warnDegraded('partial_miss', symbol, { missing, requested: requested.length });
  }

  /**
   * 三类**本片特有**失败的结构化留痕 (064 `FR-023`, plan D11) —— 单点。
   *
   * 行首是 {@link REALTIME_DEGRADE_LOG_TAG}, 其后是一段 JSON, 类别在 `kind` 上 ⇒ 聚合器
   * 按 tag 捞行、按 `kind` 分组即可, 不必对中文正文写正则。体例照 061 的
   * `sync-anchor-intraday.ts` (`JSON.stringify` 一个扁平对象)。
   *
   * 🚨 **只有这三类走这里**: `FR-011` 的通用降级 (两闸判定失败 / 源不可达 / 超时) 照常各自
   * 留 warn, 但**不带这个 tag** —— 带上就等于把「本片特有的失败」这个问题作废 (`SC-010`),
   * 而聚合出来的图照样画得出来。
   * 🚨 **不新建心跳 / 健康指标** (plan D11): 通道级健康由 061 的 tick 回答, 本片按需触发,
   * 「没人看就没数据」的指标当哨兵会把「今天没人开选约表」读成「通道挂了」。
   */
  private warnDegraded(
    kind: RealtimeDegradeLogKind,
    symbol: string,
    detail: Readonly<Record<string, unknown>>,
  ): void {
    this.logger.warn(`${REALTIME_DEGRADE_LOG_TAG} ${JSON.stringify({ kind, symbol, ...detail })}`);
  }
}

/**
 * 一批实时报价 → 覆盖后的链 (064 T004a 的七列 + T005 的**逐行**降级)。标的现价缺失 ⇒ `null`
 * (「未就绪」, `state_branch` 6)。纯函数, `O(m + n)`。
 *
 * 🚨 **逐行档位不是页级一刀切** (FR-009 / `state_branch` 5 / 11): 返回集里少了几个合约是常态
 * (停牌 / 刚摘牌), 那几条保留收盘值并标 `'eod_close'`, 其余照常标 `'realtime'`。整页统一降级与
 * 整页统一标实时**都渲染得出一张完整的表**, 只有逐行标才分得出来。
 *
 * 🚨 **`baseline` 只多管一件事: OI 归谁写** (见 {@link ChainBaseline})。`db_snapshot` 下 OI
 * 恒取库内 (FR-004 一字不动); `realtime_batch` 下库内**没有**这个数, 由同一批实时写入 ——
 * 而那一批的归属日与本链的 `oiAsOf` 由构造对齐。🚫 MUST NOT 把它降级成「库内为空就填」的
 * 单元格级规则: 那会在 `db_snapshot` 基线上把一个 T−1 的 OI 放进标着 T−2 的表里, 而整页渲染
 * 正常、数字真实、只是差一天。
 */
function applyRealtimeBatch(
  chain: LegChainMeta,
  legs: readonly LegChainRow[],
  batch: OptionSnapshotBatch,
  baseline: ChainBaseline,
): LegChainSnapshot | null {
  const quoteByCode = new Map<string, (typeof batch.rows)[number]>();
  let spot: Prisma.Decimal | null = null;
  for (const row of batch.rows) {
    if (row.isOption) {
      quoteByCode.set(row.code, row);
      continue;
    }
    // 标的自身那行: spot 落在 `last` 上 (同 047 采集侧口径 `sync-option-snapshot.usecase.ts`)。
    spot = vendorDecimal(row.last) ?? spot;
  }
  if (spot === null) return null;

  return {
    // 区块级时刻取**信封的采集时刻** (FR-010) —— 🚫 MUST NOT 用行内 `vendorUpdateTime` 顶替:
    // 那是最后成交时刻, 低流动性腿上它可以停在上周 (`OptionSnapshotRow.vendorUpdateTime`)。
    // 🚨 `realtimeDegrade` 原样保持 `null` (T007a): 本批**取到了**实时值, 返回集里少几个合约是
    // 逐行的事 (那几行标 `'eod_close'`), 🚫 MUST NOT 因此把整块拉成降级态 —— 值域上
    // `partial_miss` 结构性够不着链级字段, 这里只是把「为什么」写下来。
    chain: { ...chain, quoteAsOf: batch.asOf, priceKind: 'realtime', spot },
    legs: legs.map((leg) => {
      const quote = quoteByCode.get(leg.code);
      // 未在返回集内 (窗外 / 停牌 / 刚摘牌) ⇒ 保留收盘值与收盘档 (`state_branch` 5)。
      if (quote === undefined) return leg;
      const bid = vendorDecimal(quote.bid);
      const ask = vendorDecimal(quote.ask);
      // 🚨 买卖价**皆空 ⇒ 整行按「未取到实时」处理** (`state_branch` 11): 🚫 MUST NOT 逐字段拼出
      // 一行半实时半昨收的数据 —— 那种行没有任何一个时刻能解释它; 更 MUST NOT 把空当成 0。
      if (bid === null && ask === null) return leg;
      return {
        ...leg,
        bid,
        ask,
        bidSize: vendorNumber(quote.bidSize),
        askSize: vendorNumber(quote.askSize),
        delta: vendorNumber(quote.delta),
        // 🚫 原样带出, 不换算 —— 与库内那条同源纪律 (`LegChainRow.iv`)。
        iv: vendorNumber(quote.iv),
        volume: vendorNumber(quote.volume),
        // 🚨 标跟着它描述的那两格走 (见方法头)。`??` 只是把端口的 `boolean | null` 收成
        // `boolean` —— `null ⟺ 非期权行`, 而 `quoteByCode` 只装 `isOption` 的行 ⇒ 右支结构上
        // 够不着。🚫 MUST NOT 把它读成「vendor 没给就沿用库内」的兜底策略, 那是另一回事。
        greeksComplete: quote.greeksComplete ?? leg.greeksComplete,
        // 🚨 OI **只在实时基线下由这一批写**; 库内基线下 `leg.openInterest` 原样留下 (FR-004)。
        // 三元的两支各自成立, 🚫 MUST NOT 合并成 `?? leg.openInterest` 那种「空就填」——
        // 见函数头对 `baseline` 那段。
        openInterest:
          baseline === 'realtime_batch' ? vendorNumber(quote.openInterest) : leg.openInterest,
        priceKind: 'realtime',
      };
    }),
  };
}

/**
 * 请求级超时 (064 `FR-011`)。`work` 在超时后仍会自己跑完 —— 我们只是不再等它, 且**不留计时器**
 * (`finally` 清掉, 否则每请求泄一个 timer)。
 */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RealtimeSnapshotTimeoutError(ms, what)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 日志里的错误摘要 —— 非 `Error` 也要说得出是什么 (吞掉类型信息比不记还糟)。 */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 计数列与 Δ → number (张数与无量纲希腊值, 没有精度可丢; 金额列不走这里)。 */
function numberOf(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/**
 * vendor 侧金额串 → `Decimal`。空串与 `null` 同为「没有这个数」。
 *
 * 🚫 **MUST NOT 回落成 0** (064 FR-011 / SC-004): 0 在买卖价上读作「有人挂到 0」, 与「没取到」
 * 是两件完全不同的事, 而两者在屏上都显示得出来。
 */
function vendorDecimal(value: string | null): Prisma.Decimal | null {
  return value === null || value === '' ? null : new Prisma.Decimal(value);
}

/** vendor 侧计数 / 无量纲希腊值串 → number; 空、非数一律 `null` (理由同上, 禁 0 冒充)。 */
function vendorNumber(value: string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `YYYY-MM-DD` → `@db.Date` 比较用的 UTC 午夜 Date。 */
function utcMidnight(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}
