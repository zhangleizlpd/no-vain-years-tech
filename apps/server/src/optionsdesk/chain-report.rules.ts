import { Prisma } from '../generated/prisma/client';
import {
  recallCandidates,
  type RecallContext,
  type RecallLegInput,
  type RetrievalOverride,
} from './leg-recall.rules';
import type { LegTab } from './leg-tab.rules';

/**
 * 055 标的链分析报表的聚合纯函数 (ADR-0043 §4: rules 文件持无副作用业务规则)。无 I/O、无 DI。
 *
 * 报表把整条链聚成「价外幅度档 × 到期日」的网格。本文件只管**骨架**那一层 —— 行轴怎么切、
 * 列轴取什么、总体是谁; 格值聚合 / 三互斥计数 / ATM IV 插值分别归后续 task。
 *
 * 🚨 **色阶档界不住这里** (plan D-BAND-1): 它把一个数映射到一个颜色, **不参与任何腿的判定**
 * ⇒ 与 `leg-tier.rules.ts` 的 `tier` (判定量) 不同类, 住 client。服务端只下发裸值。
 */

/** 报表的行轴 —— 一个价外幅度档。量纲 = 小数比例 (`0.10` = 10%), 同 `leg-tier.rules.ts`。 */
export interface ChainReportRow {
  /** 屏上自上而下的行序, `0` = 价内那一档。 */
  readonly index: number;
  /** 价外幅度下界, **闭**。负值 = 价内。 */
  readonly otmFloor: Prisma.Decimal;
  /** 价外幅度上界, **开**; `null` = 顶档无上界。 */
  readonly otmCeiling: Prisma.Decimal | null;
  /** 对应行权价下界, **开**; `null` = 顶档无下界。随现价变 (spec Key Entities「行」)。 */
  readonly strikeFloor: Prisma.Decimal | null;
  /** 对应行权价上界, **闭**。 */
  readonly strikeCeiling: Prisma.Decimal;
}

// ─────────────────────────────────────────────────────────────────────────────
// 行轴 (FR-002) —— 两个常量决定整根轴, 🚫 别处 MUST NOT 再写第二份档界
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 档宽 (FR-002: 等距切分, 🚫 MUST NOT 按分位)。
 *
 * 🚨 **等距而非分位是判据不是口味**: 价外幅度已是相对量 (已除以现价) ⇒ 等距才能跨标的比较;
 * 分位切分会让每条链的行不同, 连着扫几条链时同一行含义就变了。
 */
export const OTM_BAND_WIDTH = new Prisma.Decimal('0.10');

/**
 * 行数 (mockup `ROW_LABELS` 定案): 价内一档 + 价外七档。
 *
 * 🚨 **两端 MUST 非对称, 别读成「对称的八等分」**:
 * · **下界封口** —— 首档下界 = 价内一个档宽, 更深的价内腿**落在行轴之外**且单独计数
 *   (FR-034 ②「被行下界排除」, 实测占骨架 57.6%)。
 * · **顶档开口** —— 末档吸收其上的全部腿 (`>60%`), 🚫 MUST NOT 让极深价外腿掉出网格:
 *   掉出去的腿既不在图上、又不在三个互斥计数的任何一个里, 求和恒等式 (SC-006) 会静默对不上账。
 */
export const OTM_BAND_COUNT = 8;

/** 顶档行序 —— 开口档, 见 {@link OTM_BAND_COUNT}。 */
export const OTM_BAND_TOP_INDEX = OTM_BAND_COUNT - 1;

/** 价内那一档的行序。「口径不适用」(FR-019c) 的**语义**判据认它的 `otmFloor < 0`, 🚫 不认下标。 */
export const OTM_BAND_ITM_INDEX = 0;

const ONE = new Prisma.Decimal(1);

/**
 * 整根行轴 (FR-002 + spec Key Entities「行」)。`O(档数)` = `O(1)`。
 *
 * 每档同时给**价外幅度区间**与**对应行权价区间** —— 后者是十字线读数面板 (FR-027) 要的,
 * 也是客户端「口径不适用」语义判据 (plan D-SCALE-1) 的输入。两者互为映射:
 * `K = spot × (1 − 价外幅度)` ⇒ 幅度的下界闭对应行权价的**上界闭**, 两端反向。
 *
 * @param spot vendor 随链下发的标的价, **未复权** (沿 047 纪律)。MUST 为正 —— 快照缺标的价时
 *   检索 port 返 `null` (链未就绪), 走不到这里。
 */
export function chainReportRows(spot: Prisma.Decimal): readonly ChainReportRow[] {
  return Array.from({ length: OTM_BAND_COUNT }, (_unused, index) => {
    const otmFloor = OTM_BAND_WIDTH.times(index - 1);
    const otmCeiling = index === OTM_BAND_TOP_INDEX ? null : OTM_BAND_WIDTH.times(index);
    return {
      index,
      otmFloor,
      otmCeiling,
      strikeFloor: otmCeiling === null ? null : spot.times(ONE.minus(otmCeiling)),
      strikeCeiling: spot.times(ONE.minus(otmFloor)),
    };
  });
}

/**
 * 一条腿落哪一行 —— `null` = **行下界外** (比首档更深的价内, FR-034 ② 的数据源)。`O(1)`。
 *
 * 🚨 **边界归属统一「下界闭、上界开」** (同 `leg-tier.rules.ts` 六道界的纪律): 恰 0% 归价外首档、
 * 恰 −10% 归价内档、恰 10% 归第二档 ⇒ 每个界值有且只有一档, 不会两档都亮 / 都不亮。
 *
 * 🚫 **顶档 MUST NOT 溢出成 `null`** —— 那会与「行下界外」共用一个返回值, 而两者的处置相反
 * (下界外单独计数并离开网格, 顶档留在网格上)。极深价外腿因此恒被末档吸收。
 */
export function classifyOtmBand(spot: Prisma.Decimal, strike: Prisma.Decimal): number | null {
  if (spot.lessThanOrEqualTo(0)) return null;
  const otm = spot.minus(strike).div(spot);
  const index = otm.div(OTM_BAND_WIDTH).floor().toNumber() + 1;
  if (index < 0) return null;
  return index > OTM_BAND_TOP_INDEX ? OTM_BAND_TOP_INDEX : index;
}

// ─────────────────────────────────────────────────────────────────────────────
// 列轴 (FR-003) —— 不分箱
// ─────────────────────────────────────────────────────────────────────────────

/** 列轴只认这一个字段, 蓄意不吃整行: 让「列不依赖任何报价列」在签名上读得出来。 */
export interface ChainReportExpiry {
  readonly expiryDate: Date;
}

/**
 * 列轴 = 链上**实际存在**的到期日, 去重升序。`O(n + m log m)`, `m` = 到期日数 (实测 5–16)。
 *
 * 🚫 **MUST NOT 分箱** (FR-003): 到期日是真实可挂单的对象, 分箱会造出链上不存在的到期日,
 * 并把「哪个到期日有人接」这条信息糊掉。
 * 📌 **不设列数上界** (spec Assumptions): 实测 5–16 列横滑无压力, 设上界会砍掉「召回段之外还有
 * 什么」这条报表相对选约表的独有信息。
 */
export function chainReportColumns(legs: readonly ChainReportExpiry[]): readonly Date[] {
  const byTime = new Map<number, Date>();
  for (const leg of legs) byTime.set(leg.expiryDate.getTime(), leg.expiryDate);
  return [...byTime.values()].sort((a, b) => a.getTime() - b.getTime());
}

// ─────────────────────────────────────────────────────────────────────────────
// 格聚合 (FR-006 – FR-008 / FR-027 / FR-028) + 格态 (FR-016 / FR-016a)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 四种格值 (FR-010)。同一时刻只生效一种, 🚫 MUST NOT 提供「以年化为唯一格值」的形态
 * (FR-015: 年化随期限缩短系统性升高是时间折算的算术性质, 单一年化会把它呈现成机会梯度)。
 */
export const CHAIN_REPORT_METRICS = [
  'build_quality',
  'rent_annualized',
  'all_annualized',
  'activity',
] as const;

export type ChainReportMetric = (typeof CHAIN_REPORT_METRICS)[number];

/**
 * 取优方向 —— **建仓成色越低越好**, 其余三种越高越好。
 *
 * 🚨 **这张表踩反了不会红**: 建仓成色是「有效成本相对愿买价的位置」(FR-011), 负值 = 成本落在
 * 愿买价下方 ⇒ 取 `max` 会把最贵的那条腿选成该格代表, 而**网格照常渲染、数字照常有**,
 * 只是每一格都在推荐反向的腿。故方向与格值绑成一张显式的表, 🚫 别在聚合函数里写 `if`。
 */
export const CHAIN_REPORT_METRIC_BETTER: Readonly<Record<ChainReportMetric, 'lower' | 'higher'>> = {
  build_quality: 'lower',
  rent_annualized: 'higher',
  all_annualized: 'higher',
  activity: 'higher',
};

/** 格态三值 (FR-016)。🚫 MUST NOT 加第四值 —— FR-016a 明令不为第四种成因单开格级色码。 */
export const CHAIN_REPORT_CELL_STATES = ['valued', 'gated', 'absent'] as const;

export type ChainReportCellState = (typeof CHAIN_REPORT_CELL_STATES)[number];

/** 一个「价外档 × 到期日」的交点 (spec Key Entities「格」)。 */
export interface ChainReportCell {
  readonly state: ChainReportCellState;
  /**
   * 格内腿数 (FR-007) —— **当前格值下算得出值的成员条数**, 非 `valued` 恒 `0`。
   *
   * 🚨 它与格态同为**当前格值的函数**, 🚫 MUST NOT 缓存成格的静态属性 (FR-016a 末段;
   * 实测全网格填充率 建仓 6.3% / 收租 13.6% / 全腿 41.6%, 三者差得很远)。
   * 📌 口径刻意与「有值」对齐: 读数面板同时给腿数与最优 / 次优 (FR-027), 若腿数含算不出值的腿,
   * 「腿数 3 · 最优只有一个数」在面板上就自相矛盾。
   */
  readonly legCount: number;
  /** 该格最优值 (FR-006: 取最优, 🚫 MUST NOT 取均值); 非 `valued` 恒 `null`。 */
  readonly best: Prisma.Decimal | null;
  /**
   * 该格**次优**值 (FR-027 读数面板要)。
   *
   * 🚨 **格内只有一条腿时显式 `null`** (FR-028, `state_branch` 14): 🚫 MUST NOT 复述最优值充数
   * —— 次优存在的意义正是回答「这一格是一条腿撑起来的、还是一片腿都不错」。
   * 📌 两条腿**取值相等**时次优 = 那个相等的值, **不是** `null`: 判据是**腿数**不是取值互异,
   * 那确实是第二条挂得出去的腿。
   */
  readonly runnerUp: Prisma.Decimal | null;
}

/**
 * 聚合一个格 (FR-006 / FR-007 / FR-016 / FR-016a)。`O(n)` 单趟、`O(1)` 额外空间, `n` = 该格成员数;
 * 整张网格合计 `O(骨架腿数)` —— 格把腿分了区, 不重复扫。
 *
 * @param values 该格在当前格值下**算得出值**的成员读数。空数组 ⇒ 该格无值。
 * @param metric 当前格值 —— 决定取优方向 ({@link CHAIN_REPORT_METRIC_BETTER})。
 * @param chainLegCount 该格位置**链上**的腿数。
 *
 * 🚨 **`chainLegCount` MUST 数在整条链上, 🚫 MUST NOT 数在骨架上**: 骨架已经把低于权利金门槛的
 * 腿排除了 (FR-005), 拿骨架计数会让「有腿但全部太便宜」的格渲染成「该位置无合约」—— 那正是
 * US2 反对的「给出错误信息而不是缺失信息」, 而**两种数法都渲染得出一张完整的网格**。
 *
 * 🚨 **`gated` 归并三类成因** (FR-016a 显式接受的代价 —— 段内不再分辨是哪一道门槛):
 * ① 该格的腿全部低于权利金门槛 (不在骨架内);
 * ② 在骨架内、但不在当前格值对应视角的召回集内 (流动性 / 成色上界 / 有效成本硬门槛 / 活性门槛);
 * ③ 在召回集内、但该口径**算不出值** —— `computeLegRates` 在 `DTE ≤ 0` 或 `K − P ≤ 0` 时返
 *    `null` (0DTE 腿在全腿视角是进得来的)。归 `gated` 而非 `absent`: 合约确实存在,
 *    报成「无合约」是**错误信息**; 而 FR-016a 🚫 明令不为它单开第四种格级色码。
 */
export function aggregateCell(
  values: readonly Prisma.Decimal[],
  metric: ChainReportMetric,
  chainLegCount: number,
): ChainReportCell {
  if (values.length === 0) {
    return {
      state: chainLegCount > 0 ? 'gated' : 'absent',
      legCount: 0,
      best: null,
      runnerUp: null,
    };
  }

  const preferLower = CHAIN_REPORT_METRIC_BETTER[metric] === 'lower';
  const isBetter = (challenger: Prisma.Decimal, incumbent: Prisma.Decimal): boolean =>
    preferLower ? challenger.lessThan(incumbent) : challenger.greaterThan(incumbent);

  let best = values[0];
  let runnerUp: Prisma.Decimal | null = null;
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i];
    if (isBetter(value, best)) {
      runnerUp = best;
      best = value;
      continue;
    }
    // 🚨 `runnerUp === null` 这一支不可省: 首个非最优值无论与最优差多少都是第二条腿。
    if (runnerUp === null || isBetter(value, runnerUp)) runnerUp = value;
  }

  return { state: 'valued', legCount: values.length, best, runnerUp };
}

// ─────────────────────────────────────────────────────────────────────────────
// 三互斥计数 (FR-034 / SC-006) —— 页脚那三个数
// ─────────────────────────────────────────────────────────────────────────────

/** 一条腿在三道「三视角一律」判定上的落点 —— 计数的唯一入参形态。 */
export interface ChainReportLegVerdict {
  /** 过权利金门槛 ⇒ 在骨架内 (FR-005)。 */
  readonly inSkeleton: boolean;
  /**
   * 过权利金门槛**且**过活性门槛。语义上恒蕴含 {@link inSkeleton}。
   * 📌 两者不一致时以 `inSkeleton` 为准 (求值顺序决定, 见 {@link chainReportGateCounts})。
   */
  readonly live: boolean;
  /** 落在行轴哪一档; `null` = **行下界外** (比首档更深的价内)。见 {@link classifyOtmBand}。 */
  readonly band: number | null;
}

/**
 * 页脚三个互斥计数 + 有值条数, **每个带自己的分母** (FR-034)。
 *
 * 🚫 **MUST NOT 合并成一个总数** —— 三条各有各的必须显式的理由: ② 是**量级** (一半以上的腿在
 * 行轴之外); ③ 不是量级而是**唯一性** (全腿格值下活性门槛是「被门槛挡下」格的唯一成因,
 * 不给量级用户就只知道有灰格、不知道那是多少条腿)。
 */
export interface ChainReportGateCounts {
  /** 该链全量腿数 —— ① 的分母, 也是求和恒等式的右端。 */
  readonly total: number;
  /** ① 被权利金门槛移出 (分母 = {@link total})。语义「太便宜」, **整条不在图上**。实测 27.0%。 */
  readonly removedByPremium: number;
  /** 骨架 = 过权利金门槛之后的整条链 (FR-005) —— ② 的分母。 */
  readonly skeleton: number;
  /** ② 被行下界排除 (分母 = {@link skeleton})。语义「太深的价内」, 在行轴之外。实测 57.6%。 */
  readonly outsideRowFloor: number;
  /** 行下界内 —— ③ 的分母。 */
  readonly withinRows: number;
  /** ③ 被活性门槛挡下 (分母 = {@link withinRows})。语义「没人碰过」, **在图上**呈 `gated`。实测 11.0%。 */
  readonly blockedByLiveness: number;
  /**
   * ④ 有值 —— 过两道一律门槛且落在行轴内的腿数。
   *
   * 🚨 **腿级、且与当前格值无关**, 🚫 MUST NOT 与 {@link ChainReportCellState} 的 `valued` 混读:
   * 后者是**格**的态、随格值重算。本数若做成随格值变的, `SC-006` 的求和恒等式会在切换格值时
   * 时对时错 —— 而 ①②③ 三个数都不随格值变。
   */
  readonly valued: number;
}

/**
 * 三互斥计数 (FR-034 / SC-006 / `state_branch` 9)。`O(n)` 单趟。
 *
 * 🚨 **求值顺序即语义, MUST NOT 换**: 全量 → 权利金挡下 → 骨架 → 行下界外 → 行内 → 活性挡下 →
 * 有值。每条腿沿这条链**只落一个桶** (`continue` 逐级短路) ⇒ 互斥性是结构性的, 不靠测试守。
 *
 * 🚨 **③ MUST 数在「行下界内」上, 🚫 MUST NOT 数在骨架全域上** —— 后者会与 ② **重复计 865 条**
 * (实测全池)。那时三个数照样都出得来、界面照样正常, **只是加起来对不上账**。
 * 这正是 spec 自己点名「最容易被写错」的那一处, 故求和恒等式 MUST 有断言 (SC-006)。
 *
 * ⚠️ **求和恒等式对本实现是结构性恒真, 判别力不在它身上** (2026-08-14 T003 探针实测): 逐级
 * `continue` 让每条腿只落一个桶 ⇒ 把 ③ 与 ② 的判定**对调**, 恒等式**照样成立**, 红的只有
 * 「归属」断言 (深价内 ∧ 无人碰过 的腿该计入 ② 而非 ③)。⇒ 🚨 恒等式是**防未来重写**的回归网
 * (谁改成四个独立 `filter().length` 就会破), **不是**本实现的主判据; 主判据 MUST 是归属断言,
 * 下游 IT (T007) 同此纪律 —— 只复现恒等式会得到一个恒绿的假证据。
 */
export function chainReportGateCounts(
  verdicts: readonly ChainReportLegVerdict[],
): ChainReportGateCounts {
  let removedByPremium = 0;
  let outsideRowFloor = 0;
  let blockedByLiveness = 0;
  let valued = 0;

  for (const verdict of verdicts) {
    if (!verdict.inSkeleton) {
      removedByPremium += 1;
      continue;
    }
    if (verdict.band === null) {
      outsideRowFloor += 1;
      continue;
    }
    if (!verdict.live) {
      blockedByLiveness += 1;
      continue;
    }
    valued += 1;
  }

  const total = verdicts.length;
  const skeleton = total - removedByPremium;
  return {
    total,
    removedByPremium,
    skeleton,
    outsideRowFloor,
    withinRows: skeleton - outsideRowFloor,
    blockedByLiveness,
    valued,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 骨架 (FR-005) —— 网格的总体
// ─────────────────────────────────────────────────────────────────────────────

/** 骨架走全腿视角: 它是三视角里唯一不设期限段、不设价差上界的那个 (`defaultCriteria`)。 */
const SKELETON_PERSPECTIVES: readonly LegTab[] = ['all'];

/**
 * 骨架的口径覆盖 —— 把**活性**这一维显式放成「不限」, 其余维度走系统默认值。
 *
 * 🚨 **这是「只过权利金门槛」的落法, 不是一次用户检索** (FR-005): 全腿视角的系统默认值只有
 * 权利金与活性两维非空 ⇒ 活性放开之后, 候选集恰好等于「过权利金门槛之后的整条链」。
 * 📌 显式 `null` 而非缺键 —— `RetrievalOverride` 的判据取 `in`, 缺键是「未覆盖」不是「不限」。
 */
const SKELETON_OVERRIDE: RetrievalOverride = {
  perspective: 'all',
  criteria: { livenessMin: null },
};

/**
 * 网格总体 = **过权利金门槛之后的整条链** (FR-005)。`O(n)` —— 一趟召回, 不排序不截断。
 *
 * 🚨 **MUST NOT 改成「取三视角候选集」**: 那个集合的成员判据是「至少进一个视角」, 而过了权利金
 * 却被**活性门槛**挡下的腿 `tabs` 为空、不在其中 (实测 `us:ACN` 差 **38 条**)。拿它当骨架会让
 * 那 38 条腿在网格上消失成「该位置无合约」—— 而**两种取法都渲染得出一张完整的网格**。
 * 它们留在骨架里呈「被门槛挡下」态, 量级由 FR-034 的第三个计数给出。
 *
 * 🚨 **MUST NOT 在这里重写一遍权利金判据**: 成员判定单点在 `leg-recall.rules.ts`
 * (052 FR-003, 机器强制 `check-optionsdesk-rule-constants` 不变量 #7)。骨架与三视角候选集因此
 * 是**同一个判据的两次调用**, 而不是两份会各自漂移的判据。
 *
 * 🚨 **`candidateCap` 传 `legs.length` = 本次不设上限** (plan D-RECALL-1): `RECALL_CANDIDATE_CAP`
 * 那道保险丝是给下游排序 / 表达限流的, 而网格的格数由行列数决定、与腿数无关, 天然有界。沿用它
 * 等于给报表塞进一个 FR-005 明令不能有的截断 —— 且今天最大链 825 条碰不到, 真出问题时**网格照常
 * 渲染、数字照常有**, 只是少了一批腿。
 */
export function chainReportSkeleton<T extends RecallLegInput>(
  context: RecallContext,
  legs: readonly T[],
): readonly T[] {
  const outcome = recallCandidates(
    context,
    SKELETON_PERSPECTIVES,
    legs,
    legs.length,
    SKELETON_OVERRIDE,
  );
  return outcome.candidates.map((candidate) => candidate.leg);
}
