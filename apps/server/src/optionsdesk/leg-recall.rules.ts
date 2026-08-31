import { Prisma } from '../generated/prisma/client';
import type { PriceKind } from '../marketdata/marketdata.types';
import { computeLegRates } from './leg-derive.rules';
import { LEG_TABS, type LegTab } from './leg-tab.rules';
import { tierFloor, type LegTierWithFloor } from './leg-tier.rules';

/**
 * 050 optionsdesk **召回层**判据纯函数 (ADR-0043 §4, plan D-RECALL-1)。无 I/O、无 DI。
 *
 * 它整块换代 047 `leg-tab.rules.ts` 的「硬分腿族」成员判据: 047 把腿按 `|Δ|` 带 + 窄 DTE 带
 * 硬分成建仓 / 收租两族, 本层改成**粗召回 + 三道硬约束**——
 *
 * | 判据                            | 作用面             | FR      |
 * | ------------------------------- | ------------------ | ------- |
 * | DTE 段 (建仓 `[1,49]` / 收租 `[30,365]`) | 意图 Tab  | 001/002 |
 * | 有效成本 `K − bid < spot`       | **只**建仓         | 004     |
 * | 权利金绝对门槛                  | **三个 Tab 一律**  | 005     |
 * | 流动性门槛 (相对价差上界)       | 只建仓 / 收租      | 006     |
 * | 成色上界 (052 起, 见下)         | **只**收租         | 052-005 |
 * | 持仓量条件 (052 起, 见下)       | **三个 Tab 一律**  | 052-008 |
 *
 * 🚨 **`|Δ|` 不在本文件的任何入参里** (FR-009) —— 这是「Δ 已降级为打标量」的**结构保证**而非
 * 事后约定: 拿不到这个量就不可能拿它做召回判据。想把 Δ 塞回召回必须先改签名, 那一步 review
 * 看得见。⇒ greeks 缺失的腿照常进意图召回集 (与 047 相反)。
 *
 * 🚨 **有效成本判据 MUST 只作用建仓** (Guardrail 5): 收租不接货, 不受此限。误加到收租会砍掉
 * 大量本来正确的深虚腿, 而且**不会红** —— 返回的腿数量与数值全都正常, 只是少了一批。
 *
 * 🚨 **阈值单点** (FR-007 / SC-009): 本文件是两道门槛阈值与三段 DTE 界的**唯一**落点,
 * `scripts/checks/check-optionsdesk-rule-constants.ts` 机器强制 (抄到别处 = PR 门直接红)。
 *
 * 量纲: 金额比较一律 `Prisma.Decimal` (沿 `leg-derive.rules.ts` 既有纪律), DTE 是整数日历日。
 * 复杂度 `O(1)`/腿。
 */

/** 闭区间 DTE 段 (两端均可取到)。 */
export interface DteBand {
  readonly min: number;
  readonly max: number;
}

/**
 * 建仓召回段 (FR-001)。下界取 1 而非 0 —— 读端已滤「到期日 **>** 当日」, DTE=0 的腿根本到不了
 * 这里; 写成 1 是让这条前置在常量上可见, 不是多一道判定。
 */
export const BUILD_RECALL_DTE: DteBand = { min: 1, max: 49 };

/**
 * 收租召回段 (FR-002)。
 *
 * 📌 与建仓段在 `[30,49]` 的**重叠是刻意的**, MUST NOT 被「消歧」掉: 同一张合约用两种眼光看
 * 是两笔账 —— 建仓视角问「被指派后我的成本划不划算」, 收租视角问「这段期限的租金年化多少」。
 */
export const RENT_RECALL_DTE: DteBand = { min: 30, max: 365 };

/** 权利金绝对门槛的双参数 (FR-005 / spec Assumptions)。 */
export interface PremiumFloorParams {
  /** 绝对下限 (美元) —— 管掉「一分钱腿」: `weeklyRate = periodRate × 7/DTE`, DTE=1 时是 ×7 放大。 */
  readonly absolute: Prisma.Decimal;
  /** spot 的比例下限 —— 让门槛随标的价位缩放 (百元票与千元票的「太少」不是同一个数)。 */
  readonly spotRatio: Prisma.Decimal;
}

/**
 * T017 实测标定值 (2026-08-11 dev 真实链: 12 只票 / 3503 条适格认沽腿 / spot ∈ [9.27, 178.25];
 * 标定全过程与逐票对账在 `specs/050-optionsdesk-leg-recall-rank/spec.md` §标定实测)。
 *
 * · `absolute = 0.20` —— bid 低区直方图的**谷底**: `[0.15,0.20)` 29 条 → `[0.20,0.25)` 28 条
 *   → `[0.25,0.50)` 111 条, 废腿模式与真腿模式在此交界。抬到 0.25 / 0.30 只多砍建仓段 16 / 33
 *   条, 换不来判别力。
 * · `spotRatio = 0.0018` —— 两项的**交叉点 `spot = absolute / spotRatio = $111.1`** 才是这个
 *   参数的可扩展性指标 (它不随标的池大小变): spot 在交叉点之上由比例项接管、之下由绝对下限
 *   接管。📌 取 0.0012 时交叉点是 $166.7, 实测 12 只票里只有 ACN 一只被比例项接管、且只高出
 *   1.4 分 ⇒ 双参数形态**退化成单一绝对下限**, spec Assumptions 说的「随价位缩放」在真实数据
 *   上根本没发生。
 *
 * 🚨 改这两个值 MUST 避开 `leg-tier.rules.ts` 已有的六个档界 (`0.006` / `0.01` / `0.02` /
 * `0.05` / `0.10` / `0.15`): 守门脚本认的是**值不是名字**, 撞值会把那个文件报成违规。撞上时改
 * 这里的取值, 🚫 MUST NOT 放宽检查器 —— 那会让 SC-009 显示为「已机器强制」而实际没有,
 * 比不装更糟。
 */
export const PREMIUM_FLOOR: PremiumFloorParams = {
  absolute: new Prisma.Decimal('0.20'),
  spotRatio: new Prisma.Decimal('0.0018'),
};

/**
 * 流动性门槛: 相对价差上界 (FR-006)。**含端点视为通过**。
 *
 * T017 实测标定值 0.35 (同上数据面): 意图段合格腿的相对价差直方图 (桶宽 0.05) 主体在此衰减
 * 完毕 —— `[0.25,0.30)` 109 条 → `[0.30,0.35)` 77 条 → `[0.35,0.40)` 50 条, 其后是 25–52 条的
 * 平坦长尾。
 *
 * 📌 曾疑心相对口径对低价腿有 **tick 粒度偏见** (最小报价单位 `$0.05` 落在 mid `$0.30` 的腿上
 * 就是 17% 相对价差), 实测**证伪**: 落在 `[0.35,0.45)` 的 102 条腿里绝对价差 ≤ `$0.05` 的是
 * **0 条** (刀口向外逐段扫到 `+∞`, 七个窗口全为 0 ⇒ 结论对观察窗取法不敏感), 中位绝对价差
 * `$0.925` / 中位 bid `$1.90` —— 真·宽报价而非 tick 假象。⇒ 无需「绝对价差逃生舱」复合判据。
 *
 * 🚨 **本门槛的有效性依赖 {@link PREMIUM_FLOOR} —— 两道门槛是串联不是并列。** `rel` 的分母
 * `mid = bid + s/2` 被权利金门槛托住 (`bid ≥ F`), 故对固定价差 `s` 有上界 `rel ≤ s / (F + s/2)`。
 * 一档 tick (`s = 0.05`, 最坏 `F = 0.20`) 上界 **0.2222 < 0.35** ⇒ 一档宽的腿**在数学上不可能**
 * 被本门槛挡下。通用条件: `F > s · (1 − T/2) / T`, `T` = 本阈值 ⇒ `T = 0.35` 时 `F > 2.357 s`。
 *
 * ⚠️ **重验的触发条件是 `F` 与报价档宽度, 与 spot 无关** —— 高价票 `F` 更大 ⇒ 上界更低 ⇒ 更安全:
 * · `PREMIUM_FLOOR.absolute` 调到 `$0.1179` 以下 ⇒ 一档 tick 立刻能触发本门槛, MUST 重验。
 * · 两档 tick (`s = 0.10`) 需 `F > 0.2357`, 当前 `F = 0.20` **不满足** ⇒ 两档宽的腿可越线 (实测
 *   恰好 2 条, `bid 0.20 / ask 0.30`, `rel` 精确等于理论上界 `0.4000`)。`$0.10` 价差 = bid 的
 *   50%, 挡下是对的。
 * 🚫 **MUST NOT 把「低价标的」写成本条的警戒线** (2026-08-11 订正: 初版正是这么写的) —— 低价票
 * 的风险在**权利金门槛滤除过多** (spot `$2` 的票其平值腿 mid 可能只有 `$0.15`, 被
 * {@link PREMIUM_FLOOR} 整条移出), 那是另一条线, 与本门槛无关。
 */
export const LIQUIDITY_MAX_RELATIVE_SPREAD = new Prisma.Decimal('0.35');

/**
 * 052 成色条件的**兜底比例 X** (052 FR-005): 行权价上界的第二项 `spot × (1+X)`。
 *
 * ✅ **T016 实测标定值** (2026-08-13, dev 库 `2026-08-11` 那一期 / 12 链 / 3515 条适格认沽腿)。
 *
 * 判据面 = 每条链「spot 之上最近一档行权价距 spot 的相对距离」, 12 个读数排序后是**双模**:
 * 密网格 9 条 (`0.10% / 0.31% / 0.43% / 1.21% / 1.23% / 1.24% / 1.28% / 1.79% / 2.09%`) 与稀疏
 * 网格 3 条 (`us:ARE 3.91%` / `us:VICI 5.85%` / `us:KBR 6.50%`)。⇒ 取值 = 两模之间那道间隙
 * `[2.09%, 3.91%]` 的**中点 3.00%**。
 *
 * 🚨 **取中点而不是贴边, 是为了让「哪一项接管」不随 spot 日内波动来回跳**: 距两侧各 `0.91pp`。
 * 原占位值 `0.04` 恰好落在 `us:ARE` 的 `3.91%` **之上 0.09pp** —— 那条链在两个口径之间是刀口
 * 状态, 而它正是兜底比例本该收窄的那类稀疏网格。
 *
 * 📌 **改动的爆炸半径实测为 3 条腿, 且逐条同源**: 收租候选 `223 → 220`, 少掉的三条全是
 * `us:ARE K=50.00`(+3.91%) 的三个到期日; 全腿与建仓**逐条不变** (成色只作用收租, FR-006/FR-007)。
 *
 * 🚨 改值时避开 `leg-tier.rules.ts` 的六个档界与本文件已有的三个阈值 (守门脚本认值不认名,
 * 撞值会把那个文件报成违规) —— 同 {@link PREMIUM_FLOOR} 头上那条纪律。`0.03` 已实测零命中。
 */
export const QUALITY_CEILING_SPOT_RATIO = new Prisma.Decimal('0.03');

/**
 * 052 持仓量条件的下限 (052 FR-008), **三视角一律**。张数, 整数。
 *
 * ✅ **T016 定稿维持 `1`, 并把「为什么标不动」写死在这里** (2026-08-13): 更严的档在快照数据上
 * **不可判**。实测把下限从 `1` 抬到 `10` 会让全腿候选 `1592 → 1298`(**−294**), 抬到 `50` 剩
 * `1065`(−527) —— 但快照答不了「`OI = 3` 的那张合约是死是活」, 那要成交回执而不是持仓快照。
 * ⇒ 判据只剩「有没有观测到任何活动」这一条二分, 它的下限就是 `1`。更严的档 MUST 等实盘反馈
 * (spec Clarifications 原文), 🚫 **MUST NOT 靠分布拍一个中间值** —— 那会静默砍掉近三百条腿。
 *
 * 📌 **它进不了守门脚本的阈值单点扫描** —— 那条判据靠字面量子串扫, 而整数当子串扫会把行号 /
 * 数组下标全扫成违规 (`check-optionsdesk-rule-constants.ts` 自己写明了这条限制)。⇒ 本常量的
 * 单点性靠 review 与本文件的唯一导出守, 没有机器兜底。
 */
export const OPEN_INTEREST_FLOOR = 1;

/**
 * 052 T012 **当日成交下限** —— 活性条件的另一支 (052 FR-008 的免死条款)。张数, 整数。
 *
 * 🚨 **取 `1` 使它与改造前逐字等价**: T010 起该支是硬编码的 `volume > 0`, 而成交量是**整数张数**
 * ⇒ `volume > 0` ⟺ `volume >= 1`。参数化只是把这个数从代码里搬到控件上, **不是新语义**。
 *
 * ✅ **T016 定稿维持 `1`**（与 {@link OPEN_INTEREST_FLOOR} 同一条理由: 快照只答得了「有没有
 * 观测到活动」这一条二分, 抬高下限是在拿分布替代实盘反馈）。
 */
export const VOLUME_FLOOR = 1;

/**
 * 052 召回层**候选上限 K** (052 FR-027, ADR-0064 不变量 ①)。条数, 整数。
 *
 * 🚨 **它是给下游限流的保险丝, 不是用户可见条数** —— 表达层给用户看多少条 (`N`) 是另一个数,
 * 归 `053`。ADR-0064 要求 `K ≫ N`, 两者 MUST 是两个独立参数: 共用一个常量的话, 调"给用户看
 * 几条"就会顺手改掉召回的容量, 而候选集变小这件事**在响应里看不出来**。
 *
 * ✅ **T016 定稿维持 `3000`** (2026-08-13)。🚨 **它不是分布参数, 没有谷底可找** —— 判据是量级
 * 余量: dev `2026-08-11` 那一期最大链全量 **825 行** (`us:ACN`, 未过任何判据), 12 链合计 3515。
 * `3000 ≈ 3.6 ×` 今日最大链, 同时够得着大盘票单标的千级合约数的量级。⚠️ 旧注写的「758」是
 * `08-10` 那期的 `us:LULU`, 已 stale。取值 MUST 显著高于单链全量, 否则今天就在截 (那会让本条
 * 从保险丝退化成常态路径)。
 *
 * 📌 与 {@link OPEN_INTEREST_FLOOR} 同为整数 ⇒ 同样进不了守门脚本的阈值单点扫描。
 */
export const RECALL_CANDIDATE_CAP = 3000;

/**
 * 腿侧入参 —— 🚨 **MUST NOT 加 `absDelta`** (FR-009, 见文件头)。
 *
 * 也没有档位 / 费率: 召回判据一条都用不到费率, 这是 plan D-RECALL-3 否决「费率下沉 SQL」的
 * 第一条理由, 签名把它固化下来。
 */
export interface RecallLegInput {
  /** 请求时 DTE (整数日历日)。 */
  dteDays: number;
  strike: Prisma.Decimal;
  bid: Prisma.Decimal | null;
  ask: Prisma.Decimal | null;
  /** 未平仓量 (张)。052 起是召回判据的入参 —— 持仓量条件的左操作数。 */
  openInterest: number | null;
  /** 当日成交量 (张)。持仓量条件的**免死条款**看它。 */
  volume: number | null;
}

/** 标的级上下文 —— 每票每请求算一次, 全部腿共用。 */
export interface RecallContext {
  /** vendor 随链下发的标的价, **未复权** (沿 047 纪律)。有效成本判据的右操作数。 */
  spot: Prisma.Decimal;
  /**
   * 愿买价 W (067, ADR-0068 P1) —— 收租成色上界锚定轴 `axis = min(spot, w)` 的另一半输入
   * ({@link resolveQualityCeiling})。
   *
   * 🚨 **必填不可选** (067 plan D1): 可选 + 缺省回退 spot = 静默旧轴 —— 测试全绿而 prod 错轴,
   * fail-closed 纪律禁的正是这个形态。派生**单点**在 `anchor-cascade.ts`
   * (`resolveEffectiveAnchorValues`, v_manual 优先语义) + `anchor.rules.ts` (`computeW`,
   * `W_COEFFICIENT` 唯一落点); 本层只消费, 🚫 各构造点 MUST NOT 手写 `vManual ?? v` 或自乘
   * 该系数 (FR-002: W 派生零第二份)。
   */
  w: Prisma.Decimal;
}

/**
 * 链级上下文 = {@link RecallContext} + **从该链自身派生**的量 (052 FR-005)。
 *
 * 🚨 **它 MUST 由层入口 {@link recallCandidates} 一处派生, MUST NOT 由 port 的实现各造一份**
 * —— 那会让真实现与假实现的成色上界可能不同, 而两边都算得出候选集、都不会红。这正是
 * `RecallContext` (外部给的 spot) 与本类型 (链上派生) 分成两个类型的理由。
 */
export interface RecallChainContext extends RecallContext {
  /** 收租成色上界, 闭区间 (含端点视为通过)。见 {@link resolveQualityCeiling}。 */
  readonly qualityCeiling: Prisma.Decimal;
}

/**
 * **意图** Tab —— 受期限段与两道门槛约束的那两个。
 *
 * 📌 `all` 蓄意不在其内: 全腿 Tab 不设期限段 (FR-003)、不受流动性门槛约束 (FR-006) ⇒ 把它从
 * 类型里排除掉, 下游按视角统计时就不必写一条恒不成立的 `all` 分支 (那种分支既盖不到测试、
 * 又会让读的人以为「全腿也可能被挡下」)。
 */
export type LegIntentTab = Exclude<LegTab, 'all'>;

/**
 * 相对价差 `(ask − bid) / mid`, `mid = (bid + ask) / 2` (spec Assumptions: 业内通行口径)。`O(1)`。
 *
 * 任一侧缺失 → `null`; `mid ≤ 0` → `null` (禁除零 —— 双边报价都是 0 的死合约算不出价差)。
 */
export function relativeSpread(
  bid: Prisma.Decimal | null,
  ask: Prisma.Decimal | null,
): Prisma.Decimal | null {
  if (bid === null || ask === null) return null;
  const mid = bid.plus(ask).div(2);
  if (mid.lessThanOrEqualTo(0)) return null;
  return ask.minus(bid).div(mid);
}

/**
 * 069 报价护栏 (FR-001): 交叉/锁定报价 `ask ≤ bid` 判定。`O(1)`。
 *
 * 🚨 它 MUST 前置于点差闸 ({@link passesRelativeSpreadMax}): 交叉报价的 {@link relativeSpread}
 * 为负, 恒 ≤ 任何上界 ⇒ 点差闸对最坏的报价反而放行 (069 实测缺口, 本护栏在源头闭合)。它是
 * **意图无关的数据质量闸, 全部视角一律** (069 收租 scope 的唯一例外, clarify Q4) —— 施加点在
 * {@link recallCandidates} 入口。判中之后的**处置**自 070 起按口径分派
 * ({@link crossedQuoteDisposalOf}): 实时口径连全腿 Tab 也不留 (交叉报价是坏数据不是差流动性,
 * 以任何视角呈现都是把垃圾报价当行情); 收盘口径剔降为标 (FR-006 成员不变, 呈现保留 + 净链
 * 除名 + 审计 #1 留痕)。
 *
 * 任一侧缺失 ⇒ 不判交叉 (「不知道」走既有 fail-closed 路径: 权利金 / 点差闸各自挡), 🚫 MUST
 * NOT 拿 null 顶 0 参与比较 (同 {@link passesPremiumMin} 对 `bid` 的纪律)。
 */
export function isCrossedQuote(bid: Prisma.Decimal | null, ask: Prisma.Decimal | null): boolean {
  if (bid === null || ask === null) return false;
  return ask.lessThanOrEqualTo(bid);
}

/**
 * 交叉报价的两种**处置** (070 FR-006): `remove` = 整条移出候选 (069 原语义) / `retain` = 剔降为
 * 标 —— 腿保留在候选照常派生成行, 同时进护栏留痕列表供审计 #1 与净链除名。判据仍是
 * {@link isCrossedQuote} 单点, 两种处置只改「判中之后腿去哪」, 不改判定本身。
 */
export type CrossedQuoteDisposal = 'remove' | 'retain';

/**
 * 口径 → 处置的**唯一**映射 (070 FR-006 / plan §D1): 实时口径维持剔出 —— 盘中窄召回把垃圾报价
 * 当行情呈现是坏数据不是差流动性 (069 原理由); 收盘口径剔降为标 —— 离线宽视野的价值主张是成员
 * 不变, 报价异常档保持可见、净链除名、审计留痕。
 *
 * 🚨 调用方 MUST 拿**链级实际口径** (`chain.priceKind`) 来查, 🚫 MUST NOT 由 `realtime` 入参
 * 反推 (实时请求整体回落收盘档时两者相反, 而反推出来的处置照样跑得通)。
 * 📌 {@link recallCandidates} 的处置参数蓄意**必填无默认**: 忘传 = 静默沿用剔除语义, 离线成员
 * 被悄悄吞掉而不会红 —— 正是本参数要收口的那类潜伏面 (同 `candidateCap` 必填的理由)。
 */
export function crossedQuoteDisposalOf(priceKind: PriceKind): CrossedQuoteDisposal {
  return priceKind === 'realtime' ? 'remove' : 'retain';
}

/**
 * 权利金下限的**系统默认值** (FR-005): `max(绝对下限, spot × 比例)`。`O(1)`。
 *
 * 🚨 **它依赖 spot ⇒ MUST 由服务端解出并下发** (052 FR-011): 客户端自算即「同一判据两处各算
 * 一份」(ADR-0064 不变量 ③), 而 spot 每天变 ⇒ 漂移只在换日那一刻才看得见。
 */
export function resolvePremiumFloor(spot: Prisma.Decimal): Prisma.Decimal {
  const ratioFloor = spot.times(PREMIUM_FLOOR.spotRatio);
  return ratioFloor.greaterThan(PREMIUM_FLOOR.absolute) ? ratioFloor : PREMIUM_FLOOR.absolute;
}

/**
 * 权利金条件 (FR-005): `bid ≥ 下限`。`O(1)`。052 起下限由调用方给 (检索条件, 可被用户覆盖),
 * 系统默认值见 {@link resolvePremiumFloor}。
 *
 * 🚫 **无 `bid` 判 `false`, MUST NOT 通过「把无 bid 当 0」实现** —— 那会污染费率与有效成本的
 * 所有下游计算, 而且算得出数、不会红。「不知道」与「知道且很低」在**处置上同归**(都挡下并
 * 计数), 但 MUST 是两条路径。
 */
export function passesPremiumMin(bid: Prisma.Decimal | null, floor: Prisma.Decimal): boolean {
  if (bid === null) return false;
  return bid.greaterThanOrEqualTo(floor);
}

/**
 * 相对价差条件 (FR-006), 默认只作用建仓 / 收租 (全腿的默认值是「不设」)。`O(1)`。
 * 052 起上界由调用方给, 系统默认值见 {@link defaultCriteria}。
 *
 * 🚨 **算不出价差 ⇒ fail-closed** (spec Assumptions): 没有卖价就无法确认这条腿挂得出去,
 * 宁可少收不可错收。该腿在**全腿 Tab 仍可见**, 信息不丢。
 */
export function passesRelativeSpreadMax(
  bid: Prisma.Decimal | null,
  ask: Prisma.Decimal | null,
  max: Prisma.Decimal,
): boolean {
  const spread = relativeSpread(bid, ask);
  return spread !== null && spread.lessThanOrEqualTo(max);
}

/**
 * 071 宽价差机会闸的档界档位 (FR-002): **收租年化 good 档**。
 *
 * 🚨 **它是 `leg-tier.rules.ts` 档表的引用, 不是一个新阈值** —— 全仓零新增数值字面量, 策略 SoT
 * 改档界本闸自动跟随。🚫 MUST NOT 写成 `new Prisma.Decimal('0.15')`: 那会当场撞
 * `check-optionsdesk-rule-constants` 的档界子串扫描 (守门脚本认值不认名)。
 *
 * 🚨 **🚫 MUST NOT 改用行军 φ 的可配置旋钮** (`optionsdeskConfig.marchPhiTier`): 召回**成员集**
 * 若随 server 配置变,「今天候选为什么少了三十条」的答案就变成「有人改了环境变量」, 而候选表
 * 照样渲染得出来。φ 是再投资率旋钮 (「多担这段时间挣不挣得够」), 本闸是质量下限 (「砸 bid 也
 * 达档吗」) —— 两个问题恰好同源于一张档表, 不是同一个旋钮。
 */
export const WIDE_SPREAD_OPPORTUNITY_TIER: LegTierWithFloor = 'good';

/** 机会支的 bid 年化下限 —— {@link WIDE_SPREAD_OPPORTUNITY_TIER} 在年化口径上的档界。 */
export const WIDE_SPREAD_OPPORTUNITY_FLOOR = tierFloor('annualized', WIDE_SPREAD_OPPORTUNITY_TIER);

/**
 * 071 **宽价差机会支** (FR-002 / FR-004): 按 `bid` 卖出即达收租 good 档 ⇒ 这条腿值得看,
 * 哪怕市场很宽。`O(1)`。
 *
 * 它是相对价差维度的**第二条通过路径**, 与主支 ({@link passesRelativeSpreadMax}) 在
 * {@link failsCriterion} 处 OR 合成 —— 形态同 {@link passesLivenessMin} 的「OI 或当日成交」:
 * 一个维度、两条支撑。🚫 **MUST NOT 做成第七个检索维度**: `RETRIEVAL_CRITERION_KEYS` 是
 * 「有控件、可覆盖」的穷举清单, 加键就是加抽屉控件 + 三态 + 边际计数, 而本闸没有控件也不该有
 * (系统对「什么算机会」的固定判断)。
 *
 * 🚨 **本谓词只答「机会成不成立」, 不答「点差过不过」** —— 两支各自纯粹, 合成在维度判定处一处
 * 完成。这样成员判据 (主支 ∨ 机会支) 与标的判据 (主支不过 ∧ 机会支成立) 读的是同两个布尔,
 * 不会各算一份。
 *
 * 🚫 **无 `bid` 判 `false`, MUST NOT 拿 0 顶** (同 {@link passesPremiumMin} 的纪律): 「不知道」
 * 与「知道且很低」处置同归、路径必须不同。费率恒经 `leg-derive.rules.ts` 的 `computeLegRates`
 * 单点 (ADR-0064 不变量 ③), 🚫 本文件 MUST NOT 手写 `P/(K−P)`。
 *
 * 📌 **标定 (2026-08-31, 109 只 us 锚 / `2026-08-28` 收盘全量)**: 捡漏池 (仅因主支出局的收租腿)
 * 1121 条, bid 年化 p50 仅 2.9% ⇒ 池子本身以噪声为主; 过 good 档的 78 条才是机会面
 * (`us:PCG K=16.5 DTE 35` 年化 39.4% / OI 301)。08-29 对焦另拟的 `abs_spread` 下限**已否决**:
 * 年化闸一上它在 `$0.30` 之前零筛除 ⇒ 两个旋钮坍缩成一个, 留着就是一个标不出谷底的旋钮。
 */
export function isWideSpreadOpportunity(leg: RecallLegInput): boolean {
  // 🚨 **算不出相对价差 ⇒ 机会支不成立** (FR-004): 缺 `ask` 时「市场有多宽」根本无从谈起,
  // 而本支的整句话是「市场**很宽**但 bid 仍够厚」—— 少了前半句它就变成一条无条件的权利金
  // 逃生舱, 会把所有单边报价的厚腿放进意图 Tab。主支对该形态的 fail-closed 纪律
  // ({@link passesRelativeSpreadMax}) MUST 原样成立: 没有卖价就无法确认这条腿挂得出去。
  if (relativeSpread(leg.bid, leg.ask) === null) return false;
  if (leg.bid === null) return false;
  const rates = computeLegRates({ strike: leg.strike, premium: leg.bid, dteDays: leg.dteDays });
  if (rates === null) return false;
  return rates.annualizedRate.greaterThanOrEqualTo(WIDE_SPREAD_OPPORTUNITY_FLOOR);
}

/**
 * 有效成本硬判据 (FR-004): 被指派后的持仓成本 `K − bid` **严格低于**当前 spot。`O(1)`。
 *
 * 严格小于而非 `≤`: 成本持平时「用 put 代替直接买」没有任何优势, 只多出被指派的不确定性。
 *
 * 🚨 **只在建仓语义下成立** —— 调用点只有 {@link recallTabs} 的 build 分支一处。
 */
export function passesEffectiveCostGate(
  spot: Prisma.Decimal,
  strike: Prisma.Decimal,
  bid: Prisma.Decimal | null,
): boolean {
  // 无 bid ⇒ 有效成本无定义。🚫 MUST NOT 拿 `K − 0` 冒充 (那是「白拿股票」的意思)。
  if (bid === null) return false;
  return strike.minus(bid).lessThan(spot);
}

/**
 * 活性条件的下限 —— **一个维度、两个值** (052 T012)。
 *
 * 🚨 **两支是「或」不是「与」** ({@link passesLivenessMin}): 它问的是「这张合约上有没有人活动」,
 * 存量 (`OI`) 与流量 (当日成交) **任一**成立即算活着。
 * 📌 **蓄意做成一个维度而不是两个**: 拆成两个维度后, 一条腿被挡下 ⟺ 两支都不过 ⇒ 把任一支换回
 * 默认值都能救它 ⇒ 同一条腿会**同时**计进两个维度的边际计数, 两行「当前条件之外还有 N 条」说的是
 * 同一批腿, 加起来双计。与 DTE 段同构 (一个维度、值是一对数、成对覆盖)。
 */
export interface LivenessFloor {
  /** 未平仓合约数下限 (张)。 */
  readonly oi: number;
  /** 当日成交下限 (张)。 */
  readonly volume: number;
}

/**
 * 活性条件 (052 FR-008), **三视角一律**: `OI ≥ 下限` **或** `当日成交 ≥ 下限`。`O(1)`。
 * 052 T010 起下限由调用方给 (检索条件, 可被用户覆盖), 系统默认值见 {@link defaultCriteria}。
 *
 * 🚨 **成交那一支是新挂档的免死条款, MUST NOT 省略**: 美股期权 OI 盘前才更新, 今天新挂出来的档
 * 当日 `OI` 必为 0。实测全池 `OI=0` 的 1014 条腿里有 **34 条当日正在交易** —— 写成纯 `OI ≥ 下限`
 * 会把它们砍掉, 而候选集照样出得来、数字照样有 (052 Guardrail 1)。
 * 📌 T012 起该支从硬编码的 `volume > 0` 参数化成 `volume >= floor.volume`, 默认 `1` ⇒ **逐字等价**
 * (成交量是整数张数)。参数化改的是「这个数在哪儿」, 不是判据。
 *
 * 🚫 **`null` 是「没采到」不是「零」, 两者 MUST 走不同路径** (同 {@link passesPremiumMin} 对
 * `bid` 的纪律): 缺成交量时该支不成立 (不知道 ≠ 知道有), 缺 OI 时不能拿 0 顶上再比大小 —— 处置
 * 上同归 (都挡下), 但把 `null` 折成 0 会让「未采集」在下游看起来像「已确认为零」。
 */
export function passesLivenessMin(
  openInterest: number | null,
  volume: number | null,
  floor: LivenessFloor,
): boolean {
  if (volume !== null && volume >= floor.volume) return true;
  if (openInterest === null) return false;
  return openInterest >= floor.oi;
}

/**
 * 成色锚定轴 `axis = min(spot, W)` 的**全仓唯一落点** (067 SC-003 机器判据承接, 068 T001 抽出):
 * {@link resolveQualityCeiling} 与实时 K-梯形窗的收租帽 (068 FR-003) 共同消费。
 * 🚫 各消费点 MUST NOT 自写 `Decimal.min(spot, w)` —— `rg "Decimal\.min"` 仍恰好本处一命中。
 */
export function resolveCeilingAxis(spot: Prisma.Decimal, w: Prisma.Decimal): Prisma.Decimal {
  return Prisma.Decimal.min(spot, w);
}

/**
 * 收租**成色上界** (052 FR-005, 067 起换轴): 「axis 之上最近一档行权价」与 `axis × (1+X)`
 * **取严**, 其中 **`axis = min(spot, W)`** (067 FR-001, ADR-0068 P1)。`O(n)`。
 *
 * 换轴的经济语义: 成色回答的是「离**计划买价**多远」而非「离现价多远」—— 接货意愿由愿买价 W
 * (`W_COEFFICIENT` × 有效 V) 定义, spot 显著高于 W 时按 spot 锚定会把「按高于愿买价接货」的
 * 腿放进默认候选。spot ≤ W 时 axis 退化为 spot, 与换轴前逐值相同 (state_branch 1/2)。
 *
 * 🚨 **axis 的 `min` 全仓恰好出现在 {@link resolveCeilingAxis} 一处** (067 SC-003 机器判据,
 * 068 T001 抽出供实时窗收租帽共用): 调用前算好传入会让 `min` 散在各构造点, 单点性靠纪律不靠
 * 结构 (plan D1 备选否决 ①)。形状与取严逻辑不变, 仅换轴 (FR-001 末句)。
 *
 * 两项都要, 缺一不可:
 * · 结构项 `min{K ≥ axis}` 是成色的定义 —— 收租卖的是租金, 不是折价接货, 至多轻微实值一档。
 * · 比例项是**稀疏网格的兜底** —— 实测 `us:KBR` spot `37.56` 的最近一档是 `40` (`+6.50%`),
 *   网格再疏 (如 `37.5 → 45`) 结构项就形同虚设, 单靠它挡不住。
 *
 * 🚨 **网格取自「链上全部腿」而非过完门槛的那批** (调用点在 {@link recallCandidates} 的权利金
 * 门槛**之前**): 若那一档恰好 bid 太低被门槛滤掉, 在过滤后的集合上求就会跳到**下一档**, 上界
 * 反而变松 —— 更实值的腿因此进了候选。行权价网格是合约的属性, 与当日报价无关。
 *
 * 🚨 **口径是整条链, 不是同到期日** (2026-08-12 定, 实测差 16 条腿): 远月网格更疏, 按到期日各
 * 算会让远月上界松到 `+3.5% ~ +6.6%` (`us:PSKY` 15 个到期日里 9 个如此)。取链级还因为 T016 的
 * X 标定分布就是按链取的 —— 两处口径 MUST 同一, 否则标出来的数配不上实装的判据。
 *
 * 链上无 `K ≥ axis` 的档 (axis 高于全部行权价) ⇒ 结构项无定义 ⇒ **退化为仅比例项** (spec Edge
 * Case, 067 轴替换后语义保留)。🚫 MUST NOT 在此返 `null` 让调用方"没上界就全放行": 那会让最该
 * 被挡的深度实值全进来。
 */
export function resolveQualityCeiling(
  spot: Prisma.Decimal,
  w: Prisma.Decimal,
  legs: readonly RecallLegInput[],
): Prisma.Decimal {
  const axis = resolveCeilingAxis(spot, w);
  const ratioCeiling = axis.times(QUALITY_CEILING_SPOT_RATIO.plus(1));
  let structural: Prisma.Decimal | null = null;
  for (const leg of legs) {
    if (leg.strike.lessThan(axis)) continue;
    if (structural === null || leg.strike.lessThan(structural)) structural = leg.strike;
  }
  if (structural === null) return ratioCeiling;
  return structural.lessThan(ratioCeiling) ? structural : ratioCeiling;
}

/**
 * 成色条件 (052 FR-005), **只作用收租**。闭区间: 恰等于上界的腿在候选内。`O(1)`。
 *
 * 🚫 **MUST NOT 用有效成本 `K − bid < spot` 代替** (052 Guardrail 2): 后者更松 —— `K` 高于 spot
 * 两档但权利金厚时照样过, 而这里要的是成色。两者不等价, 合并会静默放回一批深度实值腿。
 */
export function passesQualityCeiling(
  strike: Prisma.Decimal,
  qualityCeiling: Prisma.Decimal,
): boolean {
  return strike.lessThanOrEqualTo(qualityCeiling);
}

// ─────────────────────────────────────────────────────────────────────────────
// 052 T010 检索条件 (FR-002 / FR-011, plan D-CRIT-1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 六个**检索条件**维度 (FR-002: 有控件、系统给默认值、用户可覆盖)。**穷举且有序**, 三态与
 * 计数都按它展开 ⇒ 加一个维度而不实现它的判据 = 编译红 (同 050 特征注册表那条机制)。
 *
 * 🚨 **与「硬门槛」的分界** (FR-002: 无控件、不可调、表达不成范围区间): 本片只有一条硬门槛 ——
 * 建仓的有效成本 `K − bid < spot` ({@link passesEffectiveCostGate})。它 MUST NOT 混进本清单:
 * 一旦有了控件, 「被指派后成本高于现价」这种结构性错误就成了可谈判的, 而它不是。
 *
 * 📌 **DTE 段是一个维度不是两个**: 值是闭区间, 三态与计数按整段判 —— 一端收一端放时
 * 「是否产生排除」照样给得出唯一答案, 而两端各判会得出互相矛盾的两个态。
 */
export const RETRIEVAL_CRITERION_KEYS = [
  'strikeMax',
  'strikeMin',
  'dteBand',
  'premiumMin',
  'livenessMin',
  'relativeSpreadMax',
] as const;

export type RetrievalCriterionKey = (typeof RETRIEVAL_CRITERION_KEYS)[number];

/** 一个视角的一套检索条件。每维度 `null` = **不限** (该维度不产生任何排除)。 */
export interface RetrievalCriteria {
  /** 行权价上界, 闭区间。收租的系统默认值 = 成色上界 ({@link resolveQualityCeiling})。 */
  readonly strikeMax: Prisma.Decimal | null;
  /** 行权价下界, 闭区间。三视角系统默认值均为不限 —— 它只为用户可覆盖而存在。 */
  readonly strikeMin: Prisma.Decimal | null;
  /** DTE 段, 闭区间。三视角系统默认值不同 (全腿不限)。 */
  readonly dteBand: DteBand | null;
  /** 权利金下限。系统默认值依赖 spot ({@link resolvePremiumFloor}), 三视角相同。 */
  readonly premiumMin: Prisma.Decimal | null;
  /**
   * 活性下限 —— **一个维度、两个值** (`OI ≥ x` **或** `当日成交 ≥ y`)。三视角相同。
   * 🚨 覆盖时两个值 MUST 成对给 (同 {@link RetrievalCriteria.dteBand}): 半对不是合法维度值。
   */
  readonly livenessMin: LivenessFloor | null;
  /** 相对价差上界。**全腿的系统默认值是不限** (FR-010)。 */
  readonly relativeSpreadMax: Prisma.Decimal | null;
}

/**
 * 用户覆盖 —— **只作用一个视角** (2026-08-13 定)。
 *
 * 🚨 一次请求返三个视角 (047 FR-005) 而 `FR-015` 要求每个视角各自持有条件状态 ⇒ 覆盖若通吃
 * 三视角, 用户在收租设的行权价上界会同时收窄建仓, 而建仓的控件仍显示自己的默认值 —— 控件与
 * 数据不匹配, 且这个不匹配在界面上无法解释。未指定的视角一律走各自的系统默认值。
 *
 * 📌 **缺键 = 未覆盖, 显式 `null` = 覆盖为「不限」** (判据取 `in`, 不取 `!== undefined`):
 * 「用户把上界拉到不限」与「用户没动过这个维度」在三态上是两回事 —— 前者是覆盖且放宽。
 */
export interface RetrievalOverride {
  readonly perspective: LegTab;
  readonly criteria: Partial<RetrievalCriteria>;
}

/**
 * 一个维度的三态 (plan D-CRIT-1)。
 *
 * 📌 **判据是「是否产生排除」而非值比较** —— 后者对 DTE 段这种双端维度给不出唯一答案 (一端收
 * 一端放), 且计数本来就要逐腿判一遍, 两者同源派生才不会出现「显示了计数但态是放宽」。
 * ⇒ `widened` 含「覆盖了、方向是收窄、但一条腿都没排除掉」(如上界收到仍高于链上最大行权价):
 * 处置与放宽相同 (不显示计数), 为一个不影响行为的区分多养一个状态只会多一处 drift。
 */
export const CRITERION_STATES = ['default', 'widened', 'narrowed'] as const;

export type CriterionState = (typeof CRITERION_STATES)[number];

export interface CriterionOutcome {
  readonly state: CriterionState;
  /**
   * 「当前条件之外还有 N 条」(FR-030) —— **边际口径**: 把该维度换回系统默认值、其余维度保持
   * 用户值时多出来的候选数。恒有值, 非 `narrowed` 时为 `0`。
   *
   * 🚨 **MUST NOT 读成「被系统滤掉 N 条」** (FR-030 的措辞纪律): 它数的是用户自己这一刀切掉的,
   * 系统默认值下的排除**不出计数** (FR-029 —— 默认值本身就摆在控件里, 第二次告知是噪音)。
   */
  readonly excludedCount: number;
}

/** 一个视角的条件全景 —— 控件填 `defaults`, 结果按 `effective`, 计数看 `outcomes` (FR-011)。 */
export interface PerspectiveCriteria {
  readonly defaults: RetrievalCriteria;
  readonly effective: RetrievalCriteria;
  readonly outcomes: Readonly<Record<RetrievalCriterionKey, CriterionOutcome>>;
}

/**
 * 某视角的**系统默认值** (FR-011, T010 六维度表)。`O(1)`。
 *
 * 🚨 **三视角的差只在三个维度上** (其余三维三视角一律):
 * · 行权价上界 —— 只收租设 (成色条件, FR-005/FR-006: 全腿是参照视角, 建仓由有效成本硬门槛等价挡住)
 * · DTE 段 —— 两个意图视角各自的召回段, 全腿不设 (FR-003)
 * · 相对价差上界 —— 只两个意图视角设 (FR-010)
 *
 * 🚫 **MUST NOT 在客户端重算任何一项** (FR-011 / Guardrail 6): 上界与权利金下限都依赖 spot,
 * 客户端自算就是同一判据两处各一份, 而它们**两边都算得出数**。
 */
export function defaultCriteria(tab: LegTab, chain: RecallChainContext): RetrievalCriteria {
  const shared = {
    strikeMin: null,
    premiumMin: resolvePremiumFloor(chain.spot),
    livenessMin: { oi: OPEN_INTEREST_FLOOR, volume: VOLUME_FLOOR },
  };
  switch (tab) {
    case 'all':
      return { ...shared, strikeMax: null, dteBand: null, relativeSpreadMax: null };
    case 'build':
      return {
        ...shared,
        strikeMax: null,
        dteBand: BUILD_RECALL_DTE,
        relativeSpreadMax: LIQUIDITY_MAX_RELATIVE_SPREAD,
      };
    case 'rent':
      return {
        ...shared,
        strikeMax: chain.qualityCeiling,
        dteBand: RENT_RECALL_DTE,
        relativeSpreadMax: LIQUIDITY_MAX_RELATIVE_SPREAD,
      };
  }
}

/** 三视角各自的系统默认值。`O(1)`。 */
export function defaultCriteriaByTab(
  chain: RecallChainContext,
): Readonly<Record<LegTab, RetrievalCriteria>> {
  return {
    all: defaultCriteria('all', chain),
    build: defaultCriteria('build', chain),
    rent: defaultCriteria('rent', chain),
  };
}

/**
 * 单个维度的判据 —— **全仓唯一的成员判定处** (FR-003「只有一个 filter 概念」)。`O(1)`。
 *
 * 🚨 `switch` 按 {@link RetrievalCriterionKey} 穷举 ⇒ 往清单里加键而不在这里实现 = 编译红。
 * 🚫 MUST NOT 在别处再写一条「呈现层再筛一次」的路径: 那样两处都筛得出结果, 而成员集合谁说了
 * 算变成运行时才知道的事。
 */
function failsCriterion(
  tab: LegTab,
  key: RetrievalCriterionKey,
  criteria: RetrievalCriteria,
  leg: RecallLegInput,
): boolean {
  switch (key) {
    case 'strikeMax':
      return criteria.strikeMax !== null && !passesQualityCeiling(leg.strike, criteria.strikeMax);
    case 'strikeMin':
      return criteria.strikeMin !== null && leg.strike.lessThan(criteria.strikeMin);
    case 'dteBand':
      return criteria.dteBand !== null && !withinDteBand(leg.dteDays, criteria.dteBand);
    case 'premiumMin':
      return criteria.premiumMin !== null && !passesPremiumMin(leg.bid, criteria.premiumMin);
    case 'livenessMin':
      return (
        criteria.livenessMin !== null &&
        !passesLivenessMin(leg.openInterest, leg.volume, criteria.livenessMin)
      );
    case 'relativeSpreadMax':
      // 071 FR-001: 一个维度、两条支撑 —— 主支 (点差上界) 不过时机会支接管 (收租限定,
      // {@link isWideSpreadOpportunity})。🚨 `tab` 必须入参: 靠调用方守约「只在收租传」等于
      // 把「哪个视角能捡漏」变成运行时才知道的事, 而建仓表照样渲染得出来 (FR-003)。
      return (
        criteria.relativeSpreadMax !== null &&
        !passesRelativeSpreadMax(leg.bid, leg.ask, criteria.relativeSpreadMax) &&
        !wideSpreadOpportunityApplies(tab, criteria.relativeSpreadMax, leg)
      );
  }
}

/**
 * 机会支在这一套条件下**作不作用** (FR-003 / 071 clarify)。`O(1)`。
 *
 * 两个前提缺一不可:
 * 1. **收租视角** —— 建仓的档界口径是周化, 且建仓不跑行军, 本片蓄意排除 (spec 建仓面排除判据)。
 * 2. **用户没有把这一维收得比系统默认值更严** —— 拖动价差上界往紧里调是一句明确的话:
 *    「我只要窄市场」。机会支若照样放行, 这个控件就对一类腿失效了, 而**表照样渲染得出来**
 *    (071 IT ⑤ 臂实撞: 收到 0.05 时 `rel = 0.065` 的窄腿仍被机会支捞回来)。
 *
 * 🚨 **判据取「不比默认值严」而不是「有没有被覆盖」**: 后者会让「显式填一个与默认值相同的数」
 * 与「压根没动过」给出不同的成员集 —— 同一个上界两种结果, 而两种都解释得通。
 * 📌 放宽 / 不限时本支恒作用但**恒无效果** (主支已经放行) —— 保留它是为了让上面那条判据是
 * 单调的一句话, 不是三个分支。
 */
function wideSpreadOpportunityApplies(
  tab: LegTab,
  relativeSpreadMax: Prisma.Decimal,
  leg: RecallLegInput,
): boolean {
  if (tab !== 'rent') return false;
  if (relativeSpreadMax.lessThan(LIQUIDITY_MAX_RELATIVE_SPREAD)) return false;
  return isWideSpreadOpportunity(leg);
}

/**
 * 这条腿在这套条件下**不过哪几个**维度 —— 空数组 = 全过。`O(6)` = `O(1)`。
 *
 * 🚨 **返回集合而不是布尔**: 计数要的是「仅因这一个维度出局」(边际口径), 一个布尔答不了
 * 「是不是只差这一条」。候选集归属与六个维度的计数由它**一次求值**同源派生。
 *
 * 🚨 **071 起吃 `tab`**: 点差维度的机会支只作用收租 (FR-003), 而维度判据 MUST 自己封死值域 ——
 * 同 `leg-mark.rules.ts` 的 `isRecommended` 那条「纯函数不依赖调用方守约」纪律。
 */
export function failedCriteria(
  tab: LegTab,
  criteria: RetrievalCriteria,
  leg: RecallLegInput,
): RetrievalCriterionKey[] {
  return RETRIEVAL_CRITERION_KEYS.filter((key) => failsCriterion(tab, key, criteria, leg));
}

/**
 * 069: 护栏剔除腿中「若非交叉本会通过该套条件」的那批 —— 每 K 审计条目 #1 的作用域判定
 * (FR-001 / FR-014: 审计只为「本会是成员」的剔除腿留痕, 带外垃圾不冒充收租档)。`O(n)`。
 *
 * 🚨 **住本文件是成员判据单点纪律的要求** (052 FR-003, 守卫 #7 机器强制): 判定用的就是
 * {@link failedCriteria} 本尊 —— 在召回层之外调它 = 第二个成员判定点; 交叉报价的负点差在
 * 点差闸恒放行 ⇒ 不会被点差维误排, 六维整套跑是安全的 (071 的机会支同理够不到: 主支恒过 ⇒
 * 第二支结构上不参与判定)。`tab` 随 071 入参, 调用点传 `'rent'` —— 审计作用域本就是收租成员。
 */
export function crossedRemovalsWithinCriteria<T extends RecallLegInput>(
  tab: LegTab,
  criteria: RetrievalCriteria,
  removed: readonly T[],
): readonly T[] {
  return removed.filter((leg) => failedCriteria(tab, criteria, leg).length === 0);
}

/**
 * 该视角的**硬门槛** (FR-002: 无控件、不可调)。`O(1)`。
 *
 * 本片只有一条: 建仓的有效成本。全腿与收租无硬门槛 —— 收租的成色是**检索条件**不是硬门槛
 * (它表达得成范围区间, 且系统默认值正是那个区间的上界)。
 */
export function passesHardGates(tab: LegTab, chain: RecallContext, leg: RecallLegInput): boolean {
  return tab !== 'build' || passesEffectiveCostGate(chain.spot, leg.strike, leg.bid);
}

/** 候选腿 = 裸行 + **已判定的视角归属** (052 plan D-PORT-1 的出参形态)。 */
export interface RecallCandidate<T extends RecallLegInput> {
  readonly leg: T;
  /** 非空, 且恒为请求视角的子集。 */
  readonly tabs: readonly LegTab[];
  /**
   * 071 **宽价差机会标** (FR-005 / FR-006): 这条腿是从点差维度的**机会支**进来的 ——
   * 市场很宽 (`rel > 系统默认上界`) 但按 `bid` 卖出仍达收租 good 档。
   *
   * 🚨 **判据取「系统默认值下的主支」不过, 而不是「本次实际被挡下」** (FR-006): 用户把点差
   * 上界覆盖成「不限」时主支恒过 ⇒ 按实际口径写这个标会当场消失, 而那还是同一条腿 —— 标会
   * 随控件闪烁, 且闪烁看着完全合理。成员判定照旧按 `effective` 走, 两者读同一个
   * {@link passesRelativeSpreadMax}, 不新增第三个谓词。
   * 📌 建仓 / 全腿视角恒 `false` (机会支收租限定, FR-003)。
   */
  readonly wideSpreadOpportunity: boolean;
}

/** 召回层的产出: 候选集 + 两道门槛各自挡下多少条 (FR-008 / 051 FR-006a 两个计数的数据源)。 */
export interface RecallOutcome<T extends RecallLegInput> {
  readonly candidates: readonly RecallCandidate<T>[];
  /**
   * 069 报价护栏 (FR-001) 判中的腿 —— **原样留痕**, 供上游拼每 K 审计条目 #1 (报价异常,
   * 证据 = 腿上的 bid/ask)。恒有值, 无判中时为空数组。
   *
   * 🚨 与流动性门槛「腿仍在全腿可见」不同, `remove` 处置下这批腿**整条移出候选** (三视角一律)
   * —— 信息不丢的责任由审计条目承接; 🚫 MUST NOT 退化成计数: 审计要逐腿的 bid/ask, 条数拼不出
   * 证据。070 起 `retain` 处置 ({@link CrossedQuoteDisposal}) 下这批腿**并未移出** —— 保留在
   * 候选照常派生成行, 本列表收敛为「护栏留痕」(#1 审计与净链除名都吃它); 字段名沿 069 出参
   * 形状不改, 改名会白牵动 port 与两个实现。**两种处置下本列表逐腿一致** (判据单点的证据)。
   */
  readonly removedByCrossedQuote: readonly T[];
  readonly removedByPremiumFloor: number;
  readonly excludedFromIntentTabs: number;
  readonly excludedFromIntentTabsByTab: Readonly<Record<LegIntentTab, number>>;
  /**
   * 触及候选上限时被切掉多少条 (052 FR-028)。恒有值, 未触及时为 `0`。
   *
   * 🚨 **这就是「触及 K 可被观测」的落点** —— 它随候选集一路上浮到响应里, 🚫 MUST NOT 退化成
   * 一行 `logger.warn`: 日志要人去翻才看得见, 而「候选被悄悄切掉一半」的现场恰恰是没人会去翻
   * 日志的那种 (数字都在、就是少了一批, 同 047「降级留痕必须是行状态」那条同源纪律)。
   *
   * 📌 **蓄意不配一个 `reached: boolean`**: 它可由 `> 0` 派生, 多存一份就多一处会 drift 的
   * 真相 —— 而两个字段不一致时, 两边都读得出值、都不会红。
   */
  readonly droppedByCandidateCap: number;
  /**
   * 三视角各自的条件全景 (052 FR-011 / FR-029)。**恒有三份** —— 客户端本地切视角时要用另两个
   * 视角的默认值填控件, 而那时不发请求。
   */
  readonly criteriaByTab: Readonly<Record<LegTab, PerspectiveCriteria>>;
}

/**
 * **召回层入口** (052 FR-001 / plan D-LAYER-1): 吃「视角 + 该链全部腿」, 吐候选集与两道门槛的
 * 排除计数。检索 port 的两个实现 (Prisma / 假) **共用本函数** ⇒ 判据不随实现分叉, 而这正是
 * 052 SC-009「召回判据脱离真库可测」的落点 —— 假实现驱动的是这里, 不是另一份判据。
 *
 * 🚨 **候选集与三个计数 MUST 同源产出** —— 它们是同一次求值的两个面。各算一份的话 drift 时
 * 两边都算得出数、都不会红 (050 的原纪律, 本片只是把它从 use case 移到了层入口)。
 *
 * 🚨 **两道门槛的作用面不同, MUST NOT 合并到一处施加** (FR-005 / FR-006): 权利金门槛把腿**整条
 * 移出候选集** (三个视角都看不见), 流动性门槛只让腿**少掉意图那几个 `tabs`** (腿仍在候选集里、
 * 仍在全腿视角可见)。合并必然把其中一个的作用面改错, 而两种错法都返回得出结果、都不会红。
 *
 * `perspectives` = 本次请求要的视角。不在其内的视角**既不产候选也不计排除数** —— 今天三视角
 * 一次全要 (047 FR-005 的既定契约), 该参数恒为全集; 拆成每视角独立请求归 053。
 *
 * `candidateCap` = 本次的候选上限 (052 FR-027)。**必填而非可选** —— 给个默认值就等于「忘传时
 * 静默无上限」, 而那正是保险丝最需要生效的那一刻 (调用方今天只有 port 的两个实现)。
 *
 * 复杂度 `O(n)`: 一遍报价护栏 (069 FR-001, {@link isCrossedQuote} 判中留痕, 处置按
 * `crossedQuoteDisposal` 分派) + 一遍求
 * 成色上界 (链级, 见 {@link resolveQualityCeiling}, 网格含被护栏剔的腿 —— 合约属性与报价无关)
 * + 一遍逐腿 `O(1)` 判据;
 * **仅在触及上限时**多一次 `O(n log n)` 排序 (见 {@link capCandidates})。
 * 前两遍**不可合成一遍** —— 上界要先于任何一条腿的判定成型。
 */
export function recallCandidates<T extends RecallLegInput>(
  context: RecallContext,
  perspectives: readonly LegTab[],
  legs: readonly T[],
  candidateCap: number,
  crossedQuoteDisposal: CrossedQuoteDisposal,
  override: RetrievalOverride | null = null,
): RecallOutcome<T> {
  const requested = new Set(perspectives);
  const candidates: RecallCandidate<T>[] = [];
  const excludedFromIntentTabsByTab: Record<LegIntentTab, number> = { build: 0, rent: 0 };
  let removedByPremiumFloor = 0;
  let excludedFromIntentTabs = 0;

  // 🚨 成色上界在**门槛之前**、对**全量腿**求一次 (052 FR-005): 行权价网格是合约属性, 与当日
  // 报价无关。放到循环里或放到门槛之后都会让上界随报价漂移 —— 而漂移后候选集照样出得来。
  const chain: RecallChainContext = {
    spot: context.spot,
    w: context.w,
    qualityCeiling: resolveQualityCeiling(context.spot, context.w, legs),
  };

  // 069 报价护栏 (FR-001): 前置于一切逐腿判据、三视角一律 ({@link isCrossedQuote})。放在成色
  // 上界**之后**过滤 —— 行权价网格是合约属性, 与报价好坏无关 (上文纪律)。070 起判据单点不动,
  // **处置**随口径分派 ({@link crossedQuoteDisposalOf}): `remove` 整条移出 (069 原语义);
  // `retain` 剔降为标 —— 腿留在池里照常走全套判据, 留痕列表两种处置下逐腿一致。
  const removedByCrossedQuote: T[] = [];
  const guardedLegs: T[] = [];
  for (const leg of legs) {
    if (!isCrossedQuote(leg.bid, leg.ask)) {
      guardedLegs.push(leg);
      continue;
    }
    removedByCrossedQuote.push(leg);
    if (crossedQuoteDisposal === 'retain') guardedLegs.push(leg);
  }

  // 三视角的系统默认值 + 本次生效值 (052 T010)。覆盖**只落在一个视角**上, 其余恒走默认值。
  const defaults = defaultCriteriaByTab(chain);
  const overridden = overriddenKeysOf(override);
  const effective: Record<LegTab, RetrievalCriteria> = {
    all: applyOverride(defaults.all, override, 'all'),
    build: applyOverride(defaults.build, override, 'build'),
    rent: applyOverride(defaults.rent, override, 'rent'),
  };
  const excludedByCriterion: Record<LegTab, Record<RetrievalCriterionKey, number>> = {
    all: zeroCriterionCounts(),
    build: zeroCriterionCounts(),
    rent: zeroCriterionCounts(),
  };

  const pass: RecallPass = { chain, requested, defaults, effective, overridden };
  for (const leg of guardedLegs) {
    const verdict = evaluateLeg(pass, leg);
    if (verdict.tabs.length > 0) {
      candidates.push({
        leg,
        tabs: verdict.tabs,
        wideSpreadOpportunity: verdict.wideSpreadOpportunity,
      });
    }
    if (verdict.premiumBlockedEverywhere) removedByPremiumFloor += 1;
    for (const hit of verdict.marginalHits) excludedByCriterion[hit.tab][hit.key] += 1;
    // 🚨 标量与两个分视角数在**同一次求值**上累加: 标量按「非空」加 1, 分视角按「里面的每个
    // 视角」各加 1 ⇒ `标量 ≤ build + rent` 是读得出来的结构保证 (重叠区 `[30,49]` 的腿会让
    // 右边比左边多 1, 这是设计不是 bug), 而不是靠测试守住的巧合。
    if (verdict.excludedByLiquidity.length === 0) continue;
    excludedFromIntentTabs += 1;
    for (const tab of verdict.excludedByLiquidity) excludedFromIntentTabsByTab[tab] += 1;
  }

  // 🚨 上限在**三个计数之后**施加: 那三个数是对整批腿的判定统计, 被切掉的腿早已过了门槛
  // ⇒ 切它不该让「被门槛挡下多少条」跟着变。反过来把 cap 提到循环里会让计数依赖遍历顺序。
  const kept = capCandidates(candidates, candidateCap);
  return {
    candidates: kept,
    removedByCrossedQuote,
    removedByPremiumFloor,
    excludedFromIntentTabs,
    excludedFromIntentTabsByTab,
    droppedByCandidateCap: candidates.length - kept.length,
    criteriaByTab: {
      all: perspectiveCriteriaOf('all', defaults, effective, overridden, excludedByCriterion),
      build: perspectiveCriteriaOf('build', defaults, effective, overridden, excludedByCriterion),
      rent: perspectiveCriteriaOf('rent', defaults, effective, overridden, excludedByCriterion),
    },
  };
}

/** 一趟召回的不变量 —— 逐腿评判要用的全部上下文, 每次 {@link recallCandidates} 求一次。 */
interface RecallPass {
  readonly chain: RecallChainContext;
  readonly requested: ReadonlySet<LegTab>;
  readonly defaults: Readonly<Record<LegTab, RetrievalCriteria>>;
  readonly effective: Readonly<Record<LegTab, RetrievalCriteria>>;
  readonly overridden: Readonly<Record<LegTab, ReadonlySet<RetrievalCriterionKey>>>;
}

/** 一条腿的评判结果 —— 三个计数与候选归属都从它读, 主循环只负责累加。 */
interface LegVerdict {
  readonly tabs: LegTab[];
  /** 「本来进得去、只被价差挡下」的意图视角 (051 两个流动性数)。 */
  readonly excludedByLiquidity: LegIntentTab[];
  /** 每个请求视角都被权利金挡下 ⇒ 它是「整条移出」的那一类 (051 已 ship 的展示值)。 */
  readonly premiumBlockedEverywhere: boolean;
  /** 052 边际计数命中的 (视角, 维度) 对。 */
  readonly marginalHits: readonly { readonly tab: LegTab; readonly key: RetrievalCriterionKey }[];
  /** 071 宽价差机会标 —— 语义见 {@link RecallCandidate.wideSpreadOpportunity}。 */
  readonly wideSpreadOpportunity: boolean;
}

/**
 * 逐腿逐视角评判。`O(视角数 × 6)` = `O(1)`。
 *
 * 🚨 **候选归属、051 的两个流动性数、052 的六维计数全部由这一趟派生** —— 各算一份的话 drift 时
 * 三边都算得出数、都不会红。
 */
function evaluateLeg(pass: RecallPass, leg: RecallLegInput): LegVerdict {
  const tabs: LegTab[] = [];
  const excludedByLiquidity: LegIntentTab[] = [];
  const marginalHits: { tab: LegTab; key: RetrievalCriterionKey }[] = [];
  let evaluatedTabs = 0;
  let premiumBlockedTabs = 0;
  let wideSpreadOpportunity = false;

  for (const tab of LEG_TABS) {
    if (!pass.requested.has(tab)) continue;
    // 071 FR-006: 标按**系统默认值下**的主支判 —— 见 `RecallCandidate.wideSpreadOpportunity`。
    // 放在成员判定之前算: 它描述的是「这条腿是怎么进来的」, 与它这次进没进来是两件事。
    const systemMax = pass.defaults[tab].relativeSpreadMax;
    if (
      tab === 'rent' &&
      systemMax !== null &&
      !passesRelativeSpreadMax(leg.bid, leg.ask, systemMax) &&
      isWideSpreadOpportunity(leg)
    ) {
      wideSpreadOpportunity = true;
    }
    const verdict = evaluateTab(tab, pass.chain, pass.effective[tab], leg);
    evaluatedTabs += 1;
    if (verdict.premiumBlocked) premiumBlockedTabs += 1;
    if (verdict.passes) {
      tabs.push(tab);
      continue;
    }
    // `soleFailure` 为 `null` = 硬门槛不过、或不止一个维度挡它 ⇒ **不进任何一个维度的计数**:
    // 把某一维换回默认值它照样进不来,「放宽这一条就能多看到 N 条」对它不成立。
    const key = verdict.soleFailure;
    if (key === null) continue;
    // 051 的流动性数与是否被用户覆盖无关; 052 的边际计数只数**用户覆盖过**且默认值下放行的维度
    // (否则把这一维换回默认它仍进不来 ⇒ 「当前条件之外还有它」不成立)。
    if (key === 'relativeSpreadMax' && tab !== 'all') excludedByLiquidity.push(tab);
    if (pass.overridden[tab].has(key) && !failsCriterion(tab, key, pass.defaults[tab], leg)) {
      marginalHits.push({ tab, key });
    }
  }

  return {
    tabs,
    excludedByLiquidity,
    premiumBlockedEverywhere: evaluatedTabs > 0 && premiumBlockedTabs === evaluatedTabs,
    marginalHits,
    wideSpreadOpportunity,
  };
}

/**
 * 一条腿在一个视角下的评判 —— 候选归属、051 的流动性排除数、052 的六维计数**三者的共同根**。
 *
 * 🚨 每个 (腿, 视角) 只求一次值: 各算一份的话 drift 时三边都算得出数、都不会红。
 */
interface LegTabVerdict {
  /** 硬门槛与六维条件全过。 */
  readonly passes: boolean;
  /** **唯一**挡下它的那个维度; 硬门槛不过、或不止一维挡它 ⇒ `null` (那时任何一维都不该计它)。 */
  readonly soleFailure: RetrievalCriterionKey | null;
  /** 是否被权利金这一维挡下 ——「整条移出」要看它在**每个**请求视角下都成立。 */
  readonly premiumBlocked: boolean;
}

function evaluateTab(
  tab: LegTab,
  chain: RecallChainContext,
  criteria: RetrievalCriteria,
  leg: RecallLegInput,
): LegTabVerdict {
  const failed = failedCriteria(tab, criteria, leg);
  const hard = passesHardGates(tab, chain, leg);
  return {
    passes: hard && failed.length === 0,
    soleFailure: hard && failed.length === 1 ? failed[0] : null,
    premiumBlocked: failed.includes('premiumMin'),
  };
}

/** 本次被用户覆盖的维度 —— 判据取 `in` 而非 `!== undefined` (见 {@link RetrievalOverride})。 */
function overriddenKeysOf(
  override: RetrievalOverride | null,
): Readonly<Record<LegTab, ReadonlySet<RetrievalCriterionKey>>> {
  const keys =
    override === null ? [] : RETRIEVAL_CRITERION_KEYS.filter((key) => key in override.criteria);
  const empty = new Set<RetrievalCriterionKey>();
  return {
    all: override?.perspective === 'all' ? new Set(keys) : empty,
    build: override?.perspective === 'build' ? new Set(keys) : empty,
    rent: override?.perspective === 'rent' ? new Set(keys) : empty,
  };
}

/** 把用户值盖到系统默认值上 —— 只对 `override.perspective` 那一个视角生效。 */
function applyOverride(
  defaults: RetrievalCriteria,
  override: RetrievalOverride | null,
  tab: LegTab,
): RetrievalCriteria {
  if (override === null || override.perspective !== tab) return defaults;
  const merged = { ...defaults };
  for (const key of RETRIEVAL_CRITERION_KEYS) {
    if (!(key in override.criteria)) continue;
    // 逐键赋值而非整体展开: 展开会把「显式给了 undefined」也盖上去, 那与「缺键」是两回事。
    Object.assign(merged, { [key]: override.criteria[key] ?? null });
  }
  return merged;
}

function zeroCriterionCounts(): Record<RetrievalCriterionKey, number> {
  return {
    strikeMax: 0,
    strikeMin: 0,
    dteBand: 0,
    premiumMin: 0,
    livenessMin: 0,
    relativeSpreadMax: 0,
  };
}

/** 三态由「是否覆盖」× 「边际排除数是否为零」判定 (见 {@link CriterionState})。 */
function perspectiveCriteriaOf(
  tab: LegTab,
  defaults: Readonly<Record<LegTab, RetrievalCriteria>>,
  effective: Readonly<Record<LegTab, RetrievalCriteria>>,
  overridden: Readonly<Record<LegTab, ReadonlySet<RetrievalCriterionKey>>>,
  excluded: Readonly<Record<LegTab, Record<RetrievalCriterionKey, number>>>,
): PerspectiveCriteria {
  const outcomes = {} as Record<RetrievalCriterionKey, CriterionOutcome>;
  for (const key of RETRIEVAL_CRITERION_KEYS) {
    const count = excluded[tab][key];
    const state: CriterionState = !overridden[tab].has(key)
      ? 'default'
      : count > 0
        ? 'narrowed'
        : 'widened';
    outcomes[key] = { state, excludedCount: state === 'narrowed' ? count : 0 };
  }
  return { defaults: defaults[tab], effective: effective[tab], outcomes };
}

/**
 * 候选上限的**确定性切法** (052 FR-027 / FR-028)。未触及时**原样返回** (零拷贝零排序)。
 *
 * 🚨 **切之前 MUST 先定序, MUST NOT 直接 `slice` 输入顺序** —— 输入顺序来自存储实现 (今天是
 * 一条无序的批量读), 同一份数据两次请求可能给出不同的前 K 条。那种不稳定是最难查的一类:
 * 数字都在、条数也对, 只是成员每次不一样。
 *
 * 🚫 **这道排序 MUST NOT 被读成「召回层在打分」** (ADR-0064 决策 1 禁第二个打分点): 键取
 * `(DTE, 行权价)` 是**日历顺序**, 不表达任何好坏 —— 它只在触及上限那一刻生效, 且切掉多少条
 * 由 {@link RecallOutcome.droppedByCandidateCap} 如实上报。真正的排序是精排层的事。
 *
 * 复杂度: 未触及 `O(1)`; 触及时 `O(n log n)`。
 */
function capCandidates<T extends RecallLegInput>(
  candidates: readonly RecallCandidate<T>[],
  candidateCap: number,
): readonly RecallCandidate<T>[] {
  if (candidates.length <= candidateCap) return candidates;
  return [...candidates]
    .sort((a, b) => a.leg.dteDays - b.leg.dteDays || a.leg.strike.comparedTo(b.leg.strike) || 0)
    .slice(0, candidateCap);
}

/** 闭区间含两端。段界一律走常量, 本文件内也不写字面量比较。 */
function withinDteBand(dteDays: number, band: DteBand): boolean {
  return dteDays >= band.min && dteDays <= band.max;
}
