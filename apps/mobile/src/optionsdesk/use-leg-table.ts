// 053 T007 — 选约表数据源：**每个视角一个独立 query**（plan D-ASYNC-1 / D-CONSIST-1）。
//
// 🚨 **047 的「一次请求取回三视角、切 Tab 零请求」整条作废**（FR-019b）—— 服务端一次只作答
//    一个视角（`perspective` 必填），三个视角是三份各自的 key、各自的缓存、各自的失败态。
//
// 🚨 **错峰不是优化是硬要求**（FR-025）：进详情页只取当前视角，落地后才在后台补其余两个。
//    三份并发约 670 kB，弱网下拖慢首屏，且其中两份用户可能永远不看。判据在
//    `leg-query.rules.ts` 的 `legQueryEnabled`。
//
// 🚨 **迟到响应不覆盖是结构性质不是手写逻辑**（FR-008）：query key 含 `perspective` 与六维
//    条件值 ⇒ 切视角 / 改条件就是**换 key**，旧 key 的响应写不进新 key。🚫 不需要手写 abort。
//
// 🚨 **拆成三份自带两个新问题**，都在本文件闭环：
//    ① 一致性（FR-020）—— 三次请求可能跨过业务日切换点，各自报着不同的 `asOf`；
//    ② 水位失效（FR-021）—— key 含 `perspective` 之后，失效必须走**不含它的前缀 key**。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import {
  getOptionsdeskControllerLegsQueryKey,
  useOptionsdeskControllerLegs,
  useOptionsdeskControllerPositionBucket,
  type LegResponse,
  type LegTableResponse,
  type OptionsdeskControllerLegsParams,
  type PerspectiveCriteriaResponse,
} from '@nvy/api-client';

import {
  criteriaQueryParams,
  normalizeCriteriaForm,
  type CriteriaForm,
} from './leg-criteria.rules';
import {
  legConsistencyStep,
  legMembershipChange,
  legQueryEnabled,
  type LegMembershipChange,
  type LegPerspectiveAsOf,
  type LegPerspectiveGate,
} from './leg-query.rules';
import {
  legPickerNotices,
  promotePick,
  resolveLegTab,
  type LegPickerNotice,
  type LegPickerTab,
  type PickedLegTab,
} from './leg-picker.rules';
import {
  buildLegSections,
  isNoAnchorError,
  legBlockState,
  legRowTotal,
  type LegBlockState,
  type LegSection,
} from './underlying-detail.rules';

/** 选约表 query key 稳定前缀（水位手选写端点成功后须失效 —— 意图落位会随之变，T033 接线）。 */
export const LEG_TABLE_QUERY_KEY = ['optionsdesk', 'legs'] as const;

/**
 * 三个视角的**共同前缀** key（orval 生成的 key 是 `[url, params]`，省掉 params 即前缀）。
 *
 * 🚨 **失效 MUST 走它，MUST NOT 走带 `perspective` 的那一份**（FR-021, Guardrail 2）——
 *    带上视角只会命中一个（甚至一个都不命中），而**屏幕上什么都不会红**：水位 chip 亮了、
 *    意图变了，另外两个视角还在用旧口径打推荐标（推荐标是**标的级、不随视角变**）。
 */
export function legTableQueryPrefix(symbol: string): readonly unknown[] {
  return getOptionsdeskControllerLegsQueryKey(symbol);
}

/** 腿集合 → 合约码集合（成员差集的比较面，064 FR-021）。复杂度 O(n)。 */
function codeSet(legs: readonly LegResponse[]): ReadonlySet<string> {
  return new Set(legs.map((leg) => leg.code));
}

/** 契约未到手时的空腿集 —— 常量引用，避免每次 render 造新数组把 `useMemo` 打穿。 */
const EMPTY_LEGS: readonly LegResponse[] = [];

/** 视角未知时的落位（与 `defaultLegTab(null)` 同值）—— 首屏只有它一份 query 是开的。 */
const BOOTSTRAP_PERSPECTIVE: LegPickerTab = 'all';

/**
 * 无锚是**预期分支**不是故障（FR-011，该端点对无锚票 404 带机器可读 code）⇒ 不重试。
 * 其余错误退 1 次 —— 选约表是 EOD 只读面，多轮重试只把降级态往后拖。
 */
function retryUnlessNoAnchor(failureCount: number, error: unknown): boolean {
  return !isNoAnchorError(error) && failureCount < 1;
}

/** 某视角**已提交**的覆盖 —— 表单（抽屉重开时回填）与它编译出的请求参数一起存。 */
interface SubmittedCriteria {
  readonly form: CriteriaForm;
  readonly params: OptionsdeskControllerLegsParams;
}

/**
 * 单个视角的 query。
 *
 * 🚨 `placeholderData: keepPreviousData` **不是体验糖，摘掉它整块屏当场炸**（052 T013 反例
 *    探针实测，6 条 e2e 红）：换 key 那一拍 `data` 变 undefined ⇒ `intent` 变 null ⇒
 *    `resolveLegTab` 退回「全腿」⇒ 参数跟着换 ⇒ `intent` 回来 ⇒ 又换回去……这一圈**全是同步的
 *    setState，跑赢了网络**：任何响应落地之前就撞到 React 的更新深度上限，页面被 error
 *    boundary 接住（React error #185），**且它不会自行收敛**。053 把请求拆成三份后换 key
 *    **更频繁**，这条只会更关键。
 */
function useLegPerspectiveQuery(
  symbol: string,
  perspective: LegPickerTab,
  submitted: OptionsdeskControllerLegsParams | undefined,
  gate: LegPerspectiveGate,
) {
  // 未覆盖 ⇒ 只带视角本身（`perspective` 必填，缺了服务端 400）；有覆盖时它已随参数同行。
  const params = useMemo<OptionsdeskControllerLegsParams>(
    () => submitted ?? { perspective },
    [submitted, perspective],
  );
  return useOptionsdeskControllerLegs(symbol, params, {
    query: {
      enabled: legQueryEnabled(perspective, gate, symbol.length > 0),
      retry: retryUnlessNoAnchor,
      placeholderData: keepPreviousData,
    },
  });
}

type LegPerspectiveQuery = ReturnType<typeof useLegPerspectiveQuery>;

/**
 * 一致性检测的单视角输入（FR-020）。`asOf` **只在成功时给** —— 失败的视角没有可比的业务日。
 * 📌 `isFetching` 期间恒 `settled: false`：`keepPreviousData` 让换 key 那一拍 `isSuccess`
 *    仍为真而 `data` 是上一份，拿它去比会把「正在换条件」误判成「跨了业务日」。
 */
function asOfView(query: LegPerspectiveQuery): LegPerspectiveAsOf {
  const settled = !query.isFetching && (query.isSuccess || query.isError);
  return query.isSuccess ? { settled, asOf: query.data?.data.asOf ?? null } : { settled };
}

export interface UseLegTableResult {
  /**
   * **当前视角自己的**响应 —— 视角级字段（`legs` / `criteria` / `gateCounts` / `basis` /
   * `matchedCount` / `memberCount` / `displayLimit` / `candidateCapDropped`）的唯一来源。
   */
  table: LegTableResponse | null;
  /**
   * **链级**字段（`state` / `asOf` / `asOfFreshnessTier` / `quoteAsOf` / `oiAsOf` / `source` /
   * `spot` / `w` / `zone` / `lLevel` / `positionBucket*` / `intent` / `rentDepth`）的读取源：
   * 当前视角优先，其未落地时回退到**任一**已到手的视角（三份链级字段逐字相等，FR-006）。
   *
   * 🚫 **MUST NOT 从这里读视角级字段** —— 回退期它可能来自另一个视角，而那时腿数、档位、
   *    计数全都渲染得出来，只是答的不是当前视角。
   * 📌 它同时是「解析当前视角」的**结构前提**：视角由 `intent` 定，而 `intent` 只能来自响应 ——
   *    只认当前视角那一份的话，切视角那一拍 `intent` 变 `null`、视角退回全腿、又切回来。
   */
  chain: LegTableResponse | null;
  /** 区块四态（loading / available / chain_not_ready / read_failed）—— 无「整页」这一档。 */
  block: LegBlockState;
  /** 当前生效 Tab（手点值优先，意图一变让位给新的默认落位，见 `resolveLegTab`）。 */
  tab: LegPickerTab;
  setTab: (tab: LegPickerTab) => void;
  /** 未选水位时的就地注明（已选时空数组）。 */
  notices: readonly LegPickerNotice[];
  /** `SectionList` 的 `sections`，恒长度 1（三 Tab 共用同一个列表实例，切 Tab 只换 `data`）。 */
  sections: LegSection[];
  /** 计数条分母 —— **当前 Tab 的**逻辑集合长度，不是渲染窗口大小（SC-012）。 */
  total: number;
  /** 当前视角的条件全景（控件填 `defaults`、计数看 `outcomes`）。契约未到手 ⇒ `null`。 */
  criteria: PerspectiveCriteriaResponse | null;
  /** 当前视角**已提交**的覆盖值（抽屉重开时回填草稿）；未覆盖 ⇒ `null`。 */
  submittedCriteria: CriteriaForm | null;
  /** 「搜」—— 提交当前视角的条件（值回到默认 ⇒ 等价于复位）。 */
  submitCriteria: (form: CriteriaForm) => void;
  /** 「复位」—— 当前视角回系统默认值（请求不带任何条件）。 */
  resetCriteria: () => void;
  /** 当前视角的重试入口（FR-022：失败隔离 ⇒ 只重这一份）。 */
  retry: () => void;
  /**
   * 三份的业务日不一致，**且自动重取一次之后仍不一致**（FR-020）⇒ 显式提示 + 手动刷新。
   * 🚫 MUST NOT 静默把来自不同业务日的数据并排呈现，也 MUST NOT 无限重取。
   */
  asOfMismatch: boolean;
  /** 手动重取三份 —— `asOfMismatch` 的唯一出口。 */
  refreshAll: () => void;
  /**
   * 064 `FR-022`：**屏上已有一批、新一批在飞**。首屏（还没有表）恒 `false` —— 两者的处置不同：
   * 首屏走等待态（骨架），刷新中**保留当前表**、不遮罩不置灰，新一批到齐后整体替换。
   *
   * 🚨 **MUST NOT 拿它去清空 `sections`** —— 那正好把「刷新」做成了一次闪表；React Query 在
   *    重取期间把旧 `data` 留在原地，所以「保表」是**不写代码**就成立的，写了才会坏。
   * 📌 判据只看**当前视角**那一份：屏上是它，另外两份在后台补齐与用户无关。
   */
  isRefreshing: boolean;
  /**
   * 064 `FR-021`：**相邻两次取数**之间的成员进出（本轮新进 N · 已不满足 M）；无变化 / 首屏 /
   * 换视角 / 改条件 ⇒ `null`。
   *
   * 🚨 **首屏不报**：一进页面就被告知「3 条进」是无中生有 —— 那不是「变化」，那是第一批。
   * 🚨 **换视角与改条件也不报**：那时成员变了是用户自己动的手，报出来只会稀释真正的信号
   *    （盯着的那一行因价格移动而消失）。判据是「同一个视角、同一份条件」的相邻两批。
   */
  membershipChange: LegMembershipChange | null;
  /** 关掉本轮的成员变化提示（可关闭，下一轮真有变化时重新出现）。 */
  dismissMembershipChange: () => void;
}

export function useLegTable(symbol: string): UseLegTableResult {
  // 🚨 **每视角各自持有自己的条件状态**（FR-007）—— 切视角看到的是**那个视角**的值，
  //    上一个视角的覆盖既不带走、也不丢弃（2026-08-13 user 定：各自留存）。
  // 🚫 MUST NOT 做成一份全局条件：覆盖只作用当前视角（052 T010 裁定），全局一份会让「在收租设的
  //    上界」把建仓也收窄，而建仓控件仍显示自己的默认值 —— 控件与数据不匹配且无从解释。
  // 📌 不持久化（FR-014）：状态只活在本 hook 的 state 里，离屏卸载即回默认值。
  // 📌 053 起它**天然落进 query key**（条件值就是请求参数）⇒ 各视角各自缓存是结构保证。
  const [criteriaByPerspective, setCriteriaByPerspective] = useState<
    Partial<Record<LegPickerTab, SubmittedCriteria>>
  >({});
  // 手点值连同**当时的意图**一起记 —— 判定见 `resolveLegTab`（意图变了就让位）。
  const [picked, setPicked] = useState<PickedLegTab | null>(null);
  // 错峰闸（FR-025）。滞后一拍是结构使然，见 `LegPerspectiveGate` 的注释。
  const [gate, setGate] = useState<LegPerspectiveGate>({
    current: BOOTSTRAP_PERSPECTIVE,
    primed: false,
  });
  // 一致性布尔闩（FR-020）—— 🚫 **MUST NOT 换成计数器**（写错方向即死循环，Guardrail 4）。
  const [latched, setLatched] = useState(false);

  const allQuery = useLegPerspectiveQuery(symbol, 'all', criteriaByPerspective.all?.params, gate);
  const buildQuery = useLegPerspectiveQuery(
    symbol,
    'build',
    criteriaByPerspective.build?.params,
    gate,
  );
  const rentQuery = useLegPerspectiveQuery(
    symbol,
    'rent',
    criteriaByPerspective.rent?.params,
    gate,
  );
  const queries: Readonly<Record<LegPickerTab, LegPerspectiveQuery>> = {
    all: allQuery,
    build: buildQuery,
    rent: rentQuery,
  };

  // 🚨 链级读取源 —— 回退任一已到手的视角，**固定序**：全腿（= 首屏唯一开着的那份）→ 建仓 → 收租。
  //    没有这个回退，「视角 → intent → 视角」在切视角那一拍会来回震荡（052 T013 的 #185）。
  //
  // 🚨 **顺序 MUST NOT 由 `gate.current`（或任何本 hook 自己回写的 state）打头**（T016）——
  //    那会把「读哪一份 `intent`」这件事交给上一拍解析出的视角，于是
  //    `gate.current → chainSource → intent → tab → gate.current` 闭成一个环。它在三份缓存
  //    对 `intent` **各执一词**时**没有不动点**：闸在全腿 ⇒ 读到新意图 `rent` ⇒ 落位收租 ⇒
  //    闸切收租 ⇒ 读到那份还没重取完的旧意图 `pending` ⇒ 落位全腿 ⇒ 闸切回…… 而 render 期
  //    回写让这一圈**同步跑满**，React 25 次重入后抛 `Too many re-renders`（生产构建 = #301），
  //    整块屏被 ErrorBoundary 接住 = **真机白屏**。
  //    ⚠️ 「三份各执一词」不是罕见时序，**是选水位这条主路径本身**：写成功 ⇒ 三份 key 一起失效
  //    ⇒ 三份在不同 tick 落地 ⇒ 中间那个窗口必然存在。2026-08-14 变异实验（只把这一行改回去、
  //    重新 export 后跑同一条 `US3-AS3 --repeat-each=5`）：**3 failed + #301 复现；改回来 10 passed
  //    + #301 零命中**。判据同时钉在单测里（本文件 spec 的「视角解析收敛性」两条）。
  // 📌 **去掉「当前视角优先」零损失**：`chain` 是 `table ?? chainSource`，而 `table` 就是当前
  //    视角自己那一份 ⇒ 它到手时本就轮不到 `chainSource`。收敛态下 `gate.current === tab`，
  //    那个首选项恒等于 `table`、恒是死键；它**只在 `gate.current !== tab` 的那一拍起作用**，
  //    而那一拍正是上面这个环。⇒ 删掉的是环，不是回退链。
  const chainSource = allQuery.data?.data ?? buildQuery.data?.data ?? rentQuery.data?.data ?? null;
  const intent = chainSource?.intent ?? null;
  // 🚨 契约到手时先把「点击时意图未知」的手点值升格，再解析 —— 否则 loading 期间那一下点击
  //    会被 `resolveLegTab` 当成「意图变了」丢掉（见 promotePick 注释里的真机实证）。
  //    render 期条件 setState 是 React 官方的 derived-state 修正范式：`promoted !== picked`
  //    只在升格那一次成立，随即收敛，不会自激。
  const promoted = promotePick(picked, intent);
  if (promoted !== picked) setPicked(promoted);
  const tab = resolveLegTab(promoted, intent);

  const currentQuery = queries[tab];
  const table = currentQuery.data?.data ?? null;
  const chain = table ?? chainSource;

  // 错峰闸同步（与上面的升格同一范式：render 期条件 setState，一拍内收敛）。
  // 🚨 **收敛是可证的，靠的是「闸只出不进」**（T016）：`gate` 唯一的去处是 `legQueryEnabled`
  //    的 `enabled`，而 `enabled` 改不动同一拍的 `data` / `isSuccess`（React Query 里被关掉的
  //    query 照常吐缓存），⇒ 回写后重跑这一段，`tab` 与 `primed` **逐字不变**、条件转假、写入停止。
  //    ⇒ 恒 ≤ 1 次额外 render。🚫 **MUST NOT 让 `gate` 反向喂回 `tab` 的任何上游**（`chainSource`
  //    / `intent` / `picked`）—— 那会把这里变回一个无不动点的迭代，见 `chainSource` 处的长注。
  const primed = currentQuery.isSuccess;
  if (gate.current !== tab || gate.primed !== primed) setGate({ current: tab, primed });

  // 🚨 一致性只看三份**已落地**的 `asOf`（FR-020）；处置是布尔闩状态机，见 `legConsistencyStep`。
  const consistency = legConsistencyStep(
    [asOfView(allQuery), asOfView(buildQuery), asOfView(rentQuery)],
    latched,
  );
  const { refetch: refetchAll } = allQuery;
  const { refetch: refetchBuild } = buildQuery;
  const { refetch: refetchRent } = rentQuery;
  // 🚨 依赖里放的是**解构出来的 `refetch`**（QueryObserver 构造期绑定，引用稳定），
  //    🚫 MUST NOT 放整个 query 对象 —— 它每次 render 都是新引用，effect 会每帧重跑成重取风暴。
  const refreshAll = useCallback(() => {
    void refetchAll();
    void refetchBuild();
    void refetchRent();
  }, [refetchAll, refetchBuild, refetchRent]);

  const consistencyAction = consistency.action;
  const nextLatched = consistency.latched;
  useEffect(() => {
    if (nextLatched !== latched) setLatched(nextLatched);
    // 闩已在同一步置上 ⇒ 重取后仍不一致时走的是 `warn` 那一支，**不会再进这里**（FR-020）。
    if (consistencyAction === 'refetch') refreshAll();
  }, [consistencyAction, nextLatched, latched, refreshAll]);

  // 064 `FR-022`：`isPending` = 首屏（连一份 `data` 都还没有）⇒ 那一档归等待态，不是刷新。
  const isRefreshing = currentQuery.isFetching && !currentQuery.isPending;

  const block = useMemo(
    () =>
      legBlockState(
        {
          isPending: currentQuery.isPending,
          isError: currentQuery.isError,
          error: currentQuery.error,
        },
        table?.state,
      ),
    [currentQuery.isPending, currentQuery.isError, currentQuery.error, table?.state],
  );

  // 🚨 `legs[]` 已是**该视角、已精排、已截断**的腿（FR-002）—— 数组序**就是**呈现序：
  //    这里零 `slice`、零 `sort`（两者都是 server 的职责，客户端重排会让截断砍错腿）。
  const legs: readonly LegResponse[] = table?.legs ?? EMPTY_LEGS;
  const sections = useMemo(() => buildLegSections(legs), [legs]);

  // ── 064 FR-021 成员变化（差集只在客户端算，plan §D9）─────────────────────────
  // 🚨 **比的是「同一个视角 + 同一份条件」的相邻两批** —— 视角 / 条件一变就是另一条比较线，
  //    此时只换基准、不报变化（那时成员变了是用户自己动的手）。
  const membershipKey = `${tab}::${JSON.stringify(criteriaByPerspective[tab]?.params ?? null)}`;
  // 🚫 上一轮的成员集合走 `useRef` 而非 `useState`：它不参与渲染，进 state 会白激一次 render。
  const previousMembership = useRef<{ key: string; legs: readonly LegResponse[] } | null>(null);
  const [membershipChange, setMembershipChange] = useState<LegMembershipChange | null>(null);
  // 🚨 只在**已落地**的批次上比：在飞期间 `legs` 还是上一批（保表，FR-022），拿它去比恒无变化，
  //    真正的那一批到齐时反而已经把基准换掉了。
  const settledLegs = currentQuery.isFetching || !currentQuery.isSuccess ? null : legs;
  useEffect(() => {
    if (settledLegs === null) return;
    const previous = previousMembership.current;
    previousMembership.current = { key: membershipKey, legs: settledLegs };
    // 首屏（无上一轮）/ 换了比较线 ⇒ 只换基准。
    if (previous === null || previous.key !== membershipKey) return;
    // 同一批的重渲染（引用没变）⇒ 什么都没发生，别把上一轮的提示重算一遍盖掉用户的关闭。
    if (previous.legs === settledLegs) return;
    setMembershipChange(legMembershipChange(codeSet(previous.legs), codeSet(settledLegs)));
  }, [settledLegs, membershipKey]);

  const dismissMembershipChange = useCallback(() => setMembershipChange(null), []);

  const setTab = useCallback((next: LegPickerTab) => setPicked({ intent, tab: next }), [intent]);

  const criteria = table?.criteria ?? null;
  const submitted = criteriaByPerspective[tab] ?? null;

  const submitCriteria = useCallback(
    (form: CriteriaForm) => {
      const normalized = normalizeCriteriaForm(form);
      // 🚫 未改动的维度不下发（缺键 = 未覆盖）；全部回到默认值 ⇒ 无参数 = 等价于复位。
      const params = criteriaQueryParams(tab, normalized, criteria?.defaults ?? null);
      setCriteriaByPerspective((prev) => {
        const next = { ...prev };
        if (params === undefined) delete next[tab];
        else next[tab] = { form: normalized, params };
        return next;
      });
    },
    [tab, criteria],
  );

  const resetCriteria = useCallback(() => {
    setCriteriaByPerspective((prev) => {
      const next = { ...prev };
      delete next[tab];
      return next;
    });
  }, [tab]);

  // 🚨 只重当前视角这一份（FR-022 失败隔离）—— 其余两个已取得的数据 MUST NOT 被连坐清空。
  const retry = useCallback(() => {
    const refetch = { all: refetchAll, build: refetchBuild, rent: refetchRent }[tab];
    void refetch();
  }, [tab, refetchAll, refetchBuild, refetchRent]);

  return {
    table,
    chain,
    block,
    tab,
    setTab,
    notices: legPickerNotices(chain, tab),
    sections,
    total: legRowTotal(sections),
    criteria,
    submittedCriteria: submitted?.form ?? null,
    submitCriteria,
    resetCriteria,
    retry,
    asOfMismatch: consistencyAction === 'warn',
    refreshAll,
    isRefreshing,
    membershipChange,
    dismissMembershipChange,
  };
}

/**
 * 水位手选写端点（FR-017, plan D-UI-5）。**成功即失效选约表** —— 水位是意图矩阵的一维输入，
 * 它一变，`intent` / `rentDepth` / 每腿的推荐标全跟着变。
 *
 * 🚨 漏了这次失效，屏幕上会出现最难查的那种不一致：「人工输入」角标亮了、chip 也选中了，
 *    但表还是旧那张（全局 `staleTime 30s` + 详情屏常驻挂载 ⇒ **没有任何触发器**自动重取）。
 *    typecheck 与单测都拦不住它（形状没变，只是数据陈旧）。
 * 🚨 **053 起必须失效三份**（FR-021）：key 含 `perspective` 之后，带视角的那一份只命中一个 ——
 *    而推荐标是**标的级、不随视角变**，只重取收租视角会让另外两个继续用旧口径打标，
 *    **数字与标都在、只是口径不对，且不会红**。⇒ 走 `legTableQueryPrefix` 这个前缀 key。
 * 📌 只失效选约表 —— 锚列表 / 雷达的可见字段与水位无关，连坐失效是白跑一趟网络。
 */
export function useSetPositionBucket(symbol: string) {
  const queryClient = useQueryClient();
  return useOptionsdeskControllerPositionBucket({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: legTableQueryPrefix(symbol) });
      },
    },
  });
}
