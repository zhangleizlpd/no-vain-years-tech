// 047 T033 — 三 Tab / 意图落位 / 水位提示的纯函数（FR-002/016/017/019/020, plan D-SOT-3/D-SOT-4）。
// Tab 栏与 chip 组件只做接线与版面；渲染 / 交互 / a11y 走 T035 Playwright e2e。
//
// 🚨 **Tab 成员判据 MUST NOT 在客户端重算** —— 判据单点在 server 的 `leg-recall.rules.ts`。
//    053 起一次请求只作答一个视角 ⇒ `legs[]` **就是**该视角的成员集合，客户端连「筛哪些」
//    这个动作都不再存在。重算至少有两条必踩的坑：
//    ① IT 已实证 **greeks 缺失腿合法进意图视角** —— 050 起 Δ 整个退出召回判据（FR-009），
//       客户端拿 `|Δ| ∈ 档带` 重算必把这支筛没，而且**不会红**；
//    ② 活跃度是「**该视角候选集内**的相对排名」（D-SOT-5），server 用它自己筛出的候选集算的。
//       客户端筛出另一个集合，排名照样显示得出来，只是**跟谁比**已经对不上了。
//
// 🚨 **顺序就是 `legs[]` 的数组序**（053 FR-002）—— 精排与表达层截断都在 server 完成，
//    下发的是**该视角、已排序、已截断**的腿。047/051 那份与 `legs[]` 并行下发的有序 code 列表
//    随本片退役：同一个顺序下发两份表达必 drift，而两份**各自都渲染得出来**。
//    🚨 **这条不是体验问题**：截断必须发生在排序之后；排序若留在客户端，server 截断会砍掉
//    本该排前面的腿 —— 而返回条数与每个数字都正常，**不会红**。
//
// 🚨 **切视角只换 `section.data`** —— 三个视角共用同一个 `SectionList` 实例（plan D-UI-1）。
//    053 起换的是**哪一份响应的 `legs[]`**（三个视角三份 query），组装仍恒长度 1 个 section。
import type {
  LegTableResponse,
  LegTableResponseBasis,
  LegTableResponseIntent,
  LegTableResponsePerspective,
  LegTableResponsePositionBucketSource,
  PerspectiveCriteriaResponse,
  SetPositionBucketRequestPositionBucket,
} from '@nvy/api-client';

import { criteriaOverrideCount } from './leg-criteria.rules';
import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.legPicker;
const CRITERIA_COPY = COPY.criteria;

/**
 * Tab 键 = 契约 `perspective`（请求参数与响应回显的那一个）的值域本身，不另造一套。
 * 🚨 053 起底是 `LegTableResponsePerspective` —— 每腿的 `tabs` 随响应收窄一并删除
 *    （拆请求之后它恒等于当前视角，零信息量），值域改由**视角**这一维承担。
 * ⚠️ **本文件只 `import type`** —— `*.rules.ts` 跑在 vitest 里，而 `@nvy/api-client` 的运行时
 *    入口要先 `nx build api-client` 才解析得到。值导入会让纯逻辑单测在未构建时直接炸。
 */
export type LegPickerTab = LegTableResponsePerspective;

/**
 * Tab 展示序 + 标签。🚨 **`Record` 而非 `Partial<Record>`** —— server 往视角值域加一个成员，
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

// 🚨 **053 起本文件没有「取序 / 取该视角那一格」这类函数了**：`legs[]` 已是该视角、已排序、
//    已截断的腿（数组序就是呈现序），每腿的 `tier` / `activity` 已收窄成**本次视角**的标量
//    ⇒ 调用点直接读字段。`orderedLegsForTab` / `legPickerSections` / `legActivityForTab` /
//    `legTierForTab` 四个函数随三个 by-tab 契约结构（有序 code 列表 / 分视角活跃标 /
//    分视角档位）一并退役 —— 那三个结构在收窄后的契约里已不存在，故这里连名字都不复述。

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

/**
 * 契约到手那一刻，把「点击时意图还未知」的手点值**升格**到当前意图。复杂度 O(1)。
 *
 * 🚨 **为什么需要它**：Tab 栏在 loading 期恒可点（FR-020 / `leg-picker-tabs.tsx` 文件头），
 *    于是存在这么一个窗口 —— 人进详情页立刻点了某个 Tab，而契约还没回来、`intent` 是 `null`。
 *    {@link resolveLegTab} 判「当时的意图 ≠ 现在的意图」就丢弃手点值，`null → rent` 恰好命中
 *    这条，那一下点击于是被**静默丢掉**，Tab 弹回意图默认格。人看到的是「点了没反应」。
 *    2026-08-12 真机实证：点「建仓视角」，页面停在「收租视角」。
 *
 * 🚨 **升格 ≠ 取消让位**：FR-016 要让位的是**人选完水位档**引起的意图变化（US3-AS1）——
 *    那是真的换了意图。而「意图从未知变为已知」根本不是一次意图变化，是第一次知道它。
 *    升格后 `picked.intent` 持有真实意图，后续真变化照旧让位（spec 有专门用例锁住）。
 *
 * 📌 未发生升格时**返回同一引用** —— 调用方靠 `!==` 判断要不要写 state，避免每帧 setState。
 */
export function promotePick(
  picked: PickedLegTab | null,
  intent: LegTableResponseIntent | null | undefined,
): PickedLegTab | null {
  return picked !== null && picked.intent === null && intent != null
    ? { intent, tab: picked.tab }
    : picked;
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

/** 费率列头 —— `main` 即口径本身；`sub` 只有周化那支有（折年是参照，不作排序键）。 */
export interface LegRateHeader {
  main: string;
  sub: string | null;
}

/** 两个口径的列头。穷举 `Record` —— server 的口径值域加一格即编译红。 */
const RATE_HEADER_BY_BASIS: Readonly<Record<LegTableResponseBasis, LegRateHeader>> = {
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
 * 🚨 客户端 MUST NOT 自带一份「视角 → 口径」映射 —— 硬编码必与 server 漂移，而漂移时**两边
 *    都算得出结果**：列头写着「周化」、数字却是年化口径判出来的档，没有任何一处会红。
 *    053 起契约只发**本次视角**那一份口径（`basis` 标量），连「取哪一格」都不再是客户端的事。
 * 🚨 穷举 `Record` 只拦得住编译期；`?? RATE_HEADER_UNKNOWN` 拦的是**运行时**那一支 ——
 *    server 可能先于客户端上线新口径取值，那时类型层已经骗不了运行时（FR-018）。
 */
export function rateHeaderFor(basis: LegTableResponseBasis | null): LegRateHeader {
  if (basis === null) return RATE_HEADER_UNKNOWN;
  const known: Readonly<Record<string, LegRateHeader | undefined>> = RATE_HEADER_BY_BASIS;
  return known[basis] ?? RATE_HEADER_UNKNOWN;
}

/** 「人工输入」角标 —— 直接读契约的来源标，**不靠前端记忆推**（FR-017）。O(1)。 */
export function isManualBucket(source: LegTableResponsePositionBucketSource): boolean {
  return source === 'manual';
}

/**
 * 就地注明。`key` 同时是 testID 后缀（T035 e2e 的锚）。
 *
 * 🚨 051 FR-010a 起**渲在腿列表之后的非常驻区**（原在 Tab 栏下、属 sticky 常驻区）——
 *    说明是「看完表之后要不要接着往下想」的东西，占常驻区等于每屏都收一次高度的税。
 */
export interface LegPickerNotice {
  key: 'bucket_unset' | 'rent_depth_union' | 'marks_follow_intent';
  text: string;
}

/**
 * 就地注明 —— 未选水位的两条（FR-017）+ 收租意图下建仓视角那条（051 FR-012）。复杂度 O(1)。
 *
 * 🚫 **收租视角那条是硬要求不是装饰**：未选水位 ⇒ 意图落「待定」⇒ 全表零推荐标，而**成员集合
 *    与选了水位时一条不差**（051 FR-020）。不说出来，用户看到的是一张一个标都没有、却看不出
 *    为什么的收租表。📌 **050 起它说的不再是「Δ 档取三档并集」** —— 那条召回判据已整条删除。
 * 🚨 **FR-012 那条与水位无关**：它解释的是「标按什么口径打」，不是「你还没选东西」——
 *    故 MUST NOT 挂在未选水位那个 early return 后面（挂错位置时它在最常见的路径上恒不出现）。
 * 📌 `table === null`（loading / 读故障）不出提示：那时什么都还不是已知事实。
 */
export function legPickerNotices(
  table: Pick<LegTableResponse, 'positionBucket' | 'intent'> | null,
  tab: LegPickerTab,
): LegPickerNotice[] {
  if (table === null) return [];
  const notices: LegPickerNotice[] = [];
  if (table.positionBucket === null) {
    notices.push({ key: 'bucket_unset', text: COPY.bucketUnsetHint });
    if (tab === 'rent')
      notices.push({ key: 'rent_depth_union', text: COPY.rentDepthUnionNote(COPY.fitBadge) });
  }
  // 收租意图 × 建仓视角：标全按收租档带判 ⇒ 这个视角可能一个标都没有，而那是**正确信号**。
  if (table.intent === 'rent' && tab === 'build') {
    notices.push({
      key: 'marks_follow_intent',
      text: COPY.marksFollowIntentNote(COPY.intents.rent, COPY.fitBadge),
    });
  }
  return notices;
}

// ═══════════════ 两个门槛计数（051 FR-006 / FR-007 / FR-007a / FR-010） ═══════════════

/**
 * 计数区的一行。`key` 同时是 testID 后缀；`goTab` 非 null ⇒ 该行**可点**并切到那个视角。
 *
 * 🚨 **交互差别是语义差别的组成部分**（FR-007a）：权利金门槛挡下的腿整条移出响应，给入口
 *    只能是空承诺 ⇒ 恒 `goTab: null`。MUST NOT 为了对称把两条做成一样。
 */
export interface LegGateCountLine {
  key: 'premium_floor' | 'liquidity';
  text: string;
  goTab: LegPickerTab | null;
  /** 这一行报的数本身 —— 降权判据读它（FR-008），呈现层不从文案里往回抠数字。 */
  count: number;
}

/**
 * 两个门槛计数（顺序恒定：权利金在前）。复杂度 O(1)。
 *
 * 🚨 **053 起排除数就是「该视角自己的数」** —— 一次请求只判定一个视角，051 那个「全表标量 vs
 *    分视角数」的二选一结构上已消失，契约面只留一份（全腿视角恒 0，它不受流动性门槛约束）。
 *    ⇒ 本函数不再按视角取数，`tab` 只决定**措辞与入口**。
 * 📌 全腿视角**收回入口**：人已经在全腿视角了，再给一个「去全腿视角」是死链。
 * 📌 FR-010 的留位靠「本函数返回一个数组」实现 —— 053 的截断计数按同一形状追加
 *    （见 {@link legTruncationLine}），调用方的版面一行不用改。
 */
export function legGateCountLines(
  gateCounts: LegTableResponse['gateCounts'] | null,
  tab: LegPickerTab,
): LegGateCountLine[] {
  if (gateCounts === null) return [];
  const inAllTab = tab === 'all';
  const excluded = gateCounts.excludedFromIntentTabs;
  return [
    {
      key: 'premium_floor',
      text: withNote(
        COPY.gatePremiumFloor,
        gateCounts.removedByPremiumFloor,
        COPY.gatePremiumFloorNote,
      ),
      goTab: null,
      count: gateCounts.removedByPremiumFloor,
    },
    {
      key: 'liquidity',
      text: withNote(
        COPY.gateLiquidity,
        excluded,
        inAllTab ? COPY.gateLiquidityNoteAll : COPY.gateLiquidityNoteIntent,
      ),
      goTab: inAllTab ? null : 'all',
      count: excluded,
    },
  ];
}

/** 计数为 0 时只报数 —— 「移出 0 条 · 三个视角都看不到」是一句自相矛盾的话。 */
function withNote(line: (n: number) => string, count: number, note: string): string {
  return count === 0 ? line(0) : `${line(count)}${note}`;
}

/**
 * 计数区要不要降权（FR-008）—— **两个数皆 0** 才降，任一非零都是要被看见的真数据。O(行数)。
 *
 * 🚨 降权 MUST 靠**去掉主色 + 缩字号**，🚫 MUST NOT 靠压低对比度：计数是真数据（只是为 0），
 *    不是占位符。mockup 阶段踩过 —— 用 `text-subtle` 掉到 2.85:1，那是「看不清」不是「不抢眼」。
 * 📌 判据落在**行**上而不是 `gateCounts` 上：行已经按视角选好了数，这里不再重走一遍选数逻辑。
 */
export function legGateCountsQuiet(lines: readonly LegGateCountLine[]): boolean {
  return lines.every((line) => line.count === 0);
}

// ═══════════════ 计数三处分工（053 FR-016 / FR-018 / FR-019c，plan D-API-1 / D-UI-1） ═══════════════
//
// 🚨 **三处各报各的数，MUST NOT 有两处报同一个**（`SC-005`）：
//    · sticky 区块头 → 符合条件的总数（覆盖生效时并列「全量」基准）
//    · 非常驻区第 3 条 → 已显示的条数 D 与被截掉的条数 N−D
//    · 非常驻区异常位 → 候选上限 `K` 的触及数（**仅触及时**，与截断计数不同款）
// 🚨 **`D` 与「其余 N−D」都是现算的**（Guardrail 11）：`D === legs.length`、
//    `N−D === matchedCount − legs.length` ⇒ 服务端 MUST NOT 下发第二份（下发必 drift）。

/**
 * sticky 区块头的计数（FR-009 / FR-016）。复杂度 O(1)。
 *
 * 🚨 **报的是 `matchedCount` 不是渲染出来的行数** —— 截断之后两者不再相等，而「已显示前 D 条」
 *    由 {@link legTruncationLine} 承担；区块头再报 D 就是同一个数一屏两处（`SC-005` 明禁）。
 * 🚨 **未覆盖时 MUST NOT 并列显示两个相等的数**（FR-009 📌）—— 那时 `memberCount === matchedCount`，
 *    并列出来的「筛后 40 · 全量 40」只会让人去找它们为什么不同。
 * 📌 契约未到手 ⇒ 退「共 0 行」，与 loading 期的空表同形（不渲半截依据）。
 */
export function legRowCountLine(
  table: Pick<LegTableResponse, 'matchedCount' | 'memberCount'> | null,
): string {
  if (table === null) return COPY.rowTotal(0);
  return table.memberCount === table.matchedCount
    ? COPY.rowTotal(table.matchedCount)
    : COPY.rowTotalNarrowed(table.matchedCount, table.memberCount);
}

/** 截断计数（第 3 条）。`shown` / `hidden` 供断言与 e2e 读数，呈现层不从文案里往回抠数字。 */
export interface LegTruncationLine {
  shown: number;
  hidden: number;
  text: string;
}

/**
 * 表达层截断的计数（FR-016 / FR-017 / FR-018）。**未触发截断恒 `null`**。复杂度 O(1)。
 *
 * 🚨 **未触发时整条不渲染**（FR-018）—— 🚫 MUST NOT 显示刺眼的空值，也 MUST NOT 显示两个恒等的数。
 * 🚨 **视觉与「权利金移出」同款**（plan D-UI-1）：`text-ink-muted` 纯文字、**无雪佛龙** ——
 *    🚫 MUST NOT 用告警色（Guardrail 6）：截断是**正常的呈现约定**不是异常，告警色会让人以为
 *    数据坏了。真正的异常位是 {@link legCandidateCapLine}，两者刻意不同款。
 * 🚨 **收窄指引是硬要求不是装饰**（FR-017）：分页 / 「加载更多」/ 被截断腿的下钻在本片**都不存在**
 *    （FR-019），不给指引等于告诉用户「还有 N 条，但你够不到」。
 * 📌 `shown === 0` 时同样不渲染 —— 那时列表本就是空的，空态自己会说话，再叠一句「已显示前 0 条」
 *    只是自相矛盾（且 `hidden` 会恰好等于 `matchedCount`，撞 `SC-005`）。
 */
export function legTruncationLine(
  table: Pick<LegTableResponse, 'legs' | 'matchedCount'> | null,
): LegTruncationLine | null {
  if (table === null) return null;
  const shown = table.legs.length;
  const hidden = table.matchedCount - shown;
  if (shown <= 0 || hidden <= 0) return null;
  return {
    shown,
    hidden,
    text: `${COPY.truncated(shown, hidden)}${COPY.truncatedGuide(CRITERIA_COPY.entry)}`,
  };
}

/** 候选上限 `K` 的异常位。`dropped` 供断言读数；**未触及恒 `null`**。 */
export interface LegCandidateCapLine {
  dropped: number;
  text: string;
}

/**
 * 候选上限 `K` 触及时的**异常**提示（FR-019c）。复杂度 O(1)。
 *
 * 🚨 **与截断计数不同款是硬要求**（Guardrail 14）：`K` 是给下游限流的保险丝（触及即系统异常，
 *    处置是**调容量**），`N` 是用户可见条数（触及是正常约定，处置是**调展示**）。做成第四条
 *    常规计数会让「该调容量」被读成「该调展示」。
 * 🚨 **提示 MUST 说明「上面的数可能不完整」** —— `K` 触及会让 `matchedCount` **静默失真**：
 *    它算在已被 `K` 砍过的集合上，于是 {@link legTruncationLine} 的「其余 N−D 条」**少报**，
 *    而条数与数值全都正常、**不会红**。
 * 📌 未触及（`0`）⇒ `null` ⇒ 整块不渲染（`SC-016`：未触及时该呈现 100% 不出现）。
 */
export function legCandidateCapLine(
  table: Pick<LegTableResponse, 'candidateCapDropped'> | null,
): LegCandidateCapLine | null {
  if (table === null || table.candidateCapDropped <= 0) return null;
  return { dropped: table.candidateCapDropped, text: COPY.candidateCap(table.candidateCapDropped) };
}

// ═══════════════ 意图视角空态（051 FR-009 / SC-013） ═══════════════

/** 空态。`title` 为 null ⇒ 沿用既有单行形态（全腿视角）；`cta` 非 null ⇒ 带入口。 */
export interface LegEmptyState {
  title: string | null;
  text: string;
  cta: { label: string; tab: LegPickerTab } | null;
  /**
   * 052：空是**用户自己收窄出来的**时给的「复位」入口文案（`null` ⇒ 不给）。
   * 🚨 与 {@link LegEmptyState.cta} 蓄意分成两个字段而不是一个联合：两者该做的事完全不同
   *    （一个是「去别的视角看那些腿」，一个是「把条件放回去」），合并成一个入口就要在
   *    渲染处再判一次它到底是哪种。
   */
  reset: string | null;
}

/** 意图视角空态的通用兜底 —— 全腿视角与契约未到手都走它。 */
const GENERIC_EMPTY: LegEmptyState = { title: null, text: COPY.empty, cta: null, reset: null };

/**
 * 意图视角的空态，按**该视角自己的**排除数分两支（FR-009）。复杂度 O(1)。
 *
 * 🚨 051 期这里 MUST 取分视角数而非全表标量（SC-013 / D-GATES-2）—— 后者是「build 或 rent
 *    任一期限段合格且被挡下」的合计，据此对建仓视角说「有 20 条被挡了，去全腿看」会指向别的
 *    视角的腿，而且**不会红**。053 起该风险由**契约**消掉：一次请求只判定一个视角，下发的
 *    `excludedFromIntentTabs` 就是本视角自己的数，两个口径结构上已是同一个数。
 * 📌 全腿视角不受流动性门槛约束（FR-006），它没有「被挡下」这一分支 ⇒ 沿用既有单行文案。
 */
export function legEmptyState(
  gateCounts: LegTableResponse['gateCounts'] | null,
  tab: LegPickerTab,
  criteria: PerspectiveCriteriaResponse | null = null,
): LegEmptyState {
  // 🚨 052 第三支**排在最前** —— 用户自己收窄出来的空与「这只票本来就没有」是两件事，
  //    而它在三个视角**都**可能发生（含全腿）。判据取服务端下发的三态回执，不靠客户端记忆。
  if (criteriaOverrideCount(criteria) > 0) {
    return {
      title: CRITERIA_COPY.emptyTitle,
      text: CRITERIA_COPY.emptyText,
      cta: null,
      reset: CRITERIA_COPY.emptyResetCta,
    };
  }
  if (gateCounts === null || tab === 'all') return GENERIC_EMPTY;
  const excluded = gateCounts.excludedFromIntentTabs;
  const title = COPY.emptyIntentTitle[tab];
  // > 0：本视角确有够格却被挡下的腿 ⇒ 指向门槛并给入口（那些腿在全腿视角看得到）。
  if (excluded > 0) {
    return {
      title,
      text: COPY.emptyBlockedByGate(excluded),
      cta: { label: COPY.emptyBlockedCta(excluded), tab: 'all' },
      reset: null,
    };
  }
  // = 0：本视角是真的没有合格腿 ⇒ 指向判据本身，**不给入口**（没有可去看的腿）。
  return {
    title,
    text: `${COPY.emptyNoneReason[tab]}${COPY.emptyNoneTail}`,
    cta: null,
    reset: null,
  };
}
