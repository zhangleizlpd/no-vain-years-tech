import { ApiProperty } from '@nestjs/swagger';

/**
 * OSS PostObject V4 form fields the client appends to the multipart upload
 * (in order; `file` is appended last by the client, not echoed here). Same
 * shape as account `UploadCredentialFieldsResponse` — both ctx consume the one
 * platform signer (`integrations/oss`, ADR-0058 / 036 D3); the ideation copy is
 * a sibling DTO (no cross-ctx DTO import, ideation 叶子 ctx)。
 */
export class AttachmentCredentialFieldsResponse {
  @ApiProperty({ description: 'Pre-allocated object key', example: 'ideation/42/uuid/img' })
  key!: string;

  @ApiProperty({ description: 'base64(UTF-8 policy JSON); also the signed message' })
  policy!: string;

  @ApiProperty({ enum: ['OSS4-HMAC-SHA256'], example: 'OSS4-HMAC-SHA256' })
  'x-oss-signature-version'!: 'OSS4-HMAC-SHA256';

  @ApiProperty({ example: 'LTAI.../20260625/cn-shanghai/oss/aliyun_v4_request' })
  'x-oss-credential'!: string;

  @ApiProperty({ example: '20260625T120000Z' })
  'x-oss-date'!: string;

  @ApiProperty({ description: 'Lowercase hex HMAC-SHA256 signature' })
  'x-oss-signature'!: string;

  @ApiProperty({ enum: ['200'], example: '200' })
  success_action_status!: '200';
}

/**
 * POST /api/v1/ideation/sessions/{id}/attachments/credential response (036 T005,
 * FR-007 / US1 / US3).
 *
 * The client POSTs a multipart form (these `fields` first, then the image `file`
 * last) straight to `host` — the backend never touches the image bytes (per
 * ADR-0045 / SC-007). Credential is locked to this account's `ideation/<accountId>/`
 * key prefix + image content-type whitelist + size ceiling + short TTL.
 */
export class AttachmentCredentialResponse {
  @ApiProperty({
    description: 'Bucket root URL to POST the multipart form to',
    example: 'https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com',
  })
  host!: string;

  @ApiProperty({
    description: 'Pre-allocated object key (the burned-in image lands here)',
    example: 'ideation/42/11111111-2222-3333-4444-555555555555/img',
  })
  objectKey!: string;

  @ApiProperty({
    description: 'Credential expiration (ISO 8601)',
    example: '2026-06-25T12:15:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  expiresAt!: string;

  @ApiProperty({ type: AttachmentCredentialFieldsResponse })
  fields!: AttachmentCredentialFieldsResponse;
}
