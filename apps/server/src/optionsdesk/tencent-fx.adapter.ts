import { Injectable, Logger } from '@nestjs/common';
import { VendorHttpClient } from '../marketdata/vendor-http-client';
import { FX_PAIRS, type FxPair, type FxRate, type FxRatePort } from './fx-rate.port';
import { decodeGbk, parseTencentFx } from './fx-rate.rules';

/**
 * 085 T002 腾讯汇率 adapter (**主源**, FX_RATE_PORT FallbackChain 首节点; FR-002, plan D3/D5)。
 *
 * GET `<baseUrl>/q=whUSDCNY,whHKDCNY,whUSDHKD` —— 一发取全三对 (plan PoC P1), GBK 字节,
 * `~` 分隔 22 字段, 取 `f3`。解析在 `fx-rate.rules.ts` (纯函数), 本类只负责 vendor 语义
 * (URL / 编码 / 采集时刻) 与失败上抛。
 *
 * EVIDENCE: 裸 curl (无 Referer、无 UA) 即返有效数据 —— 2026-09-17 实拉。`TENCENT_PROFILE`
 * 照带 UA + Referer 无害且保留 (vendor 可能收紧), 但它们不是本端点的必要条件; 与新浪那条
 * 「漏了 403」不同, 别照抄成同一句。
 *
 * 失败语义: 传输错 (非 2xx / 超时 / 熔断) 由 `VendorHttpClient` 抛, 解析契约破 (少一对 /
 * 哨兵 / 汇率位不可解析) 由 `parseTencentFx` 抛 —— 两者都原样上抛给 FallbackChain 平移。
 */
@Injectable()
export class TencentFxAdapter implements FxRatePort {
  private readonly logger = new Logger(TencentFxAdapter.name);

  constructor(
    // CROSS-CONTEXT-SYNC: 复用 marketdata 的 vendor 传输类 (限频 / 退避 / 熔断纪律, ADR-0047),
    // 非业务调用; 实例由本 ctx 以 `TENCENT_PROFILE` 自建, 与 marketdata 零共享状态
    // (既有形态见 `futu-broker-account.adapter.ts` 的同名构造参数)。
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    /**
     * 采集时刻时钟。注入是为了让 D5 的判据可被确定化断言 —— 「`capturedAt` 是我们的采集
     * 时刻而不是 `f5`」只有在时钟可控时才区分得开 (两者都会随轮次推进, 光断言「两次不同」
     * 对取错的实现没有鉴别力)。
     */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async fetchRates(): Promise<readonly FxRate[]> {
    const url = `${this.baseUrl}/q=${FX_PAIRS.map((pair) => `wh${pair}`).join(',')}`;
    const bytes = await this.http.requestBytes({ url });
    // 🚨 采集时刻取在**字节到手这一刻**, 不取 vendor 自报的 `f5` (plan D5): 实测 `f5` 可一路
    // 推进而 `f3` 纹丝不动 ⇒ 拿它上屏就是给旧数字盖新时间戳, 而屏幕上一切正常。
    const capturedAt = this.now();
    const quotes = parseTencentFx(decodeGbk(bytes), FX_PAIRS);
    // vendor 自报时刻只到这里为止 —— 作证据进日志, 不进返回值。
    this.logger.debug(
      `tencent fx vendorStamp: ${FX_PAIRS.map(
        (pair) => `${pair}=${quotes.get(pair)?.vendorStamp ?? '-'}`,
      ).join(' ')}`,
    );
    // 顺序随 vendor 响应 (三对齐全由解析契约① 保证), 消费方按 `pair` 取。
    return [...quotes].map(([pair, quote]) => toFxRate(pair, quote.rate, capturedAt));
  }
}

/** 单条 `FxRate` 组装 —— 与新浪 adapter 同形, 各自落一份 (两个 vendor, 两条通路)。 */
function toFxRate(pair: FxPair, rate: FxRate['rate'], capturedAt: Date): FxRate {
  return { pair, rate, capturedAt };
}
