import type { UniverseEntry } from './marketdata.types.js';

/**
 * universe 枚举端口 (FR-S01, US6)。东财 clist 枚举全 A 股 (含北交所)。
 * 本 feature 仅落接口 + Mock; live `EastmoneyUniverseAdapter` → 016 (D2, 唯一消费者
 * = 同步管线, 015 不建无消费者的 speculative live adapter)。
 */
export const INSTRUMENT_UNIVERSE_PORT = Symbol('INSTRUMENT_UNIVERSE_PORT');

export interface InstrumentUniversePort {
  /**
   * 枚举指定市场的标的 {market, code, name}, 归一化 canonical (S2-T2 per-market)。各实现只处理
   * 其支持的市场 ∩ `markets` (理杏仁 cn/hk / 东财 cn/hk/us / Mock cn); 不支持的市场静默跳过。
   * 枚举范围由调用方 (`SyncUniverseUseCase` 读 universe 维度 marketScope) 传入。
   */
  enumerate(markets: string[]): Promise<UniverseEntry[]>;
}
