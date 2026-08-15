import { ApiProperty } from '@nestjs/swagger';

/**
 * OSS PostObject V4 form fields the channel appends to the multipart upload (in
 * order; the HTML `file` is appended last by the client, not echoed here). Same
 * shape as the ideation attachment / account upload credential — all consume the
 * one platform signer (`integrations/oss`, ADR-0058); this is a sibling DTO for
 * the mockup (text/html) caller (no cross-ctx DTO import, ideation 叶子 ctx)。
 */
export class MockupCredentialFieldsResponse {
  @ApiProperty({
    description: 'Pre-allocated object key',
    example: 'ideation-mockup/42/101/uuid/img',
  })
  key!: string;

  @ApiProperty({ description: 'base64(UTF-8 policy JSON); also the signed message' })
  policy!: string;

  @ApiProperty({ enum: ['OSS4-HMAC-SHA256'], example: 'OSS4-HMAC-SHA256' })
  'x-oss-signature-version'!: 'OSS4-HMAC-SHA256';

  @ApiProperty({ example: 'LTAI.../20260627/cn-shanghai/oss/aliyun_v4_request' })
  'x-oss-credential'!: string;

  @ApiProperty({ example: '20260627T120000Z' })
  'x-oss-date'!: string;

  @ApiProperty({ description: 'Lowercase hex HMAC-SHA256 signature' })
  'x-oss-signature'!: string;

  @ApiProperty({ enum: ['200'], example: '200' })
  success_action_status!: '200';
}

/**
 * POST /api/v1/ideation/mockups/credential response (037 T005, US1 / FR-002 / FR-003).
 *
 * **worker-token 端点** —— channel POSTs a multipart form (these `fields` first,
 * then the mockup HTML `file` last) straight to `host`; the backend never touches
 * the bytes (ADR-0045 / FR-003). Credential is locked to this session's
 * `ideation-mockup/{accountId}/{sessionId}/` key prefix + `text/html` content-type
 * + size ceiling + short TTL. The (accountId, sessionId) scope is derived by the
 * server from the claimed event — the channel never self-reports it (FR-002).
 */
export class MockupCredentialResponse {
  @ApiProperty({
    description: 'Bucket root URL to POST the multipart form to',
    example: 'https://nvy-profile-images.oss-cn-shanghai.aliyuncs.com',
  })
  host!: string;

  @ApiProperty({
    description: 'Pre-allocated object key (the uploaded mockup HTML lands here)',
    example: 'ideation-mockup/42/101/11111111-2222-3333-4444-555555555555/img',
  })
  objectKey!: string;

  @ApiProperty({
    description: 'Credential expiration (ISO 8601)',
    example: '2026-06-27T12:15:00.000Z',
    type: 'string',
    format: 'date-time',
  })
  expiresAt!: string;

  @ApiProperty({ type: MockupCredentialFieldsResponse })
  fields!: MockupCredentialFieldsResponse;
}
