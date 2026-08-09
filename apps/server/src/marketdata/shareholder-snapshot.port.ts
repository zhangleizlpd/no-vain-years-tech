import type { ShareholderSnapshotDto, ShareholderSnapshotRangeQuery } from './marketdata.types.js';

/**
 * 最新股东端口 (042 US2)。理杏仁 `${market}/company/latest-shareholders` 主源 (指定证券各报告期
 * 大股东名册: 持股数量 numOfSharesInterestedList / 占已发行有投票权股份比例
 * percentageOfIssuedVotingShares, 均为嵌套 L/S/P 数组)。
 *
 * per-stock 区间抓取 (形态照抄 041 shareholder-change `getRange(from,to)`): 单只 symbol 拉
 * [from, to] 报告期股东名册序列 (date 升序), 供 backfill 回填历史报告期 + delta 抓当期。理杏仁端点
 * 单数 stockCode (数组 → 400, 同 041 事件流; **不用 metricsList** → 无 p1 #670 all-or-nothing
 * 静默 0 行坑)。**嵌套结构维度** (plan Decision 4, 复用 041 ShareholderChange 范式): 嵌套 L/S/P
 * 数组整存 payload Json, 缺 L/S/P 值 / 缺字段 → 存 null 不崩。**probe verified SERIES**: latest
 * shareholders 返多个不同 date 行 (报告期×股东序列, 非覆盖式快照) → date 进自然键可回填历史。
 * 无最新股东历史的标的 → 空数组 (不崩)。与 041 shareholder-change 是不同语义、独立表 (本表 = 报告
 * 期股东名册 shareholder_snapshot, 041 = 权益变动事件 shareholder_change)。
 */
export const SHAREHOLDER_SNAPSHOT_PORT = Symbol('SHAREHOLDER_SNAPSHOT_PORT');

export interface ShareholderSnapshotPort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 报告期股东名册序列, date 升序; 无数据 → 空数组。 */
  getShareholderSnapshotRange(
    query: ShareholderSnapshotRangeQuery,
  ): Promise<ShareholderSnapshotDto[]>;
}
