import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../security/prisma.service.js';
import type { InstrumentSearchPort } from './instrument-search.port.js';
import type { InstrumentSearchHit } from './marketdata.types.js';

/**
 * 本地 pg_trgm 模糊搜索 adapter (015 T013, INSTRUMENT_SEARCH_PORT 备援, FR-S04 / US2)。
 *
 * `FallbackChainAdapter` 的次源: 东财 503/超时/熔断时平移本地, 在已 seed 的 `Instrument`
 * 注册表上做模糊匹配 —— 名 / 拼音 / 代码三路命中:
 *   - 代码: 前缀 ILIKE (`600519` → `cn:600519`)
 *   - 名 / 简拼 / 全拼: ILIKE 子串 (`gzmt` / `maotai` 子串可命中) **并** 名+简拼 pg_trgm `%`
 *     相似 (容错错字)
 * GIN trgm index (`ix_instrument_pinyin_abbr_trgm`, migration raw) 加速简拼 `%` / ILIKE;
 * 全拼 (`pinyin_full`) 无 index 走 seq scan, 备援在已 seed universe 上代价可接受。
 * 按 (代码精确 → 相似度 → 代码) 排序, 限 20。无命中 → 空数组 (非 error)。
 *
 * 拼音列 (`pinyin_abbr`/`pinyin_full`) 由 016 同步写 Instrument 时用 pinyin-pro 生成填充;
 * 本 feature 仅消费该列 (IT seed fixture 含拼音验搜索), 不引入拼音生成依赖。
 */

interface InstrumentSearchRow {
  market: string;
  code: string;
  name: string;
  type: string;
}

@Injectable()
export class LocalInstrumentSearchAdapter implements InstrumentSearchPort {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: string): Promise<InstrumentSearchHit[]> {
    const q = query.trim();
    if (q.length === 0) return [];
    const contains = `%${q}%`;
    const codePrefix = `${q}%`;

    const rows = await this.prisma.$queryRaw<InstrumentSearchRow[]>(Prisma.sql`
      SELECT market, code, name, type
      FROM marketdata.instrument
      WHERE code ILIKE ${codePrefix}
         OR name ILIKE ${contains}
         OR coalesce(pinyin_abbr, '') ILIKE ${contains}
         OR coalesce(pinyin_full, '') ILIKE ${contains}
         OR name % ${q}
         OR coalesce(pinyin_abbr, '') % ${q}
      ORDER BY
        (code = ${q}) DESC,
        GREATEST(similarity(name, ${q}), similarity(coalesce(pinyin_abbr, ''), ${q})) DESC,
        code ASC
      LIMIT 20
    `);

    return rows.map((r) => ({ symbol: `${r.market}:${r.code}`, name: r.name, type: r.type }));
  }
}
