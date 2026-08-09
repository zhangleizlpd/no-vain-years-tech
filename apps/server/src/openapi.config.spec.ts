import { CanActivate, ExecutionContext } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule, OpenAPIObject } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PhoneSmsAuthUseCase } from './auth/phone-sms-auth.usecase';
import { RequestSmsCodeUseCase } from './auth/request-sms-code.usecase';
import { AccountPhoneSmsAuthController } from './auth/account-phone-sms-auth.controller';
import { AccountSmsCodeController } from './auth/account-sms-code.controller';
import { SmsPhoneThrottlerGuard } from './auth/sms-phone-throttler.guard';
import { buildOpenApiConfig } from './openapi.config';

/**
 * W4 V8 acceptance: @nestjs/swagger 产 OpenAPI 3.1 JSON,
 * 顶层 openapi: '3.1.0' + 含所有公开 endpoint + 含 schema 引用.
 *
 * 不 import AppModule — full AppModule init 会让 ioredis 真连 REDIS_URL,
 * GitHub runner 无 Redis 会 EPIPE。改用 controllers-only test module + mock
 * use cases + bypass throttler guard,scope 仅 swagger metadata 验证。
 *
 * Spec 不替代 e2e 测试:e2e 走 Testcontainers 起真 PG+Redis 跑实际 HTTP。
 */
const passthroughGuard: CanActivate = {
  canActivate: (_ctx: ExecutionContext) => true,
};

describe('OpenAPI document (W4 V8)', () => {
  let app: NestFastifyApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountSmsCodeController, AccountPhoneSmsAuthController],
      providers: [
        { provide: RequestSmsCodeUseCase, useValue: { execute: async () => ({ ttlSec: 60 }) } },
        { provide: PhoneSmsAuthUseCase, useValue: { execute: async () => null } },
      ],
    })
      .overrideGuard(SmsPhoneThrottlerGuard)
      .useValue(passthroughGuard)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.setGlobalPrefix('api');
    await app.init();
    document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  });

  afterAll(async () => {
    await app?.close();
  });

  it('uses OpenAPI 3.1.0', () => {
    expect(document.openapi).toBe('3.1.0');
  });

  it('declares accounts tag', () => {
    expect(document.tags?.map((t) => t.name)).toContain('accounts');
  });

  it('exposes POST /api/v1/accounts/sms-codes', () => {
    const path = document.paths['/api/v1/accounts/sms-codes'];
    expect(path).toBeDefined();
    expect(path.post).toBeDefined();
    expect(path.post?.tags).toContain('accounts');
    expect(path.post?.responses['200']).toBeDefined();
    expect(path.post?.responses['429']).toBeDefined();
  });

  it('exposes POST /api/v1/accounts/phone-sms-auth', () => {
    const path = document.paths['/api/v1/accounts/phone-sms-auth'];
    expect(path).toBeDefined();
    expect(path.post).toBeDefined();
    expect(path.post?.tags).toContain('accounts');
    expect(path.post?.responses['200']).toBeDefined();
    expect(path.post?.responses['401']).toBeDefined();
    expect(path.post?.responses['403']).toBeDefined();
    expect(path.post?.responses['429']).toBeDefined();
  });

  it('registers request + response DTO schemas', () => {
    const schemas = document.components?.schemas ?? {};
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'PhoneSmsAuthRequest',
        'PhoneSmsAuthResponse',
        'RequestSmsCodeRequest',
        'RequestSmsCodeResponse',
        'ProblemDetailResponse',
      ]),
    );
  });

  it('PhoneSmsAuthRequest schema carries phone pattern + code pattern', () => {
    const schema = document.components?.schemas?.PhoneSmsAuthRequest as {
      properties?: Record<string, { pattern?: string }>;
    };
    expect(schema.properties?.phone?.pattern).toBe('^\\+861[3-9]\\d{9}$');
    expect(schema.properties?.code?.pattern).toBe('^\\d{6}$');
  });
});
