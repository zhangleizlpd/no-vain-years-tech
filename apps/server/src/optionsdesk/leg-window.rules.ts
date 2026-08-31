import { Prisma } from '../generated/prisma/client';
import { BUILD_RECALL_DTE, RENT_RECALL_DTE, type RecallLegInput } from './leg-recall.rules';

/**
 * optionsdesk **bootstrap 宽窗**派生纯函数 (068 起降格, ADR-0068 §决策 2)。无 I/O、无 DI、零
 * class (ADR-0043 §4)。
 *
 * 068 (P2) 起实时召回是两段式: 第一段选码判据单点在 `leg-delta-surface.rules.ts` (K-梯形窗,
 * 昨日 Δ 面派生)。本文件的矩形宽窗只剩**一个**存续场景 —— **bootstrap**: 新锚无昨日 Δ 面
 * (零快照期 / 整面零 Δ 读数) 时的一次矩形宽取, 次日有面后自动转梯形窗。
 *
 * 🚨 **窗即召回第一段** (064 教义修订, ADR-0068 §决策 2): 064 立的「窗 MUST NOT 当 filter」在
 * 实时档已撤销 —— 出窗的 K 根本不外呼、不进实时结果。该教义的存续范围收窄为本文件的 bootstrap
 * 场景语义注释, 不再是运行时不变量; 与之配套的 `windowTripwire` 绊线已随 064 覆盖范式**退役**
 * (068 D1 退役清单 —— 窗漏腿的守卫改由标定回放承担, SC-002 零漏腿判据)。
 *
 * 🚨 **窗永不进离线档** (068 FR-011): 离线档的价值主张是宽视野, 本文件任何导出 MUST NOT 被
 * 离线读路径消费。
 *
 * 复杂度: {@link bootstrapWindowFor} `O(1)`; {@link withinWindow} `O(1)`。
 */

/**
 * 已支持的市场 (064 FR-008 沿用; 071 FR-001 加 `hk`)。派生一开始就按市场取参 —— 加市场只需
 * 在这里加数据、不重写派生逻辑 (同 061 §4.5 tick 分组预埋), 071 接港股时**照此兑现**:
 * `bootstrapWindowFor` / `isSupportedMarket` 的函数体零改动。
 *
 * 🚨 **加市场前先确认它的 bootstrap 下界站得住** —— 见 {@link STRIKE_ENVELOPE_FLOOR_SPOT_RATIO}
 * 那条已知缺陷。白名单只管「派生逻辑认不认这个市场」, 不保证参数对它成立。
 */
export const WINDOW_SUPPORTED_MARKETS = ['us', 'hk'] as const;

export type WindowMarket = (typeof WINDOW_SUPPORTED_MARKETS)[number];

/**
 * DTE 段下界 = 两个召回段下界的**较小者**。
 *
 * 🚫 MUST NOT 手写这个数 —— 它必须随 `leg-recall.rules.ts` 的召回段一起动。手写的第二份边界数
 * 在调参那天不会红: 窗悄悄比判据窄一截, 表现为「有些腿今天没有实时报价」, 与 vendor 真缺数
 * 不可区分。`scripts/checks/check-optionsdesk-rule-constants.ts` 的 050 不变量 #2 / #3 也按
 * 字面量 / 语法形状硬拦。
 */
export const WINDOW_DTE_MIN = Math.min(BUILD_RECALL_DTE.min, RENT_RECALL_DTE.min);

/** DTE 段上界 = 两个召回段上界的**较大者**。纪律同 {@link WINDOW_DTE_MIN}。 */
export const WINDOW_DTE_MAX = Math.max(BUILD_RECALL_DTE.max, RENT_RECALL_DTE.max);

/**
 * bootstrap 宽窗 strike 下界比例 —— **068 起 bootstrap 专用** (非实时主路参数)。
 *
 * 无昨日 Δ 面时两条边都给不出 Δ 带包络, 只能退回经验矩形: 深虚到 spot 的七成以下时, 认沽
 * 权利金在美股常规时段几乎必然落到门槛之下 ⇒ 问了也是白问。宁宽不可窄 —— bootstrap 只发生
 * 在新锚首日, 宽一点的代价是一次外呼多问几十条码, 窄的代价是首日候选静默缺腿。
 * 进 `check-optionsdesk-rule-constants` 守卫表 (068), 🚫 第二处出现该字面量即红。
 *
 * ## 🚨 已知缺陷 (2026-08-31 实证, 蓄意保留, issue #308)
 *
 * 本比例是 **spot 的固定比例**, 而收租成色上界是 **W 派生**的 (`axis = min(spot, W)`,
 * `W = 0.8 × V` ⇒ 上界 ≈ `0.824 × V/spot × spot`)。⇒ 锚的 `V` 相对 spot 偏低到一定程度时,
 * **下界会高过上界**, bootstrap 首日的收租候选**恒为空集**。
 *
 * 实测踩中的不止港股: `hk:00700` 上界 0.681×spot、**`us:APA` 上界 0.635×spot —— 美股今天
 * 就在犯**; `us:AFL` (0.708) 与 `hk:09988` (0.724) 是贴边。⇒ **这不是港股标定问题**, 是 067
 * 引 W-axis 之后遗留、068 把矩形窗降格成 bootstrap 时没重新核过的结构性缺口。
 *
 * 🚫 **MUST NOT 在这里悄悄调一个数**: 往下调会改动**美股**的 bootstrap 窗 (撞 071 SC-004
 * 「美股逐值零变化」), 往 per-market 表转需要港股实测取证 (071 T003/T004②, 数据 2026-09-02
 * 到齐)。两条路都是显式决策, 不是顺手改。
 */
export const STRIKE_ENVELOPE_FLOOR_SPOT_RATIO = new Prisma.Decimal('0.7');

/**
 * bootstrap 宽窗 strike 上界比例 —— 同 {@link STRIKE_ENVELOPE_FLOOR_SPOT_RATIO}, bootstrap
 * 专用。略高于 spot, 把收租成色上界与建仓有效成本的定义域整个罩住。
 */
export const STRIKE_ENVELOPE_CEILING_SPOT_RATIO = new Prisma.Decimal('1.05');

/** 一个市场在某个 spot 下的 bootstrap 候选范围。四个边界均**闭区间** (含端点视为窗内)。 */
export interface LegWindow {
  /** 047 起选约表只看认沽。 */
  readonly optionType: 'PUT';
  readonly dteMin: number;
  readonly dteMax: number;
  /** `spot × ` {@link STRIKE_ENVELOPE_FLOOR_SPOT_RATIO}。 */
  readonly strikeMin: Prisma.Decimal;
  /** `spot × ` {@link STRIKE_ENVELOPE_CEILING_SPOT_RATIO}。 */
  readonly strikeMax: Prisma.Decimal;
  /** 非标合约不进选约表 (047 FR-008)。 */
  readonly isStandard: true;
}

/**
 * 某市场在给定 spot 下的 **bootstrap 宽窗** (068 FR-004 唯一矩形宽取场景)。`O(1)`。
 *
 * `spot` 取**定窗基准** (三级基准链产物, 068 FR-006) —— 窗是包络, 容得下一拍滞后。
 *
 * 🚨 **未支持的市场 MUST throw, MUST NOT 静默返空 / 静默套用美股的窗** (064 FR-008 沿用):
 * 返空会让港股看起来「今天没有实时报价」, 套用美股的窗则会让港股拿到一批按美股比例圈出来的
 * 合约 —— 两种错都算得出结果、都不会红。#286 的市场 guard 在调用方闸后挡住, 本 throw 是
 * 纵深防御的最后一层。
 */
export function bootstrapWindowFor(market: string, spot: Prisma.Decimal): LegWindow {
  if (!isSupportedMarket(market)) {
    throw new Error(
      `[leg-window] 市场 '${market}' 尚未支持候选范围派生 —— 已支持: ` +
        `${WINDOW_SUPPORTED_MARKETS.join(' / ')}`,
    );
  }
  return {
    optionType: 'PUT',
    dteMin: WINDOW_DTE_MIN,
    dteMax: WINDOW_DTE_MAX,
    strikeMin: spot.times(STRIKE_ENVELOPE_FLOOR_SPOT_RATIO),
    strikeMax: spot.times(STRIKE_ENVELOPE_CEILING_SPOT_RATIO),
    isStandard: true,
  };
}

function isSupportedMarket(market: string): market is WindowMarket {
  return (WINDOW_SUPPORTED_MARKETS as readonly string[]).includes(market);
}

/**
 * 这条腿是否落在 bootstrap 宽窗内 —— 四个边界均闭区间。`O(1)`。
 *
 * 068 起它是 bootstrap 路径的**圈码判据** (召回第一段): 决定「问 vendor 哪一批」。成员判定
 * 单点仍在 `leg-recall.rules.ts` (052 FR-003) —— 圈码答「问谁」, 判腿答「谁是候选」,
 * 🚫 两者 MUST NOT 合并 (圈码结果照旧要过第二段同一判据入口)。
 */
export function withinWindow(leg: RecallLegInput, window: LegWindow): boolean {
  if (leg.dteDays < window.dteMin || leg.dteDays > window.dteMax) return false;
  return (
    leg.strike.greaterThanOrEqualTo(window.strikeMin) &&
    leg.strike.lessThanOrEqualTo(window.strikeMax)
  );
}
