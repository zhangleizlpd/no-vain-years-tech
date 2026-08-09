import { Injectable } from '@nestjs/common';
import type { InstrumentUniversePort } from './instrument-universe.port.js';
import { LixingerAdapterBase } from './lixinger-adapter.base.js';
import type { UniverseEntry } from './marketdata.types.js';

/**
 * 理杏仁 universe 枚举 adapter (ADR-0047 §2 + Amendment 2026-06-03, INSTRUMENT_UNIVERSE_PORT
 * primary 实现)。
 *
 * POST `/{market}/company` **不带 `stockCodes`** → 理杏仁返该市场全 company 列表 (2026-06-03 真
 * token 实测 cn: `code=1 count=5622`, 含北交所 920xxx, **单次返回无分页**)。逐项取 `stockCode` /
 * `name` 归一化 canonical `${market}:${code}` (与 `EastmoneyUniverseAdapter` 同市场粒度 `cn`, 保证两源
 * 经 FallbackChain 切换时 upsert 命中同一 `(market, code)` 键, 不造重复 Instrument 行)。
 * **038 T008**: 逐 `ENUMERATED_MARKETS` (cn + hk) 枚举 → 多市场 canonical; 各维度 marketScope 下游过滤。
 *
 * **容错解析**: 缺 stockCode / name 的坏项跳过、不整体失败 (镜像东财 universe adapter);
 * canonical 去重。`/cn/company` 应用层错 (无效 token / 非数组 data) → `LixingerAdapterBase.post`
 * 抛 Error → 上抛由 `UniverseFallbackChainAdapter` 平移东财备源。
 *
 * **per-provider 熔断 / 限频 / 退避**由共享 `LIXINGER_HTTP_CLIENT` (`VendorHttpClient` 的
 * cockatiel ConsecutiveBreaker, ADR-0047 §3) 在传输层承担 —— 本 adapter 不自管 (避免双层冗余熔断)。
 *
 * **退市/状态处理 (raw + normalized 并存)**: 响应 `listingStatus` 是 9 值谱系 (2026-06-03 实测:
 * normally_listed 5353 / special_treatment(ST) 108 / delisting_risk_warning(*ST) 134 /
 * delisting_transitional_period 8 / ipo_suspension 8 / issued_but_not_listed 5 / undefined 4 /
 * issue_failure 1 / unauthorized 1)。本 adapter:
 *   - `listingStatus`: 原样透传 (供审计 + 前端 ST/*ST 徽标 + 改映射不重 sync);
 *   - `status`: 经 allowlist 归一成 active/inactive (ADR-0047 §5 归一化在 adapter)。**4 个可交易值**
 *     (含 ST/*ST/退市整理期 —— 它们仍在交易、有日线) → active; 其余 (暂停/未上市/发行失败/未知)
 *     → inactive (allowlist fail-safe: 未来未知值默认不同步, 不烧配额)。`SyncUniverseUseCase`
 *     按 status 落库、`loadActiveInstruments` 据此筛同步工作集。
 *   - `listDate`: 取 `ipoDate` 日期段。
 */

/** 仍在交易 (有日线) 的 listingStatus 白名单 → active; 其余 inactive (allowlist, fail-safe)。 */
const TRADEABLE_LISTING_STATUSES: ReadonlySet<string> = new Set<string>([
  'normally_listed',
  'special_treatment', // ST — 风险警示但仍交易
  'delisting_risk_warning', // *ST — 仍交易
  'delisting_transitional_period', // 退市整理期 — 摘牌前短期仍交易
]);

/** 理杏仁 listingStatus 原值 → Instrument.status (可交易→active, 其余/未知→inactive)。 */
export function listingStatusToStatus(raw: string | null): 'active' | 'inactive' {
  return raw !== null && TRADEABLE_LISTING_STATUSES.has(raw) ? 'active' : 'inactive';
}

interface LixingerCompanyRow {
  stockCode?: unknown;
  name?: unknown;
  listingStatus?: unknown;
  ipoDate?: unknown;
}

/**
 * 枚举的市场段 (038 T008 seam#1): 各市场 `/{market}/company` 全集枚举, canonical 按 market 粒度。
 * 加市场 = 此处加一值 (adapter 内多市场; 各维度 marketScope 再下游过滤工作集)。
 */
const ENUMERATED_MARKETS: readonly string[] = ['cn', 'hk'];

@Injectable()
export class LixingerUniverseAdapter extends LixingerAdapterBase implements InstrumentUniversePort {
  async enumerate(markets: string[]): Promise<UniverseEntry[]> {
    const out: UniverseEntry[] = [];
    const seen = new Set<string>();
    const failures: string[] = [];
    // 038 T008 / S2-T2 per-market: 逐市场枚举 (/{market}/company), 仅本 adapter 支持的市场
    // (ENUMERATED_MARKETS = cn/hk) ∩ 请求 markets (给 ['us'] → 空集不外呼)。fail-soft: 单市场
    // 失败 (vendor 错 / 熔断) 记录续跑其余市场 (hk 失败不拖累 cn); 全市场失败才上抛交 FallbackChain 平移。
    for (const market of ENUMERATED_MARKETS.filter((m) => markets.includes(m))) {
      try {
        const rows = await this.post<LixingerCompanyRow>(`/${market}/company`, {}); // 不带 stockCodes → 该市场全集
        for (const row of rows) {
          const code = row.stockCode != null ? String(row.stockCode) : '';
          const name = row.name != null ? String(row.name) : '';
          if (code.length === 0 || name.length === 0) continue; // 容错: 坏项跳过
          // /{market}/company = 该市场全集 → canonical 市场粒度 = market (cn 沪/深/北均归 cn, 同东财 universe)。
          const canonical = `${market}:${code}`;
          if (seen.has(canonical)) continue; // 去重
          seen.add(canonical);
          const listingStatus = row.listingStatus != null ? String(row.listingStatus) : null;
          const ipo = row.ipoDate != null ? String(row.ipoDate).slice(0, 10) : '';
          out.push({
            market,
            // DEFERRED-PROBE(P1): hk listingStatus 值域待 T020 真调确认; 现沿 allowlist fail-safe
            // (非明确可交易值一律 → inactive, 不纳入工作集) + listingStatus 原值存档供改映射不重 sync。
            code,
            name,
            status: listingStatusToStatus(listingStatus),
            listingStatus,
            listDate: ipo.length === 10 ? ipo : null,
          });
        }
      } catch (err) {
        failures.push(`${market}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (out.length === 0 && failures.length > 0) {
      // 全市场枚举失败 → 上抛 (交 UniverseFallbackChain 平移备源, ADR-0047 §6)。
      throw new Error(`[lixinger] universe 全市场枚举失败: ${failures.join(' | ')}`);
    }
    return out;
  }
}
