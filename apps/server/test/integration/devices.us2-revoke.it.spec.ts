import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { setupIsolatedStores } from '../_support/isolated-db';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { AuthModule } from '../../src/auth/auth.module';
import { PrismaService } from '../../src/security/prisma.service';
import { JwtTokenService } from '../../src/security/jwt-token.service';
import {
  OUTBOX_PUBLISHER,
  type OutboxPublisher,
} from '../../src/security/outbox/outbox-publisher.port';
import { DEVICE_REVOKED_EVENT_TYPE } from '../../src/auth/device-revoked.event';

const DAY_MS = 24 * 60 * 60 * 1000;

// US2 Independent Test (FR-S06~S12): 撤非当前设备 → 200 + revokedAt + outbox 1 event +
// 当前行不变; 撤当前 → 409; 撤他人/不存在 → 404; 撤已撤 → 幂等 200 无新事件; 缺 x-device-id → 401。
describe('US2 撤销单设备 (Testcontainers PG + Redis + Fastify)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtTokenService;
  let outbox: OutboxPublisher;
  let seq = 0;

  let stores: Awaited<ReturnType<typeof setupIsolatedStores>>;

  beforeAll(async () => {
    stores = await setupIsolatedStores();
    process.env.DATABASE_URL = stores.databaseUrl;
    process.env.REDIS_URL = stores.redisUrl;
    process.env.AUTH_JWT_SECRET = 'us2-revoke-jwt-secret-min-32-bytes-pad-abc';
    process.env.SMS_CODE_HMAC_SECRET = 'us2-revoke-hmac-secret-min-32-bytes-pad-z';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AuthModule],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = moduleRef.get(PrismaService);
    jwt = moduleRef.get(JwtTokenService);
    outbox = moduleRef.get(OUTBOX_PUBLISHER);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stores.drop();
  });

  async function seedRow(accountId: bigint, deviceId: string, revokedAt: Date | null = null) {
    seq += 1;
    return prisma.refreshToken.create({
      data: {
        tokenHash: `us2dev${String(seq).padStart(4, '0')}`.padEnd(64, '0'),
        accountId,
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
        revokedAt,
        deviceId,
        loginMethod: 'PHONE_SMS',
      },
    });
  }

  function revokeDevice(recordId: string | bigint, token?: string, deviceId?: string) {
    return app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/devices/${recordId}`,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(deviceId ? { 'x-device-id': deviceId } : {}),
      },
    });
  }

  async function deviceRevokedEvents(accountId: bigint) {
    const events = await prisma.outboxEvent.findMany({
      where: { eventType: DEVICE_REVOKED_EVENT_TYPE },
    });
    return events.filter(
      (e) => (e.payload as { data: { accountId: string } }).data.accountId === accountId.toString(),
    );
  }

  it('撤非当前设备 → 200 + revokedAt + outbox 1 event (逐字段) + 当前行不变 + 再撤幂等 200 无新事件', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800146001', status: 'ACTIVE' } });
    const current = await seedRow(A.id, 'A-current');
    const target = await seedRow(A.id, 'dev-B');
    const token = jwt.signAccessToken({ accountId: A.id });

    const res = await revokeDevice(target.id, token, 'A-current');
    expect(res.statusCode).toBe(200);

    const targetRow = await prisma.refreshToken.findUniqueOrThrow({ where: { id: target.id } });
    expect(targetRow.revokedAt).not.toBeNull();
    const currentRow = await prisma.refreshToken.findUniqueOrThrow({ where: { id: current.id } });
    expect(currentRow.revokedAt).toBeNull(); // 当前行不变

    const events = await deviceRevokedEvents(A.id);
    expect(events).toHaveLength(1);
    const envelope = events[0]!.payload as {
      metadata: { producer_context: string; event_version: number };
      data: {
        accountId: string;
        recordId: string;
        deviceId: string;
        revokedAt: string;
        occurredAt: string;
      };
    };
    expect(envelope.metadata.producer_context).toBe('auth');
    expect(envelope.data.accountId).toBe(A.id.toString());
    expect(envelope.data.recordId).toBe(target.id.toString());
    expect(envelope.data.deviceId).toBe('dev-B');
    expect(envelope.data.revokedAt).toBe(targetRow.revokedAt!.toISOString());
    expect(envelope.data.revokedAt).toBe(envelope.data.occurredAt);

    // 再撤已撤行 → 幂等 200, outbox 仍 1 条 (不重复发事件)。
    const again = await revokeDevice(target.id, token, 'A-current');
    expect(again.statusCode).toBe(200);
    expect(await deviceRevokedEvents(A.id)).toHaveLength(1);
  });

  it('撤当前设备 (deviceId == x-device-id) → 409 CANNOT_REMOVE_CURRENT_DEVICE 无事件, 行不变', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800146002', status: 'ACTIVE' } });
    const current = await seedRow(A.id, 'A-current');
    const token = jwt.signAccessToken({ accountId: A.id });

    const res = await revokeDevice(current.id, token, 'A-current');
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe('CANNOT_REMOVE_CURRENT_DEVICE');
    expect(await deviceRevokedEvents(A.id)).toHaveLength(0);
    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { id: current.id } });
    expect(row.revokedAt).toBeNull();
  });

  it('撤他人行 / 不存在 id → 均 404 DEVICE_NOT_FOUND', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800146003', status: 'ACTIVE' } });
    const X = await prisma.account.create({ data: { phone: '+8613800146004', status: 'ACTIVE' } });
    await seedRow(A.id, 'A-current');
    const otherRow = await seedRow(X.id, 'X-1');
    const token = jwt.signAccessToken({ accountId: A.id });

    const otherRes = await revokeDevice(otherRow.id, token, 'A-current');
    expect(otherRes.statusCode).toBe(404);
    expect((otherRes.json() as { code: string }).code).toBe('DEVICE_NOT_FOUND');

    const missingRes = await revokeDevice('999999999', token, 'A-current');
    expect(missingRes.statusCode).toBe(404);
    expect((missingRes.json() as { code: string }).code).toBe('DEVICE_NOT_FOUND');

    // 他人行未被撤。
    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { id: otherRow.id } });
    expect(row.revokedAt).toBeNull();
  });

  it('缺 x-device-id 头 → 401 (FR-S12 防自撤前置); 缺鉴权 → 401', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800146005', status: 'ACTIVE' } });
    const target = await seedRow(A.id, 'dev-B');
    const token = jwt.signAccessToken({ accountId: A.id });

    expect((await revokeDevice(target.id, token)).statusCode).toBe(401); // 无 x-device-id
    expect((await revokeDevice(target.id)).statusCode).toBe(401); // 无 bearer
    // 行未被撤。
    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.revokedAt).toBeNull();
  });

  it('原子性 (FR-S11): 注入 outbox publish 失败 → 整 tx 回滚 (行未撤 + 无事件)', async () => {
    const A = await prisma.account.create({ data: { phone: '+8613800146006', status: 'ACTIVE' } });
    await seedRow(A.id, 'A-current');
    const target = await seedRow(A.id, 'dev-B');
    const token = jwt.signAccessToken({ accountId: A.id });

    // 注入: outbox.publish 抛 → revoke usecase tx 内发事件步失败 → 整 tx 回滚。
    const spy = vi.spyOn(outbox, 'publish').mockRejectedValueOnce(new Error('outbox fixture boom'));
    const res = await revokeDevice(target.id, token, 'A-current');
    // 未捕获 infra 错 → ProblemDetailFilter 映射 500 (不静默成功)。
    expect(res.statusCode).toBe(500);
    spy.mockRestore();

    // 回滚: 行未撤 (revokedAt 仍 null) + 无事件。
    const row = await prisma.refreshToken.findUniqueOrThrow({ where: { id: target.id } });
    expect(row.revokedAt).toBeNull();
    expect(await deviceRevokedEvents(A.id)).toHaveLength(0);
  });
});
