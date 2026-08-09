import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * PUT /chat/preferences request body (031 T004, plan D5 / FR-002/005)。
 *
 * 单一账号级「自定义指令」自由文本。`@IsString` + `@MaxLength(2000)`:
 * - 空串**合法** = 清空语义 (D9; 不用 `@IsNotEmpty`, 空串是有效输入)。
 * - 超 2000 字符 → 400 不落库半截 (FR-005; **长度上限只在此 validator 层**,
 *   DB 列是 `@db.Text` 不钉 2000, U1 单道拒绝面避免 UTF-16 vs PG 字符计数错位)。
 *
 * `@ApiProperty({ type: 'string' })` 显式类型 → 防 orval 误生 objectmap
 * (nullable/类型不显式时 orval 会把 string 误判成对象 map, 仓库已知坑)。
 */
export class UpsertChatPreferenceRequest {
  @ApiProperty({
    type: 'string',
    description: '账号级自定义指令 (自由文本; 空串 = 清空; 最长 2000 字符)',
    maxLength: 2000,
    example: '请用简洁中文回答, 先给结论再展开, 控制在 5 句内。',
  })
  @IsString()
  @MaxLength(2000)
  customInstruction!: string;
}
