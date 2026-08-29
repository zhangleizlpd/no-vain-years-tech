import { Prisma } from '../generated/prisma/client';
import {
  BUILD_RECALL_DTE,
  RENT_RECALL_DTE,
  type RecallCandidate,
  type RecallLegInput,
} from './leg-recall.rules';

/**
 * 064 optionsdesk **候选范围 (窗) 派生**纯函数 (FR-005 ~ FR-008, plan D4)。无 I/O、无 DI、零 class
 * (ADR-0043 §4)。
 *
 * 「窗」= 盘中取实时报价时**要向 vendor 问哪一批合约**的范围。它不是判据 —— 判据仍单点在
 * `leg-recall.rules.ts`。窗只负责把「值得问」的那批合约圈出来, 因为
 * 单批有硬上限 (`OPTION_SNAPSHOT_MAX_CONTRACT_CODES`), 而整条链动辄八百行。
 *
 * 🚨 **窗是判据定义域的「包络」而不是「等价」** (FR-006 / FR-007, plan D4):
 * - DTE 段**可以**精确派生 —— 它就是两个召回段的并集 ({@link WINDOW_DTE_MIN} /
 *   {@link WINDOW_DTE_MAX}), 边界数一份也不手写。
 * - strike 上下界**不能** —— 召回侧管行权价的那道门槛是权利金门槛 `PREMIUM_FLOOR`
 *   (`max(spot × 比例, 绝对下限)`), 它是个**动态**门槛: 同一个行权价在不同 spot / 不同报价下
 *   结论不同, 反解不出一对静态比例。⇒ 只能取一对**带余量的包络比例**
 *   ({@link STRIKE_ENVELOPE_FLOOR_SPOT_RATIO} / {@link STRIKE_ENVELOPE_CEILING_SPOT_RATIO}),
 *   并由 {@link windowTripwire} 兜住漂移。
 *
 * ⇒ 这两个数**没有**「算对了」这回事, 只有「够不够宽」。绊线是它们唯一的守卫。
 *
 * 复杂度: {@link legWindowFor} `O(1)`; {@link windowTripwire} `O(n)` (逐腿 `O(1)` 判据)。
 */

/**
 * 已支持的市场 (FR-008)。**今天只有美股**, 但派生一开始就按市场取参 —— 将来判据按市场分表时
 * 只需在这里加数据, 不必重写派生逻辑 (同 061 §4.5 tick 分组预埋)。
 */
export const WINDOW_SUPPORTED_MARKETS = ['us'] as const;

export type WindowMarket = (typeof WINDOW_SUPPORTED_MARKETS)[number];

/**
 * DTE 段下界 = 两个召回段下界的**较小者** (FR-005)。
 *
 * 🚫 MUST NOT 手写这个数 —— 它必须随 `leg-recall.rules.ts` 的召回段一起动。手写的第二份边界数
 * 在调参那天不会红: 窗悄悄比判据窄一截, 表现为「有些腿今天没有实时报价」, 与 vendor 真缺数
 * 不可区分。`scripts/checks/check-optionsdesk-rule-constants.ts` 的 050 不变量 #2 / #3 也按
 * 字面量 / 语法形状硬拦。
 */
export const WINDOW_DTE_MIN = Math.min(BUILD_RECALL_DTE.min, RENT_RECALL_DTE.min);

/** DTE 段上界 = 两个召回段上界的**较大者** (FR-005)。纪律同 {@link WINDOW_DTE_MIN}。 */
export const WINDOW_DTE_MAX = Math.max(BUILD_RECALL_DTE.max, RENT_RECALL_DTE.max);

/**
 * strike 下界比例 —— **带余量的包络, 不是 `PREMIUM_FLOOR` 的精确反解** (FR-006, plan D4)。
 *
 * 🚨 `PREMIUM_FLOOR` 是 `max(spot × 比例, 绝对下限)` 的**动态**门槛, 反解不出静态比例: 同一个
 * 行权价能不能过门槛取决于当时的报价, 而不是它离 spot 多远。这里取的是一个**经验余量** ——
 * 深虚到 spot 的七成以下时, 认沽权利金在美股常规时段几乎必然落到门槛之下 ⇒ 问了也是白问。
 *
 * ⚠️ 它宁可**宽**不可窄: 窄了会把本该进候选的腿排除在实时批之外, 而那条腿照样出现在结果里
 * (只是带着收盘档的价), **不会红**。真正的守卫是 {@link windowTripwire}, 不是这个取值本身。
 */
export const STRIKE_ENVELOPE_FLOOR_SPOT_RATIO = new Prisma.Decimal('0.7');

/**
 * strike 上界比例 —— 同 {@link STRIKE_ENVELOPE_FLOOR_SPOT_RATIO}, **包络而非等价**。
 *
 * 收租侧的成色上界 (`resolveQualityCeiling`) 是「axis 之上最近一档行权价」与比例项取严
 * (067 起 `axis = min(spot, W)` ≤ spot ⇒ 仍在 spot 之下收口), 建仓侧由有效成本硬门槛
 * `K − bid < spot` 挡住 —— 两者都是**逐链 / 逐腿**才解得出的量。⇒ 这里取一个略高于 spot 的
 * 固定比例把它们整个罩住。
 */
export const STRIKE_ENVELOPE_CEILING_SPOT_RATIO = new Prisma.Decimal('1.05');

/** 一个市场在某个 spot 下的候选范围。四个边界均**闭区间** (含端点视为窗内)。 */
export interface LegWindow {
  /** 047 起选约表只看认沽。 */
  readonly optionType: 'PUT';
  readonly dteMin: number;
  readonly dteMax: number;
  /** `spot × ` {@link STRIKE_ENVELOPE_FLOOR_SPOT_RATIO}。 */
  readonly strikeMin: Prisma.Decimal;
  /** `spot × ` {@link STRIKE_ENVELOPE_CEILING_SPOT_RATIO}。 */
  readonly strikeMax: Prisma.Decimal;
  /** 非标合约不进选约表 (047 FR-008)。 */
  readonly isStandard: true;
}

/**
 * 某市场在给定 spot 下的窗 (FR-005 / FR-006 / FR-008)。`O(1)`。
 *
 * `spot` 取**定窗基准** (盘中价, 可滞后一个采集周期) —— 窗是包络, 容得下一拍滞后; 判据与呈现
 * 用的现价是另一个数 (与报价同刻), 两者 MUST NOT 合并 (FR-006a / plan D5)。
 *
 * 🚨 **未支持的市场 MUST throw, MUST NOT 静默返空 / 静默套用美股的窗** (FR-008): 返空会让港股
 * 看起来「今天没有实时报价」, 套用美股的窗则会让港股拿到一批按美股比例圈出来的合约 —— 两种错
 * 都算得出结果、都不会红。
 */
export function legWindowFor(market: string, spot: Prisma.Decimal): LegWindow {
  if (!isSupportedMarket(market)) {
    throw new Error(
      `[leg-window] 市场 '${market}' 尚未支持候选范围派生 —— 已支持: ` +
        `${WINDOW_SUPPORTED_MARKETS.join(' / ')}`,
    );
  }
  return {
    optionType: 'PUT',
    dteMin: WINDOW_DTE_MIN,
    dteMax: WINDOW_DTE_MAX,
    strikeMin: spot.times(STRIKE_ENVELOPE_FLOOR_SPOT_RATIO),
    strikeMax: spot.times(STRIKE_ENVELOPE_CEILING_SPOT_RATIO),
    isStandard: true,
  };
}

function isSupportedMarket(market: string): market is WindowMarket {
  return (WINDOW_SUPPORTED_MARKETS as readonly string[]).includes(market);
}

/**
 * 这条腿是否落在窗内 —— 四个边界均闭区间。`O(1)`。
 *
 * 🚨 **它是「该不该去问这条腿此刻的价」, 不是「这条腿是不是候选」** —— 成员判定单点在
 * `leg-recall.rules.ts` (052 FR-003)。窗外的腿照常出现在结果里, 只是带着收盘档的价;
 * 🚫 MUST NOT 拿它当 filter 去删腿, 那就是给召回开了第二个判据点。
 */
export function withinWindow(leg: RecallLegInput, window: LegWindow): boolean {
  if (leg.dteDays < window.dteMin || leg.dteDays > window.dteMax) return false;
  return (
    leg.strike.greaterThanOrEqualTo(window.strikeMin) &&
    leg.strike.lessThanOrEqualTo(window.strikeMax)
  );
}

/**
 * **包络漂移的绊线** (FR-007): 返回「被窗排除、却能通过召回判据」的候选。空数组 = 无漂移。`O(n)`。
 *
 * 🚨 **它是 {@link STRIKE_ENVELOPE_FLOOR_SPOT_RATIO} / {@link STRIKE_ENVELOPE_CEILING_SPOT_RATIO}
 * 唯一的守卫** —— 那两个数是经验余量, 没有「算对了」这回事; 判据一旦调松 (门槛下调 / 成色上界
 * 放宽), 窗就可能比判据窄, 而窄掉的那批腿**照常出现在结果里**, 只是带着收盘档的价。没有这条
 * 绊线, 这种漂移在响应里看不出来。
 *
 * 🚨 **入参是召回的判决 ({@link RecallCandidate}) 而不是「裸腿 + 一套判据」** —— 本函数**不自己
 * 判成员**: 成员判定单点在 `leg-recall.rules.ts` (052 FR-003「全仓只有一个 filter 概念」,
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 不变量 #7 机器强制)。在这里再判一次照样
 * 判得出结果, 只是「谁说了算」变成运行时才知道的事 —— 而绊线一旦与召回口径分叉, 它报的东西就
 * 不再是 FR-007 说的那件事了。
 * 📌 类型上收 `RecallCandidate` 而不是 `T[]` 也是这条纪律的一半: 传裸行进来直接编译红,
 * 「忘了先跑召回」不可能静默发生。
 */
export function windowTripwire<T extends RecallLegInput>(
  candidates: readonly RecallCandidate<T>[],
  window: LegWindow,
): readonly RecallCandidate<T>[] {
  return candidates.filter((candidate) => !withinWindow(candidate.leg, window));
}
