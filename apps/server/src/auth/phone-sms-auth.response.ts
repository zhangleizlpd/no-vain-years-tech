import { ApiProperty } from '@nestjs/swagger';

/**
 * POST /api/v1/accounts/phone-sms-auth response body (FR-S09).
 *
 * accountId 序列化为 string (JSON-safe vs BigInt;匹配 JWT sub claim).
 * 同 shape 在 byte-level anti-enumeration 下,US1 已注册 / US2 自动注册路径返回完全一致.
 */
export class PhoneSmsAuthResponse {
  @ApiProperty({
    description:
      'Account ID (serialized as string to remain JSON-safe vs BigInt; matches JWT sub claim)',
    example: '1234567890',
  })
  accountId!: string;

  @ApiProperty({
    description: 'JWT access token (short-lived)',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiProperty({
    description: 'JWT refresh token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  refreshToken!: string;
}
