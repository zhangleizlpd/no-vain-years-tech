import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Test } from '@nestjs/testing';
import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ProblemDetailFilter } from './problem-detail.filter';

/**
 * Mock ClsService — returns deterministic trace id for assertions.
 * Tests that don't assert on traceId can ignore the field.
 */
const mockCls = {
  getId: () => 'test-trace-id',
} as unknown as ClsService;

function mockHost(): {
  host: ArgumentsHost;
  sent: { status?: number; body?: unknown; headers?: Record<string, string> };
} {
  const sent: { status?: number; body?: unknown; headers?: Record<string, string> } = {
    headers: {},
  };
  const reply = {
    status: vi.fn((code: number) => {
      sent.status = code;
      return reply;
    }),
    header: vi.fn((k: string, v: string) => {
      sent.headers![k] = v;
      return reply;
    }),
    send: vi.fn((body: unknown) => {
      sent.body = body;
      return reply;
    }),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ url: '/api/v1/accounts/phone-sms-auth', method: 'POST' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

describe('ProblemDetailFilter', () => {
  let filter: ProblemDetailFilter;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ProblemDetailFilter, { provide: ClsService, useValue: mockCls }],
    }).compile();
    filter = moduleRef.get(ProblemDetailFilter);
  });

  it('maps BadRequestException to RFC 9457 problem+json with 400', () => {
    const { host, sent } = mockHost();
    filter.catch(new BadRequestException('phone format invalid'), host);
    expect(sent.status).toBe(400);
    expect(sent.headers!['content-type']).toBe('application/problem+json');
    expect(sent.body).toMatchObject({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'phone format invalid',
      instance: '/api/v1/accounts/phone-sms-auth',
    });
  });

  it('maps UnauthorizedException to 401 INVALID_CREDENTIALS', () => {
    const { host, sent } = mockHost();
    filter.catch(new UnauthorizedException('INVALID_CREDENTIALS'), host);
    expect(sent.status).toBe(401);
    expect(sent.body).toMatchObject({
      status: 401,
      title: 'Unauthorized',
      detail: 'INVALID_CREDENTIALS',
    });
  });

  it('maps generic HttpException with custom status', () => {
    const { host, sent } = mockHost();
    filter.catch(new HttpException({ code: 'RATE_LIMITED' }, 429), host);
    expect(sent.status).toBe(429);
    expect(sent.body).toMatchObject({ status: 429 });
  });

  it('maps unknown Error to 500 with generic detail (no internal leak)', () => {
    const { host, sent } = mockHost();
    filter.catch(new Error('database connection lost'), host);
    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ status: 500, title: 'Internal Server Error' });
    // 不暴露内部错误细节
    expect((sent.body as { detail?: string }).detail).not.toContain('database');
  });
});
