import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Redis } from 'ioredis';
import { PrismaService } from '../security/prisma.service.js';
import { REDIS_CLIENT } from '../security/redis.token.js';

/**
 * Liveness vs Readiness split (per gap-audit A1):
 *  - /healthz/live   only proves the Node process is alive. K8s liveness
 *                    probe maps here: failure → pod restart.
 *  - /healthz/ready  exercises Prisma + Redis. K8s readiness probe maps
 *                    here: failure → cut traffic, do NOT restart (transient
 *                    dependency outage shouldn't loop-restart the pod).
 */
@Controller('healthz')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([() => this.checkPrisma(), () => this.checkRedis()]);
  }

  private async checkPrisma(): Promise<HealthIndicatorResult> {
    const session = this.indicators.check('prisma');
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return session.up();
    } catch (e) {
      return session.down({ error: (e as Error).message });
    }
  }

  private async checkRedis(): Promise<HealthIndicatorResult> {
    const session = this.indicators.check('redis');
    try {
      const pong = await this.redis.ping();
      if (pong !== 'PONG') {
        return session.down({ error: `unexpected ping response: ${pong}` });
      }
      return session.up();
    } catch (e) {
      return session.down({ error: (e as Error).message });
    }
  }
}
