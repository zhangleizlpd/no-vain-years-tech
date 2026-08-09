import { Injectable } from '@nestjs/common';
import type { VolatilityPort } from './volatility.port.js';
import type { VolatilityPoint, VolatilityRangeQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnly, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 波动率回看窗口集 (040 US1, clarify 定值): 30/60/250 日年化历史波动率。**adapter 常量驱动**
 * (非 DB 配置, plan Decision 5) — executor 对本集循环, 每窗口一次 `getVolatilityRange`。改子集 =
 * 改此常量 + 补 probe, 零 schema 变更。范式照 039 `lixinger-fundamental.adapter.ts` `FUNDAMENTAL_METRICS`。
 */
export const VOLATILITY_WINDOWS = [30, 60, 250] as const;

/**
 * 理杏仁波动率日频 adapter (040 US1, VOLATILITY_PORT live 实现)。
 *
 * POST `/${market}/company/volatility` body `{ token, stockCode, startDate, endDate?, volatilityDays }` ——
 * `stockCode` **单只** + `volatilityDays` **单数 number** (数组 `[250]` → HTTP 400
 * `"volatilityDays must be a number"`, p3 探查报告实测; 与短窗口的短卖端点一致「每端点单独确认 param
 * 契约」)。**不用 `metricsList`** (返回固定 `{date,value}`) → 无 p1 #670 all-or-nothing 静默 0 行坑。
 * **不注 Prisma / 不解析 fsType** (波动率与公司类型无关, 同 short-selling)。
 *
 * 响应字段极简 `{date,value}` (p3 prod PoC 实测:
 *   {"date":"2024-12-31T00:00:00+08:00","value":0.3267671516225093})。value = 该窗口年化 HV。
 * 摄取侧 live: backfill/delta 灌 PG VolatilityDaily, uk (instrumentId, date, volatilityDays)。
 */
interface LixingerVolatilityRow {
  date?: unknown;
  value?: unknown;
}

@Injectable()
export class LixingerVolatilityAdapter extends LixingerAdapterBase implements VolatilityPort {
  async getVolatilityRange(query: VolatilityRangeQuery): Promise<VolatilityPoint[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    // volatilityDays 单数 number (非数组); 数组 → vendor 400。
    const body: Record<string, unknown> = {
      stockCode,
      startDate: query.from,
      volatilityDays: query.volatilityDays,
    };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerVolatilityRow>(`/${market}/company/volatility`, body);

    return rows
      .map(
        (r): VolatilityPoint => ({
          date: lixDateOnly(r.date),
          value: lixNumToString(r.value),
        }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
