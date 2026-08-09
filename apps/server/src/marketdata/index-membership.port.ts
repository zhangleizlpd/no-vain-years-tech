import type { IndexMembershipDto } from './marketdata.types.js';

/**
 * 所属指数归属端口 (039 US3)。理杏仁 `hk/company/indices` 主源 (指定证券当前所属指数集合)。
 *
 * **第 3 形态** (异于其他 4 维): **无 range/from/to** —— vendor `indices` 端点返当前成分快照
 * (无历史/无日期), 只取单只 symbol 拿其当前所属指数集合 (指数×来源)。理杏仁端点单数 stockCode
 * (无日期); 无归属的标的 → 空数组 (executor 覆盖式同步, 空返回语义 T019 真调定, plan Deferred-probe #2)。
 */
export const INDEX_MEMBERSHIP_PORT = Symbol('INDEX_MEMBERSHIP_PORT');

export interface IndexMembershipPort {
  /** 取单只 symbol 当前所属指数集合 (无 date, 快照); 无归属 → 空数组。 */
  getIndexMembership(symbol: string): Promise<IndexMembershipDto[]>;
}
