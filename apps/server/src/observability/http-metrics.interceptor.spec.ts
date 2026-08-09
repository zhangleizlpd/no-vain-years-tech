import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getToken } from '@willsoto/nestjs-prometheus';
import type { Histogram } from 'prom-client';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpMetricsInterceptor } from './http-metrics.interceptor.js';
import { HTTP_REQUEST_DURATION_SECONDS } from './metrics.constants.js';

type ObserveSpy = ReturnType<typeof vi.fn>;
type LabelsSpy = ReturnType<typeof vi.fn>;

interface ContextOpts {
  method?: string;
  routeOptionsUrl?: string;
  responseStatus?: number;
  classPath?: string;
  handlerPath?: string;
}

function makeContext(opts: ContextOpts = {}): ExecutionContext {
  class TestController {}
  function handler() {}
  if (opts.classPath !== undefined) {
    Reflect.defineMetadata('path', opts.classPath, TestController);
  }
  if (opts.handlerPath !== undefined) {
    Reflect.defineMetadata('path', opts.handlerPath, handler);
  }
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: opts.method ?? 'GET',
        routeOptions: opts.routeOptionsUrl ? { url: opts.routeOptionsUrl } : undefined,
      }),
      getResponse: () => ({ statusCode: opts.responseStatus ?? 200 }),
    }),
    getClass: () => TestController,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe('HttpMetricsInterceptor', () => {
  let interceptor: HttpMetricsInterceptor;
  let observeSpy: ObserveSpy;
  let labelsSpy: LabelsSpy;

  beforeEach(async () => {
    observeSpy = vi.fn();
    labelsSpy = vi.fn(() => ({ observe: observeSpy }));
    const fakeHistogram = { labels: labelsSpy } as unknown as Histogram<string>;

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        HttpMetricsInterceptor,
        Reflector,
        { provide: getToken(HTTP_REQUEST_DURATION_SECONDS), useValue: fakeHistogram },
      ],
    }).compile();
    interceptor = mod.get(HttpMetricsInterceptor);
  });

  it('uses Fastify routeOptions.url as the canonical template route', async () => {
    const ctx = makeContext({ routeOptionsUrl: '/api/v1/accounts/:id', method: 'get' });
    const call: CallHandler = { handle: () => of({ ok: true }) };

    await firstValueFrom(interceptor.intercept(ctx, call));

    expect(labelsSpy).toHaveBeenCalledExactlyOnceWith('/api/v1/accounts/:id', 'GET', '200');
    expect(observeSpy).toHaveBeenCalledOnce();
    expect(observeSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
  });

  it('falls back to controller + handler metadata when Fastify route absent', async () => {
    const ctx = makeContext({ classPath: 'healthz', handlerPath: 'live' });
    const call: CallHandler = { handle: () => of({}) };

    await firstValueFrom(interceptor.intercept(ctx, call));

    expect(labelsSpy).toHaveBeenCalledExactlyOnceWith('/healthz/live', 'GET', '200');
  });

  it('returns "unknown" when neither Fastify nor metadata yields a path', async () => {
    const ctx = makeContext({});
    const call: CallHandler = { handle: () => of({}) };

    await firstValueFrom(interceptor.intercept(ctx, call));

    expect(labelsSpy).toHaveBeenCalledExactlyOnceWith('unknown', 'GET', '200');
  });

  it('records error status when HttpException-like error thrown', async () => {
    const ctx = makeContext({ routeOptionsUrl: '/api/v1/x' });
    const call: CallHandler = { handle: () => throwError(() => ({ status: 401 })) };

    await expect(firstValueFrom(interceptor.intercept(ctx, call))).rejects.toEqual({ status: 401 });
    expect(labelsSpy).toHaveBeenCalledExactlyOnceWith('/api/v1/x', 'GET', '401');
  });

  it('defaults to 500 when thrown error has no status field', async () => {
    const ctx = makeContext({ routeOptionsUrl: '/api/v1/x' });
    const call: CallHandler = { handle: () => throwError(() => new Error('boom')) };

    await expect(firstValueFrom(interceptor.intercept(ctx, call))).rejects.toBeInstanceOf(Error);
    expect(labelsSpy).toHaveBeenCalledExactlyOnceWith('/api/v1/x', 'GET', '500');
  });

  it('strips concrete IDs by relying on the matched template (cardinality guard)', async () => {
    const ctx = makeContext({ routeOptionsUrl: '/api/v1/accounts/:id', method: 'GET' });
    const call: CallHandler = { handle: () => of({}) };

    // Even though the actual URL would contain `/abc123`, the interceptor
    // sources from routeOptions.url, which is the Fastify-matched template.
    await firstValueFrom(interceptor.intercept(ctx, call));

    expect(labelsSpy).toHaveBeenCalledExactlyOnceWith('/api/v1/accounts/:id', 'GET', '200');
  });
});
