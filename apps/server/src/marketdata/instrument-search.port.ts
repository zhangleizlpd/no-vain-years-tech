import type { InstrumentSearchHit } from './marketdata.types.js';

/**
 * 模糊搜索端口 (FR-S04)。主走东财, 503/超时 → FallbackChain 平移本地 pg_trgm。
 * 消费者仅依赖此 Symbol + interface, 不感知背后 vendor / fallback (ADR-0047)。
 */
export const INSTRUMENT_SEARCH_PORT = Symbol('INSTRUMENT_SEARCH_PORT');

export interface InstrumentSearchPort {
  /** query = 名 / 拼音 / 代码。返候选归一化 canonical; 无命中 → 空数组 (非 error)。 */
  search(query: string): Promise<InstrumentSearchHit[]>;
}
