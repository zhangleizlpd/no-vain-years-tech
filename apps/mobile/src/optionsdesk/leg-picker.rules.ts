// 047 T033 — 三 Tab / 意图落位 / 水位提示的纯函数（FR-002/016/017/019/020, plan D-SOT-3/D-SOT-4）。
// Tab 栏与 chip 组件只做接线与版面；渲染 / 交互 / a11y 走 T035 Playwright e2e。
//
// 🚨 **Tab 成员判据 MUST NOT 在客户端重算** —— 每腿自带 `tabs: ('all'|'build'|'rent')[]`，
//    判据单点在 server 的 `leg-recall.rules.ts`（050 起；047 时在 `leg-tab.rules.ts`）。
//    重算至少有两条必踩的坑：
//    ① IT 已实证 **greeks 缺失腿合法进意图 Tab** —— 050 起 Δ 整个退出召回判据（FR-009），
//       客户端拿 `|Δ| ∈ 档带` 重算必把这支筛没，而且**不会红**；
//    ② 活跃度是「**当前 Tab 候选集内**的相对排名」（D-SOT-5），server 用它自己筛出的候选集算的。
//       客户端筛出另一个集合，排名照样显示得出来，只是**跟谁比**已经对不上了。
//
// 🚨 **顺序取自 `tabOrder[tab]`，不是 `legs[]` 的顺序**（051 FR-001/FR-004）—— 精排 050 起在
//    server 完成，每个 Tab 各下发一份有序合约代码列表。`legs[]` 那一份是 legacy 载体序
//    （档位 → 到期日 → 行权价 → code），050 之后**不承载任何 Tab 的排序语义**，只作为按 code
//    定位腿的数据源。
//    🚨 **这条不是体验问题**：P3 要做 server 端截断，而截断必须发生在排序之后；排序若留在
//    客户端，server 截断会砍掉本该排前面的腿 —— 而返回条数与每个数字都正常，**不会红**。
//
// 🚨 **切 Tab 只换 `section.data`** —— 三个 Tab 共用同一个 `SectionList` 实例（plan D-UI-1），
//    故本文件恒返回长度 1 的 sections，空 Tab 是 `data: []` 而不是零 section。
import type {
  LegActivityResponse,
  LegResponse,
  LegResponseBasis,
  LegResponseTabsItem,
  LegTableResponse,
  LegTableResponseIntent,
  LegTableResponsePositionBucketSource,
  SetPositionBucketRequestPositionBucket,
} from '@nvy/api-client';

import type { LegTier } from './leg-picker-copy';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';
import { buildLegSections, type LegSection } from './underlying-detail.rules';

const COPY = OPTIONSDESK_COPY.legPicker;

/**
 * Tab 键 = 契约 `tabs` 的值域本身（不另造一套）。
 * ⚠️ **本文件只 `import type`** —— `*.rules.ts` 跑在 vitest 里，而 `@nvy/api-client` 的运行时
 *    入口要先 `nx build api-client` 才解析得到。值导入会让纯逻辑单测在未构建时直接炸。
 */
export type LegPickerTab = LegResponseTabsItem;

/**
 * Tab 展示序 + 标签。🚨 **`Record` 而非 `Partial<Record>`** —— server 往 `tabs` 加一个成员，
 * 这里立刻编译红（而不是静默少一个 Tab）。{@link LEG_PICKER_TABS} 从本表派生，不手抄第二份。
 */
const TAB_LABEL: Readonly<Record<LegPickerTab, string>> = {
  all: COPY.tabs.all,
  build: COPY.tabs.build,
  rent: COPY.tabs.rent,
};

/** 三个 Tab（FR-002），**顺序 = 展示序**。 */
export const LEG_PICKER_TABS = Object.keys(TAB_LABEL) as readonly LegPickerTab[];

/** Tab 标签。O(1)。 */
export function legTabLabel(tab: LegPickerTab): string {
  return TAB_LABEL[tab];
}

/**
 * 每 Tab 一份**有序的合约代码列表**（契约 `LegTableResponse.tabOrder`）。
 * 用本仓自己的 Tab 类型而非生成类型名 —— server 往 `tabs` 加一个成员时这里立刻编译红。
 */
export type LegTabOrder = Readonly<Record<LegPickerTab, readonly string[]>>;

/**
 * 契约还没到手时的取序输入（loading / 读故障）。三份恒是空数组 ——
 * 🚫 MUST NOT 用 `null` 顶替：「这个 Tab 没有腿」与「还没有数据」在**呈现上同归**（空态），
 * 但调用方不该为此写一条 null 分支。
 */
export const EMPTY_LEG_TAB_ORDER: LegTabOrder = { all: [], build: [], rent: [] };

/**
 * 当前 Tab 的腿，**按 server 下发的 `tabOrder[tab]` 取序**（FR-001/FR-003/FR-004）。
 *
 * 建一次 `Map<code, leg>`（`O(n)`）再按有序列表映射（`O(m)`）⇒ 总 `O(n+m)`，与被它取代的
 * `filter` 同量级。
 *
 * 🚨 **签名里 MUST NOT 出现任何比较器 / 排序键入参** —— 这是「排序不在客户端」（FR-002）的
 *    **结构保证**而非事后约定：想在客户端排就必须先改签名，那一步 review 看得见
 *    （同 050 server 侧对 `absDelta` 退出召回入参的处置）。
 *
 * 🚨 **两份数据的缺口都不许崩**（spec Edge Case）：`tabOrder` 里有 code 而 `legs[]` 定位不到
 *    → **跳过该 code**，MUST NOT 塞占位行；反之 `legs[]` 有而 `tabOrder` 无 → 该 Tab 本就
 *    不含它，正常。一致性由 server 保证（`tabOrder[t]` 与每腿 `tabs` 同源派生），客户端
 *    只负责撞上时不崩。
 *
 * 📌 `all` 也走同一条路径 —— 全腿 Tab 的有序列表照样由 server 下发，不为它开特例分支。
 */
export function orderedLegsForTab(
  legs: readonly LegResponse[],
  tabOrder: LegTabOrder,
  tab: LegPickerTab,
): readonly LegResponse[] {
  const byCode = new Map(legs.map((leg) => [leg.code, leg]));
  const ordered: LegResponse[] = [];
  for (const code of tabOrder[tab]) {
    const leg = byCode.get(code);
    if (leg !== undefined) ordered.push(leg);
  }
  return ordered;
}

/**
 * 当前 Tab 的 `sections`（恒长度 1）。
 * 🚨 **空 Tab 返的是 `data: []` 而不是零 section** —— 面板要照常在（FR-005：可进入、不隐藏、不置灰）。
 * 复杂度 O(n+m)。
 */
export function legPickerSections(
  legs: readonly LegResponse[],
  tabOrder: LegTabOrder,
  tab: LegPickerTab,
): LegSection[] {
  return buildLegSections(orderedLegsForTab(legs, tabOrder, tab));
}

/**
 * 该腿在**当前 Tab** 的活跃度标（D-SOT-5）。不属于该 Tab 的位置恒 `null` ——
 * 🚫 MUST NOT 拿别的 Tab 的标顶上（那是另一个候选集里的排名）。复杂度 O(1)。
 */
export function legActivityForTab(
  leg: Pick<LegResponse, 'activityByTab'>,
  tab: LegPickerTab,
): LegActivityResponse | null {
  return leg.activityByTab[tab];
}

/**
 * 当前视角下的档位（契约 `tierByTab`，051 FR-015）。复杂度 O(1)。
 *
 * 🚨 **MUST NOT 回落到 legacy 的 `leg.tier`**（FR-016）—— 那个标量是全表一个口径的老载体，
 *    拿它顶上时屏幕照样渲得出四档色，只是**染的是另一个视角的判定**：不属于该视角的腿会被
 *    染成「好档」的绿，而它在这个视角里根本没判过档。
 * 📌 同一条腿在两个视角判出不同档是**定义如此**（建仓走周化档界、收租与全腿走年化）。
 */
export function legTierForTab(
  leg: Pick<LegResponse, 'tierByTab'>,
  tab: LegPickerTab,
): LegTier | null {
  return leg.tierByTab[tab];
}

/**
 * 意图 → 默认落位 Tab（FR-016）。穷举而非 `Partial<Record>`：矩阵加一态即编译红。
 *
 * 🚨 `pending`（水位未选）与 `no_new_position`（不动区 / L4）**都停「全腿」**：
 *    前者是 FR-017 明令的「未选之前 MUST NOT 假设任何档位」，后者是 FR-021 的
 *    「警示注置顶 + 腿数据照常全量」—— 两者都没有一个「该去的意图 Tab」。
 */
export const DEFAULT_TAB_BY_INTENT: Readonly<Record<LegTableResponseIntent, LegPickerTab>> = {
  build_position: 'build',
  rent: 'rent',
  no_new_position: 'all',
  pending: 'all',
};

/** 契约还没到手时退「全腿」—— 不闪一个意图 Tab（闪完再跳比不动更难读）。O(1)。 */
export function defaultLegTab(intent: LegTableResponseIntent | null | undefined): LegPickerTab {
  return intent == null ? 'all' : DEFAULT_TAB_BY_INTENT[intent];
}

/** 用户手点过的 Tab —— 连同**当时的意图**一起记，见 {@link resolveLegTab}。 */
export interface PickedLegTab {
  intent: LegTableResponseIntent | null;
  tab: LegPickerTab;
}

/**
 * 当前生效 Tab = 手点值优先，**但意图一变就让位给新的默认落位**（FR-016）。复杂度 O(1)。
 *
 * 🚨 为什么手点值不是无条件优先：意图会变基本只有一个原因 —— **人刚选了水位档**
 *    （`pending → rent` / `→ build_position`）。US3-AS1 要的正是那一刻 Tab 停到矩阵输出的
 *    那个 Tab；若手点值一直压着，选完水位屏幕上什么都不动，人会以为水位没存上。
 *    反过来，同一意图内手点仍然完全说了算（切去看别的 Tab 不会被弹回来）。
 */
export function resolveLegTab(
  picked: PickedLegTab | null,
  intent: LegTableResponseIntent | null | undefined,
): LegPickerTab {
  const current = intent ?? null;
  return picked !== null && picked.intent === current ? picked.tab : defaultLegTab(current);
}

/** 意图 chip 文案。穷举 `Record` —— 矩阵加一态即编译红。 */
const INTENT_LABEL: Readonly<Record<LegTableResponseIntent, string>> = {
  build_position: COPY.intents.build_position,
  rent: COPY.intents.rent,
  no_new_position: COPY.intents.no_new_position,
  pending: COPY.intents.pending,
};

/** 契约未到手时显「待定」—— 与「水位未选」同一个字，两者都不是 loading 的替身。O(1)。 */
export function intentLabel(intent: LegTableResponseIntent | null | undefined): string {
  return intent == null ? INTENT_LABEL.pending : INTENT_LABEL[intent];
}

/** 水位三档文案。值域 = 写端点 body 的值域（**三值必填、不收 null、无「清空」动作**）。 */
const BUCKET_LABEL: Readonly<Record<SetPositionBucketRequestPositionBucket, string>> = {
  lt_one_third: COPY.buckets.lt_one_third,
  one_to_two_thirds: COPY.buckets.one_to_two_thirds,
  gte_two_thirds: COPY.buckets.gte_two_thirds,
};

/** 三个水位 chip，**顺序 = 由低到高**（与 server `POSITION_BUCKETS` 同序）。 */
export const LEG_POSITION_BUCKETS = Object.keys(
  BUCKET_LABEL,
) as readonly SetPositionBucketRequestPositionBucket[];

/** 🚫 `null` 显「未选」—— MUST NOT 显 0、MUST NOT 按最保守档静默假设（FR-017）。O(1)。 */
export function bucketLabel(bucket: SetPositionBucketRequestPositionBucket | null): string {
  return bucket === null ? COPY.bucketUnselected : BUCKET_LABEL[bucket];
}

/**
 * 意图 chip 下的判定依据小字 —— 矩阵的**三个输入原样摊开**（`L2 · 买区 · 水位 未选`）。
 * 判定本身在 server；这里只把「凭什么是这个意图」摆出来，人才有得核对。复杂度 O(1)。
 * 📌 区间中文名复用 045 雷达那份（`radar.zoneLabels`），不另起一套。
 */
export function intentBasisLine(
  table: Pick<LegTableResponse, 'lLevel' | 'zone' | 'positionBucket'> | null,
): string {
  if (table === null) return '';
  const zone = table.zone === null ? COPY.noValue : OPTIONSDESK_COPY.radar.zoneLabels[table.zone];
  return COPY.intentBasis(table.lLevel, zone, bucketLabel(table.positionBucket));
}

/** 全腿 Tab 混排 ⇒ 每行标腿族口径徽标；单口径 Tab 关掉（FR-019）。O(1)。 */
export function showsBasisBadge(tab: LegPickerTab): boolean {
  return tab === 'all';
}

/**
 * 每 Tab 一个**档位判定口径**（契约 `LegTableResponse.basisByTab`）。
 * 同 {@link LegTabOrder}：用本仓自己的 Tab 类型，server 往 `tabs` 加一个成员即编译红。
 */
export type LegBasisByTab = Readonly<Record<LegPickerTab, LegResponseBasis>>;

/** 费率列头 —— `main` 即口径本身；`sub` 只有周化那支有（折年是参照，不作排序键）。 */
export interface LegRateHeader {
  main: string;
  sub: string | null;
}

/** 两个口径的列头。穷举 `Record` —— server 的口径值域加一格即编译红。 */
const RATE_HEADER_BY_BASIS: Readonly<Record<LegResponseBasis, LegRateHeader>> = {
  weekly: { main: COPY.rateBasisWeekly, sub: COPY.rateBasisWeeklySub },
  annualized: { main: COPY.rateBasisAnnualized, sub: null },
};

/**
 * 未知口径 / 契约未到手时的**降级态**（FR-018）。退回通用标题「费率」——
 * 🚫 MUST NOT 猜一个口径挂上去（猜错时屏幕上的每个数字都还对，只有口径是错的，不会红）；
 * 🚫 也 MUST NOT 渲成占位符「—」，那会让这一列连是什么都认不出来。
 */
const RATE_HEADER_UNKNOWN: LegRateHeader = { main: COPY.columns.rate, sub: null };

/**
 * 费率列头 = **服务端下发的那个口径本身**（FR-017 / FR-017a）。复杂度 O(1)。
 *
 * 🚨 客户端 MUST NOT 自带一份「Tab → 口径」映射 —— 硬编码必与 server 漂移，而漂移时**两边
 *    都算得出结果**：列头写着「周化」、数字却是年化口径判出来的档，没有任何一处会红。
 * 🚨 穷举 `Record` 只拦得住编译期；`?? RATE_HEADER_UNKNOWN` 拦的是**运行时**那一支 ——
 *    server 可能先于客户端上线新口径取值，那时类型层已经骗不了运行时（FR-018）。
 */
export function rateHeaderFor(basisByTab: LegBasisByTab | null, tab: LegPickerTab): LegRateHeader {
  const basis: string | undefined = basisByTab?.[tab];
  if (basis === undefined) return RATE_HEADER_UNKNOWN;
  const known: Readonly<Record<string, LegRateHeader | undefined>> = RATE_HEADER_BY_BASIS;
  return known[basis] ?? RATE_HEADER_UNKNOWN;
}

/** 「人工输入」角标 —— 直接读契约的来源标，**不靠前端记忆推**（FR-017）。O(1)。 */
export function isManualBucket(source: LegTableResponsePositionBucketSource): boolean {
  return source === 'manual';
}

/** Tab 面板内的就地注明。`key` 同时是 testID 后缀（T035 e2e 的锚）。 */
export interface LegPickerNotice {
  key: 'bucket_unset' | 'rent_depth_union';
  text: string;
}

/**
 * 未选水位时的两条**显式**提示（FR-017）。复杂度 O(1)。
 *
 * 🚫 **收租 Tab 那条是硬要求不是装饰**：未选水位时 server 的 Δ 档取三档并集，
 *    静默取某一档才是 FR-017 否掉的「替人做方向性假设」。判据在 server —— 客户端负责
 *    **把这件事说出来**，否则用户看到的是一张没有任何说明的、口径不明的收租表。
 * 📌 `table === null`（loading / 读故障）不出提示：那时「未选」还不是已知事实。
 */
export function legPickerNotices(
  table: Pick<LegTableResponse, 'positionBucket'> | null,
  tab: LegPickerTab,
): LegPickerNotice[] {
  if (table === null || table.positionBucket !== null) return [];
  const notices: LegPickerNotice[] = [{ key: 'bucket_unset', text: COPY.bucketUnsetHint }];
  if (tab === 'rent') notices.push({ key: 'rent_depth_union', text: COPY.rentDepthUnionNote });
  return notices;
}
