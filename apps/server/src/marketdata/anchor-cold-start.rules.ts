import {
  SNAPSHOT_SOURCE_EOD,
  SNAPSHOT_SOURCE_PREMARKET_BACKFILL,
  type SnapshotCollectionSpec,
} from './sync-option-snapshot.usecase.js';
import { exchangeCalendarDate } from './session-clock.js';

/**
 * 锚首建冷启动的**判据层** (060 T003, FR-006 / FR-008 / FR-014 / FR-023 / FR-024,
 * plan §D4)。纯函数、**零 I/O**、无 DI (ADR-0043 §4) —— 日历查询由调用方做完再喂进来。
 *
 * 三样东西住这里, 都是「散开就会漂」的那类:
 * 1. {@link resolveSnapshotSpec} —— 快照三元组 (归属交易日 / 来源 / OI 归属日) 的决策表;
 * 2. {@link COLD_START_CAPABILITY} —— 「哪些市场支持哪些补数内容」的**唯一**登记处 (FR-024);
 * 3. {@link COLD_START_OUTCOME} —— 结局值域 (FR-027 八种, 零折叠)。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 结局值域 (FR-027)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次冷启动的结局。**八种取值两两互异** —— FR-027 明禁把「没做」与「做了但失败」折叠成
 * 同一个值: 折叠之后一条按结局分组的查询再也分不出「今天本就不该做」和「今天该做没做成」,
 * 而那两件事的处置完全相反 (前者不该有人管, 后者要人管)。
 */
export const COLD_START_OUTCOME = {
  /** 已补齐 —— 本次真的采了并落了库。 */
  BACKFILLED: 'backfilled',
  /** 盘中跳过 —— 该场进行中 (含午休), 敏感档不写 (FR-010 / FR-011)。 */
  INTRADAY_SKIPPED: 'intraday_skipped',
  /** 数据已具备 ⇒ 零外呼 (FR-016a 起手复判命中)。 */
  ALREADY_PRESENT: 'already_present',
  /** 该市场未开通期权采集 —— 显式 no-op, 非错误 (FR-023)。 */
  MARKET_NOT_ENABLED: 'market_not_enabled',
  /** 该市场未登记交易时段 ⇒ 判不了盘中, fail-closed 不写。 */
  SESSION_UNREGISTERED: 'session_unregistered',
  /** 标的标识不可解析 (ticker → market/code 失败)。 */
  TICKER_UNRESOLVED: 'ticker_unresolved',
  /** 交易日历缺行 ⇒ 定位不到目标交易日, 不猜 (见 {@link resolveSnapshotSpec})。 */
  CALENDAR_MISSING: 'calendar_missing',
  /** BullMQ `attempts` 耗尽后仍失败 (FR-019a) —— **做了但失败**。 */
  RETRY_EXHAUSTED: 'retry_exhausted',
  /**
   * 采集跑完了, 但目标交易日的快照**仍不在库** (FR-027a) —— **做了但没补上**。
   *
   * 🚨 它与 {@link BACKFILLED} 的差别不是程度而是事实: 后者宣称「那份快照现在在库里」,
   * 而这条说的是「跑完之后它仍然不在」。两条最常见的到达路径:
   * ① 链 child **成功完成但零结果** (per-target 失败不让 job 失败 ⇒ `failParentOnFailure`
   *    够不着), 第二相于是拿着空工作集跑 —— `SyncOptionSnapshotUseCase` 判「无未到期合约」
   *    WARN + 零外呼返回, 一切"正常";
   * ② 有合约, 但整批被落库前硬门拒掉。
   *
   * 期权 EOD **无跨日补救** ⇒ 这两种情形盖住的都是**永久缺口**, 记成 `backfilled` 会让
   * 唯一能发现它的那条按结局分组的查询失明 (2026-08-17 本地真跑实撞: 链 13 只票全失败、
   * job 却 completed)。处置对齐 {@link CALENDAR_MISSING}: ERROR 级留痕 + 人工介入, 不重试
   * —— 链是**第一相**跑的, 第二相重试只会拿着同一个空工作集再问一遍。
   */
  BACKFILL_INCOMPLETE: 'backfill_incomplete',
} as const;

export type ColdStartOutcome = (typeof COLD_START_OUTCOME)[keyof typeof COLD_START_OUTCOME];

// ─────────────────────────────────────────────────────────────────────────────
// 市场能力登记 (FR-024)
// ─────────────────────────────────────────────────────────────────────────────

/** 某市场冷启动能补哪些内容。空表项 (两档全关) = 已知但未开通。 */
export interface ColdStartCapability {
  /**
   * **不敏感档**: 组 flow 入队的维度 code, 顺序即依赖次序 (链 → 日线)。空数组 = 不补。
   *
   * 登记 code 而非布尔, 是因为「哪个市场走哪个维度」本身就是市场相关的
   * (`us_equity_bar` 就带着市场名) —— 登记布尔的话执行侧还得再写一张 market → dim 的映射,
   * 那就是 FR-024 要禁的「散落在多个判断分支里」的第二处。
   */
  deltaDimensions: readonly string[];
  /** **敏感档**: 是否补期权日快照 (直调 `SyncOptionSnapshotUseCase.collect`)。 */
  optionSnapshot: boolean;
}

/**
 * 「哪些市场支持哪些补数内容」的**唯一**登记处 (FR-024)。
 *
 * ⚠️ `hk` 是**空表项而非缺项**: 它已在 `market-session.rules.ts` 登记了盘中时段, 却蓄意
 * 不开通期权采集 (那片是并行 HK 集成的地盘, plan §D11)。写成空表项而不是干脆不写, 是为了
 * 让「已知但未开通」与「压根没考虑过」在代码里看得出差别 —— 两者结局同为
 * {@link COLD_START_OUTCOME.MARKET_NOT_ENABLED}, 但下一个加市场的人需要知道 hk 被想过。
 */
export const COLD_START_CAPABILITY: Record<string, ColdStartCapability> = {
  us: { deltaDimensions: ['option_contract', 'us_equity_bar'], optionSnapshot: true },
  hk: { deltaDimensions: [], optionSnapshot: false },
};

/** 该市场是否有任何一档可补 —— 两档全关或未登记 ⇒ `false` (FR-023 显式 no-op)。 */
export function isColdStartEnabled(market: string): boolean {
  const capability = COLD_START_CAPABILITY[market];
  if (capability === undefined) return false;
  return capability.deltaDimensions.length > 0 || capability.optionSnapshot;
}

// ─────────────────────────────────────────────────────────────────────────────
// 快照三元组决策 (plan §D4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 决策入参。**全部日历事实由调用方查好喂进来** —— 本文件零 I/O。
 *
 * 🚫 `market` **MUST NOT 做成带默认值的可选入参** (同 `trading-day-gate.ts` 的
 * `OPTION_EXCHANGE_SCOPE` 上方那条禁令): 悄悄落回某个市场的口径, 正是本函数存在的理由。
 */
export interface SnapshotSpecInput {
  /** 锚所属市场 (`us` / `hk` / ...)。必填。 */
  market: string;
  /** 本次冷启动的**绝对时刻**。 */
  now: Date;
  /**
   * `trading_day` 中 ≤ `sessionWatermark(market, now)` 的**最大交易日**
   * (= 最近一个已收盘交易日, FR-006)。`null` = 日历缺行。
   */
  lastClosedTradingDay: string | null;
  /** `exchangeCalendarDate(market, now)` 那一天**是不是**该市场的交易日。 */
  todayIsTradingDay: boolean;
  /** {@link lastClosedTradingDay} 的**上一个交易日**; `null` = 日历缺更早的行。 */
  tradingDayBeforeTarget: string | null;
}

/**
 * 决策结果: 要么给出一份可直接喂给 `collect` 的归属声明, 要么放弃并交回结局。
 */
export type ColdStartSnapshotDecision =
  | {
      decision: 'collect';
      /**
       * 🚨 **原样喂给 `SyncOptionSnapshotUseCase.collect`, 别在调用点重算** ——
       * 重算就是第二处判据, 而这套判据错了不报错、只让数字差一天。
       */
      spec: SnapshotCollectionSpec;
      /**
       * 本次采集的 OI 归属日 (`YYYY-MM-DD`)。
       *
       * ⚠️ **不喂给 `collect`** —— 它自己从 `trading_day` 派生 (`resolveOiSessionDate`)。
       * 之所以仍在这里给出: FR-014 要求「归属交易日」与「OI 归属日」两个口径与常规轮 / 盘前
       * 兜底在同一时刻取值一致, 而 D4 那张表的第三列在这儿写死一次之后, 单测才能拿它跟
       * `collect` 的派生规则对表 —— 谁改坏任一边立刻红。
       *
       * `null` = {@link SnapshotSpecInput.tradingDayBeforeTarget} 缺行。此时**不复制**
       * `collect` 的 `previousWeekday` 兜底 (那条兜底连同它的 ERROR 只该有一处), 采集照常。
       */
      oiAsOf: string | null;
    }
  | { decision: 'abandon'; outcome: typeof COLD_START_OUTCOME.CALENDAR_MISSING };

/**
 * 按 plan §D4 的四行表定「补哪一天、按什么来源、OI 算哪天」。复杂度 O(1)。
 *
 * | 条件 | `sessionDate` | `source` | `oiAsOf` |
 * | --- | --- | --- | --- |
 * | `target` 查不到 | — | — | **放弃** (照抄 remediation 的 `blocked`: 不猜日子) |
 * | `today === target` (仍在目标 session 收盘当日的盘后) | `target` | `eod` | `target` 的上一交易日 |
 * | `today > target` 且 `today` **是**交易日 (已进下一交易日盘前, OI 已翻新) | `target` | `premarket_backfill` | `target` |
 * | `today > target` 且 `today` **不是**交易日 (周末 / 节假日, OI 未翻新) | `target` | `eod` | `target` 的上一交易日 |
 *
 * 🚨 **本函数把 `option-snapshot-remediation` 的两条固定路径推广成一条连续规则** —— 在它
 * 自己的两个时点 (北京 08:00 / 18:00) 上取值**逐字相同**, 单测里有一条跑真 remediation 的
 * 等值回归钉住这件事。
 *
 * 🚨 **`oiAsOf` 两条路径 MUST NOT 抹平**: 抹平后永远不会红, 但两条路径产出的 OI 差一天,
 * 而活跃度排名与 UI 的 `asOf` 都读它 (`sync-option-snapshot.usecase.ts` Guardrail 6)。
 *
 * 🚫 **MUST NOT 扩成「补最近 N 天」** (FR-008): 只有紧邻的上一个 session 能从当下快照原样
 * 补回, 再往前一天拿到的是错的收盘价。
 */
export function resolveSnapshotSpec(input: SnapshotSpecInput): ColdStartSnapshotDecision {
  const { market, now, lastClosedTradingDay: target, todayIsTradingDay } = input;
  if (target === null) {
    // 🚫 不猜: 猜错就是一批 `session_date` 标错的脏行, 比不补更难发现且要人工回删。
    return { decision: 'abandon', outcome: COLD_START_OUTCOME.CALENDAR_MISSING };
  }

  const today = exchangeCalendarDate(market, now);
  // 已进下一个**交易日**的盘前 ⇒ 目标 session 的 OI 已随之翻新, 此刻抓到的就是它的真值。
  // 非交易日 (周末 / 节假日) 不翻新 ⇒ 与「仍在收盘当日」同走 eod。
  const oiRefreshed = today > target && todayIsTradingDay;

  return {
    decision: 'collect',
    spec: {
      sessionDate: target,
      mode: oiRefreshed ? SNAPSHOT_SOURCE_PREMARKET_BACKFILL : SNAPSHOT_SOURCE_EOD,
      marketScope: [market],
      // 绝对时刻原样带过去: DTE 基准要的是「今天离到期还有几天」, 拿 `sessionDate` 当基准
      // 会让豁免线在补采路径上系统性偏一天且永远不会红 (Guardrail 18)。
      now,
    },
    oiAsOf: oiRefreshed ? target : input.tradingDayBeforeTarget,
  };
}
