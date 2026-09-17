import { Injectable, Logger } from '@nestjs/common';
import type { FxRate, FxRatePort } from './fx-rate.port';

/** 错误 → 一行可读文本 (非 `Error` 也要能说出话)。 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 085 T002 FX FallbackChain adapter (FX_RATE_PORT 的 live 绑定; FR-002/FR-006, plan D3)。
 *
 * 包裹有序节点 `[主, ...备]` (V1 = `[腾讯, 新浪]`)。按序尝试:
 *   - 节点抛 (传输错 / 解析契约破) → 记 warn, 平移下一节点
 *   - 节点返回 → 短路 (主源命中即停, 不打备源)
 *   - 全部失败 → **抛**
 *
 * 全败抛而不返空数组 —— 照 `alert/realtime-quote-fallback-chain.adapter.ts:39-42`, 与搜索链
 * 「返空」的那一支刻意相反: 空数组会被上层当成「汇率查到了, 只是一条都没有」而静默走完折算
 * 路径; 抛才能让 use case catch 成一个**显式**降级态 (T006 / state_branch 8)。
 *
 * 与 alert 那份的唯一差别: 这里不做「返回非空才算成功」的兜底。FX 侧的解析契约① 已把
 * 「少一对」折成抛 (`fx-rate.rules.ts` `requireAllPairs`), 空结果在本链上不可能出现,
 * 多一条判不出真假的分支只是照抄形状。
 */
@Injectable()
export class FxRateFallbackChainAdapter implements FxRatePort {
  private readonly logger = new Logger(FxRateFallbackChainAdapter.name);

  constructor(private readonly nodes: readonly FxRatePort[]) {}

  async fetchRates(): Promise<readonly FxRate[]> {
    let lastError: unknown;
    for (let i = 0; i < this.nodes.length; i++) {
      try {
        return await this.nodes[i].fetchRates();
      } catch (err) {
        lastError = err;
        this.logger.warn(`fx node #${i} failed, falling through: ${describeError(err)}`);
      }
    }
    throw new Error(`all fx rate sources failed: ${describeError(lastError)}`);
  }
}
