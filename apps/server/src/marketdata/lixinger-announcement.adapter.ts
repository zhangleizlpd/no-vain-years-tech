import { Injectable } from '@nestjs/common';
import type { AnnouncementPort } from './announcement.port.js';
import type { AnnouncementDto, AnnouncementRangeQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnly, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁公告 adapter (043 US2, ANNOUNCEMENT_PORT live 实现)。
 *
 * POST `/${market}/company/announcement` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 `stockCodes` → HTTP 400, 同 039 short-selling 单数契约)。
 * ⚠️ **`endDate` 排他 (右开)**, 本族端点里独一份 → 发请求前 +1 天归一到端口的右闭契约,
 * 判定证据与失败形态见 `getAnnouncementRange` 内联注释。**不用
 * `metricsList`** (返回固定元数据字段) → 无 p1 #670 all-or-nothing 静默 0 行坑。**单 POST 无分页**
 * (probe 10yr 区间单请求返全量 1152 行、无 cap); **≤10yr 硬上限** (>10yr → 403, 同 dividend) → executor
 * backfill `from=asOf−3650` 天然卡限内, adapter 不构造超 10yr 区间。
 *
 * 响应字段 (043 prod 77 probe 实测 hk:00700):
 *   {"date":"2024-12-31T00:00:00+08:00","linkUrl":"https://…/xxx.pdf","linkText":"翌日披露报表",
 *    "linkType":"PDF","types":["ndd_r"]}。
 * ⚠️ `date` 为 `+08:00` (HK-local) → `lixDateOnly` slice(0,10) 正确无 off-by-one (**异于 042 营收 UTC-Z
 * 需 `lixDateOnlyHk`**, 同 buyback/allotment)。`linkUrl` 是 HKEX 文档全局唯一 URL (probe 433/433 unique)
 * → 自然键 (instrumentId, date, linkUrl), **无需 vendorEventId/contentHash**。`linkText`/`linkType`
 * 文本字段 `lixNumToString`→`string|null` (非空串透传, 缺 null); `types` 是 vendor 分类标签数组 → 保真
 * 映射 (非数组/缺 → `[]`)。**只存元数据不存 PDF 正文**。摄取侧 live: backfill/delta 灌 PG Announcement
 * (无 fsType → 无-Prisma, 不注 Prisma)。
 */
/** YYYY-MM-DD 加 n 天 (UTC; 本端点右开 endDate 的归一用)。 */
function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface LixingerAnnouncementRow {
  date?: unknown;
  linkUrl?: unknown;
  linkText?: unknown;
  linkType?: unknown;
  types?: unknown;
}

@Injectable()
export class LixingerAnnouncementAdapter extends LixingerAdapterBase implements AnnouncementPort {
  async getAnnouncementRange(query: AnnouncementRangeQuery): Promise<AnnouncementDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    // 🚨 本端点 `endDate` **排他** (右开 `[startDate, endDate)`) —— 与同族 repurchase /
    // short-selling / mutual-market / equity-change **全部右闭** 不一致, 是该端点独有的语义。
    // 2026-08-01 prod 只读探针实测 (hk:00005, 宽窗基准 = 07-23/07-24 各 1 行 + 07-30/07-31 各 2 行):
    //   [07-31→07-31]=0 · [07-29→07-30]=0 · [07-30→07-31]=2 · [07-23→07-24]=1 · [07-29→08-01]=4
    // 右闭假设 5 发全错, 右开假设 5 发全中。故此处 +1 天把 vendor 语义**归一到端口契约的右闭**,
    // 归一点放 adapter (vendor 契约差异就该在这层吸收) —— 让 executor 不必逐维度记住谁右开。
    // ⚠️ 不归一的后果已在 prod 兑现: executor delta 的 `from = to = asOf` 在右开语义下是**空区间**
    // → 每晚 0 行且 SyncRun 全绿, 043 上线 (2026-07-16) 起增量静默全失, 12 个交易日无人发现。
    if (query.to) body.endDate = addDays(query.to, 1);

    const rows = await this.post<LixingerAnnouncementRow>(`/${market}/company/announcement`, body);

    return rows
      .map(
        (r): AnnouncementDto => ({
          // probe verified +08:00 HK-local → slice 正确无 off-by-one (照抄 buyback, 非 lixDateOnlyHk)。
          date: lixDateOnly(r.date),
          // linkUrl 是 HKEX 文档全局唯一 URL (自然键组件, NOT NULL 列, probe 恒有值) → 透传。
          linkUrl: String(r.linkUrl),
          // linkText/linkType 文本字段, lixNumToString 对 string 输入亦返 string|null (非空串透传, 缺 null)。
          linkText: lixNumToString(r.linkText),
          linkType: lixNumToString(r.linkType),
          // types 是 vendor 分类标签数组 (值域 srp/ndd_r/mr/fs/dividend…) → 保真映射; 非数组/缺 → 空数组。
          types: Array.isArray(r.types) ? r.types.map((t) => String(t)) : [],
        }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
