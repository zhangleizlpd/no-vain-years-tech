import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { EodBarPort } from './eod-bar.port.js';
import type { Adjust, EodBarPoint, EodBarQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnly, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/** 理杏仁 `change` (涨跌幅小数, 如 -0.0215) → 百分数 string ("-2.1500"); 缺失透传 null。
 *  Decimal ×100 (非 Float, 防 -0.0215*100 = -2.1499999 漂移)。 */
/**
 * 📌 **盘中问「今天」返空数组**（2026-08-19 prod 取证，与富途相反）。
 *
 * 本端点在该 session 尚未收盘时对 `end = 今天` 返**空**，`syncEodBarNone` 拿到空数组即
 * 早返、零落库 ⇒ cn/hk 历史上从未落过「半根 K」，即便有 5 次触发真的落在盘中/午休。
 *
 * 🚨 **别把这当成代码层的保护** —— 它是 vendor 行为，不是判据。同一个判据缺失在富途
 * (`futu-eod-bar.adapter.ts`) 上就落了 #103。采集侧的真防线是 `sync-asof.rules.ts` 的
 * 收盘口径 asOf（ADR-0066 §2）。
 */
function lixPctToString(v: unknown): string | null {
  const s = lixNumToString(v);
  return s === null ? null : new Prisma.Decimal(s).times(100).toFixed(4);
}

/**
 * 理杏仁 EOD 日线 adapter (015 T006, EOD_BAR_PORT live 实现)。
 *
 * POST `/cn/company/candlestick` (求证: Python/R 客户端库): body `{ token, type,
 * startDate, endDate?, stockCode }` —— `stockCode` **单只** (非数组)。`type` 复权口径:
 *   none → ex_rights (不复权) / forward → fc_rights (前复权) / backward → bc_rights (后复权)。
 *
 * 数据点字段 `date/open/high/low/close/volume/amount/change/to_r` 已求证 (实测 ex_rights 响应)。
 * `change` = **官方涨跌幅小数** (已含除权除息调整, 非相邻收盘差) → ×100 存 changePct;
 * `to_r` = 换手率 → turnoverRate。理杏仁不下发 prevClose → null (官方昨收由读侧 close+changePct 反推)。
 *
 * 这是**摄取侧** live 实现: 016 同步管线调它灌 PG DailyBar;读端点 (报价/详情/K线)
 * 读 PG, 不在请求路径直打理杏仁。
 */

/** canonical adjust → 理杏仁 candlestick `type` (求证 Python Literal + R man-page)。 */
const ADJUST_TO_TYPE: Record<Adjust, string> = {
  none: 'ex_rights',
  forward: 'fc_rights',
  backward: 'bc_rights',
};

interface LixingerCandlestickPoint {
  date?: unknown;
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
  amount?: unknown;
  change?: unknown; // 官方涨跌幅小数 (除权除息调整后)
  to_r?: unknown; // 换手率
}

@Injectable()
export class LixingerEodBarAdapter extends LixingerAdapterBase implements EodBarPort {
  async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
    if (!query.from) {
      // 理杏仁 candlestick 必填 startDate (区间 ≤ 10 年)。016 同步永远供区间;
      // 缺 from = 调用方契约错 → 明确抛, 不向理杏仁发无 startDate 的坏请求。
      throw new Error('[lixinger] getBars requires query.from (startDate)');
    }
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = {
      type: ADJUST_TO_TYPE[query.adjust],
      startDate: query.from,
      stockCode,
    };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerCandlestickPoint>(`/${market}/company/candlestick`, body);

    return rows
      .map(
        (r): EodBarPoint => ({
          tradeDate: lixDateOnly(r.date),
          adjust: query.adjust,
          open: lixNumToString(r.open) ?? '0',
          high: lixNumToString(r.high) ?? '0',
          low: lixNumToString(r.low) ?? '0',
          close: lixNumToString(r.close) ?? '0',
          changePct: lixPctToString(r.change), // 官方涨跌幅 ×100 (除权除息调整后)。
          prevClose: null, // 理杏仁 ex_rights 不下发昨收;官方昨收由读侧 close+changePct 反推。
          volume: lixNumToString(r.volume),
          amount: lixNumToString(r.amount),
          turnoverRate: lixNumToString(r.to_r), // 换手率 (理杏仁 `to_r`)。
        }),
      )
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate)); // 端口契约: tradeDate 升序。
  }
}
