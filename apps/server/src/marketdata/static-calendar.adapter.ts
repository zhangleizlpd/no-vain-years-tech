import { Injectable } from '@nestjs/common';
import { STATIC_CALENDAR_COVERAGE, STATIC_CALENDAR_DATES } from './static-calendar.data.js';
import type {
  TradingCalendarFetchResult,
  TradingCalendarSource,
} from './trading-calendar-source.port.js';

/**
 * 静态离线日历 adapter (044 L2, TRADING_CALENDAR_SOURCE 链尾)。L1 活源 (腾讯) 失效时兜底,
 * 使「日历填充」不再单点死 —— 换源治不了根, **链路 + 闸 + 告警**才治。
 *
 * 数据 = `static-calendar.data.ts` (HKEX 官方 Stock Connect 年历 PDF 离线抽, 由
 * `scripts/checks/gen-static-calendar.ts` **人工年更**生成)。无网络 / 无 IO / 纯查表。
 *
 * ★ **为何必须源自官方年历**: 填充只问 `[今天-30, 今天]` (永远是过去), 但静态表必须**覆盖到
 * 今天** ⇒ 只能用「年初即发布全年」的官方年历。**不能**从我方 `trading_day` 历史快照生成 ——
 * 快照一生成即开始腐烂, 到年中就答不了近 30 天窗。
 *
 * 🚨 **Guardrail 7 — 区间未被覆盖范围完全包含 → throw** (禁返空、**禁返已覆盖的那部分**):
 * 判据是「**完全包含**」不是「有交集」。返部分 → 缺失日被当成非交易日 → **静态层自己就成了
 * 第二个 push2delay** (同一个坑换个地方踩)。年更漏跑 → 跨年即区间外 → throw → 全链失败 →
 * 告警: 失败模式**响亮**, 这是**有意设计**, 不是缺陷。
 *
 * ⚠️⚠️ **绊线 — us 蓄意不覆盖** (plan 风险 4): 本表仅 cn + hk。044 当时的**无害性前提**是
 * 「当前无 `{us}`-only 同步维度, 且 gate 取 OR ⇒ us 日历陈旧不阻塞任何维度同步」, 并留话
 * 「将来若新增 `{us}`-only 维度, 此假设即失效, 届时必须回到这里」。
 *
 * ✅ **该前提已于 2026-07-31 失效并被显式处置** (sellput-viz Phase 1 #5, p3b §3.3):
 * sellput-viz 的 6 个期权维度全是 `{us}`-only, 是第一批踩线者。处置**不是**给本表补 us,
 * 而是给 us 换了一条**独立的两活源链** —— `us: [富途 L1, 腾讯 L2]` (接线见
 * `marketdata.module.ts` 的 `TRADING_CALENDAR_SOURCE`), 且探针已把 us 纳入监控 (26h 内必报,
 * 见 `ops/jobs/marketdata-calendar-health.sql`)。
 *
 * 🚨 **us 仍蓄意无 L3, 这是拍板过的取舍** (user 2026-07-31): 补 us 静态表要新建一条 NYSE
 * 假日采集 + 人工年更 = 新的 drift 面, 且静态表反映不了临时休市 (国丧等) 与半日市; 而 us 的
 * 两个活源走**不同物理通路** (富途经 B↔C WireGuard 隧道 / 腾讯经公网直连), 双源同时挂的场景
 * 由探针 26h 内报出 + 人工 seed 兜底。**要改这个取舍, 连带要改的是探针的主源表与本段, 不是
 * 只往 `SUPPORTED_MARKETS` 里加个字符串。**
 */

/** 🚨 仅 cn + hk —— **us 蓄意缺席**, 见上文绊线。改这里前先读该段。 */
const SUPPORTED_MARKETS = ['cn', 'hk'] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO 日期格式闸 —— 覆盖判定靠**字典序比较** (`YYYY-MM-DD` 下等价于时序), 格式不合即比较
 * 无意义 ⇒ 必须先 throw, 否则 `'2026/03/01' >= '2026-01-01'` 之类会**静默误判为在覆盖内**。
 */
function assertIsoDate(date: string, field: string): void {
  if (!ISO_DATE_RE.test(date)) {
    throw new Error(`[static] trading-calendar 非法日期 ${field}="${date}" (须 YYYY-MM-DD)`);
  }
}

@Injectable()
export class StaticCalendarAdapter implements TradingCalendarSource {
  async fetchTradingDates(
    market: string,
    from: string,
    to: string,
  ): Promise<TradingCalendarFetchResult> {
    assertIsoDate(from, 'from');
    assertIsoDate(to, 'to');
    if (from > to) {
      throw new Error(`[static] trading-calendar 区间非法 (from > to): ${from}..${to}`);
    }

    const dates = SUPPORTED_MARKETS.includes(market as (typeof SUPPORTED_MARKETS)[number])
      ? STATIC_CALENDAR_DATES[market]
      : undefined;
    if (!dates) {
      // us 亦走此分支 (蓄意不覆盖, 见类注释绊线)。**禁静默返空** —— 那会让该市场日历漏填
      // 且无人知晓, 比 fail-closed 更隐蔽。
      throw new Error(
        `[static] trading-calendar 不支持市场 "${market}" ` +
          `(静态表仅 ${SUPPORTED_MARKETS.join('/')}; us 蓄意不覆盖, 见 adapter 注释绊线)`,
      );
    }

    // 🚨 **Guardrail 7** —— 判据 = 请求区间被覆盖区间**完全包含**。**任一端越界即 throw**,
    // 不返「已覆盖的那部分」(跨年窗 2026-12-20..2027-01-20 必 throw, 哪怕 12-20..12-31 有数据)。
    if (from < STATIC_CALENDAR_COVERAGE.from || to > STATIC_CALENDAR_COVERAGE.to) {
      throw new Error(
        `[static] trading-calendar 请求区间 ${from}..${to} 未被静态表覆盖区间 ` +
          `${STATIC_CALENDAR_COVERAGE.from}..${STATIC_CALENDAR_COVERAGE.to} 完全包含 ` +
          `(禁返部分: 缺失日会被当成非交易日 = 静默毒饵; 静态日历年更是否漏跑?)`,
      );
    }

    // 数据升序 ⇒ filter 保序。区间内确无交易日 → 空数组是**合法**结果 (port 契约), 与上文
    // 「区间外」的 throw 是两回事 —— 别把两者合流。
    return { dates: dates.filter((d) => d >= from && d <= to), servedBy: 'static' };
  }
}
