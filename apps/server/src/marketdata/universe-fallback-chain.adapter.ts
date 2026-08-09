import { Injectable, Logger } from '@nestjs/common';
import type { InstrumentUniversePort } from './instrument-universe.port.js';
import type { UniverseEntry } from './marketdata.types.js';

/**
 * universe FallbackChain adapter (ADR-0047 §4 + §6, INSTRUMENT_UNIVERSE_PORT live 绑定)。
 *
 * 包裹有序节点 `[primary, ...secondaries]` (V1 = `[理杏仁, 东财]`, per Amendment 2026-06-03)。
 * **S2-T2 per-market**: 对请求的每个市场**独立**按序 `enumerate([market])` — 让 cn/hk 命中理杏仁
 * 主源、us 主源落空自然平移到东财备源 (否则主源整组命中即停, 东财永不触达 = us 拉不到)。单市场内:
 *   - 节点抛错 (vendor 故障 / 熔断 open `BrokenCircuitError` / 配额耗尽) → warn 打点, 平移下一节点
 *   - 节点返**非空** → 该市场短路返回 (主源命中即停, 不打备源)
 *   - 节点返**空** → warn 打点, 继续下一节点 (主源无候选时仍试备源)
 *   - 全部空/错 → error 告警 + 该市场贡献空 (**不抛** → 不连坐其余市场/维度); 其余市场照常聚合
 *
 * **per-provider 熔断**由各节点的 `VendorHttpClient` (cockatiel `ConsecutiveBreaker`) 在传输层
 * 承担 (ADR-0047 §3) —— 本链不重复熔断, 只负责 ADR-0047 §6 的编排层政策:
 *   ① **不静默降级**: 越过主源 (主源 fail / 熔断 open / 返空) 必 warn 打点, 避免「在备源上跑
 *      数周无人察觉主源已烂」(AWS Builders' Library: fallback 最大风险是静默降级);
 *   ② **fail-soft**: 整链耗尽返空而非抛 —— 直接抛会冒泡到维度执行层 catch 记 failed
 *      (含理杏仁其余维度连坐); 改返空后 `SyncUniverseUseCase` scanned=0,
 *      `loadActiveInstruments` 仍读 DB 持久化清单, 其余维度照跑 (解维度间连坐缺陷)。
 *
 * 镜像 search 的 `FallbackChainAdapter`, 但补了 §6 要求的「越过主源打点」+「整链耗尽 error 告警」。
 */
@Injectable()
export class UniverseFallbackChainAdapter implements InstrumentUniversePort {
  private readonly logger = new Logger(UniverseFallbackChainAdapter.name);

  constructor(private readonly nodes: InstrumentUniversePort[]) {}

  async enumerate(markets: string[]): Promise<UniverseEntry[]> {
    const out: UniverseEntry[] = [];
    for (const market of markets) {
      out.push(...(await this.enumerateMarket(market)));
    }
    return out;
  }

  /**
   * 单市场按序 fallback (§6): 逐节点 `enumerate([market])`, 首个非空短路返回 (越过主源必 warn
   * 打点); 全节点空/错 → error 告警 + 返**空** (该市场整链耗尽, **不抛** → 不连坐其余市场/维度)。
   */
  private async enumerateMarket(market: string): Promise<UniverseEntry[]> {
    const failures: string[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      try {
        const entries = await this.nodes[i].enumerate([market]);
        if (entries.length > 0) {
          if (i > 0) {
            // §6 不静默降级: 用了备源必打点 (主源失败/空已降级)。
            this.logger.warn(
              `[universe] market=${market} 已降级用备源 node #${i} 枚举到 ${entries.length} 标的`,
            );
          }
          return entries;
        }
        // 空成功 → 继续下一节点 (主源无候选时仍试备源)。
        this.logger.warn(`[universe] market=${market} node #${i} 返空, 平移下一节点`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`#${i}: ${msg}`);
        this.logger.warn(`[universe] market=${market} node #${i} 失败, 平移下一节点: ${msg}`);
      }
    }
    // §6 fail-soft + 不静默: 该市场整链耗尽 (全部空/错) → error 告警 (log-based alerting 出口); 返空不抛。
    this.logger.error(
      `[universe] market=${market} 全 ${this.nodes.length} 源枚举失败/空 → 该市场本轮不刷新 (沿用 DB 持久化清单)` +
        (failures.length > 0 ? `; 失败明细: ${failures.join(' | ')}` : ''),
    );
    return [];
  }
}
