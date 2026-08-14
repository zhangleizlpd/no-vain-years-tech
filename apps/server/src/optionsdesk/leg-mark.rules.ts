import { dateOnlyOf } from './date-only';
import { type LegIntent, type RentDepth } from './intent-matrix.rules';

/**
 * 050 optionsdesk **打标层**判据纯函数 (ADR-0043 §4, plan D-MARK-1)。无 I/O、无 DI。
 *
 * 本文件承接 047 `leg-tab.rules.ts` 的两组 Δ 带常量, **取值一字不改、语义整个翻转**:
 *
 * | | 047 (召回) | 050 (打标) |
 * | --- | --- | --- |
 * | Δ 带的作用 | 决定腿**进不进**候选集 | 决定腿**打不打**推荐标 |
 * | 水位未选 (`rentDepth === null`) | 取三档**并集**(放宽收进来) | **不打标** |
 *
 * 🚨 **这是本片最容易照抄错的一点** (Guardrail 1): 上表两行出自**同一条**原则——「不替人做
 * 方向性假设」。在召回语义下它导出「别替人砍掉候选 ⇒ 取并集」, 在打标语义下它导出「打了就是
 * 替人指了个方向 ⇒ 不打」。**同一条原则, 相反的行为。**
 * ⇒ 047 的 `RENT_DEPTH_UNION_BAND` **整条删除、不迁不留**: 留一个返回并集的辅助函数在这里,
 * 「水位未选」时全表就会冒出一片推荐标, 而那段代码 code review 时看着完全合理。
 *
 * 🚨 **Δ 带是本文件的唯一落点** (SC-009): 判定逻辑读这里的常量, MUST NOT 抄字面量。
 */

/** 闭区间带 (两端均可取到)。 */
export interface AbsDeltaBand {
  readonly min: number;
  readonly max: number;
}

/**
 * 建仓意图的推荐带 (FR-011)。自 047 `BUILD_LEG_ABS_DELTA_BAND` 迁入, 值不变。
 *
 * 📌 它判的是**形态**不是**授权**: 意图矩阵有没有给建仓授权由 `intent-matrix.rules.ts` 单独
 * 回答, 与这条腿长什么样是两件事。
 */
export const BUILD_RECOMMEND_ABS_DELTA_BAND: AbsDeltaBand = { min: 0.4, max: 0.55 };

/**
 * 收租意图按水位档的推荐带三档 (FR-011, 策略 SoT 第四章)。自 047
 * `RENT_DEPTH_ABS_DELTA_BANDS` 迁入, 值不变。键序与 `RENT_DEPTHS` 一致 (由浅到深)。
 *
 * 🚫 **水位未选时 MUST NOT 回落到任何一档, 也 MUST NOT 取并集** —— 见文件头。
 */
export const RENT_RECOMMEND_ABS_DELTA_BANDS: Readonly<Record<RentDepth, AbsDeltaBand>> = {
  near_atm: { min: 0.3, max: 0.4 },
  moderate: { min: 0.15, max: 0.3 },
  deep: { min: 0.05, max: 0.15 },
};

/**
 * 这条腿该不该打**推荐标** (FR-011 / FR-012 / FR-013)。`O(1)`。
 *
 * 判定序 (每一条短路都是语义决定的):
 * 1. `absDelta` 缺失 → `false` (FR-013) —— 缺 Δ 不能推定它落在任何带内。该腿**照常在召回集里**
 *    (`leg-recall.rules.ts` 的入参根本没有 Δ), 只是拿不到这个标。
 * 2. 建仓意图 → 取建仓带。**不看 `rentDepth`**: 意图矩阵在该态恒给 `null`, 但本函数不依赖调用方
 *    守约 —— 纯函数的值域由它自己封死。
 * 3. 非收租的其余两态 (`pending` / `no_new_position`) → `false` (FR-012)。没有方向就没有标。
 * 4. 收租 + **水位未选** → `false`。见下。
 * 5. 收租 + 水位已选 → 取该档带。
 *
 * 🚨 **第 4 条是本片最容易照抄错的一点** (Guardrail 1): 「不替人做方向性假设」这条原则在**召回**
 * 语义下导出「取三档并集放宽收进来」, 在**打标**语义下导出「打了标就是替人指了个方向 ⇒ 不打」。
 * 同一条原则、相反的行为。⇒ 这里直接 `return false`, 🚫 **MUST NOT** 复用任何返回并集的辅助
 * 函数 (047 的 `RENT_DEPTH_UNION_BAND` 已整条删除, 结构上不给它存在的机会)。
 *
 * 🚨 **推荐标随标的级意图判, MUST NOT 随当前 Tab 变** (FR-011): 收租意图下打开建仓 Tab, 里面
 * 带标的腿其 `|Δ|` 落的是**当前收租档带**而不是建仓带 —— 按建仓带打出的标恒 0 条 (SC-005)。
 * 那是**正确信号**不是 bug, 呈现侧配就地说明 (口径是「这些推荐按你当前的收租意图打」, **不是**
 * 「这个 Tab 没有推荐」)。
 * 📌 SC-005 原写「建仓 Tab 推荐标数恒为 0」—— 那个「恒 0」在 047 的旧判据下才结构成立 (旧建仓族
 * 的成员判据本身就是 `|Δ| ∈ [0.40,0.55]`)。050 把 Δ 移出召回后建仓召回集 = 整条短端虚值链,
 * 收租档带正好从中间切过 ⇒ 判据于 2026-08-11 (T009) 改成上面这条, 详见 spec US3-AS2 的修正注。
 */
export function isRecommended(
  intent: LegIntent,
  rentDepth: RentDepth | null,
  absDelta: number | null,
): boolean {
  if (absDelta === null) return false;
  if (intent === 'build_position') {
    return withinAbsDeltaBand(absDelta, BUILD_RECOMMEND_ABS_DELTA_BAND);
  }
  if (intent !== 'rent') return false;
  if (rentDepth === null) return false;
  return withinAbsDeltaBand(absDelta, RENT_RECOMMEND_ABS_DELTA_BANDS[rentDepth]);
}

/** 闭区间含两端。带界一律走常量, 本文件内也不写字面量比较 (同 `leg-recall.rules.ts` 的纪律)。 */
function withinAbsDeltaBand(absDelta: number, band: AbsDeltaBand): boolean {
  return absDelta >= band.min && absDelta <= band.max;
}

// ─────────────────────────────────────────────────────────────────────────────
// 月度链标 (FR-014 / FR-015, plan D-MARK-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * vendor 声明「标准月度」用的到期周期取值 —— 落在
 * `marketdata.option_contract.expiration_cycle` (富途原样落库, 不换算)。
 *
 * 🚨 **判据是白名单 `=== MONTHLY_EXPIRATION_CYCLE`, 🚫 MUST NOT 写成「不等于 WEEK」**:
 * 富途未公开 `ExpirationCycle` 的完整值域 (官方字段表只给了枚举链接, 那一页并未列出取值),
 * 我方实证只见过 `MONTH` / `WEEK`。将来冒出第三个值时, 白名单只会**漏标**、黑名单会**错标**
 * —— 漏标是少一个 chip, 错标是把一条周链说成月链。两者代价不对称。
 */
export const MONTHLY_EXPIRATION_CYCLE = 'MONTH';

/**
 * 月度链标的腿侧入参。**结构定义, 蓄意不 import 检索 port** —— 同 `leg-recall.rules.ts` 的
 * `RecallLegInput` 体例: rules 文件不认识存储层, 由 `LegChainRow` 结构上满足它。
 */
export interface MonthlyChainLegInput {
  readonly expiryDate: Date;
  /** vendor 到期周期, 原样; 缺字段为 `null` (禁默认值冒充, 同 015 端口层契约)。 */
  readonly expirationCycle: string | null;
}

/**
 * 这批腿里哪些**到期日**是月度到期日 (FR-014 / FR-015)。`O(n)`, 零 I/O。
 *
 * 🚨 **判据于 2026-08-15 (#45) 整条换源: 交易日历 → vendor 到期周期。** 原判据是「该月第三个
 * 周五, 该日非交易日则取前一交易日, 取自 `marketdata.trading_day`」, 它在生产**从未生效过**:
 * 交易日历的填充判据是「某代表指数当日**有 bar**」⇒ 结构上不含未来交易日, 而期权到期日按定义
 * 全在未来 ⇒ 回退目标恒取不到 ⇒ 标一个都不出。而单测喂的日历**含候选日本身**, 于是全绿。
 *
 * 🚨 **也 MUST NOT 退回「是不是第三个周五」这个简化**: `2027-06-19` Juneteenth 落周六 ⇒ NYSE
 * 提前到周五 `2027-06-18` 休市 ⇒ 该月月度到期日前挪到**周四 `2027-06-17`** (实据: dev 库 us 链
 * 上该日 298 条合约的 `expiration_cycle` 全为 `MONTH`)。周五判据在那一列会整月漏标, 而漏标
 * 看起来完全正常。这类前挪并不罕见 —— Juneteenth 逢周六即触发 (2027 / 2032 / 2038…),
 * 耶稣受难日撞第三个周五亦然 (2014 / 2030…)。
 *
 * 📌 **这不是 050 clarify 否决的「从链自身到期日分布反推」** —— 那条否的是靠数据**形状**猜
 * 规则 (链不全时会误判且看着正常); 本判据读的是 vendor 对每张合约**逐条声明**的属性。
 *
 * 📌 **结果是到期日级集合而非逐腿布尔**: 「同一到期日的腿必同标」于是是结构保证, 与财报标
 * 同一个形状; 两个消费方 (选约表逐腿 / 报表逐列) 吃同一个集合, 结构上没有第二处判据可写。
 */
export function monthlyChainExpiries(legs: readonly MonthlyChainLegInput[]): Set<string> {
  const monthly = new Set<string>();
  for (const leg of legs) {
    if (leg.expirationCycle === MONTHLY_EXPIRATION_CYCLE) monthly.add(dateOnlyOf(leg.expiryDate));
  }
  return monthly;
}
