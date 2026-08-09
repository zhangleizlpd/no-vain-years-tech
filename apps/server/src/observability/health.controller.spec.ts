import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrismaService } from '../security/prisma.service.js';
import { REDIS_CLIENT } from '../security/redis.token.js';
import { HealthController } from './health.controller.js';

interface FakeRedis {
  ping: () => Promise<string>;
}

interface FakePrisma {
  $queryRaw: (...args: unknown[]) => Promise<unknown>;
}

function buildModule(prisma: FakePrisma, redis: FakeRedis): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [TerminusModule],
    controllers: [HealthController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: REDIS_CLIENT, useValue: redis },
    ],
  }).compile();
}

describe('HealthController', () => {
  let controller: HealthController;

  describe('/healthz/live', () => {
    beforeEach(async () => {
      const mod = await buildModule({ $queryRaw: vi.fn() }, { ping: vi.fn() });
      controller = mod.get(HealthController);
    });

    it('always returns ok without exercising deps', async () => {
      const result = await controller.live();
      expect(result.status).toBe('ok');
    });
  });

  describe('/healthz/ready', () => {
    it('returns ok when prisma + redis are up', async () => {
      const mod = await buildModule(
        { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
        { ping: vi.fn().mockResolvedValue('PONG') },
      );
      controller = mod.get(HealthController);

      const result = await controller.ready();
      expect(result.status).toBe('ok');
      expect(result.info?.['prisma']?.status).toBe('up');
      expect(result.info?.['redis']?.status).toBe('up');
    });

    it('returns 503 when prisma $queryRaw throws', async () => {
      const mod = await buildModule(
        { $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')) },
        { ping: vi.fn().mockResolvedValue('PONG') },
      );
      controller = mod.get(HealthController);

      await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('returns 503 when redis ping does not return PONG', async () => {
      const mod = await buildModule(
        { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
        { ping: vi.fn().mockResolvedValue('unexpected') },
      );
      controller = mod.get(HealthController);

      await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('returns 503 when redis ping throws', async () => {
      const mod = await buildModule(
        { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) },
        { ping: vi.fn().mockRejectedValue(new Error('redis unreachable')) },
      );
      controller = mod.get(HealthController);

      await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
