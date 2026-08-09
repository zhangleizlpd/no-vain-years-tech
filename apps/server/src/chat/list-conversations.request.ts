import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * GET /chat/conversations query (028 T001, plan D4)。
 *
 * 历史会话列表 cursor 分页 + 可选标题模糊搜索 (scope accountId)。
 * - `limit`: 页大小 (默认 20, 1..50)。下滑加载更多 (FR-013)。
 * - `cursor`: 上一页末游标 (base64 编码 `{updatedAt,id}` 复合, 稳定排序不重不漏)。
 *   解码/校验在 UC 层 (非法游标当无 cursor, 从首页起 —— 反枚举无关, 不暴露内部)。
 * - `q`: 可选标题关键词, ILIKE 大小写不敏感子串 (FR-009, 仅 title, 不搜 message 正文)。
 */
export class ListConversationsRequest {
  @ApiPropertyOptional({
    description: '页大小 (默认 20, 范围 1..50)',
    minimum: 1,
    maximum: 50,
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({
    description: '上一页末游标 (base64 编码 {updatedAt,id}); 留空取首页',
    type: 'string',
    example: 'eyJ1IjoiMjAyNi0wNi0xNFQwODowMDowMC4wMDBaIiwiaSI6IjEwMSJ9',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: '标题关键词 (ILIKE 大小写不敏感子串; 留空返完整列表)',
    type: 'string',
    maxLength: 40,
    example: '茅台',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  q?: string;
}
