import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/**
 * POST /api/v1/auth/cancel-deletion/sms-codes (EP3, FR-S07/S08) request body。
 *
 * phone 仅 `@IsString` (缺失 / 非 string → 400 FORM_VALIDATION via 全局 ValidationPipe;
 * whitelist:true 需至少一个校验装饰器保留属性)。E.164 格式校验**不**放 `@Matches` ——
 * 全局 pipe 会把 `@Matches` 失败也映射成 400, 而 FR-S08 要求格式错 → 422
 * `INVALID_PHONE_FORMAT`。故格式校验由控制器显式做 (见 cancel-deletion.controller)。
 */
export class SendCancelCodeRequest {
  @ApiProperty({
    description: 'E.164 +86 CN mobile phone number',
    example: '+8613800138000',
    pattern: '^\\+861[3-9]\\d{9}$',
  })
  @IsString()
  phone!: string;
}
