import { ApiProperty } from '@nestjs/swagger';

/**
 * RFC 9457 ProblemDetail response shape (FR-S10 + ADR-0038 — full-stack
 * error handling contract).
 *
 * Top-level 5 fields are RFC 9457 mandatory (type/title/status) + recommended
 * (detail/instance). Business extension 6 fields enable typed client-side
 * error handling without parsing free-text `detail`:
 *
 *   code               machine-readable error code (UPPER_SNAKE_CASE)
 *   traceId            request trace id (CLS-managed; mirrors x-trace-id
 *                      response header for UI display + log correlation)
 *   freezeUntil        ISO 8601 — for ACCOUNT_IN_FREEZE_PERIOD
 *   retryAfterSeconds  for AUTH_ATTEMPT_LOCKED / RATE_LIMIT_EXCEEDED
 *   invalidAttributes  for FORM_VALIDATION; [{ field, messages[] }]
 *                      drives client form.setError() per ADR-0038 chain
 *
 * OpenAPI codegen (Orval per ADR-0027) emits typed unions for `code` per
 * endpoint, enabling exhaustive switch in client. additionalProperties
 * remains true on the response schema for forward-compat extension fields.
 */
export class ProblemDetailResponse {
  @ApiProperty({
    description: 'RFC 9457 problem type URI; "about:blank" if generic',
    example: 'about:blank',
  })
  type!: string;

  @ApiProperty({
    description: 'Short human-readable summary of the problem type',
    example: 'Forbidden',
  })
  title!: string;

  @ApiProperty({
    description: 'HTTP status code',
    example: 403,
  })
  status!: number;

  @ApiProperty({
    description: 'Human-readable explanation specific to this occurrence',
    required: false,
    example: 'Account is in 30-day freeze period',
  })
  detail?: string;

  @ApiProperty({
    description: 'URI reference identifying the specific occurrence',
    required: false,
    example: '/api/v1/accounts/phone-sms-auth',
  })
  instance?: string;

  @ApiProperty({
    description: 'Machine-readable error code (UPPER_SNAKE_CASE)',
    required: false,
    example: 'ACCOUNT_IN_FREEZE_PERIOD',
  })
  code?: string;

  @ApiProperty({
    description: 'Request trace id (CLS-managed; mirrors x-trace-id response header)',
    required: false,
    example: '0e6a4d6e-...-2c8f',
  })
  traceId?: string;

  @ApiProperty({
    description: 'ISO 8601 timestamp — for ACCOUNT_IN_FREEZE_PERIOD',
    required: false,
    example: '2026-06-20T10:00:00.000Z',
  })
  freezeUntil?: string;

  @ApiProperty({
    description: 'Seconds until retry permitted — for AUTH_ATTEMPT_LOCKED / RATE_LIMIT_EXCEEDED',
    required: false,
    example: 1800,
  })
  retryAfterSeconds?: number;

  @ApiProperty({
    description:
      'Per-attribute validation issues — for FORM_VALIDATION; drives client form.setError()',
    required: false,
    type: 'array',
    items: {
      type: 'object',
      properties: {
        field: { type: 'string', example: 'displayName' },
        messages: {
          type: 'array',
          items: { type: 'string', example: '1-32 chars required' },
        },
      },
    },
  })
  invalidAttributes?: Array<{ field: string; messages: string[] }>;
}
