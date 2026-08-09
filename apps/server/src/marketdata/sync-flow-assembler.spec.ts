import { describe, it, expect } from 'vitest';
import type { FlowJob } from 'bullmq';
import {
  assembleSyncFlow,
  deriveExecutionOrder,
  type FlowDimensionInput,
  type SyncDependencyEdge,
} from './sync-flow-assembler.js';
import type { DimensionKey } from './dimension-executor.js';
import { MARKETDATA_SYNC_QUEUE } from './marketdata-sync.worker.js';

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

function dim(key: DimensionKey, retryMax = 3): FlowDimensionInput {
  return {
    payload: { dimensionKey: key, mode: 'delta', asOf: '2026-06-01', triggeredBy: 'tick' },
    opts: { attempts: retryMax, backoff: { type: 'exponential', delay: 60_000 } },
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
    const root = assembleSyncFlow([dim('eod_bar')], T011_EDGES, T011_ORDER);
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
    const root = assembleSyncFlow([dim('eod_bar')], SEED_EDGES, ORDER);
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
      ),
    ).toThrow(/未知维度/);
    expect(() => assembleSyncFlow([dim('eod_bar'), dim('eod_bar')], SEED_EDGES, ORDER)).toThrow(
      /重复/,
    );
    expect(() => assembleSyncFlow([], SEED_EDGES, ORDER)).toThrow(/空/);
  });
});
