import type { Prisma } from '../generated/prisma/client';
import { FX_CURRENCIES, type FxCurrency, type FxPair, type FxRate } from './fx-rate.port';
import { invertRate } from './fx-rate.rules';

/**
 * 085 T005 **展示币种折算规则** —— 逐行折算 + 降级判定 + 组聚合置 null
 * (FR-002 / FR-003 / FR-004 / FR-006 / FR-008 / FR-012; plan D2 / D6)。
 * 无 I/O、无 DI、无时钟 (ADR-0043 §4 rules)。
 *
 * ## 管道位置 (plan D2)
 *
 * `list-broker-positions.usecase.ts` 拿到 rows 之后、调 `buildPositionGroups` **之前**调
 * {@link convertRows}; 分组完成之后调 {@link finalizeConvertedGroups}。**先逐行折算再聚合**:
 * 反过来 (先聚合再折算) 会把降级行的原币种值混进 `signedSum`, 乘汇率后得到一个「看起来合理」
 * 的错数 (plan P5 判据改写后的现行依据)。
 *
 * ## 🚫 改 `broker-position-display.rules.ts`
 *
 * 降级行把 `marketValue` / `unrealizedPl` **置 `null`** 再喂进去, 既有 `signedSum`
 * (`broker-position-display.rules.ts:134-140`, 非空带符号求和 / 全空 ⇒ null) 与 `compareGroups`
 * (`:190-205`, `|groupMarketValue|` 降序 → null 排末) 就**自动**给出 FR-006「不混入求和」与
 * 全降级组的沉底 —— 零新排序键、零改既有比较器。
 *
 * ⚠️ **自动复用盖不住的那一半**: 含降级行但**也有**可折算行的组, 其 `groupMarketValue` 是非
 * null 的**部分和** ⇒ 不会落进 `compareGroups` 的 null 分支 ⇒ 不会沉底。故
 * {@link finalizeConvertedGroups} 显式把这类组的**两个**聚合值都置 `null` 并沉底 —— 「沉底」
 * 与「不完整标记」由**同一个判定** (`rows.some(degraded)`) 驱动, 不会出现「标了不完整却没沉底」。
 *
 * ## 🚫 陈旧阈值 (plan D6)
 *
 * 本文件**不读时钟、不接受 `now`**, 故没有任何「汇率太旧 ⇒ 降级」的路径。在岸 CNY 盘前会给
 * 数小时前的值 (plan §plan 前验证「两条新发现」②), 把陈旧判成不可用会让盘前**整屏**退回原币种。
 * 没有阈值就没有「阈值定错导致整屏降级」这一类失效面; 取数时刻已由 {@link AppliedFxRate.capturedAt}
 * 上屏, 陈旧与否由用户自己判 (FR-007)。
 *
 * ## 金额口径
 *
 * 一律 `Prisma.Decimal`, 不经 Number 中转 (Guardrail 2); 折算不做额外舍入 —— 位数由 Decimal
 * 自身的有效位决定, 展示位数是 mobile 的事。
 */

/** 单行折算所需的最小形状; 调用方的行可带更多字段, 原样透传。 */
export interface DisplayCurrencyInputRow {
  /** 券商回报的原币种; 未回报 ⇒ `null` (FR-006 的「币种未知」)。 */
  currency: string | null;
  marketValue: Prisma.Decimal | null;
  unrealizedPl: Prisma.Decimal | null;
}

/** 本屏实际消费的一条参考汇率 (FR-007 的响应素材)。 */
export interface AppliedFxRate {
  readonly from: FxCurrency;
  readonly to: FxCurrency;
  /** 实际查到的**直接**币对; `from`/`to` 是它的反向时, {@link rate} 是它的倒数。 */
  readonly pair: FxPair;
  /** `from` → `to` 的乘数。 */
  readonly rate: Prisma.Decimal;
  /** **我们采到这个数的时刻** (`FxRate.capturedAt` 原样带出, 不重新取时钟)。 */
  readonly capturedAt: Date;
}

/** 折算后附加在每行上的呈现元信息 (T006 的行级 DTO 字段来源)。 */
export interface DisplayCurrencyMeta {
  /**
   * 该行**金额类**字段的呈现币种。
   *
   * - 已折算 ⇒ 选定币种; 选定 = 原币种 ⇒ 原币种 (两者同值, 但 {@link converted} 不同)。
   * - 降级且原币种已知 ⇒ 原币种 (FR-006「标注币种」)。
   * - 原币种未知 / 不是本片三档之一 ⇒ `null` —— 呈现层据此走「币种未知」文案,
   *   🚫 回落成任何币种 (US3-AS2「不被默认成任何币种」)。
   */
  readonly displayCurrency: FxCurrency | null;
  /** 是否真的乘过汇率。选定 = 原币种的直出路径恒 `false` (FR-008)。 */
  readonly converted: boolean;
  /** 降级行: 金额类已置 `null`, 原值在 {@link originalMarketValue} / {@link originalUnrealizedPl}。 */
  readonly degraded: boolean;
  /**
   * 降级行的**原币种**市值 / 持仓盈亏; 未降级 ⇒ `null` (值就在 `marketValue` / `unrealizedPl` 上)。
   *
   * 🚨 这两个字段存在的唯一理由: 降级行必须同时满足两条互相拉扯的要求 —— FR-006 要求
   * 「以该行原币种**显示其金额**」, 而 plan D2 要求把 `marketValue` 置 `null` 才能不混进
   * `signedSum`。置 null 的那一份是**聚合与排序的入参**, 这一份是**呈现值**。
   */
  readonly originalMarketValue: Prisma.Decimal | null;
  readonly originalUnrealizedPl: Prisma.Decimal | null;
}

export type ConvertedRow<R extends DisplayCurrencyInputRow> = R & DisplayCurrencyMeta;

export interface ConvertRowsOptions {
  /** 选定的展示币种 (缺省档由调用方按 market 决定, 见 T006)。 */
  readonly target: FxCurrency;
  /**
   * 汇率表 (FX port 的 `fetchRates()` 结果原样传入; 全源失败 ⇒ 空数组 ⇒ 整屏降级)。
   *
   * 🚨 **按 `pair` 索引, 🚫 按位置** —— port 契约只保证「三对齐全」, 顺序随 vendor 响应
   * (`fx-rate.port.ts` `fetchRates` 文档)。
   */
  readonly rates: readonly FxRate[];
}

/** {@link finalizeConvertedGroups} 所需的最小组形状 (`PositionGroup` 的子集)。 */
export interface DisplayCurrencyGroup {
  readonly rows: readonly { readonly degraded: boolean }[];
  readonly groupMarketValue: Prisma.Decimal | null;
  readonly groupUnrealizedPl: Prisma.Decimal | null;
}

export type FinalizedGroup<G extends DisplayCurrencyGroup> = G & {
  /** 两个聚合值是否完整 (FR-006: 不完整时**两个**都要标)。 */
  readonly aggregateComplete: boolean;
};

/**
 * 券商回报的币种串 → 本片三档之一; 不在值域内 (含 `null` / 空串 / 如 `JPY`) ⇒ `null`。
 *
 * 🚫 猜或回落: 猜错的后果是把一行标成别的币种再乘汇率, 而屏幕上一切正常 (FR-006 / US3-AS2)。
 */
export function parseDisplayCurrency(raw: string | null): FxCurrency | null {
  if (raw === null) return null;
  const upper = raw.trim().toUpperCase();
  return FX_CURRENCIES.find((c) => c === upper) ?? null;
}

/**
 * 从汇率表解出 `from → to` 的乘数。
 *
 * - `from === to` ⇒ `null` —— **不是**「汇率缺失」, 而是压根不需要汇率 (FR-008 直出路径)。
 *   调用方据此判断「本屏是否发生折算」⇒ 汇率行仅在需要时出现 (FR-007 / FR-011)。
 * - 直接币对命中 ⇒ 原值; 只有反向命中 ⇒ 取倒数 (`invertRate`; 反向三对 vendor 全 MISS,
 *   `fx-rate.rules.ts:188-199` 的 EVIDENCE)。
 * - 都没有 ⇒ `null` (降级)。🚫 **链式交叉** (用另两对相除凑第三对): 交叉出来的数字任何源都
 *   没直接给过, 而它照样算得出来 (`fx-rate.port.ts:26-29`)。
 *
 * 复杂度 O(表长) = O(3)。
 */
export function resolveDisplayRate(
  rates: readonly FxRate[],
  from: FxCurrency,
  to: FxCurrency,
): AppliedFxRate | null {
  if (from === to) return null;

  const direct = rates.find((r) => r.pair === `${from}${to}`);
  if (direct !== undefined) {
    return usable(direct)
      ? { from, to, pair: direct.pair, rate: direct.rate, capturedAt: direct.capturedAt }
      : null;
  }

  const reverse = rates.find((r) => r.pair === `${to}${from}`);
  if (reverse === undefined || !usable(reverse)) return null;
  return {
    from,
    to,
    pair: reverse.pair,
    rate: invertRate(reverse.rate),
    capturedAt: reverse.capturedAt,
  };
}

/**
 * 非正 / 非有限的汇率**当作不可用**(⇒ 降级), 🚫 上抛。
 *
 * 解析层已经把这类值挡在外面 (`fx-rate.rules.ts:102-114` 的 `toRate` 即抛), 这里是呈现路径的
 * 兜底: 在这一步抛会把一次脏数据升级成整个端点 500, 而降级本来就是这条链约好的失败形态
 * (plan D6 / `fx-rate.port.ts:62-63`)。顺带保证 {@link invertRate} 的前置条件成立。
 */
function usable(quote: FxRate): boolean {
  return quote.rate.isFinite() && quote.rate.gt(0);
}

/**
 * 逐行折算。入参不被原地修改; 行顺序原样保留 (组内相对顺序由此天然不变, FR-012)。
 *
 * 每行三条分支 (顺序即优先级):
 * 1. **原币种未知** ⇒ 降级。不能证明它已经是选定币种, 也就不能直出 (US3-AS2)。
 * 2. **原币种 = 选定币种** ⇒ **原值直出, 不进折算路径** (FR-008) —— 🚫 「乘以 1」:
 *    乘法会按 Decimal 有效位重新定标, 屏上多出一个与今天不同的数字, 而它看起来完全正常。
 * 3. **需要折算** ⇒ 汇率可用则金额类乘汇率; 不可用则降级。
 *
 * **价格类 (现价 / 成本价 / 行权价) 一律不折** (FR-003): 它们不在本函数触碰的字段里, 随 `...row`
 * 原样透传 —— 这是「不折」的实现方式, 不是遗漏。
 *
 * 复杂度 O(n): 每行 O(1), 汇率按原币种记忆化 (至多 3 个币种 ⇒ 至多 3 次查表)。
 * 分组与排序仍 O(n log n), 在 `buildPositionGroups` 内, 不因本函数改变。
 */
export function convertRows<R extends DisplayCurrencyInputRow>(
  rows: readonly R[],
  { target, rates }: ConvertRowsOptions,
): ConvertedRow<R>[] {
  // 汇率按**原币种**记忆化: 同屏恒单一市场 ⇒ 实际只会查一次 (`list-broker-positions.usecase.ts`
  // 的 `findMany({ where: { accountId, market } })`), 但本函数不假设这一点。
  const resolved = new Map<FxCurrency, AppliedFxRate | null>();
  const rateFrom = (from: FxCurrency): AppliedFxRate | null => {
    if (!resolved.has(from)) resolved.set(from, resolveDisplayRate(rates, from, target));
    return resolved.get(from) ?? null;
  };

  return rows.map((row) => {
    const from = parseDisplayCurrency(row.currency);
    // 币种未知 ⇒ 无从证明「它已经是选定币种」, 直出路径也不许走 (US3-AS2)。
    if (from === null) return degrade(row, null);
    if (from === target) {
      return {
        ...row,
        displayCurrency: target,
        converted: false,
        degraded: false,
        originalMarketValue: null,
        originalUnrealizedPl: null,
      };
    }
    const applied = rateFrom(from);
    if (applied === null) return degrade(row, from);
    return {
      ...row,
      marketValue: row.marketValue === null ? null : row.marketValue.mul(applied.rate),
      unrealizedPl: row.unrealizedPl === null ? null : row.unrealizedPl.mul(applied.rate),
      displayCurrency: target,
      converted: true,
      degraded: false,
      originalMarketValue: null,
      originalUnrealizedPl: null,
    };
  });
}

/** 降级行: 聚合入参置 `null`, 呈现值搬到 `original*` (见 {@link DisplayCurrencyMeta})。O(1)。 */
function degrade<R extends DisplayCurrencyInputRow>(
  row: R,
  from: FxCurrency | null,
): ConvertedRow<R> {
  return {
    ...row,
    marketValue: null,
    unrealizedPl: null,
    displayCurrency: from,
    converted: false,
    degraded: true,
    originalMarketValue: row.marketValue,
    originalUnrealizedPl: row.unrealizedPl,
  };
}

/**
 * 组聚合收口: **组只要含降级行, 就把两个聚合值都置 `null` 并沉底**。
 *
 * 为什么必须显式做 (plan D2 的 ⚠️ 条): 全降级组的 `groupMarketValue` 本来就是 `null`,
 * `compareGroups` 的 null 分支已把它排到末尾; 但**混合组**的聚合值是非 null 的部分和,
 * 它会照常参与 `|groupMarketValue|` 降序 —— 排在前面, 还带着一个只算了一半的数字。
 *
 * 沉底用**稳定分区**而不是重排: 可完整折算的组保持 `buildPositionGroups` 给的顺序,
 * 不完整的组保持它们之间的原有相对顺序 (FR-012) —— 零新排序键, 也不需要既有比较器
 * (它是模块私有的, 本文件拿不到, 而重新发明一个就有了第二份排序口径)。
 *
 * 入参不被原地修改。复杂度 O(g + Σ|rows|)。
 */
export function finalizeConvertedGroups<G extends DisplayCurrencyGroup>(
  groups: readonly G[],
): FinalizedGroup<G>[] {
  const marked = groups.map((group): FinalizedGroup<G> => {
    if (!group.rows.some((row) => row.degraded)) return { ...group, aggregateComplete: true };
    return { ...group, groupMarketValue: null, groupUnrealizedPl: null, aggregateComplete: false };
  });
  // 稳定分区 —— `filter` 保序, 故两段各自的原有相对顺序原样保留 (FR-012)。
  return [
    ...marked.filter((g) => g.aggregateComplete),
    ...marked.filter((g) => !g.aggregateComplete),
  ];
}
