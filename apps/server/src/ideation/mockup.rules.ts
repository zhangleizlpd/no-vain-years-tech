/**
 * mockup 交付不变量 —— 无状态纯函数 (per ADR-0043 §2 贫血 + 纯函数, 无 DB / 无 LLM)。
 *
 * 037 mockup 交付链路 (US1 / FR-002 / FR-006 / FR-010) 的三件纯逻辑:
 *  ① `assertObjectKeyOwnership` —— 写记录时校 objectKey 落在「本 (accountId, sessionId)
 *     前缀」内, 防 channel 谎报他 session 的 key (worker-token scope 派生在 UC 层, 此处
 *     只做前缀归属断言)。
 *  ② `normalizeScreens` —— 逐屏标签清单 (FR-010) 落库前规整: 非数组 / 含非字符串元素一律
 *     兜底成「干净字符串数组」(贫血 Json, channel 上报数据不可信)。
 *  ③ `deriveVersionRank` —— append-only 多版 (FR-006) 的版本序号**派生** (不落 version 列):
 *     按 createdAt 倒序, 最新版 = v1 … 历史版递增 (senior 测: 可派生不落列)。
 */

/** 落库 mockup 记录的产物前缀根 (本 (accountId, sessionId) 唯一 scope; 凭证签发亦用同串)。 */
export function mockupKeyPrefix(accountId: bigint, sessionId: bigint): string {
  return `ideation-mockup/${accountId}/${sessionId}/`;
}

/**
 * 校 objectKey 是否落在本 (accountId, sessionId) 的产物前缀内 (FR-002 / FR-007 防越权)。
 *
 * scope 永远由 server 据 claimed event 派生 (accountId / sessionId 不可由 channel 自报);
 * 写记录时此断言挡「派生出的 scope」与「channel 上报的 objectKey」不一致 (谎报他 session)。
 * 纯前缀字符串比较, O(1)。
 */
export function assertObjectKeyOwnership(
  objectKey: string,
  accountId: bigint,
  sessionId: bigint,
): boolean {
  return objectKey.startsWith(mockupKeyPrefix(accountId, sessionId));
}

/**
 * 规整逐屏标签清单 (FR-010) —— channel 上报的 `screens` 是不可信 Json。
 *
 * - 非数组 (null / object / string / number 等) → 兜底空数组。
 * - 数组内非字符串元素 (number / null / object 等) → 丢弃 (不强转, 避免 `[object Object]` 噪声)。
 * - 字符串元素原样保留 (不 trim / 不去重: 逐屏标签语义化, 由 channel 负责; 此处只挡类型脏数据)。
 *
 * 复杂度 O(n), n = 屏数。
 */
export function normalizeScreens(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.filter((s): s is string => typeof s === 'string');
}

/** 单条 mockup 的版本派生入参 (仅需 createdAt 排序; 贫血 row 子集)。 */
export interface MockupVersionInput {
  createdAt: Date;
}

/**
 * 按 createdAt 倒序为 append-only 多版派生版本序号 (FR-006, **不落 version 列**)。
 *
 * 入参为同一 session 的 mockup 行 (任意顺序); 返回与入参**一一对位**的 rank 数组:
 * 最新交付 (max createdAt) = 1, 次新 = 2 … (1-based, latest-first, App 展示「v1=最新」)。
 * 同 createdAt 时按入参出现序稳定打 tie (createdAt 毫秒级, 实务几乎不撞)。
 *
 * **不就地排序** (返回与入参等长、同序的 rank 数组), 让调用方自持原始行顺序。复杂度 O(n log n)。
 */
export function deriveVersionRank(rows: readonly MockupVersionInput[]): number[] {
  // 倒序索引: createdAt desc, tie 时保留入参出现序 (稳定)。
  const order = rows
    .map((row, index) => ({ index, createdAt: row.createdAt.getTime() }))
    .sort((a, b) => b.createdAt - a.createdAt || a.index - b.index);

  const rankByIndex = new Array<number>(rows.length);
  order.forEach((entry, rankZeroBased) => {
    rankByIndex[entry.index] = rankZeroBased + 1;
  });
  return rankByIndex;
}
