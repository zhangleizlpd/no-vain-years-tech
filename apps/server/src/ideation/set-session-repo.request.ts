import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * PATCH /ideation/sessions/{id}/repo request body (034 T004, FR-005 / US2)。
 *
 * 会话选/切接地目标仓 —— 写 `idea_session.repo` 锁定本会话检索命名空间。repo = catalog
 * (GET /ideation/repos) 暴露的某 repo 标识 (字符串)。trim 后空白 → 400 (own-resource
 * 输入校验, 与 create-session 标题同款)。仓存在性不在此校验 (catalog 已就绪态把关);
 * 切仓只影响后续轮 (FR-006), 既有 turn 引用不回改 (UC 仅改 session.repo 单字段)。
 */
export class SetSessionRepoRequest {
  @ApiProperty({
    description: '接地目标仓标识 (必填, trim 后非空; 来自 catalog GET /ideation/repos)',
    minLength: 1,
    maxLength: 200,
    example: 'no-vain-years-mono',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  repo!: string;
}
