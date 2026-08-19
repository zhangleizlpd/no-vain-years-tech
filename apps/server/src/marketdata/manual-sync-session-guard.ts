import { exchangeCalendarDate, isSessionComplete } from './session-clock.js';

/**
 * **手动补采的时点闸** —— 收盘口径的维度只能在该市场收盘后跑（2026-08-17 prod 实撞）。
 *
 * ## 事故形态
 *
 * 北京 21:07（= ET 09:07 周一，**盘前**）跑 `marketdata-trigger --dimension
 * option_daily_snapshot` ⇒ 8065 行盘前数据被盖上 `session_date=2026-08-17 / source='eod'`。
 * 又因该表落库是 `createMany(skipDuplicates)`（键 `(contract_id, session_date, source)`）⇒
 * **当晚真收盘那轮被静默挡掉**；而完整性探针只核逐合约覆盖率（行在 = 覆盖满）照样绿。
 * 13 只锚整条链被错标，靠人工 SQL 删了三次才清干净。
 *
 * 根因不是 CLI，是判据缺失：采集本体拿**市场时区的日历日**（`exchangeCalendarDate`）当
 * `session_date`，从不问「这一场收了没有」。四个入口里前三个（夜间轮 / 当日重试 / 盘前兜底）
 * 各有自己的 `cron_expr`、**时刻是评审过的配置**；CLI 是第四个，时刻由敲命令的人决定。
 *
 * ## 🚨 为什么闸在这里，而不在采集本体里
 *
 * 曾把断言下沉到 `SyncOptionSnapshotUseCase.collect()`，**实测两条都不成立**：
 *
 * 1. **它会让 worker 路径的正确性挂在墙上时钟上** —— `MarketdataSyncWorker.processDimension`
 *    传的是 `now: new Date()`，于是 worker 驱动的整夜端到端 IT「几点跑就几点的结论」：
 *    北京 13:52 跑（ET 01:52 盘前）全红，凌晨跑就绿。测试的成败取决于运行时刻，不可接受。
 * 2. **没有任何一个 `now` 能同时满足全景 IT 的两个前提** —— `universe` 的 scope 是
 *    `{cn,hk,us}`，`exchangeCalendarDateForScope` 在三者业务日不一致时**抛**；而 us 收盘要求 ET ≥ 16:00，
 *    那时北京已翻天 ⇒ 「us 已收盘」与「三市场同业务日」在任何时刻都不可兼得。
 *    📌 生产里不存在这个矛盾：`universe` 的 cron 是周一 22:00（ET 10:00，同日历日），
 *    `option_daily_snapshot` 是每日 06:30（ET 前日 18:30，已收盘）—— **各维度各自挑了能让
 *    自己 scope 成立的时刻**。把 28 个维度塞进一个 `now` 是测试侧刻意的简化。
 *
 * ⇒ 闸放在**显式传 `now` 的手动入口**上：定时轮的时点由 `cron_expr` 治理，随手敲的命令才是
 * 风险源。**代价说清楚：采集本体没有第二道闸** —— 将来若新增第三个手动入口（管理端点 / 另一
 * 条 CLI），必须在那里也调 {@link assertClosedSessionForManualSync}，否则这个洞原样复活。
 *
 * 📌 **这笔债的另一半已在 063 Phase 1 结清**：「这批数据算哪一天」不再由各入口自算，四个入口
 * 共用 `sync-asof.rules.ts` 的 `resolveAsOfForDimension`。本闸管的是**另一件事** ——「这一场还没
 * 收盘就别去采」。两者不可互相替代：日线可以**订正日期**（区间接口能取历史），而期权链快照
 * vendor 只给当下一份，跑早了只能**拒绝**。
 */

/** 收盘口径 = 采集时刻决定业务日，因此必须在该场收盘后跑。 */
const OPTION_DAILY_SNAPSHOT = 'option_daily_snapshot';

/**
 * 受本闸约束的维度集。
 *
 * 🚨 **只有 `option_daily_snapshot` 一个**，判据是「错行的后果**可不可逆**」而不是「口径像不像」：
 * 它落库是 `createMany(skipDuplicates)` ⇒ 错行按唯一键占位，把当晚真收盘那轮**永久**挡在门外。
 *
 * 📌 同为收盘口径的 `underlying_iv_daily` **刻意不在此列**：它落库是 upsert，错行会被下一轮
 * 覆盖修正，没有不可逆后果（060 spec 的 Out of Scope 段对同一件事已有同样判断）。把它拦掉是
 * **误拒一个合法操作** —— 那和放行错数一样是 bug，只是方向相反。
 */
export const DIMENSIONS_REQUIRING_CLOSED_SESSION: ReadonlySet<string> = new Set([
  OPTION_DAILY_SNAPSHOT,
]);

/** 一个待入队维度的时点判据入参（`marketScope` 取自 `sync_dimension` 行）。 */
export interface ClosedSessionCandidate {
  dimensionKey: string;
  /** `sync_dimension.market_scope`。缺 / 空 ⇒ 视为不受约束（见 {@link assertClosedSessionForManualSync}）。 */
  marketScope: string[] | null;
}

/** 时点闸不通过 —— 命令拒绝入队。不是「系统坏了」，是「这条命令跑早了」，文案按这个语气写。 */
export class ManualSyncSessionNotClosedError extends Error {
  constructor(readonly offenders: readonly { dimensionKey: string; market: string }[]) {
    const detail = offenders.map((o) => `${o.dimensionKey}(${o.market})`).join(', ');
    super(
      `[marketdata-cli] 拒绝入队: ${detail} 是收盘口径的维度, 但该市场本场**尚未收盘** —— ` +
        `此刻采到的是上一场的价, 却会盖上当天的 session 日戳; 且 option_daily_snapshot 落库是 ` +
        `createMany(skipDuplicates), 错行会把当晚真收盘那轮**静默挡掉**(2026-08-17 实撞)。` +
        `⇒ 采本场请等该市场收盘后再跑 (us 收盘 16:00 ET = 北京次日 04:00 起; 夜间轮 06:30 ` +
        `Asia/Shanghai 本就会跑); 要补**上一个** session 的缺口走盘前兜底 ` +
        `(option-snapshot-remediation, 每日 18:00 Asia/Shanghai 自动跑, 无需手动)。`,
    );
    this.name = 'ManualSyncSessionNotClosedError';
  }
}

/**
 * 入队**之前**判一次：本批里凡属收盘口径的维度，其 `marketScope` 内每个市场都必须已收盘。
 *
 * 判据与采集本体**同源**：`sessionDate` 用同一个 {@link exchangeCalendarDateForScope} 求（而不是另起一套
 * 时区表），问的就是采集本体待会儿会写哪一天。两处若哪天漂了，漂的也是同一个函数。
 *
 * 多市场 scope 取**最严**（任一市场未收即拒）—— 现役受约束维度只有 `{us}`，这是为将来真接入
 * 他所期权时保持保守。空 scope 视为不受约束：`sync_dimension` 缺 `market_scope` 是另一类配置
 * 问题，两条 CLI 各自已有 `sync_dimension 缺行` 的 fail-fast。
 *
 * 🚨 **抛而不是静默 skip**：skip 会让 CLI 退出码 0 = 「表面成功」，那正是事故的形态。
 *
 * 复杂度 O(维度数 × scope 长度)。
 */
export function assertClosedSessionForManualSync(
  candidates: readonly ClosedSessionCandidate[],
  now: Date,
): void {
  const offenders: { dimensionKey: string; market: string }[] = [];
  for (const candidate of candidates) {
    if (!DIMENSIONS_REQUIRING_CLOSED_SESSION.has(candidate.dimensionKey)) continue;
    // `?? []` 不是防御性编程的花边: 空 / 缺 scope 按「不受约束」放行是本函数写明的语义,
    // 而裸 for-of 一个 undefined 会当场 TypeError —— 那会把「配置缺一列」变成「CLI 崩了」。
    for (const market of candidate.marketScope ?? []) {
      // 逐市场问, 不整体求 —— scope 版对跨时区会抛, 而本闸恰恰应该逐个判。
      if (!isSessionComplete(market, exchangeCalendarDate(market, now), now)) {
        offenders.push({ dimensionKey: candidate.dimensionKey, market });
      }
    }
  }
  if (offenders.length > 0) throw new ManualSyncSessionNotClosedError(offenders);
}
