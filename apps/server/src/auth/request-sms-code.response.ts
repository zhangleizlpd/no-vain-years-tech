import { ApiProperty } from '@nestjs/swagger';

/**
 * POST /api/v1/accounts/sms-codes response body (FR-S01).
 *
 * ttlSec 用于客户端 UX 倒计时 / resend gating.
 */
export class RequestSmsCodeResponse {
  @ApiProperty({
    description: 'SMS code TTL in seconds (client countdown / resend gating)',
    example: 60,
    minimum: 1,
  })
  ttlSec!: number;
}
