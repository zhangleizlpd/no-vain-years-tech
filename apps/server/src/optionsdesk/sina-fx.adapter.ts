import { Injectable, Logger } from '@nestjs/common';
import { VendorHttpClient } from '../marketdata/vendor-http-client';
import { FX_PAIRS, type FxRate, type FxRatePort } from './fx-rate.port';
import { decodeGbk, parseSinaFx } from './fx-rate.rules';

/**
 * 085 T002 新浪汇率 adapter (**备源**, FX_RATE_PORT FallbackChain 次节点; FR-002/FR-006,
 * plan D3/D5)。
 *
 * GET `<baseUrl>/list=fx_susdcny,fx_shkdcny,fx_susdhkd` (符号小写), GBK 字节, `,` 分隔,
 * 取 `idx3`。**必带 `Referer: https://finance.sina.com.cn`** —— 漏了 403; 该 header 由
 * `SINA_FX_PROFILE` 注入 (profile 的既有职责就是「每请求必需 header」), 故本文件不重复声明。
 *
 * 失败语义同主源: 传输错与解析契约破一律上抛, 由 FallbackChain 记 warn 后平移 / 全败上抛。
 */
@Injectable()
export class SinaFxAdapter implements FxRatePort {
  private readonly logger = new Logger(SinaFxAdapter.name);

  constructor(
    // CROSS-CONTEXT-SYNC: 同 `TencentFxAdapter` —— 复用 marketdata 的传输类, 实例以
    // `SINA_FX_PROFILE` 自建 (各自持桶与熔断态)。
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    /** 采集时刻时钟, 注入理由同 `TencentFxAdapter.now`。 */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchRates(): Promise<readonly FxRate[]> {
    const url = `${this.baseUrl}/list=${FX_PAIRS.map((pair) => `fx_s${pair.toLowerCase()}`).join(
      ',',
    )}`;
    const bytes = await this.http.requestBytes({ url });
    // 同 plan D5: 采集时刻是我们自己的。新浪的时间戳字段位未核实, 解析器蓄意不消费
    // (`fx-rate.rules.ts` 的 `vendorStamp` 恒 `null`), 故这里连日志证据都没有可写的。
    const capturedAt = this.now();
    const quotes = parseSinaFx(decodeGbk(bytes), FX_PAIRS);
    this.logger.debug(`sina fx: 取到 ${quotes.size} 对 (备源)`);
    return [...quotes].map(([pair, quote]) => ({ pair, rate: quote.rate, capturedAt }));
  }
}
