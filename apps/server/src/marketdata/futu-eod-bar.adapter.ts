import { Injectable } from '@nestjs/common';
import type { EodBarPort } from './eod-bar.port.js';
import type { Adjust, EodBarPoint, EodBarQuery } from './marketdata.types.js';
import { parseCanonicalSymbol } from './marketdata.rules.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * 富途 us 正股日线 adapter (sellput-viz, `EOD_BAR_PORT` 的 us 实现)。理杏仁对 us **代码层
 * 硬编码拒绝**（`toLixinger` 抛 `UnsupportedLixingerMarketError`，注释理由「美股理杏仁仅
 * index 无个股」，p3b E17）⇒ us 日线需要独立实现，而不是给 `LixingerEodBarAdapter` 扩市场。
 *
 * GET `<shim>/kline?code=US.PEP&start&end&ktype=K_DAY&autype=NONE`，Bearer 鉴权。
 *
 * ## 🚨🚨 盘中问「今天」会返一根**进行中**的 K 线（2026-08-19 prod 取证）
 *
 * 这条差异是 #103 的直接成因，且**仓内此前零处记录**：本端点在该 session 尚未收盘时，对
 * `end = 今天` **照样返一行**，装的是「截至此刻」的累计值 —— 实测 volume 仅正常日的
 * 23%–56%，close 与官方收盘价最大差 `+1.88%`。而 `daily_bar` 的写路径是
 * `createMany(skipDuplicates)` ⇒ 那根半根 K 按唯一键占位、**永久驻留**，当晚真收盘那轮被
 * 静默挡掉，`sync_run` 却记 `ok=15 failed=0`。
 *
 * 📌 **理杏仁（cn/hk）在同样情形下返空数组** —— 所以同一个判据缺失只在 us 显形，cn/hk 在
 * 5 次盘中触发下都干净。⇒ **cn/hk 的安全不是代码给的，是 vendor 给的。**
 *
 * ⇒ 采集侧的防线是 `sync-asof.rules.ts` 把区间右端退到**已收盘 session**（ADR-0066 §2），
 * 本 adapter **不自己加闸**（它拿到什么区间就问什么，闸归调用方；在这里加会让「运维显式
 * `--as-of`」也被拦掉）。🚨 **接入新 vendor 时，「盘中问今天返什么」是必验项。**
 *
 * ## 🚨 只取不复权（`AuType.NONE`），这条是承重的
 *
 * 存储模型自 server feature 020（2026-06-05）起是「**只物化 `adjust='none'` 一行** +
 * `AdjustmentFactor` 的 per-event 跃变，读时算 forward/backward」。往那个 raw 槽里塞复权价
 * ⇒ 读时会**二次复权**。故本 adapter 对 `adjust !== 'none'` 直接抛，不做静默降级。
 *
 * ★ **本机实测（2026-07-31，US.PEP，144 个交易日）**——不是推理：
 * - NONE 的末行 close 与实时 snapshot 的 `last_price` **完全一致**（140.2 = 140.2）⇒ NONE 就是真实市价
 * - QFQ 在 **106/144 天**与 NONE 不等：半年前差 **2.73（1.9%）**，向最新逐步收敛到 0
 * - 那个形状是前复权的固有性质（锚最新价往回压）⇒ **每次新分红都会改写整条历史**，
 *   同一行的值会取决于「它是哪天被抓的」，表内部自相矛盾
 *
 * ## `changePct` 落 null 是刻意的（不是没映射）
 *
 * `EodBarPoint.changePct` 的既有语义 = **官方涨跌幅，已含除权除息调整**（理杏仁 `change`；
 * schema 注释举证茅台 2025-06-26 官方 +0.83% vs raw −1.10%）。而富途的 `change_rate` 是
 * **原始差**——实测 PEP 一年内 4 个除权日（2025-09-05 / 12-05 / 2026-03-06 / 06-05），
 * `change_rate` 与 `(close−last_close)/last_close` **逐位相等（差 0.00000000）**，与官方口径
 * 相差 0.89–1.05 个百分点。
 *
 * 照抄进去 = 同一列在 cn 是官方口径、在 us 是原始口径，**列语义随源漂移**。落 null 走的是
 * schema 已设计好的回退路径（原文「changePct 缺（旧行未回填 / **未来实时源**）→ 回退相邻前
 * 收差」），读侧由 `prevClose` 反推出的正是那个原始差 —— 结果一样，但列语义不脏。
 *
 * ⚠️ **已知限制**：us 标的在除权日呈现的涨跌幅是原始口径（那 4 天偏 ~1pp）。要官方口径得自取
 * 分红数据另算，属 M2+ 范围。
 *
 * ## 顺带：us 是第一个真有 `prevClose` 的市场
 *
 * schema 注释写 `prev_close`「理杏仁 ex_rights 不下发 → 落库永远 null，**列保留供未来实时
 * 源**」。富途下发 `last_close` 真值 ⇒ 那个"未来"就是这里。
 *
 * EVIDENCE: 同一张 `marketdata.daily_bar` 里 us 行 **1927/1927 全有 `prev_close`**, 而 cn/hk
 * (理杏仁源) **0/176631** —— 本机 dev 库 `mbw_poc` 2026-09-03 复算, 口径与观测值同见
 * `lixinger-eod-bar.adapter.ts` 的 EVIDENCE。
 *
 * 真端点 / 真隧道 / 富途历史视野边界由 env-gated 真 vendor IT 校真
 * (`marketdata.futu-shim.vendor`, `RUN_MARKETDATA_IT`)。
 */

/** market → 富途 code 前缀。**只有 us** —— cn/hk 走理杏仁。 */
const MARKET_TO_FUTU_PREFIX: Record<string, string> = {
  us: 'US',
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ShimEnvelope {
  count?: unknown;
  rows?: unknown;
}

/**
 * 数值 → Decimal-safe string；缺失 / 非有限 → null。
 * ⚠️ **不做单位换算**：`turnover_rate` 两边同为**分数**口径（实测富途 PEP 0.00607 ≈ 0.6%，
 * 库内 cn 茅台 0.0057 同量级），乘 100 会让 us 的换手率比 cn 大两个数量级。
 */
function numToString(v: unknown): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return v.trim();
  return null;
}

/**
 * 单行 → `EodBarPoint`。**坏行 throw、不跳过**：这里每行是 SDK 直出的 dict，缺字段只可能是
 * 契约变更，而静默丢一行 = 库里凭空少一个交易日的 bar（后续 RV / 区间时序全歪且无人知晓）。
 */
function parseRow(row: unknown, adjust: Adjust, ctx: string): EodBarPoint {
  const raw = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  // `time_key` 形如 `2026-07-30 00:00:00`（实测）→ 取日期段。
  const timeKey = typeof raw.time_key === 'string' ? raw.time_key : '';
  const tradeDate = timeKey.slice(0, 10);
  const close = numToString(raw.close);
  if (!ISO_DATE_RE.test(tradeDate) || close === null) {
    throw new Error(
      `[futu] kline 行不合契约 (须 time_key=YYYY-MM-DD... + 数值 close; 契约变更?): ` +
        `${ctx} 行=${JSON.stringify(row)}`,
    );
  }
  return {
    tradeDate,
    adjust,
    open: numToString(raw.open) ?? close,
    high: numToString(raw.high) ?? close,
    low: numToString(raw.low) ?? close,
    close,
    // 🚨 刻意 null —— 见类注释「changePct 落 null 是刻意的」。
    changePct: null,
    prevClose: numToString(raw.last_close),
    volume: numToString(raw.volume),
    amount: numToString(raw.turnover),
    turnoverRate: numToString(raw.turnover_rate),
  };
}

@Injectable()
export class FutuEodBarAdapter implements EodBarPort {
  constructor(
    private readonly http: VendorHttpClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /**
   * 复杂度：每次调用 **1 个 HTTP 请求**（分页由 shim 内部跟 `page_req_key` 到尽头；窗口过宽
   * 时 shim 返 400 而非静默截断 —— 故此处**不重复实现分片**，那只会把同一段逻辑写两遍）。
   * 解析 O(bar 数)。
   */
  async getBars(query: EodBarQuery): Promise<EodBarPoint[]> {
    const parsed = parseCanonicalSymbol(query.symbol);
    const prefix = parsed ? MARKET_TO_FUTU_PREFIX[parsed.market] : undefined;
    if (!parsed || !prefix) {
      // 不静默返空：返空会被同步管线当成「该标的这段无数据」记 0 行成功。
      throw new Error(`[futu] kline 不支持 symbol "${query.symbol}" (本源仅承担 us)`);
    }
    if (query.adjust !== 'none') {
      // 见类注释：raw 槽 + 读时复权，塞复权价进来会二次复权。
      throw new Error(
        `[futu] kline 只支持 adjust='none' (得 "${query.adjust}") —— ` +
          `复权由读侧按 AdjustmentFactor 计算 (server 020 模型), 源侧只供原始价`,
      );
    }

    const params = new URLSearchParams({
      code: `${prefix}.${parsed.code}`,
      ktype: 'K_DAY',
      autype: 'NONE',
    });
    if (query.from) params.set('start', query.from);
    if (query.to) params.set('end', query.to);

    const res = await this.http.request<ShimEnvelope>({
      url: `${this.baseUrl}/kline?${params.toString()}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
    });

    const rows = res?.rows;
    if (!Array.isArray(rows)) {
      throw new Error(`[futu] kline 响应缺 rows[] (契约变更?): ${query.symbol}`);
    }
    // 信封自报行数与实收对账 —— 传输层截断的最后一道闸（同 universe adapter）。
    if (typeof res?.count === 'number' && res.count !== rows.length) {
      throw new Error(
        `[futu] kline 行数与信封 count 不符 (疑截断): ${query.symbol} ` +
          `count=${res.count} rows=${rows.length}`,
      );
    }

    const ctx = `${query.symbol} ${query.from ?? '-'}..${query.to ?? '-'}`;
    // port 契约要求按 tradeDate **升序**；富途实测已升序，此处排序是防御不是修正。
    return rows
      .map((row) => parseRow(row, query.adjust, ctx))
      .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  }
}
