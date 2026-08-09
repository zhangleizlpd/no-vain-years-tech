/**
 * 期权链发现的**贪心分窗**纯函数 (047 T008, FR-029 / FR-032, plan D-DATA-2)。无 I/O、无 DI
 * (ADR-0043 §4)。
 *
 * vendor 硬约束两条: `get_option_chain` 是**单 code** 接口, 且**到期日窗跨度 ≤30 天**
 * (官方文档「传入的时间跨度上限为 30 天」, 2026-08-04 复核)。⇒ 先 `get_option_expiration_date`
 * 取全部可得到期日, 再本地分组: **相邻到期日只要落在同一个 ≤30 天的窗里就并成一次调用**。
 *
 * 两件事:
 *   ① {@link planOptionChainWindows} 到期日列表 → 窗口序列
 *   ② {@link gapCheckExpiryDates}    已发现合约的到期日集合 vs vendor 权威列表 → 双向差集
 *
 * ## 🚫 窗口边界 MUST NOT 手算 (E38 定论 2 的纪律)
 *
 * 每个窗的 `start` / `end` 都**取自真实到期日本身**, 不是 `起点 + 30k` 这种合成日期链。
 * E38 那次正是拿手算的 as-of 链去对 vendor 的实际数据, 边界一错就整段静默错位。
 * ⇒ 本文件的机器判据: 窗两端恒等于 `expiryDates[0]` / `expiryDates.at(-1)`, 单测直接断言。
 *
 * ## 🚨 贪心的预算锚在**组首**, 不在「已并入的末个到期日」
 *
 * 每组的准入线 = `组首到期日 + 上限`, **并入新成员不重置预算**。写成「拿刚并进来的到期日
 * 续期」看着更贪心, 但会让窗跨度无上限地滚下去 (实测数据上 8-21 / 9-18 / 10-16 会连成一窗,
 * 跨度 56 天) ⇒ vendor 直接 4xx, 整轮链发现断掉 —— 正是 `us_equity_bar` 08-01 回填事故的形状。
 *
 * ## 为什么「不设到期日上限、含 LEAPS」在成本上成立 (FR-032)
 *
 * 远端到期日**稀疏**(只剩月度 / 季度, 相邻 28 或 35 天), 而 28 天的能并窗 ⇒ 调用数**不随
 * 时间线性增长**。p3b 实测基线: 5–12 月 **8 个到期日 = 5 次调用**（本文件单测钉死该数）。
 *
 * ## 「腿静默消失」是本文件唯一要防的 bug 类
 *
 * 分窗漏掉一个到期日 ⇒ 那一整批腿永久采不到, 而**每次调用都成功、日志全绿**。故窗口除日期
 * 区间外还带回 {@link OptionChainWindow.expiryDates} —— 让「并集 = 输入全集、无重无叠」成为
 * 可断言的结构事实, 而不是靠读代码相信。
 */

const MS_PER_DAY = 86_400_000;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `get_option_chain` 单次请求的到期日窗跨度上限（自然日，**含首尾**）。
 *
 * vendor 官方原文是「传入的时间跨度上限为 30 天」，**没说 30 算的是含首尾天数还是端点日期差**。
 * 这里取**更严的那种读法**（含首尾计数 ≤30 ⇒ 端点差 ≤29），与同目录
 * `underlying-iv.rules.ts` 的 `HIS_VOLATILITY_MAX_SPAN_DAYS` 同口径：猜严了成本是多切一页
 * （一次调用），猜宽了则整轮链发现被 vendor 4xx 打断、当日快照全无 —— 而**期权快照漏采即
 * 永久缺口**（vendor 不提供历史交易日的链快照）。不对称性一边倒。
 *
 * 🚫 这是 vendor 侧的硬约束，MUST NOT 与 `ratelimit.py` 的 10 次/30s 限频混为一谈（那条是
 * 官方真值，本片一个字不改）。
 */
export const OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS = 30;

/** 一次 `get_option_chain` 调用的到期日窗。`start` / `end` 恒为**真实到期日**。 */
export interface OptionChainWindow {
  /** 窗起始日 = 本组首个到期日本身（闭区间）。 */
  start: string;
  /** 窗结束日 = 本组末个到期日本身（闭区间）。 */
  end: string;
  /** 本窗覆盖的到期日，升序。所有窗的并集 = 输入去重后的全集。 */
  expiryDates: readonly string[];
}

/** 双向差集。两侧都要报 —— 只看一侧会漏掉「vendor 悄悄多挂了到期日」这个方向。 */
export interface ExpiryGapCheckResult {
  /** 两个差集皆空。 */
  ok: boolean;
  /** vendor 权威列表里有、但链调用没发现到合约的到期日（升序）——「腿静默消失」的正面信号。 */
  missingFromDiscovered: string[];
  /** 发现到了、但不在 vendor 权威列表里的到期日（升序）—— 列表与链数据不自洽。 */
  unexpectedInDiscovered: string[];
}

/**
 * 分窗入参非法（到期日格式 / 日历不存在 / 跨度上限非正）。
 *
 * **这里抛而 `option-snapshot-guard.rules.ts` 不抛**，二者不矛盾：那边是逐行数据门（一条脏行
 * 不该带走整批落库），这边是**请求计划**——计划算错的后果是整票的腿静默缺失，且没有任何
 * 下游能发现。静默丢掉一个到期日 = 一整批腿永久缺口。
 */
export class InvalidChainWindowInputError extends Error {
  constructor(message: string) {
    super(`[option-chain-window] ${message}`);
    this.name = 'InvalidChainWindowInputError';
  }
}

/** `YYYY-MM-DD` 校验 + 日历有效性（02/30 这类会被 Date 滚成下月，回读不等即非法）。 */
function assertIsoDate(raw: string): void {
  const m = ISO_DATE_RE.exec(raw);
  if (m === null) {
    throw new InvalidChainWindowInputError(`到期日不是 YYYY-MM-DD: "${raw}"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new InvalidChainWindowInputError(`到期日是不存在的日期: "${raw}"`);
  }
}

/** 端点日期差（天）。含首尾计数 = 本值 + 1。 */
function endpointOffsetDays(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY;
}

/** 校验 + 去重 + 升序（ISO 日期字典序即时序，无需自定义 comparator）。 */
function normalizeExpiryDates(expiryDates: readonly string[]): string[] {
  for (const d of expiryDates) assertIsoDate(d);
  return [...new Set(expiryDates)].sort();
}

/**
 * 到期日列表 → `get_option_chain` 的窗口序列（FR-029 / FR-032）。
 *
 * 贪心：以尚未分组的**最早到期日**开组，把所有满足「含首尾跨度 ≤ `maxSpanDays`」的后继到期日
 * 并入；窗口 = `[组首到期日, 组末到期日]`。⇒ 窗口**首尾相接不重不叠**（每个到期日恰好属一组）、
 * 并集 = 输入全集、每窗跨度不超上限，三者由单测的 `assertWindowsCoverExactly` 一并钉死。
 *
 * 空输入 → `[]`（该票无期权链是合法状态，不是错误）。输入乱序 / 含重复 → 先归一化：vendor
 * **未承诺**返回有序，而假设有序一旦不成立，产出的窗会漏掉到期日且不报错。
 *
 * 复杂度 **O(n log n)**，排序主导（分组本身单遍 O(n)）。
 * ⚠️ tasks.md 记的 O(n) 是按「vendor 返回已升序」这个前提算的 —— 该前提没有文档保证，而
 * 假设错了的后果正是本函数要防的那类静默漏窗；n 是单票的到期日数（数十量级），排序成本可忽略。
 * 此处记录该偏离，免得下次有人把排序「优化」掉。
 *
 * @param maxSpanDays 窗口跨度上限（含首尾）。默认 {@link OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS}；
 *   入参化只为让单测能钉边界，生产调用**不传**。
 */
export function planOptionChainWindows(
  expiryDates: readonly string[],
  maxSpanDays: number = OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS,
): OptionChainWindow[] {
  if (!Number.isInteger(maxSpanDays) || maxSpanDays <= 0) {
    throw new InvalidChainWindowInputError(`maxSpanDays 必须是正整数, 实得 ${maxSpanDays}`);
  }

  const [first, ...rest] = normalizeExpiryDates(expiryDates);
  if (first === undefined) return []; // 该票无期权链, 不是错误。

  const maxEndpointOffset = maxSpanDays - 1; // 含首尾计 maxSpanDays 天。
  const windows: OptionChainWindow[] = [];
  let groupStart = first;
  let groupEnd = first;
  let group: string[] = [first];

  for (const expiry of rest) {
    // 🚨 预算锚在 groupStart（**组首**）, 不是刚并进来的那个 —— 拿新成员续期会让跨度无上限滚下去。
    if (endpointOffsetDays(groupStart, expiry) > maxEndpointOffset) {
      windows.push({ start: groupStart, end: groupEnd, expiryDates: group });
      groupStart = expiry;
      group = [];
    }
    groupEnd = expiry;
    group.push(expiry);
  }
  windows.push({ start: groupStart, end: groupEnd, expiryDates: group });

  return windows;
}

/**
 * 链发现跑完后的 gap check（plan D-DATA-2「跑完 MUST 做」那一条）。
 *
 * 比的是**已发现合约的到期日集合**与 `get_option_expiration_date` 返回的**权威列表**。
 * 🚨 调用方 MUST 在有差集时上抬而非静默 —— 差集非空意味着某个到期日的整批腿没落库，而分窗
 * 与链调用本身**全都成功了**，除了这条对表没有任何东西会发现它。
 *
 * 集合语义：对入参的顺序与重复不敏感；两侧皆空 → `ok`（该票无期权链是合法状态）。
 *
 * 复杂度 **O(n + m)** 建集 + **O(k log k)** 排序差集（k = 差集大小，正常态为 0）。
 */
export function gapCheckExpiryDates(
  discovered: readonly string[],
  vendorReturned: readonly string[],
): ExpiryGapCheckResult {
  const discoveredSet = new Set(discovered);
  const vendorSet = new Set(vendorReturned);

  const missingFromDiscovered = [...vendorSet].filter((d) => !discoveredSet.has(d)).sort();
  const unexpectedInDiscovered = [...discoveredSet].filter((d) => !vendorSet.has(d)).sort();

  return {
    ok: missingFromDiscovered.length === 0 && unexpectedInDiscovered.length === 0,
    missingFromDiscovered,
    unexpectedInDiscovered,
  };
}
