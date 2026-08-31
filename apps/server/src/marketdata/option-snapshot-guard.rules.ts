import { Prisma } from '../generated/prisma/client.js';

/**
 * 期权快照**落库前自洽硬门**纯函数 (047 T007, FR-043 / FR-044, plan D-DATA-7)。无 I/O、无 DI
 * (ADR-0043 §4: rules 文件持无副作用业务规则)。
 *
 * 四条门, 全部只用**行内自带**的字段判定 (不查库、不比对邻行):
 *   ① `bid ≤ ask`                      —— 交叉盘口是不可能的真实报价
 *   ② PUT `Δ ≤ 0` / CALL `Δ ≥ 0`       —— 两侧方向**相反**, 抄反了不会红
 *   ③ `|Δ| ≤ 1`                        —— 期权 Δ 的数学值域
 *   ④ **无套利下界 `ask ≥ 内在价值 − 容差`**
 *
 * ## 🚨 门 ④ 用 `ask` 不用 `bid` —— 这条看着像笔误, 不许"修正"回 bid (FR-044)
 *
 * 直觉是「买价不应低于内在价值」, 但实测**同一批 2138 行**: `ask` 版 **0 违规** / `bid` 版
 * **706 违规**。做市商对实值腿的机械占位报价普遍让 bid 跌破内在价值 —— **是市场常态不是脏
 * 数据**（同一现象的另一面就是 FR-007 那 227 行 greeks 缺失: bid 跌破内在价值 ⇒ IV 无解）。
 * 改成 bid 版会当场误拦三分之一的实值腿, 而**快照漏采即永久缺口**（vendor 不提供历史交易日的
 * 期权快照）, 拒掉的行**买不回来**。⚠️ 合成数据永远造不出那 706 行 ⇒ 单测里有一条显式造出来的
 * 「bid 跌破内在价值但 ask 未跌破的实值腿必须放行」, 改成 bid 版即红。
 *
 * ## 为什么**返回逐行判定而不抛异常** (FR-043)
 *
 * 违规行**逐行拒绝**、其余行照常入库, 且「MUST NOT 破坏已落历史数据」。抛异常会让一条脏行
 * 带走整批的落库 —— 而这批就是当日仅有的一次采集机会。⇒ 本文件**没有任何 throw**;
 * 「拒了哪些行、为什么」由 {@link OptionSnapshotVerdict} 带回, 上抬 ERROR 归调用方 (T016)。
 *
 * ## 缺失字段一律**跳过对应的门**, 不当违规 —— 但**跳过这件事本身要留痕** (2026-08-31)
 *
 * greeks 整块缺失的深实值腿 (实测 227/2150 行) 必须照常入库 (FR-007: 「MUST NOT 被筛除 ——
 * 决策带由 |Δ| 定义, 缺 Δ 即被筛没且无人知晓」)。同理 `underlying_spot` 缺失 ⇒ 算不出内在
 * 价值 ⇒ 门 ④ 不成立而非判违规。**把「算不出」判成「违规」= 拿缺失冒充证据**, 与本仓
 * 「不可算是显式态」纪律一致。
 *
 * ## 非标 (调整后) 合约的内在价值**算不出** ⇒ 门 ④ 跳过 (#186, FR-033)
 *
 * 调整后合约 (并购 / 分拆 / 特别股息后重构, root 带 `1` 后缀如 `CHTR1`) 交割的不是 100 股标的,
 * 而是「整股 + 零碎股现金找零 + 特别现金分配」的混合物 ⇒ 拿普通 `strikePrice` 与
 * `underlyingSpot` 代进 `max(0, S − K)` 得到的**不是那张合约的内在价值**。2026-08-24 夜实拒
 * 238 行, root 分布 **100%** 落在带 `1` 后缀的调整后合约上 (`CHTR1` 93 / `APTV1` 70 /
 * `CMCS1` 46 / `LEN1` 29); 非标合约快照覆盖率 **70.5% vs 标准合约 97.1%**, 且每晚复发。
 *
 * ⇒ 与上一节同一条纪律: 缺的不是 `underlying_spot` 而是「一张合约到底交割多少股」, 把
 * 「算不出」判成「违规」同样是拿缺失冒充证据。非标合约 MUST 照常全采落库 (FR-033), 排除只
 * 发生在选约层 (FR-008)。
 *
 * 🚫 **MUST NOT 改成「拿 vendor 的合约乘数重算内在价值」** —— FR-028 明令「MUST NOT 存合约
 * 乘数、MUST NOT 做乘数感知计算」: 那个混合物本就不是一个乘数能表达的。
 * 🚫 **MUST NOT 改成「放宽容差」** —— 容差要拦的是**数量级错误** (spot/strike 错配、合约映射
 * 串行), 放宽会让那类真错误一起漏过。
 *
 * 金融数值一律 `Prisma.Decimal` (Decimal.js, 零新 dep): 门 ③ 与门 ④ 都卡在**恰好等于**边界上
 * (|Δ| 恰好 1 / ask 恰好 = 内在价值 − 容差), 浮点减法会让边界归属随输入随机漂移;
 * 且 DB 侧本就是 `Decimal(16,8)` / `Decimal(18,4)`, 直传零转换 (与「禁 Float」一致)。
 */

/** Decimal 可接受形态: string (vendor payload / 常量) 或 Prisma.Decimal (PG row)。 */
type Decimalish = string | Prisma.Decimal;

const D = (v: Decimalish): Prisma.Decimal => new Prisma.Decimal(v);

const ZERO = new Prisma.Decimal(0);

// ─────────────────────────────────────────────────────────────────────────────
// 门限常量 (改口径改这里, 判定函数内 MUST NOT 出现字面量)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 无套利下界的容差 (报价单位, 与 `ask` / `strike_price` 同量纲 = USD)。
 *
 * 取 **0.05 = 美股期权的较宽一档最小报价单位** (Penny Interval Program 下权利金 <$3.00 报
 * $0.01 档、≥$3.00 报 $0.05 档)。⇒ 容差 = 「一个最小跳动」量级, 而非拍一个百分比。
 *
 * 合法松弛的来源不是舍入而是**时点错位**: `underlying_spot` 是链响应随手带回的标的价, 与该行
 * 期权盘口的 `update_time` 未必同一时刻, spot 动一跳内在价值就跟着动一跳。
 *
 * **取值方向由不对称性决定**: 误拒 = 当日快照永久缺口 (vendor 无历史期权快照, 买不回来);
 * 误放 = 库里多一行可疑数据, 下游随时可再筛。⇒ 宁松勿紧。而本门要拦的是**数量级错误**
 * (spot / strike 错配、合约映射串行), 那类偏差是「元」不是「分」, 一个 nickel 的容差拦得住。
 */
export const INTRINSIC_VALUE_TOLERANCE = new Prisma.Decimal('0.05');

/** Δ 的数学值域上界 (绝对值)。超出即 vendor 下发了不可能的 greeks。 */
export const MAX_ABS_DELTA = new Prisma.Decimal(1);

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 认沽 / 认购。**采集端两侧全采** (`option_type = ALL`, plan D-DATA-3) —— 「本片只含认沽」
 * 是呈现面的话; 这里两侧都得判, 且门 ② 的方向相反。
 */
export type OptionSide = 'PUT' | 'CALL';

/** 四条门各自的违规码 (进 ERROR 文案与运维统计, 故用稳定字符串而非序号)。 */
export type OptionSnapshotViolationCode =
  | 'bid_above_ask'
  | 'delta_sign'
  | 'delta_out_of_range'
  | 'ask_below_intrinsic';

export interface OptionSnapshotViolation {
  code: OptionSnapshotViolationCode;
  /** 人可读依据, 含涉事实值 —— 运维定位时不必回查原始 payload。 */
  reason: string;
}

/**
 * 硬门只认这几个字段 —— 快照行的其余列 (IV / gamma / OI / turnover …) **不参与判定**, 故
 * 不进入参: 让「哪些字段能左右放行」在类型层面就是封闭的。
 */
export interface OptionSnapshotGuardRow {
  /** 合约代码。只进违规原因与 verdict 回执供调用方定位, **不参与判定**。 */
  contractCode: string;
  optionSide: OptionSide;
  strikePrice: Decimalish;
  /**
   * 库内 `option_contract.is_standard`。**只喂门 ④** —— 见文件头「非标合约的内在价值算不出」。
   * 🚫 MUST NOT 拿它豁免其余三条门: 那三条只用行内自带的数, 与交割物是什么无关。
   */
  isStandard: boolean;
  /** vendor 未下发 ⇒ `null`, 对应的门跳过 (缺失不是违规)。 */
  bid: Decimalish | null;
  ask: Decimalish | null;
  delta: Decimalish | null;
  /** 链响应随行带回的标的价, **不走复权换算** (ADR-0053 绊线, plan D-ARCH-1)。 */
  underlyingSpot: Decimalish | null;
}

export interface OptionSnapshotVerdict {
  /** 原样回带, 让调用方无需按下标对齐即可定位被拒的行。 */
  contractCode: string;
  /** `violations` 为空 ⟺ 放行。 */
  admitted: boolean;
  /** **不短路**: 一行撞多条门就全列出, 一次采集把问题看全。 */
  violations: readonly OptionSnapshotViolation[];
  /**
   * 本行**无从判定**的门 —— 判据适用, 但这一行缺输入 (缺 `bid`/`ask`/`Δ`/`underlyingSpot`)。
   * 恒有值, 全判得动时为空数组。
   *
   * 🚨 **它与「`violations` 为空」不是一回事** (2026-08-31 收口): 空 `violations` 有两种成因
   * ——「判过了, 过了」与「压根没判成」, 而**下游把后者当成前者**正是那条把好数据换成坏数据
   * 的补救链的病根: hk:00700 两条深实值 PUT 在收盘轮撞 `ask_below_intrinsic` 被拒 ⇒ 判该票
   * 未完整 ⇒ 次日 08:30 盘前兜底重采, 而港股 09:00 才开始竞价 ⇒ **`ask` 全为 null ⇒ 门 ④
   * 根本没跑** ⇒ 零违规 ⇒ 判「补回了」。**空数据反而比有瑕疵的数据更"合格"**, 补救于是
   * 「成功」并把那 2 条腿以 vendor 无盘口时退化算出的 greeks 写进库。
   *
   * 📌 **本字段 MUST NOT 影响 `admitted`** —— 无从判定仍照常入库: 无盘口行携带 OI 与合约骨架,
   * 而快照漏采即永久缺口 (vendor 不提供历史期权快照)。它只让「没判成」这件事**对调用方可见**,
   * 处置权在调用方 (同本文件「返回逐行判定而不抛异常」的分工)。
   *
   * 📌 **非标合约的门 ④ 不进本列表**: 那是判据**不适用** (交割物不是 100 股标的 ⇒ 内在价值
   * 没有定义), 不是「缺输入判不了」。两者混在一起会让非标合约恒「未判」, 把信号淹掉。
   */
  unjudged: readonly OptionSnapshotViolationCode[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 内在价值 (immediate exercise value): PUT `max(0, K − S)` / CALL `max(0, S − K)`。
 *
 * **截到 0 是必须的** —— 虚值腿的 `K − S` 为负, 不截则「下界」变成负数, 门 ④ 对整个虚值区
 * 永久失效 (且不会红)。O(1)。
 *
 * 导出供 `option-anomaly.rules.ts` (T024) 判实值/虚值复用: 告警面与入库面对同一条腿的
 * 「是不是实值」必须同源, 各写一份必 drift。
 *
 * 🚨 **只对标准合约成立** —— 非标合约交割的不是 100 股标的, 这个公式对它没有意义。两个消费方
 * (门 ④ 与 `moneynessOf`) 都在调用**之前**用 `is_standard` 挡掉 (#186), 本函数不自带那道判断:
 * 它拿不到 `is_standard`, 而多加一个入参会让「同源」变成「两处各判一次」。
 */
export function intrinsicValue(
  side: OptionSide,
  strike: Prisma.Decimal,
  spot: Prisma.Decimal,
): Prisma.Decimal {
  const raw = side === 'PUT' ? strike.minus(spot) : spot.minus(strike);
  return raw.greaterThan(ZERO) ? raw : ZERO;
}

/**
 * 单行过四条门 (FR-043 / FR-044)。**永不抛异常**, 见文件头。
 *
 * 复杂度 **O(1)** —— 四条门各是常数次 Decimal 比较, 与行数、与合约集大小均无关。
 */
export function checkOptionSnapshotRow(row: OptionSnapshotGuardRow): OptionSnapshotVerdict {
  const violations: OptionSnapshotViolation[] = [];
  /** 见 {@link OptionSnapshotVerdict.unjudged} —— 缺输入 ⇒ 该门没跑, 与「跑了且过了」分开记。 */
  const unjudged: OptionSnapshotViolationCode[] = [];

  const bid = row.bid === null ? null : D(row.bid);
  const ask = row.ask === null ? null : D(row.ask);
  const delta = row.delta === null ? null : D(row.delta);
  const spot = row.underlyingSpot === null ? null : D(row.underlyingSpot);

  // ① bid ≤ ask (边界闭: 锁价盘口 bid == ask 是正常态)。
  if (bid === null || ask === null) {
    unjudged.push('bid_above_ask');
  } else if (bid.greaterThan(ask)) {
    violations.push({
      code: 'bid_above_ask',
      reason: `盘口交叉: bid ${bid.toString()} > ask ${ask.toString()}`,
    });
  }

  if (delta === null) {
    // 门 ② 与 ③ 同一个入参 ⇒ 缺 Δ 时两条一起没跑。
    unjudged.push('delta_sign', 'delta_out_of_range');
  } else {
    // ② PUT Δ ≤ 0 / CALL Δ ≥ 0 —— 两侧方向相反 (Δ = 0 两侧都合法, 深虚腿取值)。
    const signViolated = row.optionSide === 'PUT' ? delta.greaterThan(ZERO) : delta.lessThan(ZERO);
    if (signViolated) {
      violations.push({
        code: 'delta_sign',
        reason: `${row.optionSide} 的 Δ 符号非法: ${delta.toString()} (PUT 要求 ≤ 0, CALL 要求 ≥ 0)`,
      });
    }
    // ③ |Δ| ≤ 1 (边界闭: 深实值腿 |Δ| 可恰好为 1)。
    if (delta.abs().greaterThan(MAX_ABS_DELTA)) {
      violations.push({
        code: 'delta_out_of_range',
        reason: `|Δ| = ${delta.abs().toString()} > ${MAX_ABS_DELTA.toString()}`,
      });
    }
  }

  // ④ 无套利下界 —— 🚨 用 `ask` 不用 `bid` (FR-044, 见文件头 706 行实证)。
  // 🚨 三分支, 🚫 MUST NOT 合并成一个 `if`:
  //   · 非标合约 (#186) ⇒ 判据**不适用** (交割物不是 100 股标的, 内在价值没有定义) —— 既不违规
  //     也不进 `unjudged`;
  //   · 标准合约但缺 `ask` / `spot` ⇒ **无从判定**, 进 `unjudged` (港股闭市做市商全撤单时这是
  //     常态, 而正是它让补救链把空数据当成"合格"—— 见 {@link OptionSnapshotVerdict.unjudged});
  //   · 两者齐备 ⇒ 真判。
  if (!row.isStandard) {
    // 不适用 —— 蓄意什么都不记。
  } else if (ask === null || spot === null) {
    unjudged.push('ask_below_intrinsic');
  } else {
    const intrinsic = intrinsicValue(row.optionSide, D(row.strikePrice), spot);
    const floor = intrinsic.minus(INTRINSIC_VALUE_TOLERANCE);
    if (ask.lessThan(floor)) {
      violations.push({
        code: 'ask_below_intrinsic',
        reason:
          `ask ${ask.toString()} 低于无套利下界 ${floor.toString()} ` +
          `(内在价值 ${intrinsic.toString()} − 容差 ${INTRINSIC_VALUE_TOLERANCE.toString()}, ` +
          `${row.optionSide} K=${D(row.strikePrice).toString()} spot=${spot.toString()})`,
      });
    }
  }

  return {
    contractCode: row.contractCode,
    admitted: violations.length === 0,
    violations,
    unjudged,
  };
}

/**
 * 整批**逐行**判定, 输出与输入一一对应同序 (FR-043「违规行不入库, MUST NOT 破坏已落历史」)。
 *
 * 🚫 **不做任何批级短路 / 批级否决** —— 调用方据每行 `admitted` 决定入不入库, 一条脏行
 * MUST NOT 带走整批。
 *
 * 复杂度 **O(n)**, n = 行数 (每行 O(1))。
 */
export function checkOptionSnapshotRows(
  rows: readonly OptionSnapshotGuardRow[],
): OptionSnapshotVerdict[] {
  return rows.map(checkOptionSnapshotRow);
}
