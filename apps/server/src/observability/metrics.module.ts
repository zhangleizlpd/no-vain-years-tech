import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrometheusModule, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { HttpMetricsInterceptor } from './http-metrics.interceptor.js';
import { HTTP_REQUEST_DURATION_SECONDS } from './metrics.constants.js';

/**
 * Observability — Prometheus metrics (per gap-audit A2).
 *
 * `PrometheusModule.register({ defaultMetrics: true })` ships the Node.js
 * runtime baseline (event-loop lag / RSS / CPU / GC). The custom
 * `http_request_duration_seconds` Histogram is contributed via
 * `makeHistogramProvider` and recorded by the global `HttpMetricsInterceptor`.
 *
 * Endpoint: GET /metrics (registered outside the /api global prefix; see
 * main.ts exclude list). In prod, restrict via nginx/SLB allowlist so only
 * Prometheus scrape IPs reach it — do NOT expose publicly.
 */
@Module({
  imports: [
    PrometheusModule.register({
      defaultMetrics: { enabled: true },
      defaultLabels: { app: 'server' },
    }),
  ],
  providers: [
    makeHistogramProvider({
      name: HTTP_REQUEST_DURATION_SECONDS,
      help: 'Duration of HTTP requests in seconds (route = controller template path, NOT concrete URL).',
      labelNames: ['route', 'method', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    }),
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class MetricsModule {}
