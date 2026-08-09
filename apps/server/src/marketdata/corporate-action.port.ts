import type { CorporateActionDto } from './marketdata.types.js';

/**
 * 公司行动端口 (FR-S05, US3)。分红 / 拆股 / 配股。理杏仁主源。
 */
export const CORPORATE_ACTION_PORT = Symbol('CORPORATE_ACTION_PORT');

export interface CorporateActionPort {
  /** 按 symbol 返公司行动列表, 按 exDate 降序。 */
  getCorporateActions(symbol: string): Promise<CorporateActionDto[]>;
}
