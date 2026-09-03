import { Injectable } from '@nestjs/common';
import { parseCboeIndexCsv } from './cboe-index-csv.rules.js';
import type { UsIndexCode, UsIndexHistory, UsIndexPort } from './us-index.port.js';
import type { VendorHttpClient } from './vendor-http-client.js';

/**
 * CBOE 美股波动率指数 adapter (046 T012, `US_INDEX_PORT` 的唯一实现)。
 *
 * 拉两个**官方公开历史 CSV** 全量文件, 交 T003 的纯函数 `parseCboeIndexCsv` 解析:
 * - GET `<cdn>/VIX_History.csv`  → `DATE,OPEN,HIGH,LOW,CLOSE`, 约 9.2k 行 (1990-01-02 起)
 * - GET `<cdn>/VVIX_History.csv` → `DATE,VVIX` (**只有 CLOSE**), 约 5.1k 行 (2006-03-06 起)
 *
 * 宿主 = **77 直连**, 港机与 shim 完全不参与 (plan D6)。2026-08-02 在 77 上实测两个文件均
 * HTTP 200 (471 KB / 9,242 行, 3.1s 与 108 KB / 5,074 行, 1.8s)。
 *
 * ## 🚨 合规红线: MUST NOT 碰 CBOE 盘中报价端点
 *
 * `cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json` (以及 `_VVIX.json` / 期权链的
 * `delayed_quotes/options/*.json`) **严禁进任何自动管道**:
 * - **出处 p3b E1**: `cboe.com/delayed_quotes/<product>/quote_table/` 页脚明文「IT IS STRICTLY
 *   PROHIBITED TO DOWNLOAD DELAYED QUOTE TABLE DATA … BY USING AUTO-EXTRACTION
 *   PROGRAMS/QUERIES … CBOE WILL BLOCK IP ADDRESSES OF ALL PARTIES WHO ATTEMPT TO DO SO」。
 * - **出处 p3b E24**: 站点级 Terms 禁「copy, reproduce, … store either in hard copy or in an
 *   **electronic retrieval system** … the Materials without Cboe's prior written consent」;
 *   官方免费的**只有历史文件** (= 本 adapter 在用的这两个), 盘中/实时的官方通路是付费
 *   Cboe Global Indices Feed, **无免费档**。风险来自 ToS 合同条款而非 robots.txt ——
 * ⇒ 出处: p3b E24 (三条官方页面证据)。
 *   `robots.txt` 恰恰**没有**禁这些路径, 所以「爬得动」不构成任何许可信号。
 *
 * ⇒ 本 adapter 能发起的 URL 全集 = {@link CBOE_HISTORY_CSV_URLS} 里那两条, 穷举且由单测
 * 机械断言。impl 期任何「顺手加个实时值」的念头**停在这里** (Guardrail 4 / FR-033)。
 *
 * ## 零 CSV 库
 *
 * 解析走 `cboe-index-csv.rules.ts` 手写纯函数 (plan § Dependencies + SC-007 零新第三方运行时
 * 依赖)。理由写在那个文件顶部: 引 `csv-parse` / `papaparse` 会把**非法行的处置语义**藏进库的
 * 默认行为里, 而那恰恰是本条通路唯一要显式控制的东西。
 *
 * ## vendor 错误映射
 *
 * 不自造错误分类: 传输纪律由 `VendorHttpClient` + {@link CBOE_PROFILE} 承担 —— 429/5xx/网络错
 * (含 E13 那种大响应体截断) → `TransientVendorError` (退避重试 + 熔断), 4xx → `VendorHttpError`
 * (永久, 不重试)。表头变更 → `CboeCsvHeaderError` 由纯函数抛出。本 adapter 只负责**不把它们
 * 吞掉**: 静默返空会被同步管线记成「今天这个指数没数据」= 一次成功的空采集。
 *
 * @see CBOE_PROFILE 为什么限频取极保守值 / 为什么 maxAttempts=3
 */

/** 官方历史文件 CDN 前缀 (公开下载, 无 auth)。 */
export const CBOE_HISTORY_CSV_BASE_URL = 'https://cdn.cboe.com/api/global/us_indices/daily_prices';

/**
 * 指数代码 → 官方历史文件 URL。**这是 adapter 唯一的 URL 来源面** —— 没有第二处拼 URL 的
 * 地方, 故「本 adapter 永不触碰盘中报价端点」可以被穷举断言 (合规红线的机器版)。
 */
export const CBOE_HISTORY_CSV_URLS: Readonly<Record<UsIndexCode, string>> = {
  VIX: `${CBOE_HISTORY_CSV_BASE_URL}/VIX_History.csv`,
  VVIX: `${CBOE_HISTORY_CSV_BASE_URL}/VVIX_History.csv`,
};

@Injectable()
export class CboeUsIndexAdapter implements UsIndexPort {
  constructor(private readonly http: VendorHttpClient) {}

  /**
   * 复杂度: **1 个 HTTP 请求** (全量文件, 无分页) + 解析 O(行数) 单遍扫描。
   *
   * 返回值直接就是纯函数的产出: `CboeIndexCsvParseResult` 与 {@link UsIndexHistory} 逐字段
   * 同形 ⇒ 结构化赋值直通, 零 map 代码。**类型名字不同是刻意的** —— 换源时 CBOE 那个 rules
   * 文件整个消失, 端口契约不动。
   */
  async getIndexHistory(indexCode: UsIndexCode): Promise<UsIndexHistory> {
    const csv = await this.http.requestText({
      url: CBOE_HISTORY_CSV_URLS[indexCode],
      method: 'GET',
    });
    return parseCboeIndexCsv(csv, indexCode);
  }
}
