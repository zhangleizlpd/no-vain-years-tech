import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Per-attribute validation issue surfaced in ProblemDetail `invalidAttributes`.
 *
 * Mapped 1:1 to client-side form.setError() (per ADR-0038 fallback chain).
 * `field` is the form field path (dot notation for nested);
 * `messages` is the list of i18n-ready messages for that field.
 */
export interface InvalidAttribute {
  field: string;
  messages: string[];
}

/**
 * Form-validation exception (per ADR-0038 — full-stack error UX contract).
 *
 * Thrown by use cases when one or more user-supplied form fields fail
 * business validation (e.g. displayName regex, phone E.164 shape, sms code
 * format). ProblemDetailFilter passes invalidAttributes through verbatim
 * so the client can call form.setError(field, message) without parsing
 * `detail` text.
 *
 * Status: 400 Bad Request. Code: `FORM_VALIDATION` (machine-readable).
 *
 * Why distinct from NestJS ValidationPipe BadRequestException:
 *   - ValidationPipe's default `message` is an array of strings without
 *     field association → client can't map to setError()
 *   - This explicit shape forces use cases to be intentional about which
 *     attributes are user-facing form fields vs. system-validation errors
 *
 * Usage:
 *   throw new FormValidationException([
 *     { field: 'displayName', messages: ['1-32 chars required', '禁止使用空格'] },
 *   ]);
 */
export class FormValidationException extends HttpException {
  static readonly code = 'FORM_VALIDATION';

  constructor(public readonly invalidAttributes: InvalidAttribute[]) {
    super(
      {
        code: FormValidationException.code,
        message: 'Form validation failed',
        invalidAttributes,
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}
