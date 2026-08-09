import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * POST /api/v1/accounts/me/deletion (EP2, FR-S03/S05) request body。
 * `code` 缺失 / 非 `\d{6}` → ValidationPipe 400 `FORM_VALIDATION` (与凭据路径
 * 401 `INVALID_DELETION_CODE` 区分, FR-S05)。
 */
export class DeleteAccountRequest {
  @ApiProperty({
    description: '6-digit account-deletion verification code',
    example: '123456',
    pattern: '^\\d{6}$',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
