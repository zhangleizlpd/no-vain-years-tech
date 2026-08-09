import { Injectable } from '@nestjs/common';
import type { CorporateActionPort } from './corporate-action.port.js';
import type { CorporateActionDto } from './marketdata.types.js';
import { LixingerAdapterBase, daysAgoDate, lixDateOnly } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁公司行动 adapter (015 T006, CORPORATE_ACTION_PORT live 实现)。
 *
 * POST `/cn/company/dividend`（单只 `stockCode` + `startDate`，**区间 ≤10 年**；超则 403）。
 * 返现金分红 + 送转股（`bonusSharesFromProfit`/`bonusSharesFromCapitalReserve`）。配股
 * (`/cn/company/allotment`) 与股本变动 (`/cn/company/equity-change`) 是独立端点 → 留 seam。
 *
 * **字段真名经 env-gated 真 IT 校真（2026-06-03）**：理杏仁返 **camelCase**（`exDate`/
 * `bonusSharesFromProfit`/`registerDate`…，非旧 provisional 的 snake_case），且 `exDate` 仅
 * `status:"implemented"`（已执行除权）行才有；`board_director_plan`（董事会预案，未除权）行无
 * `exDate` → **过滤掉**（无除权日无法定位复权重取区间，FR-S11）。按 exDate 降序（端口契约）。
 *
 * 🚨 **同一 exDate 的多行必须先聚合再出 DTO**（2026-08-01 修）。vendor 对同一除权日常返多行
 * （特别息 + 常规息并存，真调实证：00026 `2019-08-16` 返 `特别股息 HKD 18.00` + `第2次中期息
 * HKD 0.30`；00483 `2021-12-08` 返 `0.305` + `0.025`；00408 `2023-06-13` 返 `0.75` + `0.05`）。
 * 而 `CorporateAction` 自然键是 `(instrumentId, exDate, type)` —— 两行同为 `dividend` 时
 * **后写的把先写的覆盖掉**，静默丢掉那笔（往往更大的）特别息，且从 DB 里完全看不出来
 * （查「同日多行」永远只有 1 行）。因子按 `n₀/(n₀−d)` 算，d 少算 → 因子系统性偏小：
 * 00026 丢 18.00 后算出 1.0024，真值 1.1728（偏 15%）。
 *
 * 为什么是**聚合**而不是像 041 `shareholder_change` 那样加 `contentHash` 扩键保留逐行：
 * 同一除权日的多笔派息在**经济上就是一次除权事件**，标准除权价公式本来就要求求和
 * （`(前收 + 配股价×配股比率 − 每股派息合计) / (1+…)`），逐行保留反而要求每个下游自己再
 * 求和一遍 —— 而 041 那边逐行明细（不同股东、不同 involved）是消费者真正需要的，性质不同。
 * 原始行无损存进 `payload.rows`，聚合值放顶层（下游按顶层字段读即可，需要明细时回查 rows）。
 */

interface LixingerDividendRow {
  date?: unknown;
  exDate?: unknown;
  dividend?: unknown;
  bonusSharesFromProfit?: unknown;
  bonusSharesFromCapitalReserve?: unknown;
  currency?: unknown;
  content?: unknown;
  status?: unknown;
}

// 分红区间回看 ≈9.99yr（3650 天，安全卡在理杏仁 ≤10yr 限内；旧 1990 全史 36yr → 403）。
const DIVIDEND_LOOKBACK_DAYS = 3650;

@Injectable()
export class LixingerCorporateActionAdapter
  extends LixingerAdapterBase
  implements CorporateActionPort
{
  async getCorporateActions(symbol: string): Promise<CorporateActionDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛错。
    const { market, stockCode } = toLixinger(symbol);
    const rows = await this.post<LixingerDividendRow>(`/${market}/company/dividend`, {
      stockCode,
      startDate: daysAgoDate(DIVIDEND_LOOKBACK_DAYS),
    });

    // 仅已除权行（有 exDate）；预案行无 exDate → 跳过。
    const implemented = rows.filter((r) => r.exDate);

    const byExDate = new Map<string, LixingerDividendRow[]>();
    for (const r of implemented) {
      const ex = lixDateOnly(r.exDate);
      const bucket = byExDate.get(ex);
      if (bucket) bucket.push(r);
      else byExDate.set(ex, [r]);
    }

    return [...byExDate.entries()]
      .map(
        ([exDate, group]): CorporateActionDto => ({
          symbol,
          exDate,
          type: group.some((r) => classifyAction(r) === 'split') ? 'split' : 'dividend',
          payload: aggregatePayload(group),
        }),
      )
      .sort((a, b) => b.exDate.localeCompare(a.exDate)); // exDate 降序。
  }
}

/**
 * 同 exDate 多行 → 单 payload。顶层放聚合值（下游直读），`rows` 原样保留全部 vendor 行。
 *
 * 币种：按币种分组求和，顶层取**金额合计最大**的那个币种（多币种同日极罕见）；跨币种的换算
 * 交给读侧（它才知道标的交易币种，且 `content` 里带港币等值）。单行时行为与旧版等价
 * （顶层就是那一行的字段），故存量 payload 结构兼容。
 */
function aggregatePayload(group: LixingerDividendRow[]): Record<string, unknown> {
  const base = { ...group[0] } as Record<string, unknown>;
  if (group.length === 1) return { ...base, rows: group };

  const byCcy = new Map<string, number>();
  let bonusProfit = 0;
  let bonusReserve = 0;
  for (const r of group) {
    const ccy = typeof r.currency === 'string' ? r.currency : '';
    byCcy.set(ccy, (byCcy.get(ccy) ?? 0) + toNum(r.dividend));
    bonusProfit += toNum(r.bonusSharesFromProfit);
    bonusReserve += toNum(r.bonusSharesFromCapitalReserve);
  }
  const [topCcy, topSum] = [...byCcy.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    ...base,
    currency: topCcy === '' ? base.currency : topCcy,
    dividend: topSum,
    bonusSharesFromProfit: bonusProfit,
    bonusSharesFromCapitalReserve: bonusReserve,
    // 聚合后的 content 供人读；逐行原文在 rows 里。
    content: group
      .map((r) => String(r.content ?? ''))
      .filter(Boolean)
      .join(' + '),
    rows: group,
  };
}

/** 送转股（free/bonus shares）→ 股本扩张 ≈ split；否则现金分红。配股属独立端点（seam）。 */
function classifyAction(r: LixingerDividendRow): string {
  if (toNum(r.bonusSharesFromProfit) > 0 || toNum(r.bonusSharesFromCapitalReserve) > 0) {
    return 'split';
  }
  return 'dividend';
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
