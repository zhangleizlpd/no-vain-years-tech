import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ShareholderChangePort } from './shareholder-change.port.js';
import type { ShareholderChangeDto, ShareholderChangeRangeQuery } from './marketdata.types.js';
import { LixingerAdapterBase, lixDateOnly, lixNumToString } from './lixinger-adapter.base.js';
import { toLixinger } from './lixinger-symbol.rules.js';

/**
 * 理杏仁股东权益变动事件 adapter (041 US3, SHAREHOLDER_CHANGE_PORT live 实现)。
 *
 * POST `/${market}/company/shareholders-equity-change` body `{ token, stockCode, startDate, endDate? }` ——
 * `stockCode` **单只** (数组 `stockCodes` → HTTP 400, 同 039 short-selling 单数契约)。**不用
 * `metricsList`** → 无 p1 #670 all-or-nothing 静默 0 行坑。
 *
 * 响应字段 (p3 探查报告实测 hk:00700):
 *   {"date":"2024-12-30...","stockCode":"00700","name":"Naspers Limited",
 *    "numOfSharesInterestedList":[{"value":2215242300,"sharesType":"L"}],
 *    "percentageOfIssuedVotingShares":[{"value":0.2401,"sharesType":"L"}]}。
 *
 * **唯一有嵌套结构的 041 维度** (plan Decision 4): `numOfSharesInterestedList[]` /
 * `numOfSharesInvolvedList[]` / `percentageOfIssuedVotingShares[]` 每项 `{value, sharesType}` (sharesType
 * 见 L/S, HK SDI 有第三类 P, T018 真调实证) → **整存 payload Json 无损** (整存整行, 样板 `HotSnapshot.payload`),
 * 已知描述性数组缺项 → null 不崩 (FR-007)。`name` → `shareholderName` (自然键之一; 缺 name 无法建自然键 →
 * 跳过该行, 同 hot 无 dataDate 过滤)。
 *
 * **C1 扩键** (T018 真调实证同股东同日多笔真实存在: JPMorgan 09988 同日 3 笔 involved 不同, 汇丰同股东同日 2 笔):
 * 自然键 (instrumentId, date, shareholderName) 会 skipDuplicates 丢真行 → 加 `contentHash` (对 vendor 原始事件行
 * canonical 序列化后 sha256, Data Vault hashdiff 范式) 进自然键; 内容全同才折叠、任何实质差异 (含 involved) 都保留。
 * 摄取侧 live: backfill/delta 灌 PG ShareholderChange (无 fsType → 无-Prisma, 不注 Prisma)。
 */
interface LixingerShareholdersEquityChangeRow {
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
 * vendor 原始事件行 → contentHash (C1 扩键, Data Vault hashdiff 范式): canonical 序列化后 sha256 hex。
 * 覆盖全描述性 payload (含 numOfSharesInvolvedList) → 内容全同才折叠、任何实质差异 (如同名同日 involved 不同)
 * 产生不同 hash → 各自落行不丢。
 */
function contentHashOf(raw: LixingerShareholdersEquityChangeRow): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(raw)))
    .digest('hex');
}

/**
 * vendor 原始行 → payload: **整存整行无损** (含 numOfSharesInvolvedList 及任何 vendor 字段, C1 确认); 已知
 * 描述性数组 (numOfSharesInterestedList / percentageOfIssuedVotingShares) 缺字段 → 归一 null (不崩, FR-007)。
 * 每项 `{value, sharesType}` 原样保留 (不扁平化 L/S, 不丢潜在第三类 P, plan Decision 4)。
 */
function toShareholderPayload(raw: LixingerShareholdersEquityChangeRow): Record<string, unknown> {
  return {
    ...(raw as Record<string, unknown>),
    numOfSharesInterestedList: raw.numOfSharesInterestedList ?? null,
    percentageOfIssuedVotingShares: raw.percentageOfIssuedVotingShares ?? null,
  };
}

@Injectable()
export class LixingerShareholderChangeAdapter
  extends LixingerAdapterBase
  implements ShareholderChangePort
{
  async getShareholderChangeRange(
    query: ShareholderChangeRangeQuery,
  ): Promise<ShareholderChangeDto[]> {
    // 038 seam#1: 路径按 market 段插值 (/cn|/hk); 非 cn/hk 前缀 toLixinger 抛 UnsupportedLixingerMarketError。
    const { market, stockCode } = toLixinger(query.symbol);
    const body: Record<string, unknown> = { stockCode, startDate: query.from };
    if (query.to) body.endDate = query.to;

    const rows = await this.post<LixingerShareholdersEquityChangeRow>(
      `/${market}/company/shareholders-equity-change`,
      body,
    );

    return rows
      .map((r): ShareholderChangeDto | null => {
        // name 是文本字段, lixNumToString 对 string 输入返 string|null (非空串透传); 缺 → null → 跳过。
        const shareholderName = lixNumToString(r.name);
        if (shareholderName === null) return null; // 无 name → 无自然键, 跳过 (同 hot 无 dataDate)。
        return {
          date: lixDateOnly(r.date),
          shareholderName,
          // C1: 对 vendor 原始行做 canonical sha256 → 判别同名同日多笔 (involved 不同则 hash 不同, 不丢行)。
          contentHash: contentHashOf(r),
          payload: toShareholderPayload(r),
        };
      })
      .filter((d): d is ShareholderChangeDto => d !== null)
      .sort((a, b) => a.date.localeCompare(b.date)); // 端口契约: date 升序。
  }
}
