import { Prisma } from '../generated/prisma/client.js';
import { intrinsicValue, type OptionSide } from './option-snapshot-guard.rules.js';
import { daysToExpiry } from './trading-day-gate.js';

/**
 * 期权快照**异常监控三条**纯函数 (047 T024, FR-047 / FR-048 / FR-049, plan D-ARCH-3)。
 * 无 I/O、无 DI (ADR-0043 §4)；落 WARN 的动作归调用方，本文件只判。
 *
 *   ① **greeks 缺失只在虚值区抬**（FR-047）
 *   ② **IV 离群判定结合 DTE**（FR-048）
 *   ③ **新的非标 root → 复核名单**（FR-049）
 *
 * ## 🚨 ① 实值区 greeks 缺失是**数学固有现象**，MUST NOT 告警、MUST NOT 计入指标
 *
 * 实值腿 bid 跌破内在价值 ⇒ IV 无解 ⇒ 五个 greeks 与 IV **一起**没有（实测 227/2150 行，
 * 其中 99.5% 是深实值腿，**虚值区零缺失**）。给固有现象设告警必然长期噪音，噪音久了整条
 * 告警线就没人看了 —— 这比不设更糟。⇒ 判定对象**只有虚值区**（含平值），实值区连指标都不进
 * （进了指标就会有人拿「缺失率 10%」去定阈值，等于把固有现象重新变成信号）。
 *
 * ## 🚨 ① 的判据是**值**，不是 vendor 的 `greeks_complete` 标记
 *
 * 2026-08-07 真 vendor 实测 `US.PEP260807C75000`：`greeks_complete === true` 而五个数**全为 0**。
 * ⇒ 完整性标记**不蕴含**值可用。本函数的入参**蓄意不收** `greeksComplete` —— 拿标记当「值可用」
 * 的证明在类型层面就不可能，与 `option-snapshot-guard.rules.ts`「硬门只认这几个字段」同纪律。
 *
 * ## 🚨 ① 对**时段**鲁棒：整批零可用 greeks 出一条批级 WARN，不逐腿刷屏
 *
 * 同日实测：**美股休市时段取到的快照 greeks / IV 会大面积为 0**。若逐腿判，休市时段跑一次就是
 * 满屏假 WARN。⇒ 判据分两层：
 *   · 批内**还有**可用 greeks ⇒ 某腿缺失是**这条腿**的异常 → `otm_greeks_unavailable`
 *   · 批内**一条都没有** ⇒ 不是逐腿异常，是**全域降级**（休市快照 / vendor 整体退化）
 *     → `greeks_batch_unavailable` 单条
 * 两条都是 WARN（**全域降级也绝不静默** —— 沉默 ≠ 健康），区别只在「一条」还是「N 条」。
 * 🚨 门槛取「零」而不是某个百分比：只要还有一条腿拿到 greeks，vendor 当时就在正常下发，
 * 那条缺失就是真异常。拍百分比会在阈值两侧各制造一类误判，且数字无从证伪。
 *
 * ## 🚨 ② IV 离群必须结合 DTE
 *
 * 实测 3/2150 的 >500% IV **全部**是 DTE=1 的宽价差 —— 极短 DTE 下时间价值趋零，报价的一个
 * 最小跳动反解出来就是几百个点的 IV，属预期而非脏数据。一刀切阈值等于每个到期日前一天固定
 * 假红一次。DTE 走 {@link daysToExpiry}（基准 = **本批所属交易所的今天**，由
 * {@link OptionAnomalyInput.exchange} 显式声明），🚫 MUST NOT 在此另写一份日期基准：北京上午
 * = ET 前一日，取错基准 DTE 恒偏 1 天，边界腿静默进出豁免线且永远不会红。
 *
 * ## ③ 新的非标 root = 某白名单票发生了并购类公司行为
 *
 * 已见过的 root 由调用方持久化后回传（{@link OptionAnomalyInput.knownNonStandardRoots}）——
 * 本文件无状态，「次日不重复报」靠调用方把 {@link OptionAnomalyReport.newNonStandardRoots}
 * 并回名单。把名单塞进模块级变量会在多进程 / 重启后失效，且不可测。
 */

/** Decimal 可接受形态: string (vendor payload) 或 Prisma.Decimal (PG row)，同硬门口径。 */
type Decimalish = string | Prisma.Decimal;

const D = (v: Decimalish): Prisma.Decimal => new Prisma.Decimal(v);

const ZERO = new Prisma.Decimal(0);

// ─────────────────────────────────────────────────────────────────────────────
// 阈值常量（改口径改这里，判定函数内 MUST NOT 出现字面量）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * IV 离群阈值，**单位 = vendor 原样的百分数**（`option_implied_volatility` 直存，21.4 = 21.4%）。
 *
 * 取 500 是实测分界：2150 行里超过它的只有 3 行、且全是 DTE=1 的宽价差。**边界闭**（`>` 才算
 * 离群）—— 恰好等于阈值不算，与硬门的边界纪律一致。
 */
export const IV_OUTLIER_PERCENT = new Prisma.Decimal(500);

/**
 * IV 离群的**短 DTE 豁免线**（日历日，闭区间：`DTE ≤ 此值` 一律豁免）。
 *
 * 取 2 而非 1：到期周（周五到期）里周三采的快照 DTE=2 已进入同一形态，且 `daysToExpiry` 数的是
 * **日历日**（含周末）⇒ 周五采、下周一到期的腿 DTE=3 但只隔一个交易日。取 2 是「实测的 1」加
 * 一格余量，方向偏宽 —— 误豁免只是少一条 WARN，误报则是每个到期日固定假红。
 *
 * ⚠️ **上面这段论证的标定样本全是美股**（2150 行里 3 行 >500% IV、全为 DTE=1），且「周五到期」
 * 这个前提**对港股不成立** —— 库内两张真港股合约 `HK.TCH260929P*`（2026-09-29 周二）/
 * `HK.TCH261230P720000`（2026-12-30 周三）都不在周五。⇒ 本常量对港股是**沿用**，不是标定：
 * 「极短 DTE 下时间价值趋零 ⇒ 一个最小跳动反解出巨大 IV」这个**机制**与星期几无关，方向上仍
 * 成立；但「取 2 恰好够」这一格在港股没有对应实测。#263 只把 DTE 的**基准**参数化，🚫 没有
 * 也不该顺手改这个阈值（没有港股样本之前改它，改的是一个没人验过的数）。
 */
export const SHORT_DTE_EXEMPT_DAYS = 2;

/** 每条 finding 最多列几个样本（`affected` 仍是全量计数）。 */
const MAX_SAMPLE_ITEMS = 20;

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type OptionAnomalyCode =
  | 'otm_greeks_unavailable'
  | 'greeks_batch_unavailable'
  | 'iv_outlier'
  | 'new_nonstandard_root';

export interface OptionAnomalyFinding {
  code: OptionAnomalyCode;
  /** 人可读依据，含涉事计数与口径 —— 运维不必回查原始 payload。 */
  reason: string;
  /** 命中的**全量**条数（root 类按 root 计，其余按行计）。 */
  affected: number;
  /** 样本（合约 code 或 root），截到 {@link MAX_SAMPLE_ITEMS}；输入序稳定。 */
  samples: readonly string[];
}

/**
 * 监控指标。🚨 **实值区的 greeks 缺失不在这里的任何一个数里** —— 见文件头 ①。
 * `greeksUnclassified` 是显式的「不可算」态（缺 spot、或非标合约 ⇒ 判不出实值/虚值），
 * MUST NOT 并进另两个数。
 */
export interface OptionAnomalyMetrics {
  /** 本批行数（上下文，不参与判定）。 */
  rows: number;
  /** greeks 判定对象数 = **虚值区**（含平值）且可分类的行数。 */
  greeksSubjects: number;
  /** 其中 greeks 不可用的行数。 */
  greeksUnavailable: number;
  /** 判不出实值/虚值的行数：缺 `underlyingSpot`，或**非标合约**（#186）。 */
  greeksUnclassified: number;
  /** 参与 IV 离群判定的行数（IV 缺失或 ≤ 0 的行不算）。 */
  ivEvaluated: number;
  ivOutliers: number;
  /** 超阈但因短 DTE 豁免的行数 —— **豁免必须留数**，否则事后与「没发生过」无法区分。 */
  ivShortDteExempt: number;
}

/**
 * 判定所需的行字段。**只收这些** —— 尤其**不收** `greeksComplete`（见文件头 ①）。
 */
export interface OptionAnomalyRow {
  contractCode: string;
  optionSide: OptionSide;
  root: string;
  /** 库内 `option_contract.is_standard`。判 ③「新非标 root」；且非标 ⇒ 实值/虚值判不出（#186）。 */
  isStandard: boolean;
  /** `YYYY-MM-DD` 或 `@db.Date` 读出的 UTC 午夜 `Date`；带时间的绝对时刻会被 `daysToExpiry` 拒。 */
  expiryDate: Date | string;
  strikePrice: Decimalish;
  /** 缺失 ⇒ 判不出实值/虚值，该行退出 ① 的判定面（不当成异常）。 */
  underlyingSpot: Decimalish | null;
  iv: Decimalish | null;
  delta: Decimalish | null;
  gamma: Decimalish | null;
  vega: Decimalish | null;
  theta: Decimalish | null;
}

export interface OptionAnomalyInput {
  rows: readonly OptionAnomalyRow[];
  /** **请求时刻**（绝对时刻）。DTE 基准由 {@link daysToExpiry} 折成 {@link exchange} 的今天。 */
  now: Date;
  /**
   * 本批合约所属**交易所**（`us` / `hk` / …）。批级而非逐行：一轮采集的工作集恒为单市场
   * （`sync-option-snapshot.usecase.ts` 的 `marketScope` 守卫 fail-closed 抛），逐行带
   * market 只会造出「同一批里两个基准」这个本来不存在的状态。
   */
  exchange: string;
  /** 已见过的非标 root（调用方持久化）。 */
  knownNonStandardRoots: readonly string[];
}

export interface OptionAnomalyReport {
  /** 全部为 WARN 级；空数组 = 本批无异常。 */
  findings: readonly OptionAnomalyFinding[];
  /** 本批新见的非标 root（字典序）。**调用方 MUST 并回名单**，否则次日重复报。 */
  newNonStandardRoots: readonly string[];
  metrics: OptionAnomalyMetrics;
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * greeks 是否**可用**。🚨 值判据，不看 vendor 的完整性标记（见文件头 ①）。
 *
 * 两种不可用：① 任一字段缺失 ② vendor 的**零占位块**（IV ≤ 0 或五个 greeks 全为 0）——
 * IV 为 0 对活着的期权在数学上不成立，深虚腿的 Δ 可以近 0 但 gamma/vega 不会同时精确为 0。
 * O(1)。
 */
function greeksUsable(row: OptionAnomalyRow): boolean {
  const { iv, delta, gamma, vega, theta } = row;
  if (iv === null || delta === null || gamma === null || vega === null || theta === null) {
    return false;
  }
  if (!D(iv).greaterThan(ZERO)) return false;
  return !(D(delta).isZero() && D(gamma).isZero() && D(vega).isZero() && D(theta).isZero());
}

/**
 * 实值 / 虚值（含平值）/ 不可分类。**与落库硬门共用 `intrinsicValue`** —— 两处各写一份
 * `K > S` 必 drift，而 drift 的形态恰好是「告警面与入库面对同一条腿的判断不一致」。O(1)。
 *
 * 🚨 **非标（调整后）合约判不出**（#186）：交割物不是 100 股标的 ⇒ K 与 S 的大小关系不决定
 * 实值/虚值。这与落库硬门在非标合约上跳过门 ④ 是**同一条依据** —— 只改一面，drift 的形态
 * 就正好是上一段警告的那件事：入库面说「这条腿的内在价值算不出」而告警面说「它是虚值」。
 * ⇒ 归入「不可分类」这个**显式态**（计 `greeksUnclassified`），MUST NOT 塞进任一侧：塞进
 * 虚值区就会给那批腿的固有 greeks 缺失刷 WARN，正是 FR-047 要防的那种长期噪音。
 */
function moneynessOf(row: OptionAnomalyRow): 'itm' | 'otm' | null {
  if (!row.isStandard) return null;
  if (row.underlyingSpot === null) return null;
  const intrinsic = intrinsicValue(row.optionSide, D(row.strikePrice), D(row.underlyingSpot));
  return intrinsic.greaterThan(ZERO) ? 'itm' : 'otm';
}

/**
 * 三条异常监控一次扫完。**永不抛异常**（`expiryDate` 形态非法除外 —— 那是调用方喂错了基准，
 * 见 {@link daysToExpiry}，静默吞掉等于让 DTE 悄悄错一天）。
 *
 * 复杂度 **O(n)**：单趟遍历，每行常数次 Decimal 比较 + 一次 `daysToExpiry`；末尾一次排序
 * 只作用在新 root 集合（基数 ≪ n）。n = 本批快照行数。
 */
export function detectOptionAnomalies(input: OptionAnomalyInput): OptionAnomalyReport {
  const otmMissingCodes: string[] = [];
  let greeksSubjects = 0;
  let greeksUnclassified = 0;
  let usableAnywhere = 0;

  const ivOutlierCodes: string[] = [];
  let ivEvaluated = 0;
  let ivShortDteExempt = 0;

  const knownRoots = new Set(input.knownNonStandardRoots);
  const freshRoots = new Set<string>();

  for (const row of input.rows) {
    // ① greeks
    const usable = greeksUsable(row);
    if (usable) usableAnywhere++;
    const moneyness = moneynessOf(row);
    if (moneyness === null) {
      greeksUnclassified++;
    } else if (moneyness === 'otm') {
      greeksSubjects++;
      if (!usable) otmMissingCodes.push(row.contractCode);
    }
    // moneyness === 'itm' ⇒ 既不计对象也不计缺失（数学固有现象，见文件头 ①）

    // ② IV 离群（只判拿得到的 IV：缺失 / 零占位不是离群）
    if (row.iv !== null && D(row.iv).greaterThan(ZERO)) {
      ivEvaluated++;
      if (D(row.iv).greaterThan(IV_OUTLIER_PERCENT)) {
        const dte = daysToExpiry({
          expiry: row.expiryDate,
          now: input.now,
          exchange: input.exchange,
        });
        if (dte <= SHORT_DTE_EXEMPT_DAYS) ivShortDteExempt++;
        else ivOutlierCodes.push(row.contractCode);
      }
    }

    // ③ 新的非标 root
    if (!row.isStandard && !knownRoots.has(row.root)) freshRoots.add(row.root);
  }

  const findings: OptionAnomalyFinding[] = [];

  // 全域降级与逐腿异常**互斥**：批内一条可用 greeks 都没有 ⇒ 不是这几条腿的问题。
  if (greeksSubjects > 0 && otmMissingCodes.length === greeksSubjects && usableAnywhere === 0) {
    findings.push({
      code: 'greeks_batch_unavailable',
      reason:
        `整批零可用 greeks（虚值区 ${greeksSubjects} 行全缺，且全批无任一行拿到 greeks）：` +
        `疑似休市时段快照或 vendor 全域降级，本轮逐腿判定不成立`,
      affected: greeksSubjects,
      samples: otmMissingCodes.slice(0, MAX_SAMPLE_ITEMS),
    });
  } else if (otmMissingCodes.length > 0) {
    findings.push({
      code: 'otm_greeks_unavailable',
      reason:
        `虚值区 greeks 缺失 ${otmMissingCodes.length}/${greeksSubjects} 行` +
        `（实值区缺失是数学固有现象，已排除在判定面外）`,
      affected: otmMissingCodes.length,
      samples: otmMissingCodes.slice(0, MAX_SAMPLE_ITEMS),
    });
  }

  if (ivOutlierCodes.length > 0) {
    findings.push({
      code: 'iv_outlier',
      reason:
        `IV 超过 ${IV_OUTLIER_PERCENT.toString()}% 的行 ${ivOutlierCodes.length} 条` +
        `（DTE ≤ ${SHORT_DTE_EXEMPT_DAYS} 的 ${ivShortDteExempt} 条已按短 DTE 豁免）`,
      affected: ivOutlierCodes.length,
      samples: ivOutlierCodes.slice(0, MAX_SAMPLE_ITEMS),
    });
  }

  const newNonStandardRoots = [...freshRoots].sort();
  if (newNonStandardRoots.length > 0) {
    findings.push({
      code: 'new_nonstandard_root',
      reason:
        `出现未见过的非标 root ${newNonStandardRoots.length} 个：` +
        `通常意味着某白名单票发生了并购类公司行为，需人工复核`,
      affected: newNonStandardRoots.length,
      samples: newNonStandardRoots.slice(0, MAX_SAMPLE_ITEMS),
    });
  }

  return {
    findings,
    newNonStandardRoots,
    metrics: {
      rows: input.rows.length,
      greeksSubjects,
      greeksUnavailable: otmMissingCodes.length,
      greeksUnclassified,
      ivEvaluated,
      ivOutliers: ivOutlierCodes.length,
      ivShortDteExempt,
    },
  };
}
