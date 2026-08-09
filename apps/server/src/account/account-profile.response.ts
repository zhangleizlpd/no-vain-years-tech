import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus, Gender } from './account.rules';

/**
 * GET /api/v1/accounts/me response body (FR-001).
 *
 * accountId serialized as string (JSON-safe vs BigInt; matches JWT sub claim).
 * phone is E.164 raw string (+8613800138000); masking is client-side.
 * displayName is null for new users who have not set one (FR-007).
 */
export class AccountProfileResponse {
  @ApiProperty({
    description:
      'Account ID (serialized as string for JSON-safety vs BigInt; matches JWT sub claim)',
    example: '1234567890',
  })
  accountId!: string;

  @ApiProperty({
    description: 'E.164 phone number; mask handled by client (per apps/mobile/lib/format/phone.ts)',
    example: '+8613800138000',
  })
  phone!: string;

  @ApiProperty({
    description: 'Display name; null for new users before first update (FR-007)',
    example: 'Alice',
    nullable: true,
    type: 'string',
  })
  displayName!: string | null;

  @ApiProperty({
    description: 'Personal bio (个人简介); null when unset; ≤120 code points (007 FR-S06)',
    example: '美股研究员 / 量化交易',
    nullable: true,
    type: 'string',
  })
  bio!: string | null;

  @ApiProperty({
    description:
      'Gender (性别); one of MALE / FEMALE / NON_BINARY / PRIVATE; null when unset (008 FR-S06)',
    enum: Gender,
    nullable: true,
    example: Gender.MALE,
  })
  gender!: Gender | null;

  @ApiProperty({
    description: 'Avatar image URL (OSS public-read); null when unset (009 FR-S04)',
    example: 'https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com/avatar/42/uuid/img',
    nullable: true,
    type: 'string',
  })
  avatarUrl!: string | null;

  @ApiProperty({
    description: 'Home background image URL (OSS public-read); null when unset (009 FR-S04)',
    example: 'https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com/background/42/uuid/img',
    nullable: true,
    type: 'string',
  })
  backgroundImageUrl!: string | null;

  @ApiProperty({
    description: 'Account status',
    enum: AccountStatus,
    example: AccountStatus.ACTIVE,
  })
  status!: AccountStatus;

  @ApiProperty({
    description: 'Account creation timestamp (ISO 8601)',
    example: '2026-01-01T00:00:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  createdAt!: Date;

  @ApiProperty({
    description:
      'Whether a WeChat account is bound (010 FR-S07). MUST NOT expose openid — boolean only.',
    example: false,
  })
  wechatBound!: boolean;
}
