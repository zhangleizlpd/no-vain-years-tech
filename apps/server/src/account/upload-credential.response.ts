import { ApiProperty } from '@nestjs/swagger';

/**
 * OSS PostObject V4 form fields the client appends to the multipart upload
 * (in order; `file` is appended last by the client, not echoed here).
 */
export class UploadCredentialFieldsResponse {
  @ApiProperty({ description: 'Pre-allocated object key', example: 'avatar/42/uuid/img' })
  key!: string;

  @ApiProperty({ description: 'base64(UTF-8 policy JSON); also the signed message' })
  policy!: string;

  @ApiProperty({ enum: ['OSS4-HMAC-SHA256'], example: 'OSS4-HMAC-SHA256' })
  'x-oss-signature-version'!: 'OSS4-HMAC-SHA256';

  @ApiProperty({ example: 'LTAI.../20260601/cn-shanghai/oss/aliyun_v4_request' })
  'x-oss-credential'!: string;

  @ApiProperty({ example: '20260601T120000Z' })
  'x-oss-date'!: string;

  @ApiProperty({ description: 'Lowercase hex HMAC-SHA256 signature' })
  'x-oss-signature'!: string;

  @ApiProperty({ enum: ['200'], example: '200' })
  success_action_status!: '200';
}

/**
 * POST /api/v1/accounts/me/profile-image/upload-credential response (009 EP1).
 *
 * The client POSTs a multipart form (these `fields` first, then the image `file`
 * last) straight to `host` — the backend never touches the image bytes (SC-007).
 */
export class UploadCredentialResponse {
  @ApiProperty({
    description: 'Bucket root URL to POST the multipart form to',
    example: 'https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com',
  })
  host!: string;

  @ApiProperty({
    description: 'Pre-allocated object key (echoed back to the confirm endpoint)',
    example: 'avatar/42/11111111-2222-3333-4444-555555555555/img',
  })
  objectKey!: string;

  @ApiProperty({
    description: 'Credential expiration (ISO 8601)',
    example: '2026-06-01T12:15:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  expiresAt!: string;

  @ApiProperty({ type: UploadCredentialFieldsResponse })
  fields!: UploadCredentialFieldsResponse;
}
