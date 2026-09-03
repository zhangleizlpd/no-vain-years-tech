import { Injectable } from '@nestjs/common';
import type { PrismaService } from '../security/prisma.service.js';
import type { FundamentalPort } from './fundamental.port.js';
import type { FundamentalRangeQuery, FundamentalSnapshotDto } from './marketdata.types.js';
import type { VendorHttpClient } from './vendor-http-client.js';
import {
  LixingerAdapterBase,
  lixDateOnly,
  lixNumToString,
  type FsType,
} from './lixinger-adapter.base.js';
import { groupByMarket, toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁估值 + 分位 adapter (015 T006, FUNDAMENTAL_PORT live 实现, FR-S11)。
 *
 * **fsType 内部路由 (FR-S11)** —— 端口签名 `getFundamentals(symbols)` 不暴露 fsType:
 *   1. 解析 stockCode 公司类型 (`fsTableType`): 先读 `Instrument.lixingerCompanyType` 缓存,
 *      缺失则 POST `/cn/company` 拿 `fsTableType` 回写缓存。
 *   2. 按 fsType 分组 POST `/cn/company/fundamental/{fsType}`。
 *
 * **取最新一条 = `date:"latest"`**（env-gated 真 IT 校真 2026-06-03）：多股票批量**必须**用
 * date 模式（`startDate` 仅限单股），字面量 `"latest"` 每 stockCode 返最新一行。price metric
 * 扁平返回（`pe_ttm` / `pe_ttm.y3.cvpos`）。静态 PE `pe` 是非法 price metric（已移除）→
 * peStatic/peDynamic 置 null（理杏仁仅 TTM 口径）。
 */

// 估值 + 分位 metric（env-gated 真 IT 校真 2026-06-03；price metric 扁平 key 返回）。
// `cmc`（流通市值）仅 cn 有效 —— 2026-07-12 prod 真调（领展 REIT 00823 逐 metric 单打）：hk
// fundamental 端点 `cmc` 无效, 而理杏仁 all-or-nothing → metricsList 含任一 hk 无效 metric 整
// 请求返 code=0 / 0 行。故 hk 需剔除 `cmc`（见 fundamentalMetricsFor）；分位字段 hk 全下发保留。
const FUNDAMENTAL_METRICS = [
  'pe_ttm',
  'pb',
  'ps_ttm',
  'dyr',
  'mc',
  'cmc',
  'pe_ttm.y3.cvpos',
  'pe_ttm.y5.cvpos',
  'pb.y3.cvpos',
  'pb.y5.cvpos',
] as const;

/**
 * 按 market 取合法 fundamental metricsList。hk 剔除 `cmc`（cn 有效但 hk 无效, 理杏仁
 * all-or-nothing 会拒整请求）；cn 用全量。分位字段（pe_ttm.y3.cvpos 等）hk 全下发, 保留。
 * ⇒ 出处: #670, 同 `lixinger-financials.adapter.ts`。
 */
function fundamentalMetricsFor(market: string): string[] {
  return market === 'hk'
    ? FUNDAMENTAL_METRICS.filter((m) => m !== 'cmc')
    : [...FUNDAMENTAL_METRICS];
}

type LixingerFundamentalRow = Record<string, unknown> & { date?: unknown; stockCode?: unknown };

/**
 * 理杏仁 fundamental 行 → DTO 值字段 (symbol/date 由调用方补; latest 批量 + 区间共用)。
 * price metric 仅 TTM 口径 (`pe` 非法) → peStatic/peDynamic 恒 null。
 * P2 已落地 (2026-07-12 prod 真调): hk fundamental 分位字段 (pePctlY3/Y5/pbPctlY3/Y5) 全下发,
 * 照解析; vendor 缺字段仍 `lixNumToString` 返 null (沿 015「字段缺失存 null 不报错」)。
 */
function mapFundamentalRow(
  r: LixingerFundamentalRow,
): Omit<FundamentalSnapshotDto, 'symbol' | 'date'> {
  return {
    peTtm: lixNumToString(r['pe_ttm']),
    peStatic: null,
    peDynamic: null,
    pb: lixNumToString(r['pb']),
    ps: lixNumToString(r['ps_ttm']),
    dividendYield: lixNumToString(r['dyr']),
    marketCap: lixNumToString(r['mc']),
    // hk 不请求 cmc (all-or-nothing) → r['cmc'] 缺失 → null; cn 照解析。
    circMarketCap: lixNumToString(r['cmc']),
    pePctlY3: lixNumToString(r['pe_ttm.y3.cvpos']),
    pePctlY5: lixNumToString(r['pe_ttm.y5.cvpos']),
    pbPctlY3: lixNumToString(r['pb.y3.cvpos']),
    pbPctlY5: lixNumToString(r['pb.y5.cvpos']),
  };
}

@Injectable()
export class LixingerFundamentalAdapter extends LixingerAdapterBase implements FundamentalPort {
  constructor(
    http: VendorHttpClient,
    token: string,
    baseUrl: string,
    // PrismaService 经 SecurityModule export 复用 (platform infra, ADR-0041);
    // 仅读写 marketdata 自己的 instrument 表 (intra, moat 已登记)。
    private readonly prisma: PrismaService,
  ) {
    super(http, token, baseUrl);
  }

  async getFundamentals(symbols: string[]): Promise<FundamentalSnapshotDto[]> {
    // 038 seam#1: 按 market 段路由 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛错 (旧「仅 cn」静默丢弃删)。
    const byMarket = groupByMarket(symbols);

    const out: FundamentalSnapshotDto[] = [];
    for (const [market, codeToSymbol] of byMarket) {
      const fsTypeByCode = await this.resolveFsTypes(this.prisma, market, [...codeToSymbol.keys()]);

      // 按 fsType 分组 → 每组一次 fundamental 调用 (endpoint 含 fsType)。
      const groups = new Map<FsType, string[]>();
      for (const [code, fsType] of fsTypeByCode) {
        const list = groups.get(fsType) ?? [];
        list.push(code);
        groups.set(fsType, list);
      }

      for (const [fsType, codes] of groups) {
        const rows = await this.post<LixingerFundamentalRow>(
          `/${market}/company/fundamental/${fsType}`,
          {
            stockCodes: codes,
            date: 'latest', // 多股票必须 date 模式; "latest" 每股返最新一行 (env-gated IT 校真)。
            metricsList: fundamentalMetricsFor(market), // hk 剔除 cmc (all-or-nothing 拒整请求)。
          },
        );
        for (const r of rows) {
          const symbol = codeToSymbol.get(String(r.stockCode));
          if (!symbol) continue;
          out.push({ symbol, date: lixDateOnly(r.date), ...mapFundamentalRow(r) });
        }
      }
    }
    return out;
  }

  /**
   * per-stock 区间抓取 (038 T013 seam#4, 形态照抄 `LixingerEodBarAdapter.getBars(from,to)`):
   * 单只 symbol → 解析 fsType → POST `/{market}/company/fundamental/{fsType}` body
   * `{stockCodes:[stockCode], startDate, endDate?, metricsList}` (单股仍传数组 + startDate 区间模式,
   * 非 `date:'latest'` 单快照) → 解析多行历史日频序列 (date 升序)。供 backfill 拉 10yr 历史。
   *
   * P4 已落地 (2026-07-12 prod 真调): `/hk/company/fundamental/{fsType}` 路径真实生效
   * (文档示例 URL 显 `cn/...` 系模板复用 A 股示例)。公司类型未解析 → 空数组 (不崩)。
   */
  async getFundamentalsRange(query: FundamentalRangeQuery): Promise<FundamentalSnapshotDto[]> {
    const { market, stockCode } = toLixinger(query.symbol);
    const fsTypeByCode = await this.resolveFsTypes(this.prisma, market, [stockCode]);
    const fsType = fsTypeByCode.get(stockCode);
    if (!fsType) return []; // 公司类型未解析 → 无端点路由 (缺数据不崩)。
    const body: Record<string, unknown> = {
      // 理杏仁 range 模式 (startDate) 须 stockCodes 数组 (即使单股); stockCode 单数 → HTTP 400
      // (2026-07-12 prod 真调实证; date:'latest' 批量本就用数组, mock/env-gated IT 没打真 range 故此前漏)。
      stockCodes: [stockCode],
      startDate: query.from,
      metricsList: fundamentalMetricsFor(market), // hk 剔除 cmc (all-or-nothing 拒整请求)。
    };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerFundamentalRow>(
      `/${market}/company/fundamental/${fsType}`,
      body,
    );
    return rows
      .map(
        (r): FundamentalSnapshotDto => ({
          symbol: query.symbol,
          date: lixDateOnly(r.date),
          ...mapFundamentalRow(r),
        }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)); // 区间历史 date 升序 (端口契约)。
  }
}
