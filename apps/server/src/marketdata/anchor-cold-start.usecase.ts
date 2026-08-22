import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import {
  COLD_START_CAPABILITY,
  COLD_START_OUTCOME,
  isColdStartEnabled,
  resolveSnapshotSpec,
  type ColdStartOutcome,
} from './anchor-cold-start.rules.js';
import { AnchorDrivenSyncGate, parseGateTicker } from './anchor-driven-sync-gate.js';
import { isSessionRegistered, isSessionUnderway, marketNow } from './market-session.rules.js';
import { emptyStats } from './sync-run.recorder.js';
import { SyncOptionContractUseCase } from './sync-option-contract.usecase.js';
import { SyncOptionSnapshotUseCase } from './sync-option-snapshot.usecase.js';
import { seedInstrumentCreateData } from './sync-universe.usecase.js';
import { TRADING_CALENDAR_PORT, type TradingCalendarPort } from './trading-calendar.port.js';
import type { SessionKindStatus } from './trading-day.rules.js';
import { exchangeCalendarDate, sessionWatermark } from './session-clock.js';

/**
 * 锚首建冷启动的**编排体** (060 T005, plan §D3 / §D5 / §D9)。
 *
 * 一条建锚事件 = 一个 `sync:anchor-cold-start` job = 一次本 use case 调用, **零合流、零去重**
 * (FR-019c)。收敛靠的是起手复判 —— 排队中的后续请求走到第 5 步会判「已具备」而零外呼。
 *
 * 顺序有**硬依赖** (plan §D9), 不是风格问题:
 * ```
 * 1. 解析 market；不可解析 / 未登记时段 / 未开通采集 ⇒ 记结局后返回 (零外呼)
 * 2. 目标交易日定位 (查日历)；查不到 ⇒ calendar_missing + ERROR, 不猜日期
 * 3. Instrument 行缺失 ⇒ seed
 * 4. AnchorDrivenSyncGate.recalcSafely() 幂等开闸
 * 5. 起手复判：本锚**标的**在目标交易日的数据是否已具备；已具备 ⇒ already_present
 * 6. 不敏感档：**直调链本体** `SyncOptionContractUseCase.collect([这一只])`
 * 7. 敏感档：盘中 ⇒ intraday_skipped；否则按 §D4 算 spec → `SyncOptionSnapshotUseCase.collect`
 * 8. 落运行记录
 * ```
 * 3 → 4 → 复判这个次序反了会**静默拿到空数据**: 闸只认已存在的 Instrument 行, 而新锚
 * 在 universe 轮到它之前可能一行都没有。
 *
 * ## 🚨 全程直调本体, 不入任何队 (issue #159, 2026-08-23 定案)
 *
 * 6 与 7 **在同一次调用里顺序跑完**。原实现把链与日线组成 BullMQ flow 入队、本 job 以
 * `phase='snapshot'` 当 parent 挂其上, 分两相 —— 那是被「链作为 job 入队后, 在本 job 返回
 * 之前跑不了 (worker `concurrency=1`)」逼出来的。链改直调后该前提消失, **两相不是可以合,
 * 是没有分的理由了**。
 *
 * 代价曾经是数量级的: 维度 job 的工作集是**全部**已开闸标的 ⇒ 每建一只锚就把所有标的的链
 * 重下一遍 (O(N²))。93 只锚批量导入 prod 实测每只 2555 秒 / 872 次外呼 / `written=0`,
 * 总计 59 小时, 而真正需要的是每只约 40 秒。
 *
 * 🚫 **日线不在本流程内**: 建锚那一刻 `CreateAnchorUseCase.seedLastClose` 已同步调过
 * `EnsureLatestEodBarUseCase`, 而 `optionsdesk.anchor` 全仓只有一个 create 点 ⇒ 每只锚的
 * 日线在它出生那一秒就有了。原先那个 `us_equity_bar` flow child 是纯重复劳动。
 *
 * 📌 盘中闸仍落在**真正要写的那一刻** (第 7 步), 而不是入队那一刻 (FR-010/011) —— 直调后
 * 这一点天然成立, 不再依赖 flow 的执行时机。
 */
/**
 * 一次调用的结果。**未终结时不落运行记录** —— 那张表记的是「最近一次冷启动的**结局**」
 * (FR-026), 而两相加起来才是一次冷启动; 中途写一行会让「最近一次的结局」在窗口期内是错的,
 * 且八种结局 (FR-027) 里本就没有「进行中」这个值, 硬塞第九个会直接破 SC-009 的零折叠。
 */
export type ColdStartResult =
  | { settled: true; outcome: ColdStartOutcome }
  | {
      settled: false;
      /**
       * `vendor_budget` = vendor 限频配额耗尽, **顺延**重入队 (不耗 attempts, FR-019b)。
       *
       * 📌 issue #159 前这里还有一个 `awaiting_chain` (第一相组完 flow 交回、第二相由
       * BullMQ parent 语义接着跑)。链改直调后**两相合一**, 该值随之退役。
       */
      deferral: 'vendor_budget';
    };

@Injectable()
export class AnchorColdStartUseCase {
  private readonly logger = new Logger(AnchorColdStartUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: AnchorDrivenSyncGate,
    // 🚨 直注两个采集本体, **不注 `MarketdataSyncQueue`** (issue #159 起)。后者曾是本类的
    // 构造器参数, 而 `marketdata-sync.queue.ts` 顶部那条 TDZ 警告说的「第一个撞上的」正是
    // 060 冷启动 —— 链改直调后本类不再入任何队, 那条循环 import 的风险面随之消失。
    private readonly chain: SyncOptionContractUseCase,
    private readonly snapshot: SyncOptionSnapshotUseCase,
    @Inject(TRADING_CALENDAR_PORT) private readonly calendar: TradingCalendarPort,
  ) {}

  /**
   * 复杂度 —— **每一项都按「这一只锚」计**, 与已开闸标的总数无关:
   * O(1) 次日历查询 + O(1) 次标的查询 + 开闸的 O(市场数) 次 updateMany + 1 次复判 count
   * + 链本体 O(该票到期日窗数) 次外呼 + 快照本体 O(该票未到期合约数) + 1 次运行记录 upsert。
   *
   * 🚨 「与标的总数无关」这一句就是 issue #159 修掉的东西: 改直调前链走的是**维度级** job,
   * 执行侧载全部已开闸标的 ⇒ 单只锚的成本是 O(N)、93 只锚合起来 O(N²)。
   */
  async run(input: { anchorId: bigint; ticker: string; now: Date }): Promise<ColdStartResult> {
    const { anchorId, ticker, now } = input;

    // ── 1. 市场归属只从 ticker 解析, 不假定默认市场 (FR-020 / FR-021) ──
    const parsed = parseGateTicker(ticker);
    if (parsed === null) {
      return this.finish(input, COLD_START_OUTCOME.TICKER_UNRESOLVED, {
        reason: `ticker "${ticker}" 解析不出 market:code`,
      });
    }
    const { market, code } = parsed;

    // 未登记盘中时段 ⇒ 判不了「该场进行中」⇒ fail-closed 跳过 (FR-022)。**先于**能力检查,
    // 因为它是更靠前的前提: 时段没登记的话, 就算开通了采集也无从判断此刻能不能写快照。
    if (!isSessionRegistered(market)) {
      return this.finish(input, COLD_START_OUTCOME.SESSION_UNREGISTERED, {
        reason: `市场 "${market}" 未登记盘中时段 (market-session.rules.ts)`,
      });
    }
    // 未开通期权采集 ⇒ **显式 no-op, 非错误** (FR-023): hk 是空表项、cn 压根没登记, 两者
    // 同落一个结局但都留痕, 不静默。
    if (!isColdStartEnabled(market)) {
      return this.finish(input, COLD_START_OUTCOME.MARKET_NOT_ENABLED, {
        reason: `市场 "${market}" 未开通冷启动补数 (COLD_START_CAPABILITY)`,
      });
    }

    // 🚨 **半日市三态, 一次查、三处用** (063 Phase 2): 下面的目标日推导、日历缺行的
    // reason 串、以及盘中闸, 问的都是「今天这一场几点收」。查三遍就是三处判据。
    // `unknown` ⇒ 回落常规收盘 = 本片上线前的逐点行为。
    const todayKind = await this.todaySessionKind(market, now);

    // ── 2. 目标交易日 = 最近一个已收盘交易日 (FR-006 / FR-007) ──
    const targetSession = await this.lastClosedTradingDay(market, now, todayKind);
    if (targetSession === null) {
      // 🚫 不猜日子 (FR-009): 猜错就是一批 session_date 标错的脏行, 比不补更难发现且要人工
      //    回删。照抄 option-snapshot-remediation 的 blocked 纪律。ERROR 级 = 需人工介入。
      this.logger.error(
        `[anchor-cold-start] 交易日历缺 ${market} 的行, 定位不到目标交易日 ⇒ 放弃冷启动 ` +
          `(anchorId=${anchorId} ticker=${ticker}; 请补交易日历)`,
      );
      return this.finish(input, COLD_START_OUTCOME.CALENDAR_MISSING, {
        reason: `交易日历缺 ${market} 在 ${sessionWatermark(market, now, todayKind)} 及之前的行`,
      });
    }

    // ── 3. 有锚必有 Instrument 行 (FR-025); 缺行不让整体失败, 补上继续 ──
    const instrumentId = await this.seedInstrument(market, code);

    // ── 4. 幂等开闸: 把新锚的 needSync 翻 true。失败自降级返 null, 不上抛 ──
    await this.gate.recalcSafely();

    // ── 5. 起手复判 (FR-016 / FR-016a) ──
    if (await this.dataAlreadyPresent(market, instrumentId, targetSession)) {
      return this.finish(input, COLD_START_OUTCOME.ALREADY_PRESENT, { targetSession });
    }

    const capability = COLD_START_CAPABILITY[market];

    // ── 6. 不敏感档: **直调链本体**补这一只锚 (issue #159) ──
    //
    // 🚫 链**不受盘中判据约束** (FR-012): 合约静态属性与交易日无关。盘中闸只管敏感档,
    //    且落在第 7 步 —— 真正要写快照的那一刻。
    //
    // 🚨 **从「入维度 job」改成「直调本体」是本片的要害**: 维度 job 的工作集是**全部**已开闸
    //    标的 ⇒ 每建一只锚就把所有标的的链重下一遍, O(N²)。2026-08-23 prod 实证 (93 只锚
    //    批量导入): 每只 2555 秒 / 872 次外呼 / `written=0` (insert-only 表重跑全撞唯一键,
    //    DB 层看着零成本、vendor 侧每轮实打实全做), 总计 59 小时。直调后只打自己那一份。
    //
    // 🚨 **硬边语义靠「不 catch」表达**: 链失败直接上抛 ⇒ 本 job 交 BullMQ 重试 ⇒ attempts
    //    耗尽由 job 层落 `retry_exhausted` (FR-019a)。原先是 flow child 的
    //    `failParentOnFailure` 在表达同一件事。吞掉它就会退回「零合约 ⇒ 快照零外呼 ⇒ 却落
    //    `backfilled` 的谎」那个已知缺陷 —— 第 7 步末的落库复判是**第二道**网, 不是第一道。
    if (capability.optionChain) {
      const chainBudgetExhausted = await this.chain.collect(
        [{ id: instrumentId, market, code }],
        // 链只拿业务日剔除已过期到期日 (FR-028a, 判据 `≥` 不是 `>`)。跟**交易所的今天**走,
        // 与维度轮同源 —— 单市场时 `exchangeCalendarDateForScope([m], now)` 与本式逐点相等。
        { businessDate: exchangeCalendarDate(market, now) },
        emptyStats(),
      );
      if (chainBudgetExhausted) {
        // 🚫 顺延 ≠ 失败 (FR-018 / FR-019b): 链没采完就去抓快照 = 拿着残缺工作集问 vendor。
        this.logger.warn(`[anchor-cold-start] 链发现配额耗尽, 顺延重跑: ${ticker}`);
        return { settled: false, deferral: 'vendor_budget' };
      }
    }

    // ── 7. 敏感档 ──
    if (!capability.optionSnapshot) {
      // 该市场只补链 —— 上一步已就地补完, 本次冷启动到此为止。
      return this.finish(input, COLD_START_OUTCOME.BACKFILLED, { targetSession });
    }

    // 「今天是不是交易日」**一次查、两处用**: 盘中闸与 §D4 的三元组决策问的是同一件事,
    // 查两遍就是两处判据。
    const today = exchangeCalendarDate(market, now);
    const calendarStatus = await this.calendar.classify(market, today);

    // 🚨 **写敏感档遇 `unknown` ⇒ 放弃, MUST NOT 猜口径** (062 T009, `state_branch` 7)。
    //
    // 这一格的取值直接决定 §D4 三元组里的 `source` 与 `oi_as_of`: 猜成「是交易日」就落
    // `premarket_backfill` + OI 归属**被补那场**, 猜成「不是」就落 `eod` + OI 归属**再往前
    // 一场** —— 两者差一整天的持仓量归属, 而活跃度排名与 UI 的 asOf 都读它。猜错**不报错**,
    // 只留一批溯源信息写反的行, 事后订正要人工回删。
    //
    // 与盘中采集闸 (`sync-anchor-intraday` / alert) 的 `unknown ⇒ 照跑` 分派**方向相反, 这是
    // 刻意的**: 那两处多跑一轮的代价只是一次外呼, 这里写错的代价是持久的脏数据。
    //
    // 📌 本格排在盘中闸**之前**: 日历不可判时, 「盘中还是盘后」这个问题本身就没有意义, 且
    // `calendar_missing` 是需人工介入的一档 (探针会响), 而 `intraday_skipped` 是「一切正常」
    // 的一档 —— 折进后者等于把该被人看见的事藏起来 (FR-027 零折叠)。
    if (calendarStatus === 'unknown') {
      this.logger.error(
        `[anchor-cold-start] 交易日历视野未覆盖 ${market} 的 ${today} ⇒ 判不出补数口径, 放弃本次 ` +
          `(anchorId=${anchorId} ticker=${ticker}; 请补前瞻视野)`,
      );
      return this.finish(input, COLD_START_OUTCOME.CALENDAR_MISSING, {
        targetSession,
        reason: `交易日历视野未覆盖 ${market} 的 ${today} (覆盖声明之外) ⇒ 不猜 source / oi_as_of`,
      });
    }
    const todayIsTradingDay = calendarStatus === 'trading';

    // 🚨 闸 = 「该场进行中」**且**「今天真有这一场」, 两个条件缺一不可:
    //
    // ① `isSessionUnderway`「该场进行中」(**含午休**) MUST NOT 换成 `isWithinTradingSession`
    //    —— 后者午休返 false ⇒ 放行, 而此刻 D4 算出的目标日是**上一个交易日** ⇒ 把午休盘口
    //    贴上「上一场收盘」的标签写进库 (FR-011)。
    //    📌 **2026-08-18 起这条差异在本片够不到任何市场**: hk 已合并成单段登记 (午休算场内),
    //    us 真的无午休, 而 cn 不在 `COLD_START_CAPABILITY` 里 ⇒ 两谓词在能走到这里的市场上
    //    逐点等价。仍然用 `isSessionUnderway` 不是形式主义: 哪天给一个有午休的市场开通期权
    //    采集, 用错的那个当场就是永久缺口, 而它**不报错**。
    // ② `todayIsTradingDay` 这一格是 T010 铺时点用例时补上的 (impl 期修正, 2026-08-17):
    //    `isSessionUnderway` 是**纯时钟**谓词, 不看星期也不看日历 ⇒ 周六 ET 12:00 它照样返
    //    true。少了这一格, **北京周六 21:30 – 周日 04:00 建的锚会落 `intraday_skipped`**,
    //    而那是终态不重试、常规轮周一晚写的又是周一的数据 ⇒ 目标日快照**永久**缺失
    //    (SC-001 要的正是它)。境内用户周末夜里建锚恰是高发时段, 美股节假日同理。
    //    📌 §D4 第四行 (`today > target` 且今天非交易日 ⇒ eod) 本就是为周末这一档写的 ——
    //    没有这个 `&&`, 那一行在 ET 场内钟点上**够不到**。
    //
    // 走到这里 `calendarStatus` 只可能是 `trading` / `non-trading` (`unknown` 已在上面放弃) ⇒
    // 本闸的两个条件都建立在**确定**的日历事实上。
    // 🚨 `todayKind='half'` 时收盘时刻提前 (hk 12:00 / us 13:15 期权口径) ⇒ 半日市当天下午
    // 不再被误判成「场内」。这一格是本片**唯一不可自愈**的收益: `intraday_skipped` 是终态
    // 不重试, 落了它那一场的快照就**永久缺失** (常规轮当晚写的是当晚那一场)。
    if (
      isSessionUnderway(market, marketNow(market, now).minutesOfDay, todayKind) &&
      todayIsTradingDay
    ) {
      return this.finish(input, COLD_START_OUTCOME.INTRADAY_SKIPPED, { targetSession });
    }

    const decision = resolveSnapshotSpec({
      market,
      now,
      lastClosedTradingDay: targetSession,
      todayIsTradingDay,
      tradingDayBeforeTarget: await this.tradingDayBefore(market, targetSession),
    });
    if (decision.decision === 'abandon') {
      // 兜底: 第 2 步已挡过日历缺行, 这条正常够不到 —— 但判据在规则层, 不在这里复制一份。
      return this.finish(input, decision.outcome, {});
    }

    // 🚨 直调 `collect` 而非维度 job 的 `run()`: 后者写死 `sessionDate = 当前业务日` + `eod`
    //    (plan §D8), 在盘前窗口会把 `sessionDate` 标成**尚未收盘的那天**。`collect` 是唯一
    //    能显式指定归属日的入口, 且 spec **原样**来自 T003 的纯函数, 此处不重算 (FR-014)。
    const budgetExhausted = await this.snapshot.collect(
      [{ id: instrumentId, market, code }],
      decision.spec,
      emptyStats(),
    );
    if (budgetExhausted) {
      // 🚫 顺延 ≠ 失败 (FR-018 / FR-019b): **不**落 `retry_exhausted` (那是「做了但失败」),
      //    也**不**落 `backfilled` (什么都没采到)。交回信号由 job 层延时重入队, 不耗 attempts
      //    —— 语义与既有 `ExecutorResult.budgetExhausted` 那条路径逐字相同。
      this.logger.warn(
        `[anchor-cold-start] 快照配额耗尽, 顺延重跑: ${ticker} (目标 ${targetSession})`,
      );
      return { settled: false, deferral: 'vendor_budget' };
    }

    // 🚨 落库复判 (FR-027a): **`collect` 返回 ≠ 那份快照真的落了库**。
    //
    // `collect` 只交回「配额耗没耗尽」一个布尔; 「该票零未到期合约」在它内部只是
    // `stats.skipped++` + 一条 WARN, 而 stats 到不了这里。于是最该被发现的那条路径 ——
    // 链**跑完但零结果** (per-target 失败只计 stats.failed, 不让 `collect` 抛) —— 会一路
    // 走到下面那行落 `backfilled`, 而目标日的快照一行都没有。
    // 期权 EOD 无跨日补救 ⇒ 那是**永久缺口**, 却记成了「已补齐」。
    //
    // 判据蓄意**不看 stats 而看库**: 一来它与起手复判**同源** (同一个「标的+交易日的数据
    // 在不在」, 见 {@link snapshotPresent} 的两个调用点), 不新造第二套口径; 二来 stats 的
    // `ok=1` 只说明「有合约、走完了采集路径」, 整批被落库前硬门拒掉时它照样是 1。
    //
    // 🚫 **只看快照, 不看日线**: 日线压根不在本流程内 (建锚时已取), 让它左右结局会把
    // 一件与冷启动无关的事翻成冷启动失败。
    if (!(await this.snapshotPresent(instrumentId, targetSession))) {
      // ERROR 级 = 需人工介入, 与 `calendar_missing` 同档 (两者都是「放弃 + 留可判读记录」)。
      this.logger.error(
        `[anchor-cold-start] 采集跑完但 ${targetSession} 的快照仍不在库 ⇒ 本次补数未完成 ` +
          `(anchorId=${anchorId} ticker=${ticker}; 常见成因: 链发现未覆盖该标的 / 整批被落库前硬门拒)`,
      );
      return this.finish(input, COLD_START_OUTCOME.BACKFILL_INCOMPLETE, {
        targetSession,
        reason: `采集已执行但 ${targetSession} 快照未落库 (零未到期合约, 或整批未过落库前硬门)`,
      });
    }
    return this.finish(input, COLD_START_OUTCOME.BACKFILLED, { targetSession });
  }

  /**
   * **retry 耗尽出口** (FR-019a, plan §D10 第二层): job 层在 BullMQ `attempts` 用尽后调本方法
   * 落 `retry_exhausted` —— 「做了但失败」, 与「今天本就不该做」两两互异 (FR-027 零折叠)。
   *
   * 🚨 **判据留在 job 层, 不在这里复判**: 「还能不能再试」是 BullMQ 的账 (`attemptsMade` /
   * `opts.attempts`), use case 看不见也不该看见。本方法只负责把结论落库。
   *
   * 📌 issue #159 前这里还有一段「它可能覆盖同一次冷启动刚写下的 `backfilled`」的说明 ——
   * 那是 flow 形态的产物: 链 child 带 `failParentOnFailure` 硬失败时 BullMQ 仍会先跑一遍
   * parent, 那一遍可能已写过一个 `backfilled` 的谎。改直调后**链失败直接上抛、根本走不到
   * 落库那一行**, 该覆盖场景随之消失。
   */
  async recordRetryExhausted(input: {
    anchorId: bigint;
    ticker: string;
    now: Date;
    failedReason?: string;
  }): Promise<void> {
    await this.finish(input, COLD_START_OUTCOME.RETRY_EXHAUSTED, {
      reason: `BullMQ attempts 耗尽: ${input.failedReason ?? '(无 failedReason)'}`,
    });
  }

  /** `trading_day` 中**严格早于** `date` 的最大交易日; `null` = 缺行 (见 {@link lastClosedTradingDay})。 */
  private async tradingDayBefore(market: string, date: string): Promise<string | null> {
    const row = await this.prisma.tradingDay.findFirst({
      where: { market, date: { lt: new Date(`${date}T00:00:00Z`) } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row === null ? null : row.date.toISOString().slice(0, 10);
  }

  /**
   * `trading_day` 中 ≤ 「已收盘 session 日期上界」的**最大交易日**。缺行返 `null`。
   *
   * ⚠️ **蓄意不走 `TRADING_CALENDAR_PORT`**, 尽管它就是交易日历的读端口 —— 它只有
   * `classify(market, date)` 一个方法, 拿它找「最近一个已收盘交易日」只能逐日回退着问, 而
   * 日历没填到那儿时它给的是 `unknown`, 各调用点又统一把 `unknown` 映射到**放行**侧 (062 T006
   * Guardrail 1) ⇒ 日历真缺行时逐日回退会**编出**一个交易日, 正是 FR-009「MUST NOT 猜测日期」
   * 禁的那件事。本查询要的是 fail-closed, 故直查自有表 —— 形态与
   * `option-snapshot-remediation.resolvePreviousTradingDay` /
   * `sync-option-snapshot.resolveOiSessionDate` 逐字同构 (marketdata 自有表, 非跨 ctx)。
   *
   * 复杂度: 1 次 (market, date) 主键索引上的倒序 limit-1 查询。
   */
  /**
   * 交易所当地**今天**那一场是整天还是半天 (063 Phase 2)。库里没有该日的行 ⇒ `'unknown'`
   * —— 与列默认值同值, 且消费侧对 `unknown` 一律回落常规收盘 (fail-open)。
   *
   * 🚨 **直查自有表而非走 `TRADING_CALENDAR_PORT`**: 与本类既有的 `lastClosedTradingDay`
   * 同一条理由 —— `trading_day` 是 marketdata 自有表, 而端口那两个方法答的是别的问题
   * (三态分类 / 最近已收盘交易日), 为一个列查询往端口上加第三个方法会让所有 fake 跟着改,
   * 收益为零。
   *
   * ⚠️ 「没有该日的行」有两种成因 (今天不是交易日 / 日历还没填到) —— 本方法**不区分**:
   * 两种情形下「今天这一场几点收」都无从谈起, 而调用点自己另有日历三态判据分派。
   *
   * 复杂度: 1 次 (market, date) 主键点查。
   */
  private async todaySessionKind(market: string, now: Date): Promise<SessionKindStatus> {
    const today = exchangeCalendarDate(market, now);
    const row = await this.prisma.tradingDay.findUnique({
      where: { market_date: { market, date: new Date(`${today}T00:00:00Z`) } },
      select: { sessionKind: true },
    });
    return (row?.sessionKind ?? 'unknown') as SessionKindStatus;
  }

  private async lastClosedTradingDay(
    market: string,
    now: Date,
    todayKind: SessionKindStatus,
  ): Promise<string | null> {
    const cutoff = sessionWatermark(market, now, todayKind);
    const row = await this.prisma.tradingDay.findFirst({
      where: { market, date: { lte: new Date(`${cutoff}T00:00:00Z`) } },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    return row === null ? null : row.date.toISOString().slice(0, 10);
  }

  /**
   * 兜底 seed 标的行, 返回其 id。create payload 走
   * {@link import('./sync-universe.usecase.js').seedInstrumentCreateData} —— 与另一个 seed 点
   * (`SyncOptionContractUseCase.seedAnchoredInstruments`) **共用同一个 helper** (066 T03,
   * FR-009), 不再各自内联一份。
   *
   * 🚨 此前这里无条件写 `needSync: false`, 理由是「受保护列, 重算的唯一权威是采集闸」——
   * **那条理由只对被闸管的市场 (us) 成立**。港股没有闸, 被本路径首建的港股行会永远停在
   * `false` 并被 `eod_bar` / `sync-profile` / backfill CLI 三个消费方静默排除 ⇒ **那只标的
   * 永远没有日线且零告警**。分工订正为: **create 路径定默认值, 闸只负责被闸市场的重算**。
   *
   * 空 `update` 是纯兜底: 已有行的 name / syncTier / needSync 一个都不许被 seed 冲掉。
   */
  private async seedInstrument(market: string, code: string): Promise<bigint> {
    const existing = await this.prisma.instrument.findUnique({
      where: { market_code: { market, code } },
      select: { id: true },
    });
    if (existing !== null) return existing.id;

    const seeded = await this.prisma.instrument.upsert({
      where: { market_code: { market, code } },
      create: seedInstrumentCreateData(market, code),
      update: {},
      select: { id: true },
    });
    this.logger.warn(
      `[anchor-cold-start] 兜底 seed 标的行 (有锚但 Instrument 缺行, universe 未轮到?): ${market}:${code}`,
    );
    return seeded.id;
  }

  /**
   * 起手复判 (FR-016a): 判据是「**该标的在目标交易日**的数据是否已具备」, 查的是
   * `daily_bar` / `option_daily_snapshot` **本身**。
   *
   * 🚫 **MUST NOT 反过来读 `anchor_cold_start_run`**: 那张表是审计面 (plan §D7), 不是数据
   * 存在性的真相源。按「这只**锚**冷启动过没有」判, 今天与本判据等价, 但锚一旦按用户区分,
   * 同一标的的 N 只锚会各判「没做过」⇒ 同一份**标的级共享数据**被拉 N 遍。
   *
   * 逐档按能力登记表问, 不写死 us: 只在该市场真的会补那一档时才要求它在场。
   *
   * 🚫 **日线已不在判据内** (issue #159): 它不再是冷启动的职责 (建锚那一刻
   * `CreateAnchorUseCase.seedLastClose` 已取过), 拿它当闸只会让「日线恰好没落上」误挡住
   * 真正要补的快照。
   *
   * 复杂度: 1 次 count。
   */
  private async dataAlreadyPresent(
    market: string,
    instrumentId: bigint,
    targetSession: string,
  ): Promise<boolean> {
    const capability = COLD_START_CAPABILITY[market];

    // 快照在场 ⇒ 它上游的链**必然**也在 (快照是按 `option_contract` 行去采的) ⇒ 快照这一档
    // 就是最强判据, 不必再多问一次链。
    if (capability.optionSnapshot) return this.snapshotPresent(instrumentId, targetSession);

    // 只补链、不补快照的市场 —— 今天没有这样的市场, 留结构位 (加市场时才走得到)。
    return (
      !capability.optionChain ||
      (await this.prisma.optionContract.count({
        where: { underlyingInstrumentId: instrumentId },
      })) > 0
    );
  }

  /**
   * 「该标的在该交易日的**期权快照**在不在库」—— 起手复判 (第 5 步) 与采集后的落库复判
   * (第 7 步末) 问的是同一个问题, 故只有这一处定义。
   *
   * 🚨 拆出来不是为了少写几行, 是为了**不让两处判据漂**: 一处答「不在 ⇒ 去采」、另一处答
   * 「还是不在 ⇒ 没补上」, 二者若用不同口径, 会出现「复判说不在、采完又说在」的自相矛盾结局。
   *
   * 复杂度: 1 次 `option_daily_snapshot ⋈ option_contract` 上按 `underlying_instrument_id`
   * 的 count。
   */
  private async snapshotPresent(instrumentId: bigint, targetSession: string): Promise<boolean> {
    return (
      (await this.prisma.optionDailySnapshot.count({
        where: {
          sessionDate: new Date(`${targetSession}T00:00:00Z`),
          contract: { underlyingInstrumentId: instrumentId },
        },
      })) > 0
    );
  }

  /**
   * 落运行记录并交回结局 (FR-026 / FR-026a / FR-027)。**每一条出口都过这里** —— 早退分支
   * 不留痕的话, 「未支持」与「故障」事后就再也分不开了。
   *
   * 覆盖式单行 upsert: FR-026 只要求保留**最近一次**。PK = `anchorId` 而非 ticker (plan §D5)。
   */
  private async finish(
    input: { anchorId: bigint; ticker: string; now: Date },
    outcome: ColdStartOutcome,
    extra: { reason?: string; targetSession?: string } = {},
  ): Promise<ColdStartResult> {
    const row = {
      ticker: input.ticker,
      lastRunAt: input.now,
      outcome,
      reason: extra.reason ?? null,
      targetSession:
        extra.targetSession === undefined ? null : new Date(`${extra.targetSession}T00:00:00Z`),
    };
    await this.prisma.anchorColdStartRun.upsert({
      where: { anchorId: input.anchorId },
      create: { anchorId: input.anchorId, ...row },
      update: row,
    });
    return { settled: true, outcome };
  }
}
