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
 * 3. {@link COLD_START_OUTCOME} —— 结局值域 (FR-027 起, 零折叠)。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 结局值域 (FR-027, 066 FR-014)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一次冷启动的结局。**取值两两互异** —— FR-027 明禁把「没做」与「做了但失败」折叠成
 * 同一个值: 折叠之后一条按结局分组的查询再也分不出「今天本就不该做」和「今天该做没做成」,
 * 而那两件事的处置完全相反 (前者不该有人管, 后者要人管)。
 *
 * 沿革: FR-027 原始八档 → FR-027a 补 {@link BACKFILL_INCOMPLETE} → 066 FR-014 补
 * {@link NO_OPTION_CHAIN}, 现为十档。
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
  /**
   * 该标的**根本没有挂牌期权** (066 FR-014 / FR-014a) —— **终态、非错误、不告警**。
   *
   * 🚨 它与 {@link BACKFILL_INCOMPLETE} 的差别是「本就没有可做的」对「该做没做成」, 两者的
   * 处置完全相反 (前者不该有人管, 后者要人管) —— 正是 `FR-027` 零折叠立论的同一条理由。
   *
   * **为什么必须是一档独立结局而不是降一级日志**: 「按结局分组的查询要能分出这两件事」是
   * 八值零折叠的立论本身; 只降日志级别不改 `outcome` 列, 查询面依然分不出。
   *
   * **为什么不是边缘情况**: 港股绝大多数标的没有挂牌期权 (2026-08-22 实测六只: 腾讯 8 /
   * 小米 8 / 海底捞 7 / 药明康德 8 个到期日, 而**颐海国际 0、网龙 0**) —— 与美股「大部分
   * 流动股都有期权」正好相反。折进 `backfill_incomplete` 会让每一只无期权的港股锚都产出
   * 一条 ERROR 级、需人工介入的记录, 而那件事既不是故障也无从处理。
   *
   * 🚫 判据**取自库中该标的的期权合约计数**, MUST NOT 取采集过程的统计量 —— 「有合约但整批
   * 被落库前硬门拒掉」那种情形统计量同样为空, 两件事会被混成一个 (与既有「判据看库不看
   * stats」同源, 见 `anchor-cold-start.usecase.ts` 落库复判处)。
   *
   * ⚠️ **对美股不是零影响, 这是蓄意的**: 「链跑完但该票零合约」这条路径以前落
   * `backfill_incomplete`, 现在按同一判据落本档。美股锚基本都是有期权的票 ⇒ 真撞上它多半
   * 意味着链发现对该 target 失败了, 而那条**由链维度自己的失败计数告警**
   * (`dimension-executor.ts` 的 `alertIfDegraded`), 不靠冷启动结局兜底。既有八档的**语义**
   * 逐点不变, 变的只是这一条路径的归属。
   */
  NO_OPTION_CHAIN: 'no_option_chain',
} as const;

export type ColdStartOutcome = (typeof COLD_START_OUTCOME)[keyof typeof COLD_START_OUTCOME];

// ─────────────────────────────────────────────────────────────────────────────
// 市场能力登记 (FR-024)
// ─────────────────────────────────────────────────────────────────────────────

/** 某市场冷启动能补哪些内容。空表项 (两档全关) = 已知但未开通。 */
export interface ColdStartCapability {
  /**
   * **不敏感档**: 是否补期权链 (直调 `SyncOptionContractUseCase.collect`)。
   *
   * 🚫 **日线不在本表** (issue #159 起): 建锚那一刻 `CreateAnchorUseCase.seedLastClose`
   * 已经同步调过 `EnsureLatestEodBarUseCase` 取最近收盘 —— 同一个 `EOD_BAR_PORT`
   * (按市场路由)、同一个 `writeDailyBarRows`、10 天回看窗。而 `optionsdesk.anchor` 全仓
   * **只有一个 create 点** (`create-anchor.usecase.ts`), 控制器建锚与批量导入都汇到它
   * ⇒ 每一只锚的日线在它出生那一秒就已经取过了, 冷启动再补一遍是纯重复劳动。
   *
   * 📌 因此本字段从 `deltaDimensions: string[]` 收成布尔: 原先登记 code 是因为要拿它去
   * 组维度 job 的 flow, 而维度 job 的工作集是**全部**已开闸标的 —— 那正是 #159 要消灭的
   * O(N²)。改直调本体后既不需要 dim code, 也不再有第二个成员。
   */
  optionChain: boolean;
  /** **敏感档**: 是否补期权日快照 (直调 `SyncOptionSnapshotUseCase.collect`)。 */
  optionSnapshot: boolean;
}

/**
 * 「哪些市场支持哪些补数内容」的**唯一**登记处 (FR-024)。
 *
 * ⚠️ 「登记了但两档全关」(空表项) 与「压根没登记」(缺项) 结局同为
 * {@link COLD_START_OUTCOME.MARKET_NOT_ENABLED}, 但代码里看得出差别 —— 空表项的意思是
 * 「已知但未开通」。今天两者的现役例子分别是: 无 (hk 已于 066 T06 开通) 与 `cn`。
 *
 * 🚨 **`hk` 两档必须同开同关 —— MUST NOT 停在 `{optionChain: true, optionSnapshot: false}`
 * 这个中间态** (066 FR-016a): 中间态会让 use case 第 7 步的 chain-only 早退
 * (`if (!capability.optionSnapshot) return backfilled`) 抢在**盘中闸 / `no_option_chain`
 * 判断 / 落库复判**三者之前 —— 盘中建的港股锚会落 `backfilled` 而一行快照都没有、无挂牌期权
 * 的票落不到 `no_option_chain`、采集没落库也照样报「已补齐」。三条验收同时破, 且**都不报错**。
 *
 * 🚨 **本表与 `sync_dimension.hk_option_daily_snapshot.enabled` 是彼此独立的两条路, 必须
 * 在同一个 commit 里一起翻** (FR-016a): 本表管**建锚路径** (冷启动直调采集本体, **不读**
 * 采集维度的启用位), 那一行管**夜间 cron 路径**。只翻其一的表现是两条路行为分叉 —— 建锚补得到
 * 而当晚 cron 一行不采, 或反之 —— 而两种分叉都只是「某条路默默什么都没做」, 不报错。
 * 机械断言 (两者同真同假) 在 `test/integration/marketdata-066.hk-dimension-seed.it.spec.ts`。
 *
 * 🚫 **日线不在本表** (issue #159): 建锚那一刻 `CreateAnchorUseCase.seedLastClose` 已同步调过
 * `EnsureLatestEodBarUseCase` (按市场路由, hk 走理杏仁, 写同一张 `daily_bar`) ⇒ FR-011「不新增
 * 日线采集维度」自动满足。⚠️ 但那条路对 **universe 未收录**的港股票会**早退**: `instrument`
 * 行不存在时它只 warn 返 `null` (「不猜、不建 instrument 行」是它的明写纪律) —— 那种标的的日线
 * 要靠 066 T03 修好的 `needSync` 默认值 (`market !== 'us'`) + 当晚 22:00 的 `eod_bar` 才补得上。
 * 这就是「T03 必须先于本开关」那条排序的真实后果面。
 */
export const COLD_START_CAPABILITY: Record<string, ColdStartCapability> = {
  us: { optionChain: true, optionSnapshot: true },
  hk: { optionChain: true, optionSnapshot: true },
};

/** 该市场是否有任何一档可补 —— 两档全关或未登记 ⇒ `false` (FR-023 显式 no-op)。 */
export function isColdStartEnabled(market: string): boolean {
  const capability = COLD_START_CAPABILITY[market];
  if (capability === undefined) return false;
  return capability.optionChain || capability.optionSnapshot;
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
