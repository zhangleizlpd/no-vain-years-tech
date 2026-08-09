import { Inject, Injectable } from '@nestjs/common';
import { INSTRUMENT_SEARCH_PORT, type InstrumentSearchPort } from './instrument-search.port.js';
import type { InstrumentSearchHit } from './marketdata.types.js';

/**
 * 模糊搜索 use case (015 T014, US2, intra query — ADR-0043 直注端口无 repository)。
 *
 * 薄编排: 经 `INSTRUMENT_SEARCH_PORT` (live = `FallbackChain([东财, 本地 pg_trgm]`) 取候选,
 * 透传归一化 hit。多源/降级对消费者透明 (ADR-0047), UC 不感知背后是东财还是本地。无命中 →
 * 空数组 (非 error)。搜索不走 Redis (东财 live 已近实时, 本地兜底命中亦快; 缓存语义另议)。
 */
@Injectable()
export class SearchInstrumentsUseCase {
  constructor(@Inject(INSTRUMENT_SEARCH_PORT) private readonly searchPort: InstrumentSearchPort) {}

  async execute(query: string): Promise<InstrumentSearchHit[]> {
    return this.searchPort.search(query);
  }
}
