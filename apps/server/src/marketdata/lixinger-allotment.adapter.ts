import { Injectable } from '@nestjs/common';
import type { AllotmentPort } from './allotment.port.js';
import type { AllotmentDto, AllotmentRangeQuery } from './marketdata.types.js';
import {
  LixingerAdapterBase,
  lixDateOnly,
  lixDateOnlyOrNull,
  lixNumToString,
} from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁配股事件 adapter (041 US4, ALLOTMENT_PORT live 实现)。
 *
 * POST `/${market}/company/allotment` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 `stockCodes` → HTTP 400, 同 039 short-selling 单数契约)。**不用
 * `metricsList`** → 无 p1 #670 all-or-nothing 静默 0 行坑。**预期多数标的 vendor 返 0 行** →
 * 空数组正常返回 (不崩不阻塞工作集其余标的)。摄取侧 live: backfill/delta 灌 PG AllotmentEvent。
 *
 * 041 建表时 p3 probe 扫 12 标的全 0 行 → 按「零样本 / 字段 schema 未知」整存 payload
 * (plan Decision 5 预留「首个真实非空样本后可 expand 提列」)。**该前提 2026-08-01 证伪**:
 * prod 已积累 545 行真实样本, 字段固定 (真 API 探测校真):
 *   {"date":"2016-07-08T00:00:00+08:00","exDate":"2016-08-31T00:00:00+08:00","currency":"HKD",
 *    "allotmentRatio":3,"allotmentPrice":0.43,"allotmentShares":948857166}
 * → 本 adapter 兑现提列; `payload` 仍整存原始行 (allotmentShares 等未提列字段无损保留)。
 *
 * 🚨 `date` 是**公告日** (自然键), `exDate` 才是**除权日** —— 545 行实测 510 行两者不同 (间隔可达
 * 4 个月), 另 35 行 vendor 无 `exDate`。复权因子按除权日定版本边界, **勿拿 `date` 关联除权事件**。
 * 金融数值跨边界一律 string|null (FR-S08); 可空日期用 `lixDateOnlyOrNull` (缺失落 null 而非空串)。
 */
interface LixingerAllotmentRow {
  date?: unknown;
  exDate?: unknown;
  allotmentRatio?: unknown;
  allotmentPrice?: unknown;
  currency?: unknown;
  [key: string]: unknown;
}

@Injectable()
export class LixingerAllotmentAdapter extends LixingerAdapterBase implements AllotmentPort {
  async getAllotmentRange(query: AllotmentRangeQuery): Promise<AllotmentDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerAllotmentRow>(`/${market}/company/allotment`, body);

    return rows
      .map(
        (r): AllotmentDto => ({
          date: lixDateOnly(r.date),
          exDate: lixDateOnlyOrNull(r.exDate),
          allotmentRatio: lixNumToString(r.allotmentRatio),
          allotmentPrice: lixNumToString(r.allotmentPrice),
          // currency 为文本字段, lixNumToString 对 string 输入亦返 string|null (与 equity-change
          // 的 changeReason 同处理) → 复用同一 vendor 字段归一化。
          currency: lixNumToString(r.currency),
          // 提列列之外的字段 (allotmentShares 等) 靠整存无损保留, 无需再改 schema 即可回查。
          payload: { ...r },
        }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
