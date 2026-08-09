import { Injectable } from '@nestjs/common';
import type { InstrumentSearchPort } from './instrument-search.port.js';
import type { InstrumentSearchHit } from './marketdata.types.js';
import type { VendorHttpClient } from './vendor-http-client.js';
import { fromMktNum } from './eastmoney-symbol.rules.js';

/**
 * 东方财富模糊搜索 adapter (015 T012, INSTRUMENT_SEARCH_PORT 主源, FR-S04 / US2)。
 *
 * GET `/api/suggest/get?input={q}&type=14&token=...&count=10` (东财 searchapi)。`type=14`
 * 返 `QuotationCodeTable.Data[]` (代码表), 覆盖 A/HK/US。逐项经 `fromMktNum` 归一化 canonical
 * `market:code` + name + type。**容错解析**: 未知 MktNum / 缺字段的坏项跳过, 不整体失败
 * (spec edge「搜索主源部分降级」); 无命中 → 空数组 (非 error)。
 *
 * 无 SLA 逆向源 → 经共享 `VendorHttpClient` (东财 profile: 保守限频 + UA/Referer 伪装 +
 * 短 transientWait + 少重试)。失败 (503/超时/熔断) 上抛由 `FallbackChainAdapter` 平移本地
 * pg_trgm (T014)。真东财字段值/契约由 env-gated IT 校真 (SC-S08), 此处仅解析逻辑。
 *
 * `token` 是 suggest API 的公开固定 token (非密钥, 各客户端通用), 硬编码即可。
 */

/** 东财 suggest API 公开固定 token (非密钥, 各客户端通用)。 gitleaks:allow */
const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'; // gitleaks:allow

/**
 * 东财 `Classify` / 证券类型 → canonical type (容错默认 stock; 债券单列以便剔除)。
 * 真实采样: AStock/HKStock/USStock→stock, Fund→etf, Index→index, Bond(债券)→bond。
 */
function classifyToType(raw: unknown): string {
  const c = String(raw ?? '').toLowerCase();
  if (c.includes('etf') || c.includes('fund')) return 'etf';
  if (c.includes('index') || c.includes('idx')) return 'index';
  if (c.includes('bond') || c.includes('债')) return 'bond';
  return 'stock';
}

interface EastmoneyCodeRow {
  Code?: unknown;
  Name?: unknown;
  MktNum?: unknown;
  Classify?: unknown;
  SecurityTypeName?: unknown;
}

interface EastmoneySuggestResponse {
  QuotationCodeTable?: { Data?: EastmoneyCodeRow[] | null };
}

@Injectable()
export class EastmoneySearchAdapter implements InstrumentSearchPort {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
  ) {}

  async search(query: string): Promise<InstrumentSearchHit[]> {
    const q = query.trim();
    if (q.length === 0) return [];

    const url =
      `${this.baseUrl}/api/suggest/get?input=${encodeURIComponent(q)}` +
      `&type=14&token=${SUGGEST_TOKEN}&count=10`;

    const res = await this.http.request<EastmoneySuggestResponse>({ url, method: 'GET' });
    const rows = res?.QuotationCodeTable?.Data;
    if (!Array.isArray(rows)) return [];

    const hits: InstrumentSearchHit[] = [];
    for (const row of rows) {
      const code = row.Code != null ? String(row.Code) : '';
      const name = row.Name != null ? String(row.Name) : '';
      if (code.length === 0 || name.length === 0 || row.MktNum == null) continue;
      const type = classifyToType(row.Classify ?? row.SecurityTypeName);
      // 债券 (751xxx 等, Classify='Bond') 不在 015 标的池意图内 (消费侧加自选/详情/行情
      // 仅 stock/etf/index); 主源能返但本地 pg_trgm fallback 不含 → 主源也剔除使两源对齐。
      if (type === 'bond') continue;
      try {
        hits.push({
          symbol: fromMktNum(row.MktNum as string | number, code),
          name,
          type,
        });
      } catch {
        // 未知 MktNum (指数/板块等) → 跳过坏项, 不整体失败 (容错解析)。
        continue;
      }
    }
    return hits;
  }
}
