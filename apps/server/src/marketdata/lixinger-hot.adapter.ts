import { Injectable } from '@nestjs/common';
import type { HotSnapshotPort } from './hot-snapshot.port.js';
import type { HotSnapshotDto, HotSnapshotQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnlyOrNull } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 热度精选 type 子集 (040 US2, clarify 定值): 卖空聚合 / 换手率 / 股东数 / 相对强度 —— 四类量化常用
 * 因子, 字段均已 p3 probe 验证。**adapter 常量驱动** (非 DB 配置, plan Decision 5) — executor 对本集
 * 循环, 每 type 一次 `getHotSnapshot`。改子集 = 改此常量 + 补 probe, 零 schema 变更。范式照
 * `lixinger-volatility.adapter.ts` `VOLATILITY_WINDOWS`。
 */
export const HOT_TYPES = ['ss', 'tr', 'capita', 'rep'] as const;

/**
 * 理杏仁热度精选快照 adapter (040 US2, HOT_SNAPSHOT_PORT live 实现)。
 *
 * POST `/${market}/company/hot/${hotType}` body `{ token, stockCodes }` —— `stockCodes` **数组**
 * (与波动率单数 stockCode 相反! p3 探查报告实测, param 契约每端点单独确认) + **无日期** (快照家族
 * 忽略请求日期永返最新, 1 行/股含 `last_data_date`)。**不注 Prisma / 不解析 fsType** (热度与公司类型
 * 无关, 同 short-selling)。
 *
 * 每 type 返回字段结构完全不同 (capita/ss/tr/rep 字段各异, p3 探查报告 §hot) → payload **整存 vendor
 * 原始异构字段** (样板 `CorporateAction.payload`), 新增 type 零 schema 变更 (FR-006)。⚠️ **`hot/rep`
 * 含异常 key `"undefined"`** (vendor 数据质量) → 解析层**忽略该 key** (FR-007)。`last_data_date` →
 * `dataDate` (自然键之一; 缺 → 跳过该行, 无法定位数据日期无法建自然键, 同 corp-action 无 exDate 过滤)。
 */
interface LixingerHotRow {
  last_data_date?: unknown;
  [key: string]: unknown;
}

/** vendor 原始行 → payload: 整存字段, 但**忽略异常 key `"undefined"`** (hot/rep 数据质量, FR-007)。 */
function toPayload(raw: LixingerHotRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'undefined') continue; // vendor 数据质量: hot/rep 含异常 key "undefined" → 忽略。
    payload[k] = v;
  }
  return payload;
}

@Injectable()
export class LixingerHotAdapter extends LixingerAdapterBase implements HotSnapshotPort {
  async getHotSnapshot(query: HotSnapshotQuery): Promise<HotSnapshotDto[]> {
    if (query.stockCodes.length === 0) return [];
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    // 快照家族标的同 market (executor per-stock 传单只) → market 段按首只插值, stockCodes 收全部 code。
    const converted = query.stockCodes.map((s) => toLixinger(s));
    const market = converted[0].market;
    const stockCodes = converted.map((c) => c.stockCode);

    const rows = await this.post<LixingerHotRow>(`/${market}/company/hot/${query.hotType}`, {
      stockCodes,
    });

    return rows
      .map((r) => ({
        hotType: query.hotType,
        dataDate: lixDateOnlyOrNull(r.last_data_date),
        payload: toPayload(r),
      }))
      .filter((d): d is HotSnapshotDto => d.dataDate !== null); // 无 last_data_date → 无自然键, 跳过。
  }
}
