import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { MockSmsGateway } from '../../src/auth/mock-sms.gateway';
import { SMS_GATEWAY } from '../../src/auth/sms-gateway.port';
import { ACCOUNT_CREATED_EVENT_TYPE } from '../../src/account/account-created.event';

describe('US2 e2e smoke — unregistered phone auto-register (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mockSms: MockSmsGateway;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us2-e2e-test-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'us2-e2e-hmac-secret-min-32-bytes-pad-zzzzzz';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = moduleRef.get(PrismaService);
    mockSms = moduleRef.get<MockSmsGateway>(SMS_GATEWAY);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  it('US2 happy path: unregistered phone → 200 + tokens + new account row + outbox_event row', async () => {
    const phone = '+8613900139501';

    // pre-condition: no row in DB
    const pre = await prisma.account.findUnique({ where: { phone } });
    expect(pre).toBeNull();

    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/sms-codes',
      payload: { phone },
    });
    expect(reqRes.statusCode).toBe(200);
    expect(reqRes.json()).toEqual({ ttlSec: 300 });

    const code = mockSms.getLastCode(phone);
    expect(code).toMatch(/^\d{6}$/);

    // Send inbound x-trace-id header — nestjs-cls middleware honors it
    // (per security.module.ts idGenerator) so the same trace propagates
    // into the outbox row metadata (per ADR-0033).
    const inboundTraceId = '0a1b2c3d-4e5f-6789-abcd-ef0123456789';
    const authRes = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      headers: { 'x-trace-id': inboundTraceId },
      payload: { phone, code },
    });

    expect(authRes.statusCode).toBe(200);
    const body = authRes.json();
    expect(body.accountId).toMatch(/^\d+$/);
    expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // post-condition: new account row created with ACTIVE status
    const created = await prisma.account.findUnique({ where: { phone } });
    expect(created).not.toBeNull();
    expect(created!.status).toBe('ACTIVE');
    expect(created!.id.toString()).toBe(body.accountId);

    // outbox row written — payload follows ADR-0033 envelope shape
    // { metadata: { trace_id, occurred_at, event_version, producer_context }, data }
    const outboxRows = await prisma.outboxEvent.findMany({
      where: { eventType: ACCOUNT_CREATED_EVENT_TYPE },
    });
    const matching = outboxRows.filter((r) => {
      const p = r.payload as { data?: { phone?: string } };
      return p?.data?.phone === phone;
    });
    expect(matching).toHaveLength(1);
    expect(matching[0]!.publishedAt).toBeNull();

    const envelope = matching[0]!.payload as {
      metadata: {
        trace_id: string;
        occurred_at: string;
        event_version: number;
        producer_context: string;
      };
      data: { accountId: string; phone: string; createdAt: string };
    };
    expect(envelope.metadata.trace_id).toBe(inboundTraceId);
    expect(envelope.metadata.event_version).toBe(1);
    expect(envelope.metadata.producer_context).toBe('auth');
    expect(envelope.metadata.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(envelope.data.phone).toBe(phone);
    expect(envelope.data.accountId).toBe(body.accountId);
  });

  it('US2 unregistered path response key set matches US1 ACTIVE path (anti-enumeration prep)', async () => {
    const phone = '+8613900139502';

    await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/sms-codes',
      payload: { phone },
    });
    const code = mockSms.getLastCode(phone);

    const authRes = await app.inject({
      method: 'POST',
      url: '/api/v1/accounts/phone-sms-auth',
      payload: { phone, code },
    });
    expect(authRes.statusCode).toBe(200);

    const body = authRes.json();
    expect(Object.keys(body).sort()).toEqual(['accessToken', 'accountId', 'refreshToken'].sort());
  });
});
