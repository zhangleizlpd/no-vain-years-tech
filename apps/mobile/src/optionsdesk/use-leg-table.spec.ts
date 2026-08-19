// @vitest-environment happy-dom
// 053 T007 — 水位写端点成功后的失效必须**覆盖三个视角**（FR-021 / SC-013, Guardrail 2）。
// 053 T016 — 外加**视角解析必须收敛**（React #301 回归，见文件下半 `describe`）。
//
// 🚨 这条是本片最容易漏且**屏幕上什么都不会红**的一条：053 起 query key 含 `perspective`，
//    拿带视角的那份 key 去失效只命中一个（甚至一个都不命中）—— 水位 chip 亮了、意图变了，
//    另外两个视角还在用旧口径打推荐标（推荐标是**标的级、不随视角变**），数字与标全都在。
//
// 🚨 **反例探针（证明本断言真的会红）**：把 `legTableQueryPrefix` 改成
//    `getOptionsdeskControllerLegsQueryKey(symbol, { perspective: 'rent' })`，
//    下面「三份全失效」那条立刻红（建仓 / 全腿两份 `isInvalidated` 仍为 false）。
//
// 手法同 `use-anchor-mutations.spec.ts`：mock orval hook 捕获 `onSuccess`，手动触发后断言
// **真 QueryClient 缓存里**的失效结果；不打真网络、不渲染任何组件（本仓测试分层：vitest = 逻辑）。
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ vi.mock 的 factory 被 hoist 到文件最顶 —— 里面只能碰 vi.hoisted 出来的东西。
const h = vi.hoisted(() => ({
  // orval 生成的 key 工厂逐字镜像：`[url, ...(params ? [params] : [])]`。
  legsKey: (symbol: string, params?: Record<string, unknown>) =>
    [`/api/v1/optionsdesk/underlyings/${symbol}/legs`, ...(params ? [params] : [])] as const,
  captured: {} as { mutation?: { onSuccess?: () => void } },
  /**
   * 每视角「已到手的响应体」——键缺失 ⇒ 该视角**尚未落地**（无 `data`）。
   * 📌 蓄意**不看 `enabled`**：React Query 里被关掉的 query 仍照常吐缓存里的 `data`
   *    （`enabled` 只管发不发请求），把它读成「没数据」会让这里的模型比真的更宽松。
   */
  legsByPerspective: {} as Record<string, Record<string, unknown> | undefined>,
  /**
   * 「这一份正在飞」—— 064 T009 的刷新态入口。📌 与上一格**正交**：刷新中的视角
   * **仍有 `data`**（React Query 重取期间旧数据留在原地），两者一起才描述得出「保表」。
   */
  fetching: {} as Record<string, boolean>,
  // 引用稳定 —— 每 render 新造一个 `refetch` 会让 `refreshAll` 的 `useCallback` 每帧重建。
  refetch: () => Promise.resolve(),
}));

vi.mock('@nvy/api-client', () => ({
  getOptionsdeskControllerLegsQueryKey: h.legsKey,
  useOptionsdeskControllerLegs: (_symbol: string, params: { perspective: string }) => {
    const table = h.legsByPerspective[params.perspective];
    return table === undefined
      ? {
          data: undefined,
          isPending: true,
          isSuccess: false,
          isError: false,
          isFetching: true,
          error: null,
          refetch: h.refetch,
        }
      : {
          data: { data: table },
          isPending: false,
          isSuccess: true,
          isError: false,
          isFetching: h.fetching[params.perspective] === true,
          error: null,
          refetch: h.refetch,
        };
  },
  useOptionsdeskControllerPositionBucket: (opts: { mutation?: { onSuccess?: () => void } }) => {
    h.captured = opts;
    return { mutate: vi.fn(), isPending: false, isError: false };
  },
}));

import { useLegTable, useSetPositionBucket } from './use-leg-table';

const SYMBOL = 'US:AAPL';
const OTHER_SYMBOL = 'US:MSFT';
const PERSPECTIVES = ['all', 'build', 'rent'] as const;

function renderWithSeededCache() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 三个视角各一份缓存（键形状 = 真实请求那份：`[url, params]`，params 含 perspective）。
  for (const perspective of PERSPECTIVES) {
    client.setQueryData(h.legsKey(SYMBOL, { perspective }), { data: { perspective } });
  }
  client.setQueryData(h.legsKey(OTHER_SYMBOL, { perspective: 'all' }), { data: {} });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  renderHook(() => useSetPositionBucket(SYMBOL), { wrapper });
  return client;
}

function invalidatedCount(client: QueryClient, symbol: string): number {
  return PERSPECTIVES.filter(
    (perspective) =>
      client.getQueryState(h.legsKey(symbol, { perspective }))?.isInvalidated === true,
  ).length;
}

describe('useSetPositionBucket 的失效面（FR-021）', () => {
  it('水位写成功 ⇒ **三个视角全部**失效（只失效一个 = 另外两个继续用旧口径打推荐标）', () => {
    const client = renderWithSeededCache();
    expect(invalidatedCount(client, SYMBOL)).toBe(0);

    h.captured.mutation?.onSuccess?.();

    expect(invalidatedCount(client, SYMBOL)).toBe(3);
  });

  it('用户停在**建仓**视角时改水位，建仓那份照样失效（SC-013 点名的最易漏路径）', () => {
    const client = renderWithSeededCache();

    h.captured.mutation?.onSuccess?.();

    expect(client.getQueryState(h.legsKey(SYMBOL, { perspective: 'build' }))?.isInvalidated).toBe(
      true,
    );
  });

  it('前缀 key 不越界到别的标的 —— 失效面止于本 symbol', () => {
    const client = renderWithSeededCache();

    h.captured.mutation?.onSuccess?.();

    expect(
      client.getQueryState(h.legsKey(OTHER_SYMBOL, { perspective: 'all' }))?.isInvalidated,
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 053 T016 —— 视角解析的**收敛性**（React #301 回归）
// ════════════════════════════════════════════════════════════════════════════
//
// 🚨 **这两条守的是一个不动点问题，不是一个渲染细节**：`useLegTable` 在 render 期同步回写
//    错峰闸（`setGate`），于是「视角解析」成了一次同步迭代 —— 它**必须有不动点**，否则 React
//    在 25 次重入后直接抛 `Too many re-renders`（生产构建里就是 `Minified React error #301`），
//    整块屏被 ErrorBoundary 接住 = **真机白屏**。
//
// 🚨 **触发它的不是罕见时序，是「选水位」这条主路径**：水位写成功 ⇒ 三份 key 一起失效 ⇒
//    三份在**不同的 tick** 落地 ⇒ 中间必然存在一个窗口，三份缓存对 `intent` **各执一词**。
//    只要「读哪一份 `intent`」这件事本身由上一拍解析出的视角决定，A→B、B→A 就是个 2-循环。
//    2026-08-14 对照实验：`main` 10 passed / 0 命中 `#301`，本分支 3 failed / 6 命中。
describe('useLegTable 的视角解析收敛性（T016 / React #301 回归）', () => {
  const SUBJECT = 'US:PEP';

  // 三份同一个业务日 ⇒ 一致性闩不参与，测出来的红只可能来自视角解析本身。
  const AS_OF = '2026-08-13';

  /** 链级字段齐、视角级字段空 —— 本组只关心 `intent` 怎么被读出来。 */
  function table(intent: string): Record<string, unknown> {
    return {
      intent,
      state: 'available',
      legs: [],
      criteria: null,
      positionBucket: null,
      asOf: AS_OF,
    };
  }

  beforeEach(() => {
    h.legsByPerspective = {};
    h.fetching = {};
  });

  it('三份缓存对 `intent` 各执一词（= 改水位后的失效窗口）⇒ 解析仍收敛，落位取新意图那一份', () => {
    // 全腿 / 建仓已带回新意图（`rent`），收租那份还是改水位之前的旧响应（`pending`）。
    // 🚨 这正是把「当前视角」当读取源首选时的死循环入笼：
    //    闸在 all ⇒ 读到 `rent` ⇒ 落位 rent ⇒ 闸切 rent ⇒ 读到 `pending` ⇒ 落位 all ⇒ 闸切回……
    h.legsByPerspective = {
      all: table('rent'),
      build: table('rent'),
      rent: table('pending'),
    };

    // 🚨 不收敛时 React 在 render 期抛 `Too many re-renders`，`renderHook` 原样抛出来 ⇒ 本行即红。
    const { result } = renderHook(() => useLegTable(SUBJECT));

    expect(result.current.tab).toBe('rent');
  });

  it('当前视角尚未落地时 `intent` 仍读得到（回退链是死循环的结构解，MUST NOT 摘）', () => {
    // 只有全腿到手且报 `rent` ⇒ 落位收租，而收租那份还在飞。
    h.legsByPerspective = { all: table('rent') };

    const { result } = renderHook(() => useLegTable(SUBJECT));

    // 摘掉回退链 ⇒ `intent` 变 `null` ⇒ 落位塌回全腿 ⇒ 又读到 `rent` ⇒ 052 T013 那个 #185 死循环回来。
    expect(result.current.tab).toBe('rent');
    // 视角级字段**不**回退（回退期它可能来自另一个视角）；链级字段照常读得到。
    expect(result.current.table).toBeNull();
    expect(result.current.chain?.intent).toBe('rent');
    expect(result.current.block).toBe('loading');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 064 T009 —— 首屏等待态 + 刷新保表（FR-022 / `state_branches` 13）
// ════════════════════════════════════════════════════════════════════════════
//
// 🚨 **这三条守的是「屏上这一批必须来自同一次召回」**：先渲染一份库内收盘档、再用实时结果
//    覆盖并重排，会在首屏制造一次用户没有发起过的「成员变化」，且让他在头几百毫秒里读到一份
//    **按昨收筛出来的候选集** —— 每个数字都渲染得出来，只是筛它的那口价是昨天的。
describe('064 T009 —— 首屏等待态 + 刷新保表（FR-022）', () => {
  const SUBJECT = 'US:KO';
  const AS_OF = '2026-08-18';

  function table(legs: readonly Record<string, unknown>[]): Record<string, unknown> {
    return {
      intent: 'rent',
      state: 'available',
      legs,
      criteria: null,
      positionBucket: null,
      asOf: AS_OF,
      priceKind: 'realtime',
      quoteAsOf: '2026-08-19T21:47:32',
    };
  }

  beforeEach(() => {
    h.legsByPerspective = {};
    h.fetching = {};
  });

  it('① 首屏加载中：`rows` 恒为**空** —— MUST NOT 先渲染一份库内收盘档的表', () => {
    // 三份都还没落地 = 真·首屏。若哪天改成「先出收盘档再覆盖」，这里会拿到非空。
    const { result } = renderHook(() => useLegTable(SUBJECT));

    expect(result.current.block).toBe('loading');
    expect(result.current.total).toBe(0);
    expect(result.current.sections[0]?.data).toHaveLength(0);
    // 首屏**不是**刷新：两者的文案与处置都不同（一个「正在取」、一个「屏上这批仍是」）。
    expect(result.current.isRefreshing).toBe(false);
  });

  it('② 刷新中：`rows` 保持**上一批的引用**不变，且 `isRefreshing` 为真（不遮罩不置灰的前提）', () => {
    const legs = [{ code: 'KO260918P062000' }, { code: 'KO260918P060000' }];
    const settled = table(legs);
    h.legsByPerspective = { all: settled, build: settled, rent: settled };

    const { result, rerender } = renderHook(() => useLegTable(SUBJECT));
    const before = result.current.sections[0]?.data;
    expect(before).toBe(legs);
    expect(result.current.isRefreshing).toBe(false);

    // 新一批在飞：React Query 重取期间旧 `data` 留在原地 ⇒ 屏上这批一行不动。
    h.fetching = { all: true, build: true, rent: true };
    rerender();

    expect(result.current.isRefreshing).toBe(true);
    // 🚨 **同一个引用**，不是「内容相等」—— 重建数组会让 `SectionList` 整表重挂载，
    //    用户眼里就是表闪了一下（而断言 `toEqual` 完全看不出来）。
    expect(result.current.sections[0]?.data).toBe(before);
    expect(result.current.total).toBe(2);
  });

  it('③ 零定时器 —— 🚫 MUST NOT 引入自动轮询（spec Assumption：取数只发生在进页面与刷新）', () => {
    vi.useFakeTimers();
    try {
      const settled = table([{ code: 'KO260918P062000' }]);
      h.legsByPerspective = { all: settled, build: settled, rent: settled };

      renderHook(() => useLegTable(SUBJECT));

      // 自动轮询无论用 setInterval 还是 setTimeout 自递归，都会在这里留下计数。
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 064 T010 —— 成员变化提示（FR-021 / SC-009 / `state_branches` 12）
// ════════════════════════════════════════════════════════════════════════════
//
// 🚨 **差集只在客户端算**：服务端无状态、不持有「这个客户端上一轮看到了哪些腿」——
//    🚫 MUST NOT 为它在服务端引入会话态。
// 🚨 **三个方向各断言一次**（只进不出 / 只出不进 / 有进有出）：只测一种的话，把两个集合
//    的差集写反（拿新集减旧集当「已不满足」）在那一种里照样对得上数。
describe('064 T010 —— 成员变化提示（FR-021）', () => {
  const SUBJECT = 'US:PG';
  const AS_OF = '2026-08-18';

  function table(codes: readonly string[]): Record<string, unknown> {
    return {
      intent: 'rent',
      state: 'available',
      legs: codes.map((code) => ({ code })),
      criteria: null,
      positionBucket: null,
      asOf: AS_OF,
      priceKind: 'realtime',
      quoteAsOf: '2026-08-19T21:47:32',
    };
  }

  /** 三份同批 —— 视角解析不参与，测出来的变化只可能来自差集本身。 */
  function seed(codes: readonly string[]): void {
    const one = table(codes);
    h.legsByPerspective = { all: one, build: one, rent: one };
  }

  beforeEach(() => {
    h.legsByPerspective = {};
    h.fetching = {};
  });

  it('① 首屏（没有上一轮）⇒ **不报**成员变化（否则一进页面就被告知「3 条进」）', () => {
    seed(['A', 'B', 'C']);

    const { result } = renderHook(() => useLegTable(SUBJECT));

    expect(result.current.membershipChange).toBeNull();
  });

  it('② 只进不出：新一轮多了 2 条 ⇒ 进 2 / 出 0', () => {
    seed(['A', 'B']);
    const { result, rerender } = renderHook(() => useLegTable(SUBJECT));

    seed(['A', 'B', 'C', 'D']);
    rerender();

    expect(result.current.membershipChange).toEqual({ entered: 2, left: 0 });
  });

  it('③ 只出不进：新一轮少了 1 条 ⇒ 进 0 / 出 1（正盯着那一行的人必须被告知）', () => {
    seed(['A', 'B', 'C']);
    const { result, rerender } = renderHook(() => useLegTable(SUBJECT));

    seed(['A', 'B']);
    rerender();

    expect(result.current.membershipChange).toEqual({ entered: 0, left: 1 });
  });

  it('④ 有进有出：换掉 1 条、又多进 1 条 ⇒ 进 2 / 出 1', () => {
    seed(['A', 'B', 'C']);
    const { result, rerender } = renderHook(() => useLegTable(SUBJECT));

    seed(['A', 'B', 'D', 'E']);
    rerender();

    expect(result.current.membershipChange).toEqual({ entered: 2, left: 1 });
  });

  it('⑤ 成员完全相同（顺序变了也算相同）⇒ 不报 —— 重排不是成员变化', () => {
    seed(['A', 'B', 'C']);
    const { result, rerender } = renderHook(() => useLegTable(SUBJECT));

    seed(['C', 'A', 'B']);
    rerender();

    expect(result.current.membershipChange).toBeNull();
  });

  it('⑥ 可关闭 —— 关掉之后不再复现（下一轮真有变化时才会重新出现）', () => {
    seed(['A']);
    const { result, rerender } = renderHook(() => useLegTable(SUBJECT));
    seed(['A', 'B']);
    rerender();
    expect(result.current.membershipChange).not.toBeNull();

    act(() => result.current.dismissMembershipChange());

    expect(result.current.membershipChange).toBeNull();
  });
});
