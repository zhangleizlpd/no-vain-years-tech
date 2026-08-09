import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AgentQueueController } from './agent-queue.controller';
import { WorkerAuthGuard } from '../security/worker-auth.guard';
import { ClaimNextEventUseCase } from './claim-next-event.usecase';
import { ExtendLeaseUseCase } from './extend-lease.usecase';
import { CompleteEventUseCase } from './complete-event.usecase';
import { agentBridgeConfig } from '../config/index';

/**
 * P1.4 WorkerAuthGuard HTTP IT (token 三态)。真 guard 经 Test.createTestingModule DI 装载
 * (非 new Class, per「禁止过度 Mock」); 下游 usecase mock 隔离, 只验通道层鉴权 enforce。
 */
const TOKEN = 'w'.repeat(43);

describe('AgentQueueController WorkerAuthGuard IT (token 三态)', () => {
  let app: NestFastifyApplication;
  const claimMock = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentQueueController],
      providers: [
        WorkerAuthGuard,
        { provide: agentBridgeConfig.KEY, useValue: { workerToken: TOKEN } },
        { provide: ClaimNextEventUseCase, useValue: { execute: claimMock } },
        { provide: ExtendLeaseUseCase, useValue: { execute: vi.fn() } },
        { provide: CompleteEventUseCase, useValue: { execute: vi.fn() } },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('对: 有效 worker token → 放行 (200, 命中 usecase)', async () => {
    claimMock.mockResolvedValueOnce({
      eventId: 'e1',
      bizType: 'ideation.requirement',
      bizId: 'b1',
      delegationToken: 'dt',
      leaseExpiresAt: new Date('2026-06-26T10:05:00.000Z'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-queue/poll',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().eventId).toBe('e1');
  });

  it('错: 错误 token → 401, usecase 不被调用', async () => {
    claimMock.mockClear();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent-queue/poll',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('缺: 无 Authorization header → 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/agent-queue/poll' });
    expect(res.statusCode).toBe(401);
  });
});
