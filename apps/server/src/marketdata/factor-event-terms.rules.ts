import { Prisma } from '../generated/prisma/client.js';

/**
 * 复权因子「事件条款法」纯函数 —— 取代 `anchorFactorJumps` 的 vendor 序列反推口径。
 *
 * ## 为什么换掉反推
 *
 * `anchorFactorJumps` 从 vendor backward 序列反推跃变 `f = (b₁/b₀)·(n₀/n₁)`，隐含假设
 * vendor 用**乘法**复权。2026-08-01 直连理杏仁实测证伪：`bc_rights` 在两个公司行动之间是
 * **仿射**变换 `bc = K·ex − C`（00206 拟合 `K=2 / C=0.43`，93 个交易日残差 **0**；00232
 * `K=1.687 / C=0.2286`）。仿射映射**不保比值** —— `C ≠ 0` 时 `b₁/b₀` 与真实收益比无关，
 * 且 `C` 随窗内事件数累积，长窗下可超过股价本身（00232 2017-2023 整段 `bc` 为负值）。
 * prod 实证：62 行 ≥10% 分歧因子**全部**来自全史窗回填（00206 全史窗 2.0373 vs 真值 1.0444）。
 *
 * 反推口径不属于任何业内做法。业内两条公认路径都**不碰已复权序列**：
 *   ① 事件条款法 —— CRSP `FACPR`/`CFACPR`、Tushare `adj_factor`、通达信（本文件实现）
 *   ② 涨跌幅复权法 —— BaoStock（本文件作为**独立见证**用于交叉校验）
 *
 * ## 主算法（事件条款法）
 *
 *   除权价 = (前收 + 配股价×配股比率 − 每股派息) / (1 + 配股比率 + 送股比率)
 *   f      = 前收 / 除权价 = R · n₀ / (n₀ + P·q − d)
 *
 * `R = 1 + 送股比率 + 配股比率` 取自 `EquityChange.capitalization` 的**影响价格事件**前后
 * 比值（`changeReason` 白名单，见 `dimension-executor`）；`d` 取自 `CorporateAction.payload
 * .dividend`；`P`/`q` 取自 `AllotmentEvent.allotmentPrice/Ratio`。三者币种须与标的交易币种
 * 一致，否则调用方传 null（本函数不做汇率换算 —— 换算属数据层职责且需汇率源）。
 *
 * ## 交叉校验（L2 gate）
 *
 *   f' = (1 + 官方涨跌幅/100) · n₀/n₁      （官方涨跌幅是复权不变量）
 *
 * 两法独立（一条走事件条款、一条走交易所官方收益），PoC 实测 180 个事件 81.7% 吻合 <0.1%、
 * 88.4% <1%。分歧 ≥ `DISAGREE_TOLERANCE` → **不落猜测值**，落 `factorJump = 1` +
 * `needs_review`（读时等价于「无此事件」，与既有 `jumpOrOne` 兜底行为一致，不引入新失真），
 * 由质量闸暴露给运维。
 *
 * 复杂度：逐事件 O(1)，纯算术无排序/无 IO。
 */

/** 单个除权事件的条款输入。金融数值一律 Decimal（禁 Float，FR-S08）；不可得一律 null。 */
export interface FactorEventTerms {
  /** YYYY-MM-DD 除权日（版本边界）。 */
  exDate: string;
  /** n₀ = 除权日前一交易日 none 收盘。 */
  prevClose: Prisma.Decimal;
  /** n₁ = 除权日 none 收盘。 */
  exClose: Prisma.Decimal;
  /** 官方涨跌幅（百分数，如 -2.15）。缺失 → null（全库约 45% 的因子无此字段）。 */
  officialChangePct: Prisma.Decimal | null;
  /** d = 每股现金派息（标的交易币种）。币种不匹配 / 无分红 → null。 */
  cashDividend: Prisma.Decimal | null;
  /** R = 股本比值（影响价格事件前后 capitalization 之比）。无股本事件 → null（按 1 处理）。 */
  shareRatio: Prisma.Decimal | null;
  /** q = 配股比率。无配股 → null。 */
  allotmentRatio: Prisma.Decimal | null;
  /** P = 配股价（标的交易币种）。币种不匹配 / 无配股 → null。 */
  allotmentPrice: Prisma.Decimal | null;
}

/** 因子来源：条款法 / 官方涨跌幅法 / 未解出（落 1）。 */
export type FactorSource = 'event_terms' | 'official_change' | 'unresolved';

/**
 * 因子质量态：
 * - `verified`     两法均可算且一致 —— 最高置信
 * - `unverified`   只有一条路径可算（另一条输入缺失）—— 落值但无交叉证
 * - `needs_review` 两法分歧，或两法都算不出 —— **落 1**（读时等价无事件），等人工/补数据
 */
export type FactorStatus = 'verified' | 'unverified' | 'needs_review';

export interface FactorDecision {
  exDate: string;
  /** 落库的跃变值。`needs_review` 时恒为 1（不落猜测值）。 */
  factorJump: Prisma.Decimal;
  source: FactorSource;
  status: FactorStatus;
  /** 人可读的判定依据（进日志 / 质量闸，供运维定位）。 */
  reason: string;
}

const ZERO = new Prisma.Decimal(0);
const ONE = new Prisma.Decimal(1);
const HUNDRED = new Prisma.Decimal(100);

/**
 * 两法分歧容忍度（相对误差）。
 *
 * 定在 5% 而非更严：官方涨跌幅列是 `Decimal(10,4)` 但 vendor 实际只给 2 位有效小数，
 * 低价股（港股大量 0.0x ~ 0.2x）上量化噪声即可达 1-2%，卡太严会把噪声当缺陷。
 * PoC 实测分布：<0.1% 占 81.7%、1-5% 占 7.2%、**≥5% 仅 4.4%** —— 5% 既能抓住
 * 已知的 95%/78%/48% 量级真错，又不会把量化噪声刷成告警洪水。
 */
export const DISAGREE_TOLERANCE = new Prisma.Decimal('0.05');

/** 有限且 > 0 才是合法价格/因子；否则视为不可用（不 throw，交由调用方降级）。 */
function positive(v: Prisma.Decimal | null | undefined): v is Prisma.Decimal {
  return v !== null && v !== undefined && v.isFinite() && v.greaterThan(ZERO);
}

/** 非负有限数（派息 / 配股价 / 配股比率允许为 0，不允许为负）。 */
function nonNegative(v: Prisma.Decimal | null | undefined): Prisma.Decimal {
  return v !== null && v !== undefined && v.isFinite() && v.greaterThanOrEqualTo(ZERO) ? v : ZERO;
}

/**
 * 事件条款法：`f = R · n₀ / (n₀ + P·q − d)`。
 *
 * 分母 = 理论除权价 × 份额基数。分母 ≤ 0 表示条款自相矛盾（如派息超过股价）→ 返 null 而非
 * 算出负因子/无穷大 —— 负复权因子物理上不可能，宁可判不可解也不落坏值。
 */
export function factorFromEventTerms(t: FactorEventTerms): Prisma.Decimal | null {
  if (!positive(t.prevClose)) return null;
  const r = positive(t.shareRatio) ? t.shareRatio : ONE;
  const q = nonNegative(t.allotmentRatio);
  const p = nonNegative(t.allotmentPrice);
  const d = nonNegative(t.cashDividend);

  const denom = t.prevClose.plus(p.mul(q)).minus(d);
  if (!denom.isFinite() || denom.lessThanOrEqualTo(ZERO)) return null;

  const f = r.mul(t.prevClose).div(denom);
  return positive(f) ? f : null;
}

/**
 * 涨跌幅复权法（独立见证）：`f' = (1 + chg/100) · n₀/n₁`。
 *
 * 依据：官方涨跌幅是复权不变量（已含除权除息调整）⇒ `backward(ex)/backward(ex-1) = 1+chg`，
 * 而 `backward = none · B` ⇒ `f' = (1+chg)·n₀/n₁`。与条款法零共用输入。
 */
export function factorFromOfficialChange(t: FactorEventTerms): Prisma.Decimal | null {
  if (t.officialChangePct === null || !t.officialChangePct.isFinite()) return null;
  if (!positive(t.prevClose) || !positive(t.exClose)) return null;
  const f = ONE.plus(t.officialChangePct.div(HUNDRED)).mul(t.prevClose).div(t.exClose);
  return positive(f) ? f : null;
}

/** 相对误差 |a−b|/b。b 必须为正（调用点已保证）。 */
function relativeError(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.minus(b).abs().div(b);
}

/**
 * 2-of-2 判定：主算法 = 事件条款法，见证 = 涨跌幅复权法。
 *
 * | 条款法 | 见证法 | 判定 |
 * |---|---|---|
 * | ✓ | ✓ 一致 | `verified`，落条款法值 |
 * | ✓ | ✓ 分歧 | `needs_review`，**落 1** |
 * | ✓ | ✗ | `unverified`，落条款法值 |
 * | ✗ | ✓ | `unverified`，落见证法值（条款不全时的次优，好过整段不复权） |
 * | ✗ | ✗ | `needs_review`，落 1 |
 *
 * 分歧时落 1 而非落任一方：两法冲突时无法判断谁错（实测两种方向都出现过 —— 实物分派让
 * 条款法失真、vendor 官方涨跌幅本身也会错），而**错的大因子比没有因子危害更大**（它按乘法
 * 污染除权日之前的整段历史）。落 1 = 读时等价「无此事件」，失真有界且与既有兜底一致。
 */
export function decideFactor(t: FactorEventTerms): FactorDecision {
  const terms = factorFromEventTerms(t);
  const witness = factorFromOfficialChange(t);

  if (terms !== null && witness !== null) {
    const err = relativeError(terms, witness);
    if (err.lessThanOrEqualTo(DISAGREE_TOLERANCE)) {
      return {
        exDate: t.exDate,
        factorJump: terms,
        source: 'event_terms',
        status: 'verified',
        reason: `terms=${terms.toFixed(8)} witness=${witness.toFixed(8)} relErr=${err.toFixed(4)}`,
      };
    }
    return {
      exDate: t.exDate,
      factorJump: ONE,
      source: 'unresolved',
      status: 'needs_review',
      reason: `两法分歧: terms=${terms.toFixed(8)} witness=${witness.toFixed(8)} relErr=${err.toFixed(4)} > ${DISAGREE_TOLERANCE.toFixed(2)}`,
    };
  }

  if (terms !== null) {
    return {
      exDate: t.exDate,
      factorJump: terms,
      source: 'event_terms',
      status: 'unverified',
      reason: `无官方涨跌幅可交叉校验: terms=${terms.toFixed(8)}`,
    };
  }

  if (witness !== null) {
    return {
      exDate: t.exDate,
      factorJump: witness,
      source: 'official_change',
      status: 'unverified',
      reason: `事件条款不全 (缺派息/股本/配股条款): witness=${witness.toFixed(8)}`,
    };
  }

  return {
    exDate: t.exDate,
    factorJump: ONE,
    source: 'unresolved',
    status: 'needs_review',
    reason: '两法均不可解 (条款不全且无官方涨跌幅)',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 四表原始行 → FactorEventTerms（组装层，仍是纯函数：调用方查库后传数组进来）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 影响**每股权益比例**的股本变动原因白名单（`EquityChange.changeReason` **精确**匹配）。
 *
 * 只收「无歧义的股本倍数事件」——送红股与拆细/合股。刻意**排除**三类会重复计入的：
 *  - `供股`：份额项由 `AllotmentEvent` 的 `q` 提供（分母还要 `P·q`），走 R 会双算；
 *  - `以股代息` / `以股代息發行紅股`：价格效应就是那笔股息本身（已在 `d` 里），走 R 会双算；
 *  - `配售/認購`、`行使購股權`、`注銷購回股份`、`發行股份` 等：按市价增发/回购/行权，
 *    不改变每股权益比例，本就不该进复权。
 *
 * **精确匹配**而非子串：prod 存在大量复合原因（`行使股份期權，發行股份` / `以股代息發行紅股`
 * / `股份獎勵或期權，購回股份` …），子串匹配会把它们误收。复合原因一律不给 R —— 此时条款法
 * 与见证法会分歧 → 落 `needs_review`，**宁可判不可解也不落双算值**（2-of-2 闸是这条保守策略
 * 成立的前提：白名单漏收只会变成待审，不会变成坏数据）。
 */
const PRICE_AFFECTING_CHANGE_REASONS: ReadonlySet<string> = new Set([
  '分红送股',
  '發行紅股',
  '紅股發行',
  '股份拆細',
  '并股',
  '併股',
  '合併股份',
  '合并股份',
  '股份合並',
  '股份合併',
]);

/** 股本变动登记可能晚于除权日若干天 → 除权日当天起向后找的窗口上限。 */
const SHARE_RATIO_MATCH_DAYS = 30;

/** none 日线最小投影（tradeDate 升序，close/changePct 已转 Decimal）。 */
export interface FactorNoneBar {
  tradeDate: string;
  close: Prisma.Decimal;
  changePct: Prisma.Decimal | null;
}

/** 除权事件（`CorporateAction` 行投影；现金派息 / 送转股比 / 币种取自 vendor payload）。 */
export interface FactorCorporateAction {
  exDate: string;
  /** 每股现金派息（vendor 原币）。缺失 → null。 */
  dividend: Prisma.Decimal | null;
  /**
   * 每股送转股比 s（`bonusSharesFromProfit + bonusSharesFromCapitalReserve` 之和）。
   *
   * 🚨 **这是 A 股送转股的唯一来源**：`EquityChange` 维度 `market_scope = {hk}`，cn 一行没有
   * （prod 实测 equity_change 285,873 行全为 hk）。漏掉本字段 = 全部 A 股送转事件的份额项
   * 恒为 1，因子只剩现金分红那一半。港股 payload 不下发这两个字段 → null，走 `EquityChange` 路径。
   */
  bonusShares: Prisma.Decimal | null;
  /** 派息计价币种（vendor 原值）。 */
  currency: string | null;
}

/** 股本变动行（`EquityChange` 投影，date 升序）。 */
export interface FactorEquityChange {
  date: string;
  capitalization: Prisma.Decimal | null;
  changeReason: string | null;
}

/** 配股行（`AllotmentEvent` 投影；按**除权日**关联，非公告日）。 */
export interface FactorAllotment {
  exDate: string | null;
  allotmentRatio: Prisma.Decimal | null;
  allotmentPrice: Prisma.Decimal | null;
  currency: string | null;
}

export interface FactorSourceRows {
  /** 标的交易币种（`Instrument.currency`）—— 条款币种与之不符则该条款不可用。 */
  currency: string;
  noneBars: FactorNoneBar[];
  corporateActions: FactorCorporateAction[];
  equityChanges: FactorEquityChange[];
  allotments: FactorAllotment[];
}

/** YYYY-MM-DD 加 n 天（UTC；字典序即时序，可直接比较）。 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 四表原始行 → 逐事件条款。
 *
 * 事件集 = 除权事件 ∪ 配股除权日 ∪ 影响价格的股本变动日（三源取并集，任一源单独出现都算
 * 一次除权，不要求 `corporate_action` 必须有对应行 —— 港股股本事件本就大量不落 corp action）。
 * 除权日在 none 序列里无 bar（未来日 / 停牌）或无前一交易日 → 跳过（无法定基准，非错误）。
 *
 * 币种守卫：`d` / `P` 的计价币种与标的交易币种不一致时置 null（不做汇率换算 —— 换算需汇率源
 * 且引入新误差源）。prod 实测配股 545 行里 HKD 542 / USD 2 / CNY 1，派息侧非本币也是少数。
 * 置 null 后条款法多半与见证法分歧 → `needs_review`，比按错币种算出错值好。
 *
 * 复杂度 O(n + m log m)（n = bar 数，m = 事件数；bar 建索引线性，事件排序主导）。
 */
export function buildFactorEventTerms(rows: FactorSourceRows): FactorEventTerms[] {
  const barByDate = new Map(rows.noneBars.map((b) => [b.tradeDate, b]));
  const barDates = [...barByDate.keys()].sort();
  const idxByDate = new Map(barDates.map((d, i) => [d, i]));

  const caByEx = new Map(rows.corporateActions.map((c) => [c.exDate, c]));
  const allotByEx = new Map(
    rows.allotments.filter((a) => a.exDate !== null).map((a) => [a.exDate as string, a]),
  );
  const caps = [...rows.equityChanges]
    .filter((e) => e.capitalization !== null && e.capitalization.isFinite())
    .sort((a, b) => a.date.localeCompare(b.date));
  const priceAffecting = caps.filter((e) =>
    PRICE_AFFECTING_CHANGE_REASONS.has((e.changeReason ?? '').trim()),
  );

  const exDates = [
    ...new Set([...caByEx.keys(), ...allotByEx.keys(), ...priceAffecting.map((e) => e.date)]),
  ].sort();

  const out: FactorEventTerms[] = [];
  for (const exDate of exDates) {
    const i = idxByDate.get(exDate);
    if (i === undefined || i === 0) continue; // 无 bar / 无前一交易日 → 无基准。
    const cur = barByDate.get(exDate)!;
    const prev = barByDate.get(barDates[i - 1])!;

    const ca = caByEx.get(exDate);
    const cashDividend = ca && ca.currency === rows.currency ? ca.dividend : null;

    const al = allotByEx.get(exDate);
    const allotUsable = al !== undefined && al.currency === rows.currency;
    const allotmentRatio = allotUsable ? al.allotmentRatio : null;
    const allotmentPrice = allotUsable ? al.allotmentPrice : null;

    // 份额项 M = 1 + 送股比率 s + 配股比率 q（标准除权价公式的分母份额项）。
    // 优先用**条款自身**给出的 s/q（cn 走 payload 的 bonusShares，配股走 allotment 端点）；
    // 二者皆无时才回退到 `EquityChange` 的股本比值 R —— R 是「事后观测到的股本变化」，
    // 精度低于条款且可能混入同日的增发/行权，只当港股送股/拆合股的兜底来源。
    // 🚨 三者不可叠加：s/q 与 R 描述的是同一份额扩张，同时用会双算。
    const bonus =
      ca && ca.bonusShares !== null && ca.bonusShares.isFinite() ? ca.bonusShares : null;
    let shareRatio: Prisma.Decimal | null = null;
    if (bonus !== null || (allotmentRatio !== null && allotmentRatio.isFinite())) {
      shareRatio = ONE.plus(bonus ?? ZERO).plus(
        allotmentRatio !== null && allotmentRatio.isFinite() ? allotmentRatio : ZERO,
      );
    } else {
      const before = caps.filter((e) => e.date < exDate).at(-1);
      const hit = priceAffecting.find(
        (e) => e.date >= exDate && e.date <= addDays(exDate, SHARE_RATIO_MATCH_DAYS),
      );
      if (before && hit && before.capitalization!.greaterThan(ZERO)) {
        shareRatio = hit.capitalization!.div(before.capitalization!);
      }
    }

    out.push({
      exDate,
      prevClose: prev.close,
      exClose: cur.close,
      officialChangePct: cur.changePct,
      cashDividend,
      shareRatio,
      allotmentRatio,
      allotmentPrice,
    });
  }
  return out;
}
