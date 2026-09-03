import type { HotSnapshotDto, HotSnapshotQuery } from './marketdata.types.js';

/**
 * 热度精选快照端口 (040 US2)。理杏仁 `hk/company/hot/{type}` 家族主源 (指定证券某热度 type
 * 的当前快照, 1 行/股 + `last_data_date`)。
 *
 * **快照形态** (第 2 形态, 异于波动率的区间日频): **无 range/from/to** —— vendor `hot/{type}`
 * 忽略请求日期永返最新快照 (无历史序列), 只按 `stockCodes[]` 拉当前值。理杏仁端点 **`stockCodes[]`
 * ⇒ 出处: p3 探针 2026-07-14 §3 —— no-date / 历史 date / range 三种请求都返 1 行/股 +
 *   最新 `last_data_date`, 故不可回填历史。
 * 数组** (与波动率单数 stockCode 相反! param 契约每端点单独确认, p3 探查报告实测); 无数据的标的
 * → 空数组 (不崩)。每 type 字段结构不同 (payload 异构整存), `hot/rep` 含异常 key `"undefined"`
 * → adapter 解析层忽略 (FR-007)。executor 对 `HOT_TYPES` 循环 (每 type 一次调用)。
 */
export const HOT_SNAPSHOT_PORT = Symbol('HOT_SNAPSHOT_PORT');

export interface HotSnapshotPort {
  /** 拉某 hot type 的当前快照 (无 date, 快照); `stockCodes[]` 数组; 无数据 → 空数组。 */
  getHotSnapshot(query: HotSnapshotQuery): Promise<HotSnapshotDto[]>;
}
