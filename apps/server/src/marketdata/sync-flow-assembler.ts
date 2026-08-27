import type { FlowJob, JobsOptions } from 'bullmq';
import { dimensionJobName, type DimensionJobPayload } from './marketdata-sync.queue.js';

/** `sync_dependency` 边 (PG 真相层投影; seed 6 边, 未来 admin 可增)。 */
export interface SyncDependencyEdge {
  upstream: string;
  downstream: string;
  mode: 'hard' | 'soft';
}

/**
 * 维度全序派生 (019 T005, 常量 `DIMENSION_EXECUTION_ORDER` 退役): Kahn 拓扑排序,
 * ready 集 tie-break = `SyncDimension.priority` desc 再 key 字典序 — 派生序**确定性**是
 * hard 边相邻校验 (assertEdgesExpressible) 的前提。环 → fail-fast throw (assertAcyclic
 * 复用)。节点集 = priority 表全键 ∪ 边端点 (端点缺 priority 兜底 0, 不丢节点)。
 * 行为保持 (FR-S07): seed priority 调值后派生序 ≡ 017 旧常量序 (spec 对拍断言)。
 * 复杂度 O(V² + E) — 维度数 ≤ 个位~十位, ready 集线性扫优于堆的常数开销。
 */
export function deriveExecutionOrder(
  edges: SyncDependencyEdge[],
  priorityByKey: ReadonlyMap<string, number>,
): string[] {
  assertAcyclic(edges);
  const nodes = new Set<string>(priorityByKey.keys());
  for (const e of edges) {
    nodes.add(e.upstream);
    nodes.add(e.downstream);
  }
  const inDegree = new Map<string, number>([...nodes].map((n) => [n, 0]));
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    inDegree.set(e.downstream, (inDegree.get(e.downstream) ?? 0) + 1);
    const list = adjacency.get(e.upstream) ?? [];
    list.push(e.downstream);
    adjacency.set(e.upstream, list);
  }
  const prio = (k: string): number => priorityByKey.get(k) ?? 0;
  const order: string[] = [];
  const ready = [...nodes].filter((n) => inDegree.get(n) === 0);
  while (ready.length > 0) {
    // ready 集选优: priority desc → key asc (线性扫, 见上复杂度注)。
    let pick = 0;
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i];
      const b = ready[pick];
      if (prio(a) > prio(b) || (prio(a) === prio(b) && a < b)) pick = i;
    }
    const [node] = ready.splice(pick, 1);
    order.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) ready.push(next);
    }
  }
  return order;
}

/** 装配输入: won 维度的 payload + 基础 job opts (attempts/backoff/removeOn*, 经 jobOpts 注入)。 */
export interface FlowDimensionInput {
  payload: DimensionJobPayload;
  opts: JobsOptions;
  /**
   * 该维度所属 lane 的 queue 名 (`queueNameForLane(lane)`)。
   *
   * 🚨 **必填, 蓄意不给默认值** (#210): 给默认值 = 新入队路径静默把 futu 的活装进 default
   * 队列, 又排回理杏仁后面 —— 那正是本次要根除的东西。必填 ⇒ 漏传是 typecheck 红。
   */
  queueName: string;
}

/**
 * DAG→单亲嵌套链树装配器 (017 T012, plan D3 ⚠️)。
 *
 * BullMQ flow 是**单亲树** (一个 job 只能有一个 parent, context7 实证) — `sync_dependency`
 * 的「universe 单源 5 下游」DAG 不可直表 → 消解规则:
 *   1. won 集按维度全序构**嵌套链** (后继为 parent、前驱为 child): 最深 child 最先执行,
 *      parent 等 children 终态 — 「等待」语义由链嵌套 + 单 queue concurrency=1 承载。
 *   2. 每条 child-edge opts: 相邻对有真实边 → hard=`failParentOnFailure` /
 *      soft=`ignoreDependencyOnFailure`; **无真实边一律显式 `ignoreDependencyOnFailure`**
 *      (纯执行序, 失败不传播) — 裸 child 会让 parent 永久卡 `waiting-children` (context7 实证)。
 *   3. 不可表达拓扑**必须 throw** (禁静默错装, 任意 DAG 装配 = 管理界面 feature 的 seam):
 *      环 / 边方向与全序倒流 / hard 边在 won 链非相邻 (失败传播绕不过中间节点)。
 *
 * 语义核对 (spec FR-S09): universe 失败 → profile child=ignore → 全下游照跑 (soft 传递成立);
 * profile 失败 → fundamental failParent (hard); universe 不 due (周二) → 链从 profile 起,
 * 下游当根照跑。纯函数无副作用; 复杂度 O(V+E) (环检 DFS + 链装配线性)。
 */
export function assembleSyncFlow(
  dimensions: FlowDimensionInput[],
  edges: SyncDependencyEdge[],
  executionOrder: readonly string[],
): FlowJob {
  // won 链 = won 集按全序排序; chain[i-1] 是 chain[i] 的 child。全序由调用点
  // deriveExecutionOrder(edges, priority) 派生注入 (019 T005, 常量退役)。
  const chain = sortedWonChain(dimensions, executionOrder);
  assertSingleLane(chain);
  assertEdgesExpressible(edges, chain, executionOrder);

  const edgeByPair = new Map(edges.map((e) => [`${e.upstream}→${e.downstream}`, e]));
  const toNode = (d: FlowDimensionInput): FlowJob => ({
    name: dimensionJobName(d.payload.dimensionKey),
    queueName: d.queueName,
    data: d.payload,
    opts: { ...d.opts },
  });

  // 嵌套链装配: 从最深 child (chain[0]) 向 root (chain[n-1]) 逐层包裹。
  const [first, ...rest] = chain;
  if (!first) throw new Error('flow 装配输入为空 (won 集至少 1 维度)');
  let node = toNode(first);
  let prevKey = first.payload.dimensionKey;
  for (const d of rest) {
    // child (前驱) 的边 opts: 真实相邻边 hard/soft 二选一; 无边显式 ignore (裸 child 禁)。
    const real = edgeByPair.get(`${prevKey}→${d.payload.dimensionKey}`);
    node.opts = {
      ...node.opts,
      ...(real?.mode === 'hard'
        ? { failParentOnFailure: true }
        : { ignoreDependencyOnFailure: true }),
    };
    node = { ...toNode(d), children: [node] };
    prevKey = d.payload.dimensionKey;
  }
  return node;
}

/**
 * won 集内的 **hard 边两端必须同 lane** —— 否则 throw (#210)。
 *
 * 🚨 **这道门存在的理由是一个已经发生过的、静默了几个月的 bug**: `hk_option_contract →
 * hk_option_daily_snapshot` 与 `option_contract → option_daily_snapshot` 两条 hard 边, 因为
 * 两端 cron 差 30 分钟落在**不同 tick**, 从上线起就一次都没装配过 —— `assertEdgesExpressible`
 * 见到 `chainPos.get(upstream) === undefined` 就整段跳过, 于是「链发现失败必须断下游」这条
 * 语义**一直是句空话**, 而且全绿。
 *
 * 拆 lane 引入了**第二条**能让同一件事再发生一次的路径: 两端同 tick 但分属不同 lane ⇒ 分进
 * 两棵树 ⇒ `failParentOnFailure` 同样装不上, 同样全绿。⇒ 这里必须**吵**, 不能沿用
 * 「一端不在链里就跳过」那套沉默。
 *
 * 📌 **soft 边跨 lane 是允许的, 不在本门管辖内**: 它只定执行序, 而「跨 lane 不再排队」正是
 * 拆 lane 的目的本身。只有 hard 边的失败传播是**语义**, 丢了不响。
 *
 * @param laneByKey 只含**本轮 won** 的维度 → 其生效 lane; 一端不在其中 = 该边本轮本就不生效。
 */
export function assertHardEdgesWithinLane(
  edges: readonly SyncDependencyEdge[],
  laneByKey: ReadonlyMap<string, string>,
): void {
  for (const e of edges) {
    if (e.mode !== 'hard') continue;
    const up = laneByKey.get(e.upstream);
    const down = laneByKey.get(e.downstream);
    if (up === undefined || down === undefined) continue;
    if (up !== down) {
      throw new Error(
        `hard 边 ${e.upstream}(lane=${up})→${e.downstream}(lane=${down}) 跨 lane — ` +
          `失败传播会静默失效, 两端必须同 lane`,
      );
    }
  }
}

/**
 * **一棵树只能属于一条 lane** —— 跨 lane 装配必须 throw (#210)。
 *
 * BullMQ 的 flow 树本身**允许**跨队列 (官方: "children can reside in different queues than
 * the parent")。正因为它允许, 这里才需要一道显式的门: 把 futu 的 child 挂在 default 的
 * parent 下, parent 就要**等** child —— 跨 lane 的等待恰恰就是本次要消除的队头阻塞, 只是从
 * 队列层挪到了 flow 层, 且更隐蔽。⇒ 调用方 MUST 先按 lane 分组, 每条 lane 各装一棵树。
 */
function assertSingleLane(chain: FlowDimensionInput[]): void {
  const lanes = new Set(chain.map((d) => d.queueName));
  if (lanes.size > 1) {
    throw new Error(
      `flow 装配输入跨 lane (${[...lanes].sort().join(' / ')}) — 一棵树只能属于一条 lane, 请按 lane 分组后逐条装配`,
    );
  }
}

/** won 集校验 (未知维度 / 重复) + 按维度全序排序成链。 */
function sortedWonChain(
  dimensions: FlowDimensionInput[],
  executionOrder: readonly string[],
): FlowDimensionInput[] {
  const byKey = new Map<string, FlowDimensionInput>();
  for (const d of dimensions) {
    if (!executionOrder.includes(d.payload.dimensionKey)) {
      throw new Error(`未知维度键 "${d.payload.dimensionKey}" 不在维度全序内 (不可表达)`);
    }
    if (byKey.has(d.payload.dimensionKey)) throw new Error('won 集含重复维度 (装配输入非法)');
    byKey.set(d.payload.dimensionKey, d);
  }
  return executionOrder.flatMap((k) => byKey.get(k) ?? []);
}

/** 不可表达拓扑核验: 环 / 倒流边 (与全序矛盾) / hard 边在 won 链非相邻 → throw。 */
function assertEdgesExpressible(
  edges: SyncDependencyEdge[],
  chain: FlowDimensionInput[],
  executionOrder: readonly string[],
): void {
  assertAcyclic(edges);
  const orderIndex = new Map(executionOrder.map((k, i) => [k, i]));
  const chainPos = new Map(chain.map((d, i) => [d.payload.dimensionKey as string, i]));
  for (const e of edges) {
    // 边方向核对: 全序内已知两端的边必须顺流 (倒流边 = 本全序不可表达的「等待」语义)。
    const up = orderIndex.get(e.upstream);
    const down = orderIndex.get(e.downstream);
    if (up !== undefined && down !== undefined && up >= down) {
      throw new Error(`依赖边 ${e.upstream}→${e.downstream} 方向与维度全序矛盾 (不可表达)`);
    }
    // hard 边链相邻校验: 两端都 won 时必须恰为相邻对 (中间隔节点 → 失败传播绕不过去)。
    const upPos = chainPos.get(e.upstream);
    const downPos = chainPos.get(e.downstream);
    if (
      e.mode === 'hard' &&
      upPos !== undefined &&
      downPos !== undefined &&
      downPos !== upPos + 1
    ) {
      throw new Error(
        `hard 边 ${e.upstream}→${e.downstream} 在 won 链非相邻 (不可表达, 禁静默错装)`,
      );
    }
  }
}

/** 环检 (DFS 三色, O(V+E)): `sync_dependency` 出现环 = 配置损坏, 任何子集都不可调度。 */
function assertAcyclic(edges: SyncDependencyEdge[]): void {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.upstream) ?? [];
    list.push(e.downstream);
    adjacency.set(e.upstream, list);
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (key: string): void => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') throw new Error(`依赖边出现环 (含 "${key}"), 不可调度`);
    state.set(key, 'visiting');
    for (const next of adjacency.get(key) ?? []) visit(next);
    state.set(key, 'done');
  };
  for (const key of adjacency.keys()) visit(key);
}
