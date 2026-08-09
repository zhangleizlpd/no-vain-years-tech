import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { Gender } from './account.rules';

/**
 * PATCH /api/v1/accounts/me/gender request body (008 FR-S01..S03).
 *
 * gender 是严格 4 枚举之一或 null（清空）。`@IsEnum(Gender)` 先挡明显非法枚举值；
 * `@IsOptional` 允许 null（清空 gender，canonical 未设态，FR-S03），与 UpdateBioRequest
 * 的空串清空同义。精确归一 / 清空交 normalizeGender()（use case 内）。
 * 不接受自由文本 / 中文标签 —— 中文标签是前端展示层映射。
 */
export class UpdateGenderRequest {
  @ApiProperty({
    description:
      'Gender enum; one of MALE / FEMALE / NON_BINARY / PRIVATE, or null to clear (FR-S03)',
    enum: Gender,
    nullable: true,
    example: Gender.MALE,
  })
  @IsOptional()
  @IsEnum(Gender)
  gender!: Gender | null;
}
