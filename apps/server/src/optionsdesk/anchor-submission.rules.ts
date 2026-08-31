import type { TradingDayStatus } from '../marketdata/trading-day.rules';

/**
 * 锚待审箱的**判据层** (072)。纯函数、零 I/O、无 DI (ADR-0043 §4)。
 *
 * 住在这里的只有一样东西: 「这条待审的 `asof` 可不可信」。它是把
 * `ops/bin/anchor-approve.sh` 的 `plan` / `apply` 两个动词里那套 fail-closed 闸搬上线 ——
 * 而那套闸不是设计出来的, 是 059 那轮实测逼出来的: 只给能力目录时 `asof` **13/13 全错**,
 * 且是**收敛地错** (每次错成同一个值, 重复采样根本发现不了)。
 *
 * 🚨 **本文件比 shell 那版强一档, 差别只在一处**: shell 自己写着「这条判不了节假日」——
 * 它只能做「未来 / 周末」两种必要条件筛。服务端有 `TradingCalendarPort`, 所以判据的输入是
 * 日历的**三态**而不是 `getUTCDay()`。这正是 `cross-timezone-date-semantics.md` 铁律 2
 * 「交易日 ≠ 时区转换后的日历日 …『恰好相等』不是『可以推导』」的落点。
 *
 * 🚨 **本文件不自己算「今天」、也不自己查日历**: 两个事实 (`exchangeToday` 与
 * `calendarStatus`) 都由 use case 查好喂进来 —— 同 `classifyTradingDay` 的体例。
 * 在这里现算时区会变成仓里第 N 份「谁的今天」, 而那类偏差不报错, 只让日期差一天。
 */

export const ANCHOR_SUBMISSION_ASOF_FLAGS = [
  'OK',
  'TODAY',
  'FUTURE',
  'NON_TRADING',
  'UNKNOWN',
] as const;

export type AnchorSubmissionAsofFlag = (typeof ANCHOR_SUBMISSION_ASOF_FLAGS)[number];

export interface ClassifyAsofInput {
  /** 待审条目的估值口径日, `YYYY-MM-DD`。 */
  asof: string;
  /** **交易所当地**今天 (`exchangeCalendarDate(market, now)`), `YYYY-MM-DD`。 */
  exchangeToday: string;
  /** 日历对 `asof` 那天的三态判定 (`TradingCalendarPort.classify`)。 */
  calendarStatus: TradingDayStatus;
}

/**
 * 五档判定。**顺序即优先级**, 且每一档都有各自的处置, 不可折叠:
 *
 * 1. `FUTURE`    —— 晚于交易所今天。那天的收盘价**还不存在**, 无论它是不是交易日。
 * 2. `NON_TRADING` —— 日历说那天不开市 (周末**与节假日**, shell 版盖不住后者)。
 * 3. `UNKNOWN`   —— 日历没填到那一段。🚨 **MUST NOT 折进 `OK`**: `TradingDayStatus` 三态的
 *    立意就是「『我不知道』不许折进『不是』」; 折了就是把「日历缺行」静默判成「这天没问题」,
 *    而调用方据此放行 = 替日历做主。
 * 4. `TODAY`     —— 就是今天。**只是 warning, 不阻断**: 服务端判不了该场收没收盘, 而在这里
 *    造一个「收没收盘」的判断会成为仓里第四处同类口径 (前三处见 speed-lookup 表)。
 * 5. `OK`
 *
 * 复杂度 O(1), 纯字符串比较 —— `YYYY-MM-DD` 定长零填充, 字典序即日期序。
 */
export function classifyAsof({
  asof,
  exchangeToday,
  calendarStatus,
}: ClassifyAsofInput): AnchorSubmissionAsofFlag {
  if (asof > exchangeToday) return 'FUTURE';
  if (calendarStatus === 'non-trading') return 'NON_TRADING';
  if (calendarStatus === 'unknown') return 'UNKNOWN';
  if (asof === exchangeToday) return 'TODAY';
  return 'OK';
}

/**
 * 这一档要不要**显式确认**才放行采纳 (fail-closed 闸的判据单点)。
 *
 * 🚨 `TODAY` **不在**其中 —— 见 {@link classifyAsof} 第 4 档。把它加进来等于让每天正常提交的
 * 那一批全部卡住要人点两次, 而服务端并没有多知道一点东西。
 */
export function asofNeedsAcknowledgement(flag: AnchorSubmissionAsofFlag): boolean {
  return flag === 'FUTURE' || flag === 'NON_TRADING' || flag === 'UNKNOWN';
}

export const ANCHOR_SUBMISSION_DISPOSITIONS = ['create', 'refresh'] as const;
export type AnchorSubmissionDisposition = (typeof ANCHOR_SUBMISSION_DISPOSITIONS)[number];

/**
 * 采纳这条会**新建**锚还是**刷新**既有锚。
 *
 * 判据只有「该 ticker 在锚表里有没有行」—— 与 `anchor-approve.sh plan` 那条
 * `LEFT JOIN anchor ON ticker` 同源。
 *
 * 🚨 `refresh` 不是「更温和的 create」, 恰恰相反: 它会冲掉三处人工位并把
 * `confidence_source` 翻成 `model` (此后该锚的置信度在 App 里改不动了)。shell 版默认
 * **跳过** refresh 行, 但那是批处理没法给你看警告时的权宜 —— 在屏幕上它们是最该被看见的一批。
 */
export function resolveDisposition(hasExistingAnchor: boolean): AnchorSubmissionDisposition {
  return hasExistingAnchor ? 'refresh' : 'create';
}
