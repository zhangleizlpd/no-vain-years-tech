// 053 T007 — 三视角**各自独立取数**的判据纯函数（FR-020/FR-022/FR-025–FR-027,
// plan D-ASYNC-1 / D-CONSIST-1）。接线在 `use-leg-table.ts`；本文件零 React、零运行时依赖，
// 判定全部可单测（本仓测试分层：vitest = 纯逻辑 / Playwright = UI）。
//
// 🚨 **053 起「一次请求取回三视角」整条作废**（FR-019b）—— 每个视角一个 query、一份 key。
//    随之而来的两个新问题都在本文件里落判据：**错峰**（首屏别并发三份）与**一致性**
//    （三份可能跨过业务日切换点，各自报着不同的 `asOf`）。
import type { LegPickerTab } from './leg-picker.rules';

/**
 * 错峰闸（FR-025）—— `current` = 当前生效视角，`primed` = 该视角的 query **已成功落地过**。
 *
 * 🚨 **它比 render 期解析出的视角滞后一拍，这是结构使然不是懒**：`enabled` 必须在调 hook
 *    之前就定下来，而「当前是哪个视角」要等响应里的 `intent` 才解析得出 ⇒ 闸只能拿上一拍的
 *    结论。`use-leg-table.ts` 用 render 期同步回写让它在一拍内收敛（与 `promotePick` 同范式）。
 */
export interface LegPerspectiveGate {
  current: LegPickerTab;
  primed: boolean;
}

/**
 * 某视角的 query 要不要开（FR-025 错峰）。复杂度 O(1)。
 *
 * 🚨 **当前视角无条件开、其余两个等它落地** —— 这就是「进详情页只取当前视角，落地后后台补
 *    其余两个」，不需要手写 prefetch 编排。
 * 🚫 **MUST NOT 首屏并发取三份** —— 三视角并发约 670 kB，弱网下拖慢首屏，且其中两份用户
 *    可能永远不看。
 * 📌 当前视角自己**失败**时其余两个不开：那时「落地」这个前提没成立，此刻把另外两份也打出去
 *    只是把同一个故障放大三倍。用户切过去时它就成了当前视角，照常开（FR-022 失败隔离）。
 */
export function legQueryEnabled(
  perspective: LegPickerTab,
  gate: LegPerspectiveGate,
  hasSymbol: boolean,
): boolean {
  return hasSymbol && (perspective === gate.current || gate.primed);
}

/**
 * 一致性检测的单视角输入。
 * `settled` = 该视角已落地（成功或失败）且不在飞行中；`asOf` 只在**成功**时给
 * （`null` 也是一个值 —— 链未就绪，与「没成功」不是一回事）。
 */
export interface LegPerspectiveAsOf {
  settled: boolean;
  asOf?: string | null;
}

/**
 * 三份响应的业务日一致吗（FR-020）。`null` = **还判不了**（有视角尚未落地）。复杂度 O(n) = O(3)。
 *
 * 🚨 判据复用契约里**已有的** `asOf` —— 🚫 MUST NOT 为此新增版本戳字段（它还配了
 *    `asOfFreshnessTier`，再加一份版本戳就是同一件事的第二个表达）。
 * 📌 **失败的视角不参与比较**（FR-022 失败隔离）：它没有可比的业务日；把「缺席」读成
 *    「不一致」会让一次读故障变成一轮无谓的全量重取。
 * 📌 少于两个可比值 ⇒ 一致（没有两方可以互相矛盾）。
 */
export function legAsOfConsistent(views: readonly LegPerspectiveAsOf[]): boolean | null {
  if (views.some((view) => !view.settled)) return null;
  const values = views.map((view) => view.asOf).filter((asOf) => asOf !== undefined);
  return values.every((asOf) => asOf === values[0]);
}

/** 一致性处置：`refetch` = 重取全部一次；`warn` = 停止重取并显式提示。 */
export type LegConsistencyAction = 'none' | 'refetch' | 'warn';

/**
 * 一致性状态机的一步（FR-020）。复杂度 O(n) = O(3)。
 *
 * 🚨 **`latched` 是布尔闩不是计数器** —— 计数器写错方向就是死循环（plan Impl Guardrail 4）。
 *    语义：一次「不一致」最多换来**一次**重取；重取后仍不一致 ⇒ 转显式提示，不再重取。
 * 📌 **一致恢复即解闩**：闩守的是「本轮不一致」这一个回合，不是整个会话的生命周期 ——
 *    永久闩会让换日 / 改水位之后**真出现的第二次**不一致再也修不了。解闩只发生在「已一致」
 *    那一支，而该支本身不重取 ⇒ 解闩不可能自激。
 */
export function legConsistencyStep(
  views: readonly LegPerspectiveAsOf[],
  latched: boolean,
): { action: LegConsistencyAction; latched: boolean } {
  const consistent = legAsOfConsistent(views);
  if (consistent === null) return { action: 'none', latched };
  if (consistent) return { action: 'none', latched: false };
  return latched ? { action: 'warn', latched: true } : { action: 'refetch', latched: true };
}
