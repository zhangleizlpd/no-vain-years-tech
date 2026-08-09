import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Histogram } from 'prom-client';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { HTTP_REQUEST_DURATION_SECONDS } from './metrics.constants.js';

interface FastifyLikeRequest {
  routeOptions?: { url?: string };
  method?: string;
}

interface FastifyLikeResponse {
  statusCode?: number;
}

interface HttpError {
  status?: number;
  statusCode?: number;
}

/**
 * Global interceptor that records every HTTP request's duration into the
 * `http_request_duration_seconds` Histogram (per gap-audit A2).
 *
 * Label discipline (CRITICAL for prom storage cost):
 *  - `route` is the matched **template** (e.g. `/api/v1/accounts/:id`) —
 *    never the actual URL with concrete IDs. Sourced from Fastify 5's
 *    `request.routeOptions.url`; falls back to NestJS controller + handler
 *    path metadata for non-Fastify contexts or rare adapter quirks.
 *  - `method` is uppercase HTTP verb.
 *  - `status_code` is the numeric response status (errors map via filter).
 *
 * Cardinality budget per replica ≈ routes × methods × statuses × buckets.
 * With ~50 routes / 4 methods / ~6 statuses / 11 buckets ≈ 13.2k series —
 * well under the per-target ~100k recommendation.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(
    @InjectMetric(HTTP_REQUEST_DURATION_SECONDS)
    private readonly histogram: Histogram<'route' | 'method' | 'status_code'>,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = process.hrtime.bigint();
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyLikeRequest>();
    const route = this.resolveRoute(context, req);
    const method = (req.method ?? 'UNKNOWN').toUpperCase();

    const record = (status: number) => {
      const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
      this.histogram.labels(route, method, String(status)).observe(elapsedSec);
    };

    return next.handle().pipe(
      tap(() => record(http.getResponse<FastifyLikeResponse>().statusCode ?? 200)),
      catchError((err: HttpError) => {
        const status = err.status ?? err.statusCode ?? 500;
        record(status);
        return throwError(() => err);
      }),
    );
  }

  private resolveRoute(context: ExecutionContext, req: FastifyLikeRequest): string {
    const fastifyTemplate = req.routeOptions?.url;
    if (typeof fastifyTemplate === 'string' && fastifyTemplate.length > 0) {
      return fastifyTemplate;
    }
    const ctrlPath = this.reflector.get<string | undefined>(PATH_METADATA, context.getClass());
    const handlerPath = this.reflector.get<string | undefined>(PATH_METADATA, context.getHandler());
    const segments = [stripSlashes(ctrlPath), stripSlashes(handlerPath)].filter(
      (s) => s.length > 0,
    );
    return segments.length > 0 ? `/${segments.join('/')}` : 'unknown';
  }
}

function stripSlashes(path: string | undefined): string {
  return (path ?? '').replace(/^\/+|\/+$/g, '');
}
