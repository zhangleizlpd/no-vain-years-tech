import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * PrismaService — NestJS DI wrapper around generated PrismaClient (v7 driver
 * adapter pattern, requires @prisma/adapter-pg).
 *
 * Constructor takes connectionString so:
 *  - production / dev factory injects dbConfig.url (Zod-validated at boot)
 *  - integration tests construct directly with Testcontainers URL
 *
 * onModuleInit / onModuleDestroy bind to NestJS lifecycle for graceful
 * connect / disconnect.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(connectionString: string) {
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
