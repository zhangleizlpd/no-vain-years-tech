import { Injectable, Logger } from '@nestjs/common';
import type { MarketdataConfig } from '../config/marketdata.config';
import { TENCENT_PROFILE } from '../marketdata/tencent.constraint-profile';
import { VendorHttpClient } from '../marketdata/vendor-http-client';
import { FxRateCacheAdapter } from './fx-rate-cache.adapter';
import type { FxRate, FxRatePort } from './fx-rate.port';
import { RefusingFxRateAdapter } from './refusing-fx-rate.adapter';
import { SinaFxAdapter } from './sina-fx.adapter';
import { SINA_FX_PROFILE } from './sina-fx.constraint-profile';
import { TencentFxAdapter } from './tencent-fx.adapter';

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

/**
 * 085 T004 `FX_RATE_PORT` 的装配工厂 —— 按 `marketdataConfig.kind` 绑定 (plan D3 / D4)。
 *
 * - `live` ⇒ **缓存装饰器包 FallbackChain**: 单格 TTL + single-flight 在**最外层**, 链在内层。
 *   反过来 (每个节点各缓存一份) 会让 single-flight 形同虚设 —— 冷缓存下的并发仍然一源一发。
 * - `mock` ⇒ **调用即抛**的拒绝壳: 本地 dev 与 IT 跑的都是 mock 档, MUST NOT 真打腾讯 / 新浪。
 *
 * 形态照 `futu-broker-account.adapter.ts` 的 `createBrokerAccountPort`: **绑定判断收在工厂里**,
 * 调用处 (module 的 `useFactory`) 写不出分支。
 *
 * 两个 vendor **各自一个** `VendorHttpClient` 实例 (各持桶与熔断态, ADR-0047) —— 共用会让备源
 * 的失败去推主源的熔断计数。
 */
export function createFxRatePort(cfg: MarketdataConfig): FxRatePort {
  if (cfg.kind === 'mock') return new RefusingFxRateAdapter();
  return new FxRateCacheAdapter(
    new FxRateFallbackChainAdapter([
      new TencentFxAdapter(new VendorHttpClient(TENCENT_PROFILE), cfg.tencentFxBaseUrl),
      new SinaFxAdapter(new VendorHttpClient(SINA_FX_PROFILE), cfg.sinaFxBaseUrl),
    ]),
  );
}
