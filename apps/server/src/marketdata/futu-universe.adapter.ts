import { Injectable, Logger } from '@nestjs/common';
import type { InstrumentUniversePort } from './instrument-universe.port.js';
import type { UniverseEntry } from './marketdata.types.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途 us universe 枚举 adapter (sellput-viz Phase 1 #4, INSTRUMENT_UNIVERSE_PORT 的 us 实现)。
 * 取代东财 clist 的 us 路径 (随本次换源退役, 见 `eastmoney-universe.adapter.ts` 的 MARKET_TO_FS)。
 *
 * 换源理由 (p3b E30/E31)：**2 次请求 vs 东财 137 次**、**持牌券商正式 API vs
 * `robots.txt Disallow: /` 的逆向端点**、覆盖更广、字段更丰富。顺带 F1 分页 bug 直接 moot ——
 * 东财 `push2` 服务端硬封顶 100 条/响应而代码按 500 推进游标 ⇒ us 只收到 2800/13683 条且**完全
 * 静默**（AAPL 这种 A 打头的票根本搜不到）。
 *
 * GET `<shim>/universe?market=US`，Bearer 鉴权。shim 侧默认 `types=STOCK,ETF` 并按 `code` 去重 ——
 * 🚨 **必须 STOCK ∪ ETF 合并**：富途把 `US.VICI`（REIT）的 `stock_type` 分类成 **`ETF`**，只查
 * ⇒ 出处: p3b E31; 夹具 `services/futu-shim/tests/test_mappers.py`。
 * STOCK 会静默丢掉我们自己的锚。**并集在 shim 侧完成**，本 adapter 不重复该逻辑，只消费结果。
 *
 * ★ **本机实测（2026-07-31，经 77 → B↔C 隧道打真接口）**，以下每条都影响了本文件的取舍：
 *
 * | 事实 | 数值 | 本文件因此怎么做 |
 * | --- | --- | --- |
 * | 全集规模 | **19,202**（STOCK 13,047 ∪ ETF 6,155，零重叠） | 规模断言落 env-gated 真 IT，不在此写魔数下界 |
 * | `code` 形态 | 恒 `US.<ticker>`，19,202/19,202 带前缀、**零重复** | 按 `<市场>.` 前缀切；前缀不符 = 契约变更 → throw |
 * | `delisting` | **全 19,202 行皆 `false`** | 该端点只返在市标的 ⇒ **不映射 `status`**（恒 false 的列给不出信号） |
 * | `listing_date` | **73% 是 `1970-01-01`** 占位（AAPL 1980-12-12 真、PEP/LULU/TAP 全是占位） | **不映射 `listDate`**：3/4 是垃圾，写进库等于伪造 IPO 日 |
 * | 异常 ticker | 仅 14/19,202；13 个带 `*` 后缀，**其中 11 个的基础票也在集合里** | 🚨 **原样透传，禁剥星号**：剥了会与真票 canonical 撞车、静默覆盖真票的名字。14 行噪音远轻于此 |
 * | 交易所构成 | `US_PINK` **5,918（31%）** / NASDAQ 5,498 / NYSE 3,936 / AMEX 3,849 | **不按交易所过滤**：p3b 决策是「保留全量 us universe 供搜索与发现候选」；且 us 新标的入库即 `need_sync=false`（无锚不采）⇒ 多收录不产生采集成本 |
 *
 * ⚠️ **`stock_type` 不作权威分类**（p3b E31）：VICI 是 REIT 却被分类成 ETF ⇒ 本 adapter
 * **不把它写进 `Instrument.type`**（该列继续由 `SyncUniverseUseCase` 统一置 `'stock'`，真分类由专源
 * 富化）。合并枚举用它是对的，当分类用它是错的 —— 两件事。
 *
 * 真端点 / 真隧道 / 全集规模 / 白名单覆盖由 env-gated 真 vendor IT 校真
 * (`marketdata.futu-shim.vendor`, `RUN_MARKETDATA_IT`) —— 此处仅解析逻辑
 * (沿 015 全 adapter 范式)。
 */

/** market → 富途 `Market` 枚举值。**只有 us** —— cn/hk universe 仍由理杏仁主源承担。 */
const MARKET_TO_FUTU_MARKET: Record<string, string> = {
  us: 'US',
};

interface ShimEnvelope {
  count?: unknown;
  rows?: unknown;
}

@Injectable()
export class FutuUniverseAdapter implements InstrumentUniversePort {
  private readonly logger = new Logger(FutuUniverseAdapter.name);

  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /**
   * 复杂度 O(市场数 × 该市场标的数)：每个支持的市场 **1 次** HTTP（无分页 —— 富途
   * `get_stock_basicinfo` 单次返全集，这正是换源的决定性收益）。
   */
  async enumerate(markets: string[]): Promise<UniverseEntry[]> {
    const out: UniverseEntry[] = [];
    for (const market of markets) {
      const futuMarket = MARKET_TO_FUTU_MARKET[market];
      if (!futuMarket) {
        // 不支持的市场**静默跳过**（沿 InstrumentUniversePort 契约与东财 adapter 同范式）：
        // 由 UniverseFallbackChainAdapter 平移到下一节点，不是错误。
        this.logger.warn(`[futu] universe 不支持市场 "${market}", 跳过 (本源仅承担 us)`);
        continue;
      }
      out.push(...(await this.enumerateMarket(market, futuMarket)));
    }
    return out;
  }

  private async enumerateMarket(market: string, futuMarket: string): Promise<UniverseEntry[]> {
    const res = await this.http.request<ShimEnvelope>({
      url: `${this.baseUrl}/universe?market=${encodeURIComponent(futuMarket)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });

    const rows = res?.rows;
    if (!Array.isArray(rows)) {
      throw new Error(`[futu] universe 响应缺 rows[] (契约变更?): market=${market}`);
    }
    // 🚨 信封自报的 count 与实收行数对不上 = 传输层截断。东财 F1 那个 bug 静默活了很久,
    // 就是因为没人拿 vendor 自报的总数与实收数对过账。
    if (typeof res?.count === 'number' && res.count !== rows.length) {
      throw new Error(
        `[futu] universe 行数与信封 count 不符 (疑截断): market=${market} count=${res.count} rows=${rows.length}`,
      );
    }

    const prefix = `${futuMarket}.`;
    const out: UniverseEntry[] = [];
    for (const row of rows) {
      out.push(parseRow(row, market, prefix));
    }
    return out;
  }
}

/**
 * 单行 → `UniverseEntry`（canonical `market:code`，`code` = 去掉 `US.` 前缀的 ticker）。
 *
 * **坏行 = throw，不跳过**（与东财 adapter 的「坏项跳过」刻意不同）：东财每行是行情列表里
 * 混编的 `f1x` 字段、混入非 A 股是常态；这里每行是 SDK `get_stock_basicinfo` 直出的 dict，
 * 缺 `code`/`name` 或前缀不符只可能是**契约变更**，而静默丢行 = 静默丢标的 —— 正是 F1 的形状。
 */
function parseRow(row: unknown, market: string, prefix: string): UniverseEntry {
  const raw = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const code = typeof raw.code === 'string' ? raw.code : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!code.startsWith(prefix) || code.length === prefix.length || name.length === 0) {
    throw new Error(
      `[futu] universe 行不合契约 (须 code="${prefix}<ticker>" + 非空 name; 契约变更?): ` +
        `market=${market} 行=${JSON.stringify(row)}`,
    );
  }
  // 🚨 **原样透传 ticker，禁做任何"清洗"** —— 见类注释里那 11 个带 `*` 且基础票并存的实测。
  return { market, code: code.slice(prefix.length), name };
}
