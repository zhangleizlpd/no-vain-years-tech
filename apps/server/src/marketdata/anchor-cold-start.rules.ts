/**
 * 锚首建冷启动的**判据层** (060 T003, FR-023 / FR-024)。纯函数、**零 I/O**、无 DI
 * (ADR-0043 §4)。
 *
 * 两样东西住这里, 都是「散开就会漂」的那类:
 * 1. {@link COLD_START_CAPABILITY} —— 「哪些市场支持哪些补数内容」的**唯一**登记处 (FR-024);
 * 2. {@link COLD_START_OUTCOME} —— 结局值域 (FR-027 起, 零折叠)。
 *
 * 🚫 **第三样已经搬走了 (#187)**: 原 `resolveSnapshotSpec`(快照三元组决策表) 与 #181 新增的
 * `resolveSnapshotAttribution` 是**两份同源判据**, 两份必漂, 而漂的表现是「某条路径的
 * `session_date` 悄悄差一天」—— 不报错。冷启动现直接走
 * `snapshot-session-attribution.rules.ts` 的那一份, 本文件**MUST NOT** 再长回一个日期推导。
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
  /**
   * 交易日历缺行 ⇒ 定位不到目标交易日, 不猜。两条到达路径:
   * ① 目标 session 本身查不到 (`trading_day` 缺行);
   * ② 写敏感档时「今天是不是交易日」判成 `unknown` (062 T009 —— 猜口径会让 `source` 与
   *    `oi_as_of` 差一整天, 且不报错)。
   */
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
