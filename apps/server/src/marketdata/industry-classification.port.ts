import type { IndustryClassificationDto } from './marketdata.types.js';

/**
 * 所属行业归属端口 (043 US1)。理杏仁 `hk/company/industries` 主源 (指定证券当前所属行业集合)。
 *
 * **覆盖式快照形态** (照抄 039 index_membership, 异于区间维): **无 range/from/to** —— vendor
 * `industries` 端点返当前所属行业快照 (无历史/无日期), 只取单只 symbol 拿其当前所属行业集合
 * (hsi 3 级层级 L1/L2/L3, 如 00700 → H70/H7020/H702015)。理杏仁端点单数 stockCode (无日期);
 * 无归属的标的 → 空数组 (executor 覆盖式同步, 空返回跳过 mutate 不 wipe, plan Decision 3)。
 */
export const INDUSTRY_CLASSIFICATION_PORT = Symbol('INDUSTRY_CLASSIFICATION_PORT');

export interface IndustryClassificationPort {
  /** 取单只 symbol 当前所属行业集合 (无 date, 快照, 3 级层级全出不去重); 无归属 → 空数组。 */
  getIndustryClassification(symbol: string): Promise<IndustryClassificationDto[]>;
}
