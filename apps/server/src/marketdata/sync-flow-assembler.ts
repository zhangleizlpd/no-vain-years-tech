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

/** 分钟 → 毫秒 (下方取值表的可读性; BullMQ `delay` 的单位是 ms)。 */
const MINUTE_MS = 60_000;

/**
 * 一条**逐市场**的错开规则: 下游在其上游**完成之后**再等 `delayMs` 才起跑 (075 FR-014)。
 *
 * 匹配靠 `upstream`/`downstream` **键对** —— 判据是「装配时这个 parent 是否真的把它声明的
 * 上游包成了 immediate child」, 而**不是**「这个维度是不是某条规则的下游」: 后者会在上游
 * 本轮未 won 时让下游 (此刻是链根) 白等一个间隔 (FR-017, 见 assembleSyncFlow 内那段 🚨)。
 */
export interface SyncStaggerRule {
  /** 市场标签: 只进错误信息与可读性, 匹配不看它。 */
  market: string;
  upstream: string;
  downstream: string;
  /** 错开间隔 (ms)。0 = 不错开 ⇒ 装出的树与本片改动前**逐字段相同** (FR-019a)。 */
  delayMs: number;
  /** 该对维度的上界 (ms); `delayMs` 超过它 = 装配期 throw。出处见 MARKET_SYNC_STAGGER。 */
  maxDelayMs: number;
}

export type SyncStaggerSpec = readonly SyncStaggerRule[];

/**
 * 「链发现 → 快照」两对维度的错开取值表 (075 T005; FR-014 / FR-019 / FR-019a / FR-023)。
 *
 * 🚫 **蓄意不新增配置列 / migration** (075 spec Assumptions): 仓内无运行时配置面, 改
 *    `sync_dimension` 的行值同样要 migration + 一次部署 ⇒ 新增列买不到「免部署调参」。
 *
 * ── 取值 ────────────────────────────────────────────────────────────────────────
 * **美股 30 分钟** —— 不是新拍的数: 2026-08-27 把两对维度合并到同一拍**之前**, 港股快照
 *   相对其链发现原有的错开量就是 30 分钟。出处 = `20260823_1015_seed_hk_option_dimensions/
 *   migration.sql:46`「`cron '0 30 23 * * *'` 比链发现晚 30 分钟」。有先例、方向偏宽。
 * **港股 0** —— 🚨 **不是「不需要」, 是「没观测」**: 内存采样窗 (08:00 CST 停) 与港股采集窗
 *   (16:20 CST) 从不重叠, 港股那一侧从来没被采样覆盖过。取 0 ⇒ 行为与本片改动前逐项相同。
 *   重开判据**三选一**写死在 `specs/075-marketdata-sync-memory-footprint/spec.md` 的
 *   Assumptions「港股重开的判据」(① 采样覆盖过一次港股窗且回落时长非平凡 ② 港股窗内观测到
 *   内存压力信号 ③ 港股单轮写入量进入美股当前量级) —— 满足任一即调离 0, 且**只改这一行的
 *   取值**。🚫 MUST NOT 把这个 0 读成「量过了、不需要」。
 *
 * ── 上界 ────────────────────────────────────────────────────────────────────────
 * 口径 = **同市场下一轮采集的 cron 间隔的一半**; 另一半留给上游自身的执行时长 —— delay 从
 * 上游**完成**时刻起算, 下游实际起跑 = tick + 上游时长 + delay (FR-018 ②)。
 *   - 美股: 06:00 (`option_contract` / `option_daily_snapshot`) → 10:00 (`us_index_daily`,
 *     同 `{us}` scope 的下一轮) = 4h ⇒ 上界 2h。三个 cron 值由
 *     `test/integration/marketdata.schema-016.it.spec.ts` 逐条钉死。
 *   - 港股: 16:20 (主轮两维度) → 21:40 (`hk_option_oi_settle`) = 5h20m ⇒ 上界 2h40m。
 *     两个 cron 见 `20260901_1502_split_hk_option_collection_into_two_rounds/migration.sql`。
 * 📌 FR-018 ① (下游起跑仍落在当日采集归属窗内) 在上述上界内自动成立: 两市取满上界后仍在
 *    **同一日历日**内, 且 `asOf` 是 tick 时刻就物化进 job payload 的
 *    (`sync-tick-driver.ts` 的 `asOfByKey`), 延后起跑改不了它。
 */
export const MARKET_SYNC_STAGGER: SyncStaggerSpec = [
  {
    market: 'us',
    upstream: 'option_contract',
    downstream: 'option_daily_snapshot',
    delayMs: 30 * MINUTE_MS,
    maxDelayMs: 120 * MINUTE_MS,
  },
  {
    market: 'hk',
    upstream: 'hk_option_contract',
    downstream: 'hk_option_daily_snapshot',
    delayMs: 0,
    maxDelayMs: 160 * MINUTE_MS,
  },
];

/**
 * 「不错开」—— **人工触发**路径显式传它 (`marketdata-trigger.cli.ts` /
 * `marketdata-backfill.cli.ts`): 人在命令行敲下去那一刻的语义就是「立刻跑」, 让它空等一个
 * 为夜间自动轮次设的间隔是纯浪费。
 */
export const NO_SYNC_STAGGER: SyncStaggerSpec = [];

/**
 * 错开取值上界核验 —— 违反 MUST 在**装配期** throw (FR-018), 与 `assertEdgesExpressible`
 * 同一层、同一纪律。
 *
 * 🚨 运行期静默偏移的后果是**采成另一天**: 不报错、不会红, 只是数据归错了日子。⇒ 这里宁可
 *    让整轮走 `sync-tick-driver` 既有的 catch → 结构化 ERROR 出口, 也不放行。
 * **全表逐条校验**, 不只校验本轮 won 的那一对 —— 一张配错的表在任何一轮都是错的。
 */
function assertStaggerWithinBound(spec: SyncStaggerSpec): void {
  for (const r of spec) {
    if (!Number.isInteger(r.delayMs) || r.delayMs < 0) {
      throw new Error(
        `错开间隔 ${r.upstream}→${r.downstream} (market=${r.market}) 非法: ` +
          `delayMs=${r.delayMs} 必须是非负整数毫秒`,
      );
    }
    if (r.delayMs > r.maxDelayMs) {
      throw new Error(
        `错开间隔 ${r.upstream}→${r.downstream} (market=${r.market}) 超上界: ` +
          `delayMs=${r.delayMs} > maxDelayMs=${r.maxDelayMs} — 会把下游推出当日采集归属窗 / ` +
          `与同市场后续采集轮次次序颠倒, 拒绝装配`,
      );
    }
  }
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
 * `stagger` (075 T005) —— 🚨 **必填, 蓄意不给默认值**: 同 `FlowDimensionInput.queueName` 那条
 * 的理由 —— 给了默认值, 将来新加的入队路径会**静默**不错开, 而「内存峰又叠回去」正是 075 要
 * 根除的东西。必填 ⇒ 漏传是 typecheck 红。自动轮次传 `MARKET_SYNC_STAGGER`, 人工触发
 * (两个 CLI) 传 `NO_SYNC_STAGGER`。
 *
 * 语义核对 (spec FR-S09): universe 失败 → profile child=ignore → 全下游照跑 (soft 传递成立);
 * profile 失败 → fundamental failParent (hard); universe 不 due (周二) → 链从 profile 起,
 * 下游当根照跑。纯函数无副作用; 复杂度 O(V+E) (环检 DFS + 链装配线性)。
 */
export function assembleSyncFlow(
  dimensions: FlowDimensionInput[],
  edges: SyncDependencyEdge[],
  executionOrder: readonly string[],
  stagger: SyncStaggerSpec,
): FlowJob {
  // won 链 = won 集按全序排序; chain[i-1] 是 chain[i] 的 child。全序由调用点
  // deriveExecutionOrder(edges, priority) 派生注入 (019 T005, 常量退役)。
  const chain = sortedWonChain(dimensions, executionOrder);
  assertSingleLane(chain);
  assertEdgesExpressible(edges, chain, executionOrder);
  assertStaggerWithinBound(stagger);

  const edgeByPair = new Map(edges.map((e) => [`${e.upstream}→${e.downstream}`, e]));
  const staggerByPair = new Map(stagger.map((r) => [`${r.upstream}→${r.downstream}`, r]));
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
    // 075 T005 错开落点: 仅当**这个 parent 真的把它在错开表里声明的上游包成了 immediate
    // child** 时才合入 delay (键对 `prevKey→d`, prevKey 就是刚被包进去的 child)。
    // 🚨 反面 = 无条件挂在「下游维度」的 opts 上: 上游本轮未 won 时下游成**链根**, BullMQ
    //    对无 children 的 job 从**入队时刻**起算 delay ⇒ 白等一个间隔 (FR-017)。
    // 📌 用的是 BullMQ 的 `delay` 字段 —— 与 `MarketdataSyncQueue.jobOpts({ delayMs })` 同一
    //    通道、同一语义 (🚫 不另造第二条 delay 通道, 两份必漂)。
    const parent = toNode(d);
    const rule = staggerByPair.get(`${prevKey}→${d.payload.dimensionKey}`);
    // delayMs = 0 ⇒ **一个字段都不加**: FR-019a 要求取 0 的市场装出的树逐字段相同。
    if (rule !== undefined && rule.delayMs > 0) {
      parent.opts = { ...parent.opts, delay: rule.delayMs };
    }
    node = { ...parent, children: [node] };
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
