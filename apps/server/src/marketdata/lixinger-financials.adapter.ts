import { Injectable } from '@nestjs/common';
import type { PrismaService } from '../security/prisma.service.js';
import type { FinancialsPort } from './financials.port.js';
import type { FinancialMetricDto, FinancialsRangeQuery } from './marketdata.types.js';
import type { VendorHttpClient } from './vendor-http-client.js';
import { LixingerAdapterBase, lixNumToString, type FsType } from './lixinger-adapter.base.js';
import { groupByMarket, toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁财报衍生 adapter (015 T006, FINANCIALS_PORT live 实现)。
 *
 * POST `/cn/company/fs/{fsType}`（fsType trailing 段，复用 `resolveFsTypes` 缓存，FR-S11）。
 * **取最新一期 = `date:"latest"`**（多股票必须 date 模式）。
 *
 * **fs metric 名经 env-gated 真 IT 校真（2026-06-03）**：格式 `q.<报表>.<科目>.<计算类型>`
 * （`m`=指标库 / `ps`=利润表 / `bs`=资产负债表；`t`=当期累计）——旧 provisional `q.metrics.*.ttm`
 * 是错的（→ 400 invalid fs metrics）。⚠️ **请求**用扁平 dotted 字符串，**响应**是**嵌套**对象
 * （`r.q.m.roe.t`），非扁平 key。
 */

// fs metric 按 fsType 区分（env-gated 真 IT 校真 2026-06-03）：ROE/EPS 各类公司通用；
// 毛利率 `q.ps.gp_m.t` **仅非金融** —— 银行/保险/券商无此科目, 发了整请求 400（SC-S08 实测）。
// BPS `q.bs.tetoshopc_ps.t`（归母每股净资产）**仅 cn 有效** —— 2026-07-12 prod 真调（腾讯
// 00700 non_financial / 领展 00823 reit 逐 metric 单打）：hk fs 端点该科目无效, 而理杏仁
// all-or-nothing → metricsList 含任一 hk 无效 metric 整请求 code=0 / 0 行。故 hk 剔除 BPS。
const UNIVERSAL_FS_METRICS = ['q.m.roe.t', 'q.ps.beps.t', 'q.bs.tetoshopc_ps.t'] as const;
const NON_FINANCIAL_FS_METRICS = ['q.ps.gp_m.t'] as const; // 毛利率, 仅 non_financial

/**
 * 按 market + fsType 取该类公司合法的 fs metricsList。金融类无毛利率；hk 剔除 BPS
 * `q.bs.tetoshopc_ps.t`（cn 有效但 hk 无效, 理杏仁 all-or-nothing 会拒整请求）。
 */
function fsMetricsFor(market: string, fsType: FsType): string[] {
  const base =
    fsType === 'non_financial'
      ? [...UNIVERSAL_FS_METRICS, ...NON_FINANCIAL_FS_METRICS]
      : [...UNIVERSAL_FS_METRICS];
  return market === 'hk' ? base.filter((m) => m !== 'q.bs.tetoshopc_ps.t') : base;
}

/** fs 响应嵌套: `r.q.<报表>.<科目>.<计算类型>`。 */
interface LixingerFsRow {
  date?: unknown;
  stockCode?: unknown;
  q?: Record<string, Record<string, Record<string, unknown>>>;
}

/** 读嵌套 fs 值 `r.q.<report>.<field>.<calc>`（缺失链路 → undefined）。 */
function fsVal(r: LixingerFsRow, report: string, field: string, calc: string): unknown {
  return r.q?.[report]?.[field]?.[calc];
}

/** 理杏仁 fs 行 → DTO 值字段 (symbol/reportPeriod 由调用方补; latest 批量 + 区间共用)。 */
function mapFsRow(r: LixingerFsRow): Omit<FinancialMetricDto, 'symbol' | 'reportPeriod'> {
  return {
    roe: lixNumToString(fsVal(r, 'm', 'roe', 't')),
    grossMargin: lixNumToString(fsVal(r, 'ps', 'gp_m', 't')),
    eps: lixNumToString(fsVal(r, 'ps', 'beps', 't')),
    // hk bps 暂 null: hk 不请求 q.bs.tetoshopc_ps.t (all-or-nothing) → 缺失链路 undefined → null。
    // 理杏仁 hk fs 该科目名待考, 后续可补 (cn 照解析)。
    bps: lixNumToString(fsVal(r, 'bs', 'tetoshopc_ps', 't')),
  };
}

@Injectable()
export class LixingerFinancialsAdapter extends LixingerAdapterBase implements FinancialsPort {
  constructor(
    http: VendorHttpClient,
    token: string,
    baseUrl: string,
    // PrismaService — platform infra (ADR-0041); 仅读写 intra instrument 表。
    private readonly prisma: PrismaService,
  ) {
    super(http, token, baseUrl);
  }

  async getFinancials(symbols: string[]): Promise<FinancialMetricDto[]> {
    // 038 seam#1: 按 market 段路由 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛错 (旧「仅 cn」静默丢弃删)。
    const byMarket = groupByMarket(symbols);

    const out: FinancialMetricDto[] = [];
    for (const [market, codeToSymbol] of byMarket) {
      const fsTypeByCode = await this.resolveFsTypes(this.prisma, market, [...codeToSymbol.keys()]);

      const groups = new Map<FsType, string[]>();
      for (const [code, fsType] of fsTypeByCode) {
        const list = groups.get(fsType) ?? [];
        list.push(code);
        groups.set(fsType, list);
      }

      for (const [fsType, codes] of groups) {
        const rows = await this.post<LixingerFsRow>(`/${market}/company/fs/${fsType}`, {
          stockCodes: codes,
          date: 'latest', // 多股票必须 date 模式; "latest" 每股返最新一期 (env-gated IT 校真)。
          metricsList: fsMetricsFor(market, fsType), // 金融类无毛利率 + hk 剔除 BPS → 按 market/fsType 裁剪。
        });
        for (const r of rows) {
          const symbol = codeToSymbol.get(String(r.stockCode));
          if (!symbol) continue;
          out.push({ symbol, reportPeriod: deriveReportPeriod(r.date), ...mapFsRow(r) });
        }
      }
    }
    return out;
  }

  /**
   * per-stock 区间抓取 (038 T013 seam#4, 形态照抄 `LixingerEodBarAdapter.getBars(from,to)`):
   * 单只 symbol → 解析 fsType → POST `/{market}/company/fs/{fsType}` body
   * `{stockCodes:[stockCode], startDate, endDate?, metricsList}` (单股仍传数组 + startDate 区间模式,
   * 非 `date:'latest'`) → 解析多期财报序列 (reportPeriod 升序)。供 backfill 拉历史多期。
   *
   * P4 已落地 (2026-07-12 prod 真调): 真实 `/hk/company/fs/{fsType}` 路径生效; hk metricsList
   * 剔除 BPS (all-or-nothing)。公司类型未解析 → 空数组 (不崩)。
   */
  async getFinancialsRange(query: FinancialsRangeQuery): Promise<FinancialMetricDto[]> {
    const { market, stockCode } = toLixinger(query.symbol);
    const fsTypeByCode = await this.resolveFsTypes(this.prisma, market, [stockCode]);
    const fsType = fsTypeByCode.get(stockCode);
    if (!fsType) return []; // 公司类型未解析 → 无端点路由 (缺数据不崩)。
    const body: Record<string, unknown> = {
      // 理杏仁 range 模式 (startDate) 须 stockCodes 数组 (即使单股); stockCode 单数 → HTTP 400
      // (2026-07-12 prod 真调实证; date:'latest' 批量本就用数组, mock/env-gated IT 没打真 range 故此前漏)。
      stockCodes: [stockCode],
      startDate: query.from,
      metricsList: fsMetricsFor(market, fsType), // 金融类无毛利率 + hk 剔除 BPS → 按 market/fsType 裁剪。
    };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerFsRow>(`/${market}/company/fs/${fsType}`, body);
    return rows
      .map(
        (r): FinancialMetricDto => ({
          symbol: query.symbol,
          reportPeriod: deriveReportPeriod(r.date),
          ...mapFsRow(r),
        }),
      )
      .sort((a, b) => a.reportPeriod.localeCompare(b.reportPeriod)); // 多期升序 (端口契约)。
  }
}

/** 理杏仁报告期 date (ISO) → `YYYYQn` (财报衍生端口契约)。 */
function deriveReportPeriod(date: unknown): string {
  const iso = String(date ?? '');
  const year = iso.slice(0, 4);
  const month = Number(iso.slice(5, 7));
  const quarter = month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
  return `${year}Q${quarter}`;
}
