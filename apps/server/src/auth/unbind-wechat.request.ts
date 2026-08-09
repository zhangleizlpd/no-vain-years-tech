import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * POST /v1/accounts/me/wechat-binding/unbind (EP3, 010 FR-S04) request body。
 * `code` 缺失 / 非 `\d{6}` → ValidationPipe 400 `FORM_VALIDATION` (与凭据路径
 * 401 `INVALID_UNBIND_CODE` 区分)。copy delete-account.request。
 */
export class UnbindWechatRequest {
  @ApiProperty({
    description: '6-digit WeChat-unbind verification code',
    example: '123456',
    pattern: '^\\d{6}$',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
