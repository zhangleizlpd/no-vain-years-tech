import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../security/prisma.service';
import { escapeLike, normalizeSearchQuery } from './anchor-search.rules';

/**
 * 074 锚域模糊搜索读端 (FR-003/FR-004/FR-005/FR-011, plan D2/D3/D5)。
 *
 * 搜索域 = **已建锚的标的** (JOIN 即域判据): 起步集是锚表 (当前 ~140 行, spec Assumptions
 * 上限约 1000), 谓词与排序作用在该量级上 —— **不建**任何新索引 (plan D12)。
 * 🚨 **无 excluded 过滤、无 market 过滤**: 域判据严格是「有没有锚」(Clarifications
 * 2026-09-03 —— 被排除的锚不上雷达, 搜索恰是它的主要入口); 跨市场全量 (FR-005)。
 *
 * 匹配谓词逐路复刻 `marketdata/local-instrument-search.adapter.ts` (plan D3 复用不发明),
 * 追加第 ④ 路 ticker 前缀 (用户抄全 canonical `hk:007…` 时代码前缀路够不到冒号形态)。
 * **与参照 adapter 的有意差异**: ILIKE 三路吃 {@link escapeLike} + 显式 `ESCAPE` ——
 * spec Edge 钉了 `%` / `_` 字面语义 (plan D4, 详见 anchor-search.rules.ts 文件头);
 * pg_trgm `%` / `similarity()` 两路是相似度语义, 传原串。
 *
 * 名字唯一真相源 = `marketdata.instrument` (锚表零名字列, `instrument-name.ts` 纪律);
 * `name` = code 的注册表占位行**照实返回** (plan D5, 屏上退化为代号, 不拼假名、不特判)。
 */

/** FR-011 单页上限 (spec Assumptions 沿既有标的搜索体例拍的 20)。零命中细化输入, 无翻页。 */
export const ANCHOR_SEARCH_PAGE_LIMIT = 20;

export interface AnchorSearchHit {
  /** canonical `market:code`。 */
  ticker: string;
  /** 标的名 (占位行 = 代号, 照实)。 */
  name: string;
  /** 生效 L 层 (提示行徽标来源, 与雷达行同源)。 */
  lLevelEffective: string;
}

interface AnchorSearchRow {
  ticker: string;
  name: string;
  l_level_effective: string;
}

@Injectable()
export class SearchAnchorsUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `raw` 空 / 纯空白 ⇒ 短路 `[]`, 零 SQL (空输入是常态分支非校验错误, plan D1);
   * 超长按 64 截断继续搜。O(锚表行数) 单条查询。
   */
  async execute(raw: string | undefined): Promise<AnchorSearchHit[]> {
    const q = normalizeSearchQuery(raw ?? '');
    if (q === null) return [];
    const escaped = escapeLike(q);
    const prefix = `${escaped}%`;
    const contains = `%${escaped}%`;

    // CROSS-CONTEXT-READ: marketdata.instrument 只读直查 (catalog Q7-B) —— 锚域搜索的
    // 名 / 拼音 / 代码匹配字段来源。零写、零 @Inject() 对方 use case (Q7-C);
    // marketdata 不知道锚表存在 (方向铁律, 同 ctx 内 instrument-name.ts 范例)。
    const rows = await this.prisma.$queryRaw<AnchorSearchRow[]>(Prisma.sql`
      SELECT a.ticker, i.name, a.l_level_effective
      FROM optionsdesk.anchor a
      JOIN marketdata.instrument i
        ON i.market = a.market AND i.code = split_part(a.ticker, ':', 2)
      WHERE i.code ILIKE ${prefix} ESCAPE '\\'
         OR i.name ILIKE ${contains} ESCAPE '\\'
         OR coalesce(i.pinyin_abbr, '') ILIKE ${contains} ESCAPE '\\'
         OR coalesce(i.pinyin_full, '') ILIKE ${contains} ESCAPE '\\'
         OR i.name % ${q}
         OR coalesce(i.pinyin_abbr, '') % ${q}
         OR a.ticker ILIKE ${prefix} ESCAPE '\\'
      ORDER BY
        (i.code = ${q}) DESC,
        GREATEST(similarity(i.name, ${q}), similarity(coalesce(i.pinyin_abbr, ''), ${q})) DESC,
        i.code ASC
      LIMIT ${ANCHOR_SEARCH_PAGE_LIMIT}
    `);

    return rows.map((r) => ({
      ticker: r.ticker,
      name: r.name,
      lLevelEffective: r.l_level_effective,
    }));
  }
}
