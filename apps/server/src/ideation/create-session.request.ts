import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * POST /ideation/sessions request body (032 T007, FR-001)。
 *
 * 建会话需标题 (前端 RHF + zodResolver 标题输入; 非空)。trim 后空白 → 400
 * (own-resource 输入校验)。repo 接地缝本期不暴露 UI → 服务端建会话恒 `repo=null`,
 * 客户端不可指定。
 */
export class CreateSessionRequest {
  @ApiProperty({
    description: '会话标题 (必填, trim 后非空; 1..60)',
    minLength: 1,
    maxLength: 60,
    example: '给行情页加收藏',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  title!: string;
}
