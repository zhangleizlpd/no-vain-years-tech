import { describe, it, expect } from 'vitest';
import type { FlowJob } from 'bullmq';
import {
  assembleSyncFlow,
  assertHardEdgesWithinLane,
  deriveExecutionOrder,
  MARKET_SYNC_STAGGER,
  NO_SYNC_STAGGER,
  type FlowDimensionInput,
  type SyncDependencyEdge,
  type SyncStaggerSpec,
} from './sync-flow-assembler.js';
import type { DimensionKey } from './dimension-executor.js';
import { MARKETDATA_SYNC_FUTU_QUEUE, MARKETDATA_SYNC_QUEUE } from './marketdata-sync.queue.js';

/** seed 6 边 (017 T005): universe→* 全 soft ×5 + profile→fundamental hard。 */
const SEED_EDGES: SyncDependencyEdge[] = [
  { upstream: 'universe', downstream: 'profile', mode: 'soft' },
  { upstream: 'universe', downstream: 'eod_bar', mode: 'soft' },
  { upstream: 'universe', downstream: 'fundamental', mode: 'soft' },
  { upstream: 'universe', downstream: 'financial', mode: 'soft' },
  { upstream: 'universe', downstream: 'corporate_action', mode: 'soft' },
  { upstream: 'profile', downstream: 'fundamental', mode: 'hard' },
];

/** seed priority (019 T005 调值复现 017 现行常量序: fundamental 8 > financial 7 > eod 6)。 */
const SEED_PRIORITIES = new Map<string, number>([
  ['universe', 10],
  ['profile', 9],
  ['fundamental', 8],
  ['financial', 7],
  ['eod_bar', 6],
  ['corporate_action', 5],
]);

/** 派生全序 (各 assembleSyncFlow 调用点同源)。 */
const ORDER = deriveExecutionOrder(SEED_EDGES, SEED_PRIORITIES);

function dim(
  key: DimensionKey,
  retryMax = 3,
  queueName: string = MARKETDATA_SYNC_QUEUE,
): FlowDimensionInput {
  return {
    payload: { dimensionKey: key, mode: 'delta', asOf: '2026-06-01', triggeredBy: 'tick' },
    opts: { attempts: retryMax, backoff: { type: 'exponential', delay: 60_000 } },
    queueName,
  };
}

/** 树 root → 最深 child 的链 (每层至多一个 child, D3 嵌套链不变式)。 */
function chainFromRoot(root: FlowJob): FlowJob[] {
  const chain: FlowJob[] = [];
  let node: FlowJob | undefined = root;
  while (node) {
    chain.push(node);
    expect(node.children?.length ?? 0).toBeLessThanOrEqual(1);
    node = node.children?.[0];
  }
  return chain;
}

describe('019 T005 deriveExecutionOrder (Kahn 拓扑 + priority tie-break, 常量退役)', () => {
  it('派生序 ≡ 017 旧常量序对拍 (行为保持门: seed 边 + 调值后 priority)', () => {
    expect(ORDER).toEqual([
      'universe',
      'profile',
      'fundamental',
      'financial',
      'eod_bar',
      'corporate_action',
    ]);
  });

  it('tie-break: 同 priority → key 字典序 (确定性是 hard 边相邻校验前提)', () => {
    const flat = new Map<string, number>([
      ['b_dim', 0],
      ['a_dim', 0],
      ['c_dim', 0],
    ]);
    expect(deriveExecutionOrder([], flat)).toEqual(['a_dim', 'b_dim', 'c_dim']);
  });

  it('ready 集内 priority desc 先出 (边约束优先于 priority)', () => {
    // a→c 边: c 尽管 priority 最高也必须等 a; b 无边但 priority 低于 a。
    const edges: SyncDependencyEdge[] = [{ upstream: 'a', downstream: 'c', mode: 'soft' }];
    const prio = new Map<string, number>([
      ['a', 5],
      ['b', 1],
      ['c', 99],
    ]);
    expect(deriveExecutionOrder(edges, prio)).toEqual(['a', 'c', 'b']);
  });

  it('环 → fail-fast throw (assertAcyclic 复用, 不静默)', () => {
    const edges: SyncDependencyEdge[] = [
      { upstream: 'a', downstream: 'b', mode: 'soft' },
      { upstream: 'b', downstream: 'a', mode: 'soft' },
    ];
    expect(() => deriveExecutionOrder(edges, new Map([['a', 1]]))).toThrow(/环/);
  });

  it('边端点不在 priority 表 → 仍入序 (priority 兜底 0, 不丢节点)', () => {
    const edges: SyncDependencyEdge[] = [{ upstream: 'known', downstream: 'orphan', mode: 'soft' }];
    const order = deriveExecutionOrder(edges, new Map([['known', 1]]));
    expect(order).toEqual(['known', 'orphan']);
  });

  it('新维度 = 一行 priority (+ 可选边) 即入派生序, 零常量改动 (SC-S05 机制半)', () => {
    const prio = new Map(SEED_PRIORITIES).set('test_dimension', 4);
    const order = deriveExecutionOrder(SEED_EDGES, prio);
    expect(order).toEqual([
      'universe',
      'profile',
      'fundamental',
      'financial',
      'eod_bar',
      'corporate_action',
      'test_dimension',
    ]);
  });
});

// 019 T011 hard 边 corp→eod + 派生序变更 (D8 此时加 — 拓扑派生落地后): priority 调整
// corp 6 / eod 5 (financial 7 不动, analyze H1), 派生序 corp 提至 eod 前, 两 hard 边链相邻。
describe('019 T011 hard 边 corp→eod + 派生序变更 (D8)', () => {
  const T011_EDGES: SyncDependencyEdge[] = [
    ...SEED_EDGES,
    { upstream: 'corporate_action', downstream: 'eod_bar', mode: 'hard' },
  ];
  const T011_PRIORITIES = new Map<string, number>([
    ['universe', 10],
    ['profile', 9],
    ['fundamental', 8],
    ['financial', 7],
    ['corporate_action', 6],
    ['eod_bar', 5],
  ]);
  const T011_ORDER = deriveExecutionOrder(T011_EDGES, T011_PRIORITIES);

  it('派生序: corp 提至 eod 前 — [universe, profile, fundamental, financial, corp, eod]', () => {
    expect(T011_ORDER).toEqual([
      'universe',
      'profile',
      'fundamental',
      'financial',
      'corporate_action',
      'eod_bar',
    ]);
  });

  it('全 won 链装配: 两条 hard 边均链相邻可表达 (profile→fundamental + corp→eod)', () => {
    const root = assembleSyncFlow(
      T011_ORDER.map((k) => dim(k as DimensionKey)),
      T011_EDGES,
      T011_ORDER,
      NO_SYNC_STAGGER,
    );
    const chain = chainFromRoot(root);
    expect(chain.map((n) => n.name)).toEqual([
      'sync:eod_bar',
      'sync:corporate_action',
      'sync:financial',
      'sync:fundamental',
      'sync:profile',
      'sync:universe',
    ]);
    // hard 边 opts: corp (eod 的 child) + profile (fundamental 的 child) = failParentOnFailure。
    expect(chain[1]?.opts?.failParentOnFailure).toBe(true); // corp→eod hard。
    expect(chain[4]?.opts?.failParentOnFailure).toBe(true); // profile→fundamental hard。
  });

  it('corp 未 won 时 eod 照跑不阻塞 (hard 边仅同 won 生效, FR-S08)', () => {
    const root = assembleSyncFlow([dim('eod_bar')], T011_EDGES, T011_ORDER, NO_SYNC_STAGGER);
    expect(root.name).toBe('sync:eod_bar');
    expect(root.children ?? []).toHaveLength(0);
    expect(root.opts?.failParentOnFailure).toBeUndefined();
  });

  it('won={corp, eod}: corp 先执行 (最深 child), eod 为 root 带 hard 传播', () => {
    const chain = chainFromRoot(
      assembleSyncFlow(
        ['corporate_action', 'eod_bar'].map((k) => dim(k as DimensionKey)),
        T011_EDGES,
        T011_ORDER,
        NO_SYNC_STAGGER,
      ),
    );
    expect(chain.map((n) => n.name)).toEqual(['sync:eod_bar', 'sync:corporate_action']);
    expect(chain[1]?.opts?.failParentOnFailure).toBe(true); // corp 失败断 eod (因子未就位不重算)。
  });
});

describe('017 T012 sync-flow-assembler (DAG→单亲嵌套链树, D3; 019 T005 全序改派生注入)', () => {
  it('周一全集: 全序嵌套链 root=corporate_action…最深 child=universe, 逐边 opts 正确', () => {
    const root = assembleSyncFlow(
      ORDER.map((k) => dim(k as DimensionKey)),
      SEED_EDGES,
      ORDER,
      NO_SYNC_STAGGER,
    );
    const chain = chainFromRoot(root);
    // root → 最深 child = 全序倒排 (后继为 parent)。
    expect(chain.map((n) => n.name)).toEqual([
      'sync:corporate_action',
      'sync:eod_bar',
      'sync:financial',
      'sync:fundamental',
      'sync:profile',
      'sync:universe',
    ]);
    // 全节点 queueName + payload 维度对齐 + 基础 opts 保留 (attempts 经 jobOpts 注入)。
    for (const n of chain) {
      expect(n.queueName).toBe(MARKETDATA_SYNC_QUEUE);
      expect(`sync:${(n.data as { dimensionKey: string }).dimensionKey}`).toBe(n.name);
      expect(n.opts?.attempts).toBe(3);
    }
    // 真实边: universe→profile soft → universe (profile 的 child) = ignoreDependencyOnFailure。
    const universe = chain[5]!;
    expect(universe.opts?.ignoreDependencyOnFailure).toBe(true);
    expect(universe.opts?.failParentOnFailure).toBeUndefined();
    // 真实边: profile→fundamental hard → profile (fundamental 的 child) = failParentOnFailure。
    const profile = chain[4]!;
    expect(profile.opts?.failParentOnFailure).toBe(true);
    expect(profile.opts?.ignoreDependencyOnFailure).toBeUndefined();
    // 无真实边相邻对 (fundamental/financial/eod_bar) → 一律显式 ignore (裸 child = parent 永久 waiting-children)。
    for (const n of [chain[1]!, chain[2]!, chain[3]!]) {
      expect(n.opts?.ignoreDependencyOnFailure).toBe(true);
    }
    // root 无 parent → 不挂边 opts。
    expect(root.opts?.ignoreDependencyOnFailure).toBeUndefined();
    expect(root.opts?.failParentOnFailure).toBeUndefined();
  });

  it('全树无裸 child: 每个非 root 节点恰好带二选一边 opts (周一全集)', () => {
    const chain = chainFromRoot(
      assembleSyncFlow(
        ORDER.map((k) => dim(k as DimensionKey)),
        SEED_EDGES,
        ORDER,
        NO_SYNC_STAGGER,
      ),
    );
    for (const n of chain.slice(1)) {
      const flags = [n.opts?.failParentOnFailure, n.opts?.ignoreDependencyOnFailure].filter(
        (f) => f === true,
      );
      expect(flags).toHaveLength(1);
    }
  });

  it('周二缺 universe: 链从 profile 起构, hard 边 opts 保留 (universe 缺席日下游当根照跑)', () => {
    const won: DimensionKey[] = [
      'profile',
      'fundamental',
      'financial',
      'eod_bar',
      'corporate_action',
    ];
    const chain = chainFromRoot(
      assembleSyncFlow(
        won.map((k) => dim(k)),
        SEED_EDGES,
        ORDER,
        NO_SYNC_STAGGER,
      ),
    );
    expect(chain.map((n) => n.name)).toEqual([
      'sync:corporate_action',
      'sync:eod_bar',
      'sync:financial',
      'sync:fundamental',
      'sync:profile',
    ]);
    expect(chain[4]?.opts?.failParentOnFailure).toBe(true); // profile→fundamental hard 照挂。
  });

  it('单维度退化: 单 job 无 children、不挂边 opts', () => {
    const root = assembleSyncFlow([dim('eod_bar')], SEED_EDGES, ORDER, NO_SYNC_STAGGER);
    expect(root.name).toBe('sync:eod_bar');
    expect(root.children ?? []).toHaveLength(0);
    expect(root.opts?.failParentOnFailure).toBeUndefined();
    expect(root.opts?.ignoreDependencyOnFailure).toBeUndefined();
  });

  it('won 子集相邻化: hard 边两端在 won 链内相邻即可表达 (中间维度不 due 不算断链)', () => {
    // won={profile,fundamental}: hard 边在 won 链相邻 → 可表达。
    const chain = chainFromRoot(
      assembleSyncFlow(
        ['profile', 'fundamental'].map((k) => dim(k as DimensionKey)),
        SEED_EDGES,
        ORDER,
        NO_SYNC_STAGGER,
      ),
    );
    expect(chain.map((n) => n.name)).toEqual(['sync:fundamental', 'sync:profile']);
    expect(chain[1]?.opts?.failParentOnFailure).toBe(true);
  });

  it('不可表达: hard 边在 won 链非相邻 → throw (禁静默错装)', () => {
    // admin 误改 universe→eod_bar soft→hard: 全集链中二者非相邻 → 失败传播绕不过去。
    const edges = SEED_EDGES.map((e) =>
      e.upstream === 'universe' && e.downstream === 'eod_bar' ? { ...e, mode: 'hard' as const } : e,
    );
    // 注: 派生序仍用原 seed 边 (改 mode 不改图形状, 序不变)。
    expect(() =>
      assembleSyncFlow(
        ORDER.map((k) => dim(k as DimensionKey)),
        edges,
        ORDER,
        NO_SYNC_STAGGER,
      ),
    ).toThrow(/hard/);
  });

  it('不可表达: 环 → throw', () => {
    const edges: SyncDependencyEdge[] = [
      ...SEED_EDGES,
      { upstream: 'fundamental', downstream: 'profile', mode: 'soft' }, // profile→fundamental→profile 环。
    ];
    expect(() =>
      assembleSyncFlow(
        ORDER.map((k) => dim(k as DimensionKey)),
        edges,
        ORDER,
        NO_SYNC_STAGGER,
      ),
    ).toThrow(/环/);
  });

  it('不可表达: 边方向与维度全序矛盾 (倒流 soft 边) → throw', () => {
    const edges: SyncDependencyEdge[] = [
      ...SEED_EDGES,
      { upstream: 'eod_bar', downstream: 'profile', mode: 'soft' }, // 全序中 eod_bar 在 profile 后。
    ];
    expect(() =>
      assembleSyncFlow(
        ORDER.map((k) => dim(k as DimensionKey)),
        edges,
        ORDER,
        NO_SYNC_STAGGER,
      ),
    ).toThrow(/全序|方向|环/);
  });

  it('非法输入: 未知维度键 / 重复维度 / 空集 → throw', () => {
    expect(() =>
      assembleSyncFlow(
        [
          {
            ...dim('eod_bar'),
            payload: { ...dim('eod_bar').payload, dimensionKey: 'bogus' as DimensionKey },
          },
        ],
        SEED_EDGES,
        ORDER,
        NO_SYNC_STAGGER,
      ),
    ).toThrow(/未知维度/);
    expect(() =>
      assembleSyncFlow([dim('eod_bar'), dim('eod_bar')], SEED_EDGES, ORDER, NO_SYNC_STAGGER),
    ).toThrow(/重复/);
    expect(() => assembleSyncFlow([], SEED_EDGES, ORDER, NO_SYNC_STAGGER)).toThrow(/空/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #210 vendor lane 隔离
// ─────────────────────────────────────────────────────────────────────────────

describe('#210 一棵树只能属于一条 lane', () => {
  const ORDER = ['universe', 'profile', 'eod_bar'];

  it('混入两条 lane ⇒ throw —— 跨 lane 的 parent-child 等待 = 队头阻塞换了个地方', () => {
    expect(() =>
      assembleSyncFlow(
        [dim('universe'), dim('profile', 3, MARKETDATA_SYNC_FUTU_QUEUE)],
        [],
        ORDER,
        NO_SYNC_STAGGER,
      ),
    ).toThrow(/跨 lane/);
  });

  it('单 lane 树: 每个节点都带该 lane 的 queueName (不再硬编码 marketdata-sync)', () => {
    const tree = assembleSyncFlow(
      [
        dim('universe', 3, MARKETDATA_SYNC_FUTU_QUEUE),
        dim('profile', 3, MARKETDATA_SYNC_FUTU_QUEUE),
      ],
      [],
      ORDER,
      NO_SYNC_STAGGER,
    );
    const names: string[] = [];
    for (let node: FlowJob | undefined = tree; node !== undefined; node = node.children?.[0]) {
      names.push(node.queueName);
    }
    expect(names).toEqual([MARKETDATA_SYNC_FUTU_QUEUE, MARKETDATA_SYNC_FUTU_QUEUE]);
  });
});

describe('assertHardEdgesWithinLane (#210)', () => {
  const HARD: SyncDependencyEdge[] = [
    { upstream: 'option_contract', downstream: 'option_daily_snapshot', mode: 'hard' },
  ];

  it('两端同 lane ⇒ 通过', () => {
    const lanes = new Map([
      ['option_contract', 'futu'],
      ['option_daily_snapshot', 'futu'],
    ]);
    expect(() => assertHardEdgesWithinLane(HARD, lanes)).not.toThrow();
  });

  // 🚨 这条守的是「hard 边静默失效」再来一次: 跨 lane ⇒ 分进两棵树 ⇒ failParentOnFailure
  //    装不上 ⇒ 「链发现失败必须断下游」又变成一句全绿的空话 (跨 tick 那次就是这么丢的)。
  it('两端跨 lane ⇒ throw', () => {
    const lanes = new Map([
      ['option_contract', 'futu'],
      ['option_daily_snapshot', 'default'],
    ]);
    expect(() => assertHardEdgesWithinLane(HARD, lanes)).toThrow(/跨 lane/);
  });

  it('一端本轮未 won ⇒ 通过 (该边本轮本就不生效, 与既有相邻性判据同语义)', () => {
    const lanes = new Map([['option_contract', 'futu']]);
    expect(() => assertHardEdgesWithinLane(HARD, lanes)).not.toThrow();
  });

  // 📌 soft 边跨 lane 是**允许**的: 它只定执行序, 而「跨 lane 互不排队」正是拆 lane 的目的。
  it('soft 边跨 lane ⇒ 通过 (刻意, 不在本门管辖内)', () => {
    const soft: SyncDependencyEdge[] = [
      { upstream: 'universe', downstream: 'hk_option_contract', mode: 'soft' },
    ];
    const lanes = new Map([
      ['universe', 'default'],
      ['hk_option_contract', 'futu'],
    ]);
    expect(() => assertHardEdgesWithinLane(soft, lanes)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 075 T005 逐市场采集错开 (FR-014 / FR-015 / FR-017 / FR-018 / FR-019 / FR-019a /
// FR-019b / FR-023; state_branches 13/14/15/16; US2 / US3)
// ─────────────────────────────────────────────────────────────────────────────

describe('075 T005 错开落在装配期 (判据 = 这个 parent 真把它声明的上游包成了 immediate child)', () => {
  /** 现役两对「链发现 → 快照」+ universe 的 soft 边 (mode 取自 20260827_1957: 美股 hard / 港股 soft)。 */
  const STAGGER_EDGES: SyncDependencyEdge[] = [
    { upstream: 'universe', downstream: 'option_contract', mode: 'soft' },
    { upstream: 'option_contract', downstream: 'option_daily_snapshot', mode: 'hard' },
    { upstream: 'hk_option_contract', downstream: 'hk_option_daily_snapshot', mode: 'soft' },
  ];
  const STAGGER_PRIORITIES = new Map<string, number>([
    ['universe', 10],
    ['hk_option_contract', 5],
    ['hk_option_daily_snapshot', 5],
    ['option_contract', 5],
    ['option_daily_snapshot', 5],
  ]);
  const S_ORDER = deriveExecutionOrder(STAGGER_EDGES, STAGGER_PRIORITIES);
  const MINUTE = 60_000;
  const ruleOf = (market: string) => MARKET_SYNC_STAGGER.find((r) => r.market === market)!;
  const usWon = () => [dim('option_contract'), dim('option_daily_snapshot')];
  const hkWon = () => [dim('hk_option_contract'), dim('hk_option_daily_snapshot')];

  it('① 上游 won 且链上相邻 ⇒ 下游 parent 带 delay (FR-014, sb 14 正面)', () => {
    // 取值本身也钉一遍: 30 分钟的出处见 MARKET_SYNC_STAGGER 的 doc (FR-023)。
    expect(ruleOf('us').delayMs).toBe(30 * MINUTE);
    const root = assembleSyncFlow(usWon(), STAGGER_EDGES, S_ORDER, MARKET_SYNC_STAGGER);
    expect(root.name).toBe('sync:option_daily_snapshot');
    expect(root.children?.[0]?.name).toBe('sync:option_contract'); // parent 真包住了上游。
    expect(root.opts?.delay).toBe(30 * MINUTE);
    // 上游 (child) 自己不带 delay —— 它是这条链上先跑的那个。
    expect(root.children?.[0]?.opts?.delay).toBeUndefined();
  });

  // 🚨 这条是本 task 的**反面判据**: 落点若改回「无条件挂在下游维度的 opts 上」, BullMQ 对
  //    无 children 的 job 从**入队时刻**起算 delay ⇒ 链根白等一个间隔 (FR-017 直接违反)。
  it('② 上游本轮未 won ⇒ 下游不带 delay, 不空等 (FR-017, sb 13)', () => {
    // (a) 下游独自成链根 (无 children)。
    const lone = assembleSyncFlow(
      [dim('option_daily_snapshot')],
      STAGGER_EDGES,
      S_ORDER,
      MARKET_SYNC_STAGGER,
    );
    expect(lone.children ?? []).toHaveLength(0);
    expect(lone.opts?.delay).toBeUndefined();
    // (b) 下游 won 但它包住的 immediate child 不是它声明的上游 (是 universe)。
    const root = assembleSyncFlow(
      [dim('universe'), dim('option_daily_snapshot')],
      STAGGER_EDGES,
      S_ORDER,
      MARKET_SYNC_STAGGER,
    );
    expect(root.children?.[0]?.name).toBe('sync:universe');
    expect(root.opts?.delay).toBeUndefined();
  });

  it('③ 取值 0 的市场 (港股当前) ⇒ 装出的树与「不错开」逐字段相同 (FR-019a, sb 15)', () => {
    expect(ruleOf('hk').delayMs).toBe(0);
    const withTable = assembleSyncFlow(hkWon(), STAGGER_EDGES, S_ORDER, MARKET_SYNC_STAGGER);
    const without = assembleSyncFlow(hkWon(), STAGGER_EDGES, S_ORDER, NO_SYNC_STAGGER);
    expect(withTable).toEqual(without);
    // 「逐字段相同」= 连 `delay` 这个 key 都不许多出来 (写 delay:0 会让 opts 多一个字段)。
    expect(Object.keys(withTable.opts ?? {})).not.toContain('delay');
  });

  it('④ 一市改值不影响另一市 (FR-019b, sb 16)', () => {
    const hkOpened: SyncStaggerSpec = MARKET_SYNC_STAGGER.map((r) =>
      r.market === 'hk' ? { ...r, delayMs: 10 * MINUTE } : r,
    );
    expect(assembleSyncFlow(usWon(), STAGGER_EDGES, S_ORDER, hkOpened)).toEqual(
      assembleSyncFlow(usWon(), STAGGER_EDGES, S_ORDER, MARKET_SYNC_STAGGER),
    );
    const usZeroed: SyncStaggerSpec = MARKET_SYNC_STAGGER.map((r) =>
      r.market === 'us' ? { ...r, delayMs: 0 } : r,
    );
    expect(assembleSyncFlow(hkWon(), STAGGER_EDGES, S_ORDER, usZeroed)).toEqual(
      assembleSyncFlow(hkWon(), STAGGER_EDGES, S_ORDER, MARKET_SYNC_STAGGER),
    );
  });

  it('⑤ 取值超上界 ⇒ 装配期 throw, 不运行期静默偏移 (FR-018, sb 14 反面)', () => {
    const tooLong: SyncStaggerSpec = MARKET_SYNC_STAGGER.map((r) =>
      r.market === 'us' ? { ...r, delayMs: r.maxDelayMs + 1 } : r,
    );
    expect(() => assembleSyncFlow(usWon(), STAGGER_EDGES, S_ORDER, tooLong)).toThrow(/上界/);
    // 全表校验: 违规那对本轮**没 won** 也要拒 —— 一张配错的表在任何一轮都是错的。
    expect(() => assembleSyncFlow([dim('universe')], STAGGER_EDGES, S_ORDER, tooLong)).toThrow(
      /上界/,
    );
    // 负值 / 非整数毫秒同样拒 (delay 不是「负着跑」, 那是配置损坏)。
    for (const bad of [-1, 1.5, Number.NaN]) {
      const broken: SyncStaggerSpec = [{ ...ruleOf('us'), delayMs: bad }];
      expect(() => assembleSyncFlow([dim('universe')], STAGGER_EDGES, S_ORDER, broken)).toThrow(
        /非负整数/,
      );
    }
  });

  // US3-AS2: 这条来自 Acceptance Scenario 层 (analyze 的三张矩阵扫不到), 故显式挂账。
  it('⑥ 港股取值改成非 0 ⇒ 按与美股同一套语义生效, 且改动面只有取值本身 (US3-AS2)', () => {
    const HK_TRIAL_MS = 20 * MINUTE;
    const hkOpened: SyncStaggerSpec = MARKET_SYNC_STAGGER.map((r) =>
      r.market === 'hk' ? { ...r, delayMs: HK_TRIAL_MS } : r,
    );
    // 「只改取值那一行」的机器判据: 把 delayMs 抹平后整张表与现役表逐字段相同。
    const strip = (s: SyncStaggerSpec) => s.map((r) => ({ ...r, delayMs: 0 }));
    expect(strip(hkOpened)).toEqual(strip(MARKET_SYNC_STAGGER));
    const root = assembleSyncFlow(hkWon(), STAGGER_EDGES, S_ORDER, hkOpened);
    expect(root.name).toBe('sync:hk_option_daily_snapshot');
    expect(root.children?.[0]?.name).toBe('sync:hk_option_contract');
    expect(root.opts?.delay).toBe(HK_TRIAL_MS);
    // 同一套语义 = 臂 ② 对港股同样成立 (上游未 won 不空等), 不是「美股专用」的另一条路径。
    const lone = assembleSyncFlow(
      [dim('hk_option_daily_snapshot')],
      STAGGER_EDGES,
      S_ORDER,
      hkOpened,
    );
    expect(lone.opts?.delay).toBeUndefined();
  });
});
