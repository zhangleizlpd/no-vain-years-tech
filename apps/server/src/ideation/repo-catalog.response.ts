import { ApiProperty } from '@nestjs/swagger';
import type { RepoCatalogEntry } from '../integrations/codeindex/code-index.module';

/**
 * GET /ideation/repos 响应投影 (034 T005, FR-004 / US2)。可接地仓目录项 —— 供 mobile
 * 「选择代码库」列表呈现。形状对齐 code-index `RepoMeta` (经 CODE_INDEX 端口 RepoCatalogEntry
 * 透传, 贫血映射, 无 Entity)。`indexedAt` 已是 ISO-8601 串 (端口契约保证)。
 */
export class RepoCatalogEntryResponse {
  @ApiProperty({ description: '仓库标识', example: 'no-vain-years-mono' })
  repo!: string;

  @ApiProperty({ description: '最近索引 commit sha', example: 'a1b2c3d' })
  lastSha!: string;

  @ApiProperty({ description: '最近索引时间 (ISO-8601)', example: '2026-06-22T00:00:00.000Z' })
  indexedAt!: string;

  @ApiProperty({ description: '已索引代码块数', example: 1280 })
  chunkCount!: number;

  @ApiProperty({
    description: '索引状态 (ready=可检索 | indexing=重建中, 前端置灰)',
    enum: ['ready', 'indexing'],
    example: 'ready',
  })
  status!: 'ready' | 'indexing';
}

export class RepoCatalogResponse {
  @ApiProperty({ type: [RepoCatalogEntryResponse], description: '可接地仓库目录 (空 → [])' })
  items!: RepoCatalogEntryResponse[];
}

/** RepoCatalogEntry[] (端口 DTO) → RepoCatalogResponse (端点 DTO, 透传)。 */
export function toRepoCatalogResponse(entries: RepoCatalogEntry[]): RepoCatalogResponse {
  return {
    items: entries.map((e) => ({
      repo: e.repo,
      lastSha: e.lastSha,
      indexedAt: e.indexedAt,
      chunkCount: e.chunkCount,
      status: e.status,
    })),
  };
}
