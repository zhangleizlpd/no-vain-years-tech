/**
 * 013 自选列表纯函数不变量 (ADR-0043 §4: rules 文件持无副作用业务规则)。
 *
 * 设计取舍：本文件**只出 predicate + 纯计算**，不 throw 框架异常 (HttpException)。
 * 系统组保护 / 持仓只读的「拒绝」语义由调用方 UC 用 predicate 判定后 throw 专用
 * exception (SystemGroupProtectedException / HoldingsGroupReadonlyException, T005/T008)
 * —— 既保 rules framework-free (Phase 1 时这些 exception 尚未建)，又避免每个写 UC
 * 包 try/catch 映射的噪声 (对照 011 normalizeClientNo throw 纯 Error 的单点 catch
 * 不同：本特性多个写 UC 共用守卫，predicate 更干净)。
 *
 * 排序模型 (FR-S05)：固顶区 (pinned=true) 常驻分组顶 > 非固顶区。读侧
 * `ORDER BY pinned DESC, "order" ASC`；order 在**各区内**为 0-based 稠密序
 * (resortWithPinPriority 写侧重排保证一致，last-write-wins D1)。
 */

export const GROUP_TYPE_SYSTEM = 'system';
export const GROUP_TYPE_CUSTOM = 'custom';
export const SYSTEM_KIND_WATCHLIST = 'watchlist';
export const SYSTEM_KIND_HOLDINGS = 'holdings';

/**
 * 自选标的市场词表 (015 Instrument.market 同词，#302「不做映射」)：DTO `@IsIn` 浅校验
 * 与 add UC 业务守卫共用单源 (ADR-0048 仅借字符串值，不 import marketdata 运行时)。
 */
export const WATCHLIST_MARKETS = ['cn', 'hk', 'us'] as const;
export type WatchlistMarket = (typeof WATCHLIST_MARKETS)[number];

export function isWatchlistMarket(m: string): m is WatchlistMarket {
  return (WATCHLIST_MARKETS as readonly string[]).includes(m);
}

/**
 * 系统组显示名 (FR-S01「自选」；持仓组改名「我的持仓」以与 025 独立「持仓」页区分,
 * 025 增量)。系统组名 = app 控制常量单一真相: list-watchlist-groups 读时恒取本表 (不读
 * 已 materialize 行的 row.name), 故改名免数据迁移、已落库账户随读切换。
 */
export const SYSTEM_GROUP_NAMES: Record<
  typeof SYSTEM_KIND_WATCHLIST | typeof SYSTEM_KIND_HOLDINGS,
  string
> = {
  [SYSTEM_KIND_WATCHLIST]: '自选',
  [SYSTEM_KIND_HOLDINGS]: '我的持仓',
};

/** 系统组拒写错误码 (UC throw 专用 exception 时复用为 RFC 9457 code)。 */
export const SYSTEM_GROUP_PROTECTED = 'SYSTEM_GROUP_PROTECTED';
export const HOLDINGS_GROUP_READONLY = 'HOLDINGS_GROUP_READONLY';

/** group 行的最小判定形 (Prisma row 结构兼容超集)。 */
export interface GroupShape {
  type: string;
  systemKind: string | null;
}

/** 系统组 (自选/持仓) —— 改名 / 删除被拒 (assertGroupMutable 语义, FR-S02)。 */
export function isSystemGroup(g: GroupShape): boolean {
  return g.type === GROUP_TYPE_SYSTEM;
}

/** 持仓组 —— 派生只读，任何写 (加/删/移入移出) 被拒 (assertItemMutable 语义, FR-S06)。 */
export function isHoldingsGroup(g: GroupShape): boolean {
  return g.systemKind === SYSTEM_KIND_HOLDINGS;
}

// ── 排序 (FR-S05) ────────────────────────────────────────────────────────────

/** 排序操作 (单次一种)：固顶 / 取消固顶 / 移到最前 / 移到最后。 */
export type ResortOp =
  | { kind: 'pin'; itemId: bigint }
  | { kind: 'unpin'; itemId: bigint }
  | { kind: 'moveFront'; itemId: bigint }
  | { kind: 'moveBack'; itemId: bigint };

/** 排序输入/输出最小形 (id + pinned + order)。 */
export interface SortItem {
  id: bigint;
  pinned: boolean;
  order: number;
}

function cmpBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function renormalize(pinnedIds: readonly bigint[], nonPinnedIds: readonly bigint[]): SortItem[] {
  return [
    ...pinnedIds.map((id, idx) => ({ id, pinned: true, order: idx })),
    ...nonPinnedIds.map((id, idx) => ({ id, pinned: false, order: idx })),
  ];
}

/**
 * 对一组 items 应用一次排序操作，返回**全量** items 的新 (pinned, order)。
 *
 * - **pin**：移入固顶区**头部** (常驻分组最顶, Gherkin US2-1/US4-3)。
 * - **unpin**：移入非固顶区**尾部**。
 * - **moveFront / moveBack**：在 item **当前所属区内**调位 —— 非固顶项「移到最前」=
 *   非固顶区头部 = 固顶项**下方** (Gherkin US2-2)；固顶项的 move 仅在固顶区内 (防御，
 *   菜单常态下固顶项走 unpin 而非 move)。
 * - 未知 itemId / 空列表：仅按现状重排 (no-op move)，order 稠密化。
 *
 * order 各区 0-based 稠密；读侧 `ORDER BY pinned DESC, "order" ASC`。
 * O(n log n) (排序主导)，n = 组内 item 数 (≤ 数百，FlatList 虚拟化)。
 */
export function resortWithPinPriority(items: readonly SortItem[], op: ResortOp): SortItem[] {
  const sorted = [...items].sort((a, b) => a.order - b.order || cmpBigInt(a.id, b.id));
  const target = sorted.find((i) => i.id === op.itemId);

  let pinned = sorted.filter((i) => i.pinned).map((i) => i.id);
  let nonPinned = sorted.filter((i) => !i.pinned).map((i) => i.id);

  if (!target) return renormalize(pinned, nonPinned);

  const id = op.itemId;
  pinned = pinned.filter((x) => x !== id);
  nonPinned = nonPinned.filter((x) => x !== id);

  switch (op.kind) {
    case 'pin':
      pinned.unshift(id);
      break;
    case 'unpin':
      nonPinned.push(id);
      break;
    case 'moveFront':
      (target.pinned ? pinned : nonPinned).unshift(id);
      break;
    case 'moveBack':
      (target.pinned ? pinned : nonPinned).push(id);
      break;
  }
  return renormalize(pinned, nonPinned);
}

// ── 系统组种子 / 删组回落 ──────────────────────────────────────────────────────

/** materialize / 投影用系统组种子 (insert-ready；自选 order 0、持仓 order 1)。 */
export interface SystemGroupSeed {
  accountId: bigint;
  name: string;
  type: string;
  systemKind: string;
  visible: boolean;
  order: number;
}

/**
 * 账号默认 2 系统组种子 (D2)：GET 零写库时投影、首写时 `INSERT ON CONFLICT
 * (account_id, system_kind) DO NOTHING` materialize。自选恒 order 0 (主列表首 Tab)。
 */
export function defaultSystemGroups(accountId: bigint): SystemGroupSeed[] {
  return [
    {
      accountId,
      name: SYSTEM_GROUP_NAMES[SYSTEM_KIND_WATCHLIST],
      type: GROUP_TYPE_SYSTEM,
      systemKind: SYSTEM_KIND_WATCHLIST,
      visible: true,
      order: 0,
    },
    {
      accountId,
      name: SYSTEM_GROUP_NAMES[SYSTEM_KIND_HOLDINGS],
      type: GROUP_TYPE_SYSTEM,
      systemKind: SYSTEM_KIND_HOLDINGS,
      visible: true,
      order: 1,
    },
  ];
}

/**
 * 删非空自定义组时 item 的回落目标 = 系统「自选」组 (FR-S02 非级联删)。
 * 找不到 (理论上 materialize 后恒存在) → null，由 UC 决定兜底。
 */
export function fallbackGroupForDelete<T extends { systemKind: string | null }>(
  groups: readonly T[],
): T | null {
  return groups.find((g) => g.systemKind === SYSTEM_KIND_WATCHLIST) ?? null;
}
