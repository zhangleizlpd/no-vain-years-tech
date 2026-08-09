import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ShareholderSnapshotPort } from './shareholder-snapshot.port.js';
import type { ShareholderSnapshotDto, ShareholderSnapshotRangeQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnlyHk, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁最新股东 adapter (042 US2, SHAREHOLDER_SNAPSHOT_PORT live 实现)。
 *
 * POST `/${market}/company/latest-shareholders` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 `stockCodes` → HTTP 400, 同 041 事件流单数契约)。**不用 `metricsList`** →
 * 无 p1 #670 all-or-nothing 静默 0 行坑。
 *
 * 响应字段 (p3 探查报告实测 hk:00700, prod 77 verified = SERIES):
 *   {"date":"2024-12-30T00:00:00+08:00","stockCode":"00700","name":"Naspers Limited",
 *    "numOfSharesInterestedList":[{"value":2215242300,"sharesType":"L"}],
 *    "percentageOfIssuedVotingShares":[{"value":0.2401,"sharesType":"L"}]}。
 * **probe verified SERIES** (plan §风险 #3): 00700 返 9 行/5 个不同 date、09988 返 14 行/9 个 date
 * (报告期×股东序列, **非覆盖式快照**) → 多 date 行都落、date 进自然键可回填历史。
 *
 * **嵌套结构维度** (plan Decision 4, 复用 041 ShareholderChange payload+contentHash 范式):
 * `numOfSharesInterestedList[]` / `percentageOfIssuedVotingShares[]` 每项 `{value, sharesType}`
 * (sharesType 见 L/S, HK SDI 有第三类 P, 041 T018 真调实证) → **整存 payload Json 无损** (整存整行,
 * 样板 041 `toShareholderPayload`), 已知描述性数组缺项 → null 不崩 (FR-007)。`name` → `shareholderName`
 * (自然键之一; 缺 name 无法建自然键 → 跳过该行, 同 041)。
 *
 * **C1 扩键**: 自然键 (instrumentId, date, shareholderName) 会 skipDuplicates 丢真行 (同股东同日多笔,
 * 041 T018 已实证真实存在) → 加 `contentHash` (对 vendor 原始行 canonical 序列化后 sha256, Data Vault
 * hashdiff 范式) 进自然键; 内容全同才折叠、任何实质差异都保留。
 *
 * **🕐 日期归一** (plan §风险 #6, M1): latest-shareholders 的 `date` 为 `+08:00` (裸 slice 已 HK-correct),
 * 但用与营收/员工同一 `lixDateOnlyHk` (+8h then date-only) 归一保跨维度对齐一致 (对 `+08:00` 幂等无害)。
 *
 * 摄取侧 live: backfill/delta 灌 PG ShareholderSnapshot (无 fsType → 无-Prisma, 不注 Prisma)。
 */
interface LixingerLatestShareholderRow {
  date?: unknown;
  name?: unknown;
  numOfSharesInterestedList?: unknown;
  percentageOfIssuedVotingShares?: unknown;
}

/**
 * 确定性 canonical 序列化: 递归排序对象 key (数组保序 — 元素顺序有意义), 消除 vendor 返回 key 顺序不定
 * 引入的哈希漂移 → 同内容必产生同串。O(k·log k) per 层 (排 key), k=字段数。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * vendor 原始行 → contentHash (C1 扩键, Data Vault hashdiff 范式): canonical 序列化后 sha256 hex。
 * 覆盖全描述性 payload → 内容全同才折叠、任何实质差异 (如同名同日持股不同) 产生不同 hash → 各自落行不丢。
 */
function contentHashOf(raw: LixingerLatestShareholderRow): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(raw)))
    .digest('hex');
}

/**
 * vendor 原始行 → payload: **整存整行无损** (含任何 vendor 字段); 已知描述性数组
 * (numOfSharesInterestedList / percentageOfIssuedVotingShares) 缺字段 → 归一 null (不崩, FR-007)。
 * 每项 `{value, sharesType}` 原样保留 (不扁平化 L/S, 不丢潜在第三类 P, plan Decision 4)。
 */
function toShareholderPayload(raw: LixingerLatestShareholderRow): Record<string, unknown> {
  return {
    ...(raw as Record<string, unknown>),
    numOfSharesInterestedList: raw.numOfSharesInterestedList ?? null,
    percentageOfIssuedVotingShares: raw.percentageOfIssuedVotingShares ?? null,
  };
}

@Injectable()
export class LixingerShareholderSnapshotAdapter
  extends LixingerAdapterBase
  implements ShareholderSnapshotPort
{
  async getShareholderSnapshotRange(
    query: ShareholderSnapshotRangeQuery,
  ): Promise<ShareholderSnapshotDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerLatestShareholderRow>(
      `/${market}/company/latest-shareholders`,
      body,
    );

    return rows
      .map((r): ShareholderSnapshotDto | null => {
        // name 是文本字段, lixNumToString 对 string 输入返 string|null (非空串透传); 缺 → null → 跳过。
        const shareholderName = lixNumToString(r.name);
        if (shareholderName === null) return null; // 无 name → 无自然键, 跳过 (同 041)。
        return {
          // date 为 +08:00 (slice 已 HK-correct), 用同一 lixDateOnlyHk 归一保跨维度对齐 (幂等无害, M1)。
          date: lixDateOnlyHk(r.date),
          shareholderName,
          // C1: 对 vendor 原始行做 canonical sha256 → 判别同名同日多笔 (持股不同则 hash 不同, 不丢行)。
          contentHash: contentHashOf(r),
          payload: toShareholderPayload(r),
        };
      })
      .filter((d): d is ShareholderSnapshotDto => d !== null)
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
