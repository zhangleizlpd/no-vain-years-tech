import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * RFC 9457 ProblemDetail global exception filter (FR-S10 + ADR-0036 + ADR-0038).
 *
 * Maps every HttpException + unknown Error → `application/problem+json`
 * response. Generic body shape with 5 RFC fields + business extensions
 * passed through from `HttpException.getResponse()`:
 *
 *   code              from body.code if domain exception set it
 *   freezeUntil       from body.freezeUntil (ISO 8601 string)
 *   retryAfterSeconds from body.retryAfterSeconds
 *   invalidAttributes from body.invalidAttributes (FORM_VALIDATION)
 *   traceId           always injected from CLS context (request-scoped)
 *
 * No domain `instanceof` checks — security/ module does not reverse-depend
 * on account/auth (per ADR-0032 single direction). Domain exceptions must
 * extend HttpException + populate their own body fields (see
 * AccountInFreezePeriodException, AuthAttemptLockedException,
 * FormValidationException as canonical examples).
 *
 * Log level dispatch (per ADR-0036):
 *   4xx (business reject)        → warn (no stack)
 *   5xx + unhandled non-HTTP     → error (with stack)
 *   Unknown HTTP class above 500 → error
 */
@Catch()
export class ProblemDetailFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailFilter.name);

  constructor(private readonly cls: ClsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const traceId = this.cls.getId() ?? undefined;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exResponse = exception.getResponse();
      const body =
        typeof exResponse === 'object' && exResponse !== null
          ? (exResponse as Record<string, unknown>)
          : { message: String(exResponse) };

      const detail = this.extractDetail(body, exception.message);
      const title = HttpStatus[status] ? this.titleCase(HttpStatus[status]) : 'Error';

      this.logHttpException(status, exception, traceId);

      if (typeof body['retryAfterSeconds'] === 'number') {
        response.header('retry-after', String(body['retryAfterSeconds']));
      }

      response
        .status(status)
        .header('content-type', 'application/problem+json')
        .header('x-trace-id', traceId ?? '')
        .send({
          type: 'about:blank',
          title,
          status,
          ...(detail !== undefined && { detail }),
          instance: request.url,
          ...(traceId && { traceId }),
          ...(typeof body['code'] === 'string' && { code: body['code'] }),
          ...(typeof body['freezeUntil'] === 'string' && {
            freezeUntil: body['freezeUntil'],
          }),
          ...(typeof body['retryAfterSeconds'] === 'number' && {
            retryAfterSeconds: body['retryAfterSeconds'],
          }),
          ...(Array.isArray(body['invalidAttributes']) && {
            invalidAttributes: body['invalidAttributes'],
          }),
        });
      return;
    }

    // Unknown non-HTTP exception: 500 + redact internal detail (per OWASP)
    this.logger.error(
      `unhandled exception [trace=${traceId ?? 'no-trace'}]`,
      exception instanceof Error ? exception.stack : exception,
    );
    response
      .status(500)
      .header('content-type', 'application/problem+json')
      .header('x-trace-id', traceId ?? '')
      .send({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred',
        instance: request.url,
        ...(traceId && { traceId }),
      });
  }

  private extractDetail(body: Record<string, unknown>, fallback: string): string | undefined {
    const candidate = body['message'] ?? body['detail'] ?? fallback;
    if (Array.isArray(candidate)) {
      return candidate.map(String).join('; ');
    }
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
    return undefined;
  }

  private logHttpException(
    status: number,
    exception: HttpException,
    traceId: string | undefined,
  ): void {
    const ctx = `[trace=${traceId ?? 'no-trace'}] ${exception.name} status=${status}`;
    if (status >= 500) {
      this.logger.error(ctx, exception.stack);
    } else if (status >= 400) {
      this.logger.warn(`${ctx} message=${exception.message}`);
    } else {
      // 1xx/2xx/3xx flowed through a thrown HttpException — uncommon,
      // log at info to surface accidental misuse without alerting.
      this.logger.log(ctx);
    }
  }

  private titleCase(s: string): string {
    return s
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
