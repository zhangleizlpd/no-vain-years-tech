import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * POST /api/v1/auth/cancel-deletion (EP4, FR-S09/S11) request body。
 *
 * phone 仅 `@IsString`（缺失 / 非 string → 400 FORM_VALIDATION）—— E.164 格式校验由
 * 控制器显式做 → 422 `INVALID_PHONE_FORMAT`（全局 pipe 把 @Matches 失败映射 400, 见
 * cancel-deletion.controller / invalid-phone-format.exception）。
 * code `@Matches(/^\d{6}$/)`（缺失 / 非 6 位 → 400, 与凭据 401 折叠路径区分, 同 EP2）。
 */
export class CancelDeletionRequest {
  @ApiProperty({
    description: 'E.164 +86 CN mobile phone number',
    example: '+8613800138000',
    pattern: '^\\+861[3-9]\\d{9}$',
  })
  @IsString()
  phone!: string;

  @ApiProperty({
    description: '6-digit cancel-deletion verification code',
    example: '123456',
    pattern: '^\\d{6}$',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
