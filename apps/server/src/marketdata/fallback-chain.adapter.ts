import { Injectable, Logger } from '@nestjs/common';
import type { InstrumentSearchPort } from './instrument-search.port.js';
import type { InstrumentSearchHit } from './marketdata.types.js';

/**
 * 搜索 FallbackChain adapter (015 T014, INSTRUMENT_SEARCH_PORT live 绑定, FR-S04 / US2)。
 *
 * 包裹有序节点 `[primary, ...secondaries]` (V1 = `[东财, 本地 pg_trgm]`)。按序尝试:
 *   - 节点抛错 (503/超时/熔断/配额耗尽) → 记日志, 平移下一节点 (spec「search fallback」)
 *   - 节点返**非空** → 短路返回 (主命中即停, 不打次源)
 *   - 节点返**空** → 继续下一节点 (主源空 → 试本地)
 *   - 全部空/错 → 返空数组 (业务非异常, 非 5xx — spec「search both-empty」)
 *
 * 消费者只依赖 `INSTRUMENT_SEARCH_PORT` Symbol, 不感知背后多源/降级 (ADR-0047)。东财无 SLA
 * 的真实降级需求 → 本地 pg_trgm 兜底; 两节点最小实现 (universe/calendar live 多源 → 016)。
 */
@Injectable()
export class FallbackChainAdapter implements InstrumentSearchPort {
  private readonly logger = new Logger(FallbackChainAdapter.name);

  constructor(private readonly nodes: InstrumentSearchPort[]) {}

  async search(query: string): Promise<InstrumentSearchHit[]> {
    for (let i = 0; i < this.nodes.length; i++) {
      try {
        const hits = await this.nodes[i].search(query);
        if (hits.length > 0) return hits;
        // 空成功 → 继续下一节点 (主源无候选时仍试本地)。
      } catch (err) {
        // 节点故障 → 平移下一节点; 末节点也故障则循环结束返空 (见下)。
        this.logger.warn(
          `search node #${i} failed, falling through: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return [];
  }
}
