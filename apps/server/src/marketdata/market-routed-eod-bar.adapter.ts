import { Injectable } from '@nestjs/common';
import type { EodBarPort } from './eod-bar.port.js';
import type { EodBarPoint, EodBarQuery } from './marketdata.types.js';
import { parseCanonicalSymbol } from './marketdata.rules.js';

/**
 * 按市场路由的 EOD 日线源 (sellput-viz)。`EOD_BAR_PORT` 只有一个绑定，而
 * `DimensionExecutorRegistry` / `marketdata-backfill.cli` 逐标的调用 —— 故「不同市场用不同
 * vendor」这件事必须由一层路由承担。
 *
 * V1 路由（见 `marketdata.module.ts` 接线）：
 * - `cn` / `hk` → 理杏仁 candlestick（`LixingerEodBarAdapter`，现状不动）
 * - `us`        → 富途 shim kline（`FutuEodBarAdapter`，`AuType.NONE` 不复权）
 *
 * 🚨 **无默认路由 = 刻意 fail-closed**：未登记的市场直接 throw，而不是悄悄落到某个 vendor 上。
 * 理杏仁对 us 是**代码层硬编码拒绝**（`toLixinger` 抛），假如这里给个默认值落到它头上，
 * 表现会是「每只 us 标的都失败」而不是「配置漏了」—— 后者一眼可见，前者要翻日志。
 *
 * ⚠️ 这层路由**解释了为什么 `SyncDimension.vendor` 列不可作路由依据**（该列注释已写明「代码
 * 从不读取」）：vendor 由 DI 绑定 + 本路由决定，与维度行无关。
 *
 * 本类无状态、无 IO。
 */
@Injectable()
export class MarketRoutedEodBarAdapter implements EodBarPort {
  constructor(private readonly routes: Readonly<Record<string, EodBarPort>>) {}

  /** 复杂度 O(1) 选路 + 被选实现自身的开销。 */
  async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
    const market = parseCanonicalSymbol(query.symbol)?.market;
    const route = market ? this.routes[market] : undefined;
    if (!route) {
      throw new Error(
        `[eod-bar] symbol "${query.symbol}" 无对应市场路由 ` +
          `(已登记: ${Object.keys(this.routes).join('/') || '无'}; ` +
          `加市场须在 marketdata.module.ts 显式指定其 vendor, 禁默认落链)`,
      );
    }
    return route.getBars(query);
  }
}
