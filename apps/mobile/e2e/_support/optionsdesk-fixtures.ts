import type {
  LegActivityResponse,
  LegResponse,
  LegResponseTier,
  LegTableResponseBasis,
  PerspectiveCriteriaResponse,
  RetrievalCriteriaResponse,
} from '@nvy/api-client';

/**
 * 选约表 e2e mock 的共享片段（052 T011 起；053 T014 随契约收窄扩到「视角投影」）。
 *
 * 🚨 **为什么抽出来而不是三个 spec 各写一份**：`criteria` 是六维 × 三组字段的嵌套结构，各写
 * 一份就是三份必 drift 的镜像 —— 而 drift 时 typecheck 全绿（形状对、值不同），只有某一条断言
 * 碰巧读到那一维时才露馅。三个既有 `makeLegTable` 本身仍各自持有（它们的腿与锚数据本就该按
 * 各自场景造），这里只共享**与场景无关**的那一块。
 */

/** 一个视角的条件全景：全维度不限 + 三态全 `default`（= 首屏 / 「复位」下发的形态）。 */
export function emptyPerspectiveCriteria(): PerspectiveCriteriaResponse {
  const values: RetrievalCriteriaResponse = {
    strikeMax: null,
    strikeMin: null,
    dteBand: null,
    premiumMin: null,
    livenessMin: null,
    relativeSpreadMax: null,
  };
  const untouched = { state: 'default' as const, excludedCount: 0 };
  return {
    defaults: values,
    effective: values,
    // 🚨 六维**逐个写出**而非 Partial：漏一维时消费侧读到 `undefined` 会当「不限」渲染出一个
    // 空控件，而 typecheck 不报（Partial 把缺席合法化了）。
    outcomes: {
      strikeMax: untouched,
      strikeMin: untouched,
      dteBand: untouched,
      premiumMin: untouched,
      livenessMin: untouched,
      relativeSpreadMax: untouched,
    },
  };
}

/**
 * 报价四件套 —— **单笔权利金与相对价差是 bid/ask 的派生**（053 FR-032），fixture 里手填第二份
 * 必与报价漂移（而漂移时两个数都渲染得出来）。定标与 server 同口径：权利金是金额 ⇒ 2 位、
 * 相对价差是无量纲比例 ⇒ 4 位。
 */
export function quoted(
  bid: string,
  ask: string,
): Pick<LegResponse, 'bid' | 'ask' | 'contractPremium' | 'relativeSpread'> {
  const b = Number(bid);
  const a = Number(ask);
  const mid = (a + b) / 2;
  return {
    bid,
    ask,
    contractPremium: (b * 100).toFixed(2),
    relativeSpread: mid <= 0 ? null : ((a - b) / mid).toFixed(4),
  };
}

// ── 053 T014：视角投影 ────────────────────────────────────────────────────────────────────────

export const LEG_PERSPECTIVES = ['all', 'build', 'rent'] as const;
export type LegPerspective = (typeof LEG_PERSPECTIVES)[number];

/**
 * 视角 → 档位判定口径（server `BASIS_BY_TAB` 的镜像，随响应的 `basis` 字段下发）。
 * 全腿视角**恒年化** —— 混着 10 天与 200 天的腿，周化档界会让整列全是死档。
 */
export const BASIS_BY_PERSPECTIVE: Readonly<Record<LegPerspective, LegTableResponseBasis>> = {
  all: 'annualized',
  build: 'weekly',
  rent: 'annualized',
};

/**
 * 请求 URL 里的 `perspective`（053 FR-001 **必填**）。缺席 / 非三值一律 `null`，handler 据此 400。
 *
 * 🚫 **MUST NOT 缺席时默认一个视角** —— 那正是服务端明禁的形态：腿数、名次、档位全都正常，
 *    只是答的不是问的那个视角，而屏幕上什么都不会红。mock 在这一点上放水，e2e 就再也验不到
 *    「客户端每次请求都带上了视角」。
 */
export function perspectiveOf(url: URL): LegPerspective | null {
  const raw = url.searchParams.get('perspective');
  return (LEG_PERSPECTIVES as readonly string[]).includes(raw ?? '')
    ? (raw as LegPerspective)
    : null;
}

/**
 * `perspective` 缺席 / 非三值时的契约级拒绝 body（053 FR-001，与 server 的 ValidationPipe 同码）。
 * 三个 hermetic mock 共用一份 —— 各写各的会漂成三种「400 长什么样」。
 */
export const PERSPECTIVE_REQUIRED_400 = {
  status: 400,
  code: 'VALIDATION_FAILED',
  title: 'perspective is required',
} as const;

/**
 * 一条腿的**跨视角** canonical 形态 —— fixture 侧的状态，不是契约类型。
 *
 * 🚨 **为什么 053 之后 fixture 反而更需要它**：`FR-005` 把每腿的 `tabs` / `tierByTab` /
 *    `activityByTab` 从契约里删了（一次请求只作答一个视角）。但被 mock 的那个「服务端」仍然
 *    知道三份 —— 它是按请求参数**投影**出一份来答的。fixture 若跟着把三份也删掉，就只剩下
 *    「一个视角的一张表」，而 053 的主链路恰恰是「切视角 = 换 key = 重新请求另一个视角」。
 * 📌 {@link projectLegs} 是它与契约之间的唯一通道：投影出去的对象**没有**这三个键。
 */
export interface CanonicalLeg {
  /** 契约形态的腿。`tier` / `activity` 两格由投影按视角覆写（下面两个字段给了就用给的）。 */
  readonly leg: LegResponse;
  /** 该腿出现在哪些视角里（收窄前的每腿 `tabs`）。 */
  readonly perspectives: readonly LegPerspective[];
  /** 各视角判出的档（收窄前的 `tierByTab`）；省略 = 三视角同档，取 `leg.tier`。 */
  readonly tierBy?: Readonly<Partial<Record<LegPerspective, LegResponseTier>>>;
  /** 各视角的活跃度标（收窄前的 `activityByTab`）；省略 = 处处无标。 */
  readonly activityBy?: Readonly<Partial<Record<LegPerspective, LegActivityResponse | null>>>;
}

/**
 * 把 canonical 腿册投影成**某一个视角**的 `legs[]`（= 服务端一次请求答的那一份）。复杂度 O(n)。
 *
 * 🚨 顺序沿用入册顺序 —— 真端点是「该视角口径的费率降序」，需要顺序判别性的 spec 自己按那条
 *    规则排完再入册（写死一份与数据无关的序，「按下发序渲染」就验不到东西了）。
 */
export function projectLegs(
  book: readonly CanonicalLeg[],
  perspective: LegPerspective,
): LegResponse[] {
  return book
    .filter((entry) => entry.perspectives.includes(perspective))
    .map((entry) => ({
      ...entry.leg,
      tier: entry.tierBy === undefined ? entry.leg.tier : (entry.tierBy[perspective] ?? null),
      activity: entry.activityBy?.[perspective] ?? null,
    }));
}
