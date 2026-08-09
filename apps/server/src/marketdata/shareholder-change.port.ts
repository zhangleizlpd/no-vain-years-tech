import type { ShareholderChangeDto, ShareholderChangeRangeQuery } from './marketdata.types.js';

/**
 * 股东权益变动事件端口 (041 US3)。理杏仁 `${market}/company/shareholders-equity-change` 主源 (指定证券
 * 历次大股东权益变动: 持股数量 numOfSharesInterestedList / 占已发行有投票权股份比例
 * percentageOfIssuedVotingShares, 均为嵌套 L/S 数组)。
 *
 * per-stock 区间抓取 (形态照抄 buyback / short-selling `getRange(from,to)`): 单只 symbol 拉
 * [from, to] 股东权益变动事件序列 (date 升序), 供 backfill 回填历史 + delta 抓当日。理杏仁端点单数
 * stockCode (数组 → 400, 同 039 short-selling; **不用 metricsList** → 无 p1 #670 all-or-nothing
 * 静默 0 行坑)。**唯一有嵌套结构的 041 维度** (plan Decision 4): 嵌套 L/S 数组整存 payload Json,
 * 缺 L 或 S 值 / 缺字段 → 存 null 不崩。无股东权益变动历史的标的 → 空数组 (不崩)。
 */
export const SHAREHOLDER_CHANGE_PORT = Symbol('SHAREHOLDER_CHANGE_PORT');

export interface ShareholderChangePort {
  /** per-stock 区间抓取: 单只 symbol 拉 [from, to] 股东权益变动事件序列, date 升序; 无数据 → 空数组。 */
  getShareholderChangeRange(query: ShareholderChangeRangeQuery): Promise<ShareholderChangeDto[]>;
}
