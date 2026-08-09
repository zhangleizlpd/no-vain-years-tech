import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { SecurityModule } from '../security/security.module.js';
import { HealthController } from './health.controller.js';

/**
 * Observability — Health probes (per gap-audit A1).
 *
 * Depends on SecurityModule for PrismaService + REDIS_CLIENT (platform infra
 * exempt from CROSS-CONTEXT annotation per ADR-0041).
 *
 * Endpoints (registered outside the /api global prefix; see main.ts exclude):
 *  - GET /healthz/live   liveness (process up)
 *  - GET /healthz/ready  readiness (Prisma + Redis healthy)
 */
@Module({
  imports: [TerminusModule, SecurityModule],
  controllers: [HealthController],
})
export class HealthModule {}
