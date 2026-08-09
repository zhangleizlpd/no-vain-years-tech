import { Injectable, Logger } from '@nestjs/common';
import type { InstrumentUniversePort } from './instrument-universe.port.js';
import type { UniverseEntry } from './marketdata.types.js';
import type { VendorHttpClient } from './vendor-http-client.js';
import { fromMktNum } from './eastmoney-symbol.rules.js';

/**
 * 东方财富 universe 枚举 adapter (016 T007, INSTRUMENT_UNIVERSE_PORT live 实现, FR-S01 / US3)。
 *
 * GET `/api/qt/clist/get` (push2 行情列表)。`fs` 参数按板块过滤, 覆盖全 A 股含北交所:
 * 沪主板 + 科创板 + 深主板 + 创业板 + 北交所。逐项 `f12`(code) / `f13`(MktNum) / `f14`(name)
 * 经 `fromMktNum` 归一化 canonical `market:code`。**分页**: 首页读 `data.total` 驱动翻页,
 * 翻到覆盖全集 (限频由共享 VendorHttpClient 双窗令牌桶节流)。**容错解析**: 未知 MktNum /
 * 缺字段坏项跳过, 不整体失败 (spec edge「universe 部分降级」); canonical 去重 (防板块重叠
 * 收录同标的)。
 *
 * **真端点路径 / `fs` 板块码 / `f1x` 字段值**由 env-gated 真东财 IT 校真 (SC-S08,
 * `RUN_MARKETDATA_IT`) — 此处仅解析逻辑 (沿 015 全 adapter「求证 + env-gated IT 校真值」范式)。
 * clist 在 push2 域 (与 searchapi suggest 不同 host) → 独立 baseUrl, 共享东财 profile/限频。
 */

/**
 * 全 A 股板块过滤 (clist `fs`)。`m:0/1` = 深/沪市场号; `t:`/`s:` = 板块细分码。
 *   m:1+t:2 沪主板 / m:1+t:23 科创板 / m:0+t:6 深主板 / m:0+t:80 创业板 / m:0+t:81+s:2048 北交所。
 * ⚠️ **板块内空格必须用字面 `+` (不可 `encodeURIComponent` → `%20`/`%3A` 会让东财忽略 fs、
 * 返全集 5.8 万板块码 BKxxxx)**; `:`/`,` 同样保持字面不 encode。2026-06-03 真东财校真:
 * `+` 形态 total≈5858 真股票, encode 形态 total=57942 板块块 (生产 mock→live 切换实跑暴露)。
 */
const FS_ALL_A_SHARES = 'm:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80,m:0+t:81+s:2048';

/**
 * clist `fs` per-market 板块过滤码 (S2-T2 多市场)。cn=全 A 股 (上); hk=`m:116` 港股全集
 * (PoC-2 实测 17938 只)。
 * ⚠️ 同 cn fs 的 `+`/`:`/`,` 字面不 encode 铁律 (见上)。未列市场 → enumerate 静默跳过。
 *
 * 🪦 **us 路径已退役** (2026-07-31, sellput-viz Phase 1 #4): 原为 `m:105,m:106,m:107`
 * (NASDAQ/NYSE/AMEX)。退役理由不是"能用但不好", 是**它一直在静默少收**:
 * `push2` 服务端硬封顶 **100 条/响应**且无视 `pz`, 而下方翻页按 `PAGE_SIZE=500` 推进游标
 * ⇒ `(pn-1)*500 < total` 跑 28 页 × 100 = **2800 条 / 全集 13683**, 循环正常结束、不触
 * `MAX_PAGES`、不触零行 break —— **完全静默**, 且因按 code 降序截断, `AAPL` 这类 A 打头的票
 * 根本搜不到 (p3b E30/E16 实测)。接替者 = 富途 `get_stock_basicinfo`
 * (`futu-universe.adapter.ts`): **1 次请求取 19,202 条全集**, 且是持牌券商正式 API 而非
 * `robots.txt Disallow: /` 的逆向端点。
 *
 * 🚨 **别把 us 加回来**: 加回来 = 链上多一个"非空但残缺"的节点, 而
 * `UniverseFallbackChainAdapter` 的降级判据是"返空才平移" ⇒ 富途一挂就会被这个残缺源接住,
 * 静默写入 2800 条的 us universe。**宁可该市场整链耗尽返空** (fail-soft, 沿用 DB 既有清单)。
 * ⚠️ 下方 `PAGE_SIZE` / `MAX_PAGES` 的分页缺陷对 cn/hk **不成立** (两者 total 与实收对得上,
 * 见 IT), 故只退 us、不改分页实现。
 */
const MARKET_TO_FS: ReadonlyMap<string, string> = new Map([
  ['cn', FS_ALL_A_SHARES],
  ['hk', 'm:116'],
]);

/** 单页拉取条数 (clist 上限较宽, 取 500 控翻页轮次)。 */
const PAGE_SIZE = 500;
/** 翻页 runaway 保护 (~5500 A 股 / 500 ≈ 11 页; 100 页 = 50k 远超全集, 命中即告警非静默截断)。 */
const MAX_PAGES = 100;

interface ClistRow {
  f12?: unknown; // code
  f13?: unknown; // MktNum (0=深/北, 1=沪)
  f14?: unknown; // name
}

interface ClistResponse {
  data?: { total?: unknown; diff?: ClistRow[] | Record<string, ClistRow> | null } | null;
}

@Injectable()
export class EastmoneyUniverseAdapter implements InstrumentUniversePort {
  private readonly logger = new Logger(EastmoneyUniverseAdapter.name);

  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
  ) {}

  async enumerate(markets: string[]): Promise<UniverseEntry[]> {
    const out: UniverseEntry[] = [];
    const seen = new Set<string>(); // 跨市场共享: canonical `market:code` 天然隔离, 兼板块重叠去重。
    for (const market of markets) {
      const fs = MARKET_TO_FS.get(market);
      if (!fs) {
        this.logger.warn(
          `[eastmoney] universe 不支持市场 "${market}", 跳过 (支持 cn/hk; us 已退役换源富途)`,
        );
        continue;
      }
      await this.enumerateMarket(fs, seen, out);
    }
    return out;
  }

  /** 单市场分页枚举 (fs 已定): 翻页至覆盖 `total`; 命中 MAX_PAGES → 显式告警非静默截断。 */
  private async enumerateMarket(
    fs: string,
    seen: Set<string>,
    out: UniverseEntry[],
  ): Promise<void> {
    let total = Number.POSITIVE_INFINITY;
    let pn = 1;
    while ((pn - 1) * PAGE_SIZE < total) {
      if (pn > MAX_PAGES) {
        // 非静默截断: total 异常或翻页失控 → 显式告警 (CLAUDE.md「无声截断禁止」)。
        this.logger.error(
          `[eastmoney] universe enumerate 命中翻页上限 ${MAX_PAGES} 页 (fs=${fs}, total=${total}); 收录 ${out.length} 截断`,
        );
        break;
      }
      const res = await this.http.request<ClistResponse>({
        url: this.pageUrl(pn, fs),
        method: 'GET',
      });
      if (typeof res?.data?.total === 'number') total = res.data.total;

      const rows = normalizeDiff(res?.data?.diff);
      if (rows.length === 0) break;
      for (const row of rows) collectRow(row, seen, out);
      pn++;
    }
  }

  private pageUrl(pn: number, fs: string): string {
    return (
      `${this.baseUrl}/api/qt/clist/get?pn=${pn}&pz=${PAGE_SIZE}` +
      `&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${fs}` +
      `&fields=f12,f13,f14`
    );
  }
}

/** clist `diff` 多版本: 新版数组 / 旧版 index-keyed 对象 / 异常 → 统一成数组。 */
function normalizeDiff(rawDiff: unknown): ClistRow[] {
  if (Array.isArray(rawDiff)) return rawDiff as ClistRow[];
  if (rawDiff && typeof rawDiff === 'object') return Object.values(rawDiff) as ClistRow[];
  return [];
}

/** 单行解析 + 归一化 + 去重收录; 坏项 (缺字段 / 未知 MktNum) 跳过, 不整体失败。 */
function collectRow(row: ClistRow, seen: Set<string>, out: UniverseEntry[]): void {
  const code = row.f12 != null ? String(row.f12) : '';
  const name = row.f14 != null ? String(row.f14) : '';
  if (code.length === 0 || name.length === 0 || row.f13 == null) return;
  try {
    const canonical = fromMktNum(row.f13 as string | number, code);
    if (seen.has(canonical)) return; // 板块重叠去重
    seen.add(canonical);
    out.push({ market: canonical.slice(0, canonical.indexOf(':')), code, name });
  } catch {
    // 未知 MktNum (非 A 股) → 跳过坏项, 不整体失败 (容错解析)。
  }
}
