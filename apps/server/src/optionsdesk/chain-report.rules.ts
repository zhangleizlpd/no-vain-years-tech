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
