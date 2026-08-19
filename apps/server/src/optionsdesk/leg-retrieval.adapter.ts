import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { exchangeCalendarDate } from '../marketdata/session-clock';
import { daysToExpiry } from '../marketdata/trading-day-gate';
import {
  OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
  OPTION_SNAPSHOT_READ_PORT,
  type OptionSnapshotBatch,
  type OptionSnapshotPort,
} from '../marketdata/option-snapshot.port';
import { MARKET_STATE_PORT, type MarketStatePort } from '../marketdata/market-state.port';
import {
  TRADING_CALENDAR_PORT,
  type TradingCalendarPort,
} from '../marketdata/trading-calendar.port';
import { parseAnchorTicker } from './anchor.rules';
import { INTRADAY_FRESHNESS_SECONDS, isIntradayFresh } from './intraday-spot.rules';
import { legWindowFor, windowTripwire, withinWindow, type LegWindow } from './leg-window.rules';
import { recallCandidates, type RecallCandidate, type RecallContext } from './leg-recall.rules';
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
 * 它存在只为一个用途 —— 喂 `windowTripwire` (064 `FR-007`), 而绊线的调用点必须在召回**之后**
 * (入参是召回的判决, 不是裸腿)。收盘档 / 基准不可用时恒为 `null`: 没发生实时取数就没有窗,
 * 也就无所谓漂移。
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
interface ResolvedWindow {
  readonly window: LegWindow | null;
  /** 定窗基准的采集时刻; 锚不存在 / 该列从未写过 ⇒ `null`。 */
  readonly basisAt: Date | null;
}

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
    const loaded = await this.loadChainWithWindow(query);
    if (loaded === null) return null;
    const { chain, legs } = loaded.snapshot;

    const context: RecallContext = { spot: chain.spot };
    const outcome = recallCandidates(
      context,
      query.perspectives,
      legs,
      query.candidateCap,
      query.override,
    );
    // 064 FR-007: 绊线在**召回之后**求值 —— 它问的是「窗排除掉的那些腿里, 有没有本来能进候选的」,
    // 而「能不能进候选」只有召回答得了 (判据单点)。
    this.reportWindowDrift(query.symbol, outcome.candidates, loaded.window);
    return {
      chain,
      ...outcome,
      // 053 FR-009: 无覆盖口径的成员数 —— 对**同一批已在内存的 `legs`** 再判一次, 零额外 DB
      // 往返 (上面三次查询与它无关)。语义与三条禁忌见 `LegRetrievalResult.memberCount`。
      memberCount:
        query.override === null
          ? outcome.candidates.length
          : recallCandidates(context, query.perspectives, legs, query.candidateCap).candidates
              .length,
    };
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
   */
  private async loadChainWithWindow(query: LegChainQuery): Promise<LoadedChain | null> {
    // 064 T003: `query.realtime` 是**每次请求**的显式开关 (`FR-015` fail-closed, 无默认值)。
    const parsed = parseAnchorTicker(query.symbol);
    if (parsed === null) return null;
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
    if (latest === null) return null;

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

    // DTE 按到期日缓存: 合约数百行、到期日只有几十个 ⇒ `daysToExpiry` 每个日期算一次。
    const dteByExpiry = new Map<string, number>();
    const legs: LegChainRow[] = rows.map(({ contract, snapshot }) => {
      const key = contract.expiryDate.toISOString().slice(0, 10);
      let dteDays = dteByExpiry.get(key);
      if (dteDays === undefined) {
        dteDays = daysToExpiry({ expiry: contract.expiryDate, now: query.now });
        dteByExpiry.set(key, dteDays);
      }
      return {
        code: contract.code,
        expiryDate: contract.expiryDate,
        dteDays,
        strike: contract.strikePrice,
        bid: snapshot.bid,
        ask: snapshot.ask,
        bidSize: numberOf(snapshot.bidSize),
        askSize: numberOf(snapshot.askSize),
        delta: numberOf(snapshot.delta),
        // 🚫 原样带出, 不换算 —— 见 `LegChainRow.iv`。
        iv: numberOf(snapshot.iv),
        openInterest: numberOf(snapshot.openInterest),
        volume: numberOf(snapshot.volume),
        greeksComplete: snapshot.greeksComplete,
        // 🚫 vendor 原样带出, 不归一化大小写、不回落默认值 —— 判据是白名单 `=== 'MONTH'`,
        // 在这里「顺手」规整会让「vendor 换了取值」这件事在打标层看不出来 (`leg-mark.rules.ts`)。
        expirationCycle: contract.expirationCycle,
        // 064 T003: 库里读出来的就是收盘档 —— 这里是**唯一**的落点, 实时档由本方法尾部的
        // overlay 逐行改写 (T004a)。🚫 MUST NOT 在下游任何一层「补标」: 补标点有第二个,
        // 「这个数是什么时候的」就有两个答案, 而两个答案都渲染得出来。
        priceKind: 'eod_close',
      };
    });

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
    // 「本该外呼」这个前提结构上不成立 (mock 档下它是**绑定着的**降级实现 ⇒ 走 `fetchQuotes`
    // 那条路标 `source_unavailable`, 见 T002)。🚫 MUST NOT 在这里预置一个降级标充数。
    if (!query.realtime || this.snapshots === null) {
      return { snapshot: { chain, legs }, window: null };
    }
    return this.overlayRealtimeQuotes(
      this.snapshots,
      { symbol: query.symbol, market: parsed.market, marketDate, now: query.now },
      chain,
      legs,
    );
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
  private async resolveWindow(target: {
    readonly symbol: string;
    readonly market: string;
    readonly now: Date;
  }): Promise<ResolvedWindow> {
    const anchor = await this.prisma.anchor.findUnique({
      where: { ticker: target.symbol },
      select: { intradayPrice: true, intradayAt: true },
    });
    if (anchor === null || anchor.intradayPrice === null) {
      return { window: null, basisAt: anchor?.intradayAt ?? null };
    }
    // 🚨 新鲜度闸复用 061 的单点 {@link isIntradayFresh} —— 🚫 MUST NOT 在这里再判一次「多久算旧」:
    // 两处阈值必漂移, 而漂移的表现是「窗按一个已经没人维护的价定出来」, 结果照样渲染得出来。
    if (!isIntradayFresh(anchor.intradayAt, target.now)) {
      return { window: null, basisAt: anchor.intradayAt };
    }
    return {
      window: legWindowFor(target.market, anchor.intradayPrice),
      basisAt: anchor.intradayAt,
    };
  }

  /**
   * `FR-007` 的绊线留痕 —— 「被窗排除、却能通过召回判据」的腿。窗为 `null` (收盘档) ⇒ 无事发生。
   *
   * 🚨 报出来的不是「候选集算错了」而是「**包络该放宽了**」: 那两个 strike 比例是经验余量,
   * 判据一旦调松 (门槛下调 / 成色上界放宽) 窗就可能比判据窄, 而窄掉的那批腿照常出现在结果里,
   * 只是带着收盘档的价 —— 响应上看不出任何异常。`O(n)`。
   */
  private reportWindowDrift(
    symbol: string,
    candidates: readonly RecallCandidate<LegChainRow>[],
    window: LegWindow | null,
  ): void {
    if (window === null) return;
    const drifted = windowTripwire(candidates, window);
    if (drifted.length === 0) return;
    this.logger.warn(
      `候选范围包络漂移 (064 FR-007): ${symbol} 有 ${drifted.length} 条腿落在窗外却能过召回判据 ` +
        `—— 本次它们只拿到收盘档。窗 strike [${window.strikeMin.toString()}, ` +
        `${window.strikeMax.toString()}] / DTE [${window.dteMin}, ${window.dteMax}]; ` +
        `腿: ${drifted.map(({ leg }) => leg.code).join(' / ')}`,
    );
  }

  /**
   * 用**此刻**的报价覆盖库内收盘档 —— 恰好七列 (064 FR-001 / FR-002)。
   *
   * 🚨 **写入面只有这七列**: `bid` / `ask` / `bidSize` / `askSize` / `delta` / `iv` / `volume`。
   * 派生量 (成交额 / 单笔权利金 / 价差及其相对值) 由下游从这七列现算 ⇒ 自动成为实时口径,
   * 🚫 MUST NOT 为它们另设覆盖路径 (FR-003: 派生量有第二个来源就等于同一个数在两处各算一份)。
   * 🚨 **持仓量三列 (`openInterest` / `netOpenInterest` / `oiAsOf`) 的保留是结构性的**
   * (FR-004 / plan D8): 前者不在下面的字面量里、后两者根本不在 {@link LegChainRow} 上 ——
   * 🚫 MUST NOT 为了「对称」把它们纳入再跳过, 那把编译期保证降级成一条注释。依据是实测:
   * 美股期权 OI 盘前更新、盘中冻结 ⇒ 此刻取回的与库内是同一个数。
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
  ): Promise<LoadedChain | null> {
    /**
     * 整体回落路径的共同落点 —— 值一个不动, 只在 meta 上说清**本该给实时却没给成**没有。
     *
     * 🚨 `null` 那一支与关态**逐字节相同** (`realtimeDegrade` 在 `chain` 上已是 `null`, 展开
     * 不改键序也不改值); 非 `null` 那一支只多这一个字段的取值。
     */
    const eodClose = (realtimeDegrade: RealtimeChainDegradeKind | null): LoadedChain => ({
      snapshot: { chain: { ...chain, realtimeDegrade }, legs },
      window: null,
    });

    // ① 非常规交易状态 / 当日非交易日 ⇒ **零外呼** (`state_branch` 3)。
    // 🚨 `'closed'` 是**正常收盘档**, 降级标恒 `null` —— 北京白天美股休市, 天天如此。给它刷上
    // 降级 = 造一个永远为真的告警, 真出事那天它也就不再有人看 (T007a 的核心反例)。
    // 🚨 `'unknown'` 相反: 外呼同样没发, 但我们**不知道**此刻该不该发 ⇒ 如实标降级。
    const gate = await this.resolveRealtimeGate(target);
    if (gate === 'closed') return eodClose(null);
    if (gate === 'unknown') return eodClose('gate_unknown');

    // ② 定窗基准缺失 / 陈旧 ⇒ 窗无从定起 ⇒ 整体回落, 仍是零外呼 (`state_branch` 14)。
    // 🚫 MUST NOT 退而用收盘价定出一个窗来: 那是拿昨天的边界去圈今天的合约, 且外表看不出来。
    const { window, basisAt } = await this.resolveWindow(target);
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
    const applied = applyRealtimeBatch(chain, legs, batch);
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
 */
function applyRealtimeBatch(
  chain: LegChainMeta,
  legs: readonly LegChainRow[],
  batch: OptionSnapshotBatch,
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
