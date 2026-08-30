import { randomUUID } from 'node:crypto';
import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Redis } from 'ioredis';
import { ClsModule } from 'nestjs-cls';
import {
  appConfig,
  authConfig,
  dbConfig,
  redisConfig,
  smsConfig,
  jpushConfig,
  deepseekConfig,
  minimaxConfig,
  iqsConfig,
  codeIndexConfig,
  ossConfig,
  wechatConfig,
  marketdataConfig,
  marketdataSyncConfig,
  asrConfig,
  agentBridgeConfig,
  researchOssConfig,
  guestUploadConfig,
  optionsdeskConfig,
  type AuthConfig,
  type DbConfig,
  type RedisConfig,
} from '../config/index.js';
import { JwtTokenService } from './jwt-token.service.js';
import { PrismaService } from './prisma.service.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { IpGeoService } from './ip-geo.service.js';
import { ProblemDetailFilter } from './problem-detail.filter.js';
import { REDIS_CLIENT } from './redis.token.js';
import { OUTBOX_PUBLISHER } from './outbox/outbox-publisher.port.js';
import { OutboxEventPrismaPublisher } from './outbox/outbox-event.prisma.publisher.js';
import { OutboxEventCronPublisher } from './outbox/outbox-event-cron.publisher.js';
import { OutboxSubscriberRegistry } from './outbox/outbox-subscriber.registry.js';

const REDIS_LIFECYCLE = Symbol('REDIS_LIFECYCLE');

/**
 * ioredis 单例的生命周期宿主。
 *
 * 🚨 **连接是惰性的（首次取 `.client` 才建）**，不是在构造函数里建。原因：Nest 对模块里
 * 声明的 provider 是**急切实例化**的 —— 在构造函数里 `new Redis(url)` 意味着「只要这个
 * 模块被装进任何一个 TestingModule，就一定开一条真 socket」，即使那个测试压根不用 Redis、
 * 也已经用 `.overrideProvider(REDIS_CLIENT)` 换掉了客户端（本私有 token 覆盖不到）。
 * 2026-08-02 出网探针实测：`optionsdesk.controller.spec.ts` 就是这样在 `unit` project 里
 * 连上了 dev Redis —— 而它自称「DB / Redis 均不真连」。
 *
 * 生产行为不变：`REDIS_CLIENT` 的 factory 在 boot 时就取 `.client`，连接照旧在启动期建立。
 * 变的只是「没有任何人要这个客户端」的场景（= 测试覆盖掉它时）不再白开一条连接。
 */
class RedisLifecycle implements OnApplicationShutdown {
  #client?: Redis;
  constructor(private readonly url: string) {}
  get client(): Redis {
    return (this.#client ??= new Redis(this.url));
  }
  /**
   * 🚨 挂 `onApplicationShutdown` 而非 `onModuleDestroy` —— 与两个队列连接同一条纪律：
   * Nest 对同模块 providers 的 `onModuleDestroy` **不串行**，同步断连会插到别人 async
   * 关停的 await 中间。本连接虽是缓存用（默认重试 20 次，没有队列连接那种无限重试的
   * 死循环风险），仍统一到关停第二段，避免「三处里两处对、一处例外」这种要读文档才知道的
   * 不一致。详见 marketdata-queue-connection.ts 的 🚨 段与
   * test/integration/queue-shutdown-order.it.spec.ts。
   */
  onApplicationShutdown(): void {
    this.#client?.disconnect();
  }
}

/**
 * Security / platform infra base layer (per ADR-0032 + ADR-0036 + ADR-0038).
 *
 * Owns + exports cross-cutting infrastructure that account + auth contexts
 * depend on without violating the single-direction `auth → account → security`
 * import boundary:
 *   - JwtTokenService    pure JWT issuance/verify (no business state)
 *   - JwtModule          re-exported so JwtService is DI-resolvable in
 *                        consumers (e.g. JwtAuthGuard in account/web)
 *   - PrismaService      single DB client instance (consumed by account
 *                        + auth repositories)
 *   - REDIS_CLIENT       ioredis singleton with module lifecycle hook
 *   - ClsModule          AsyncLocalStorage trace_id (per ADR-0036) —
 *                        interceptor-mode for Fastify compat, idGenerator
 *                        honors inbound x-trace-id header for cross-service
 *                        propagation
 *   - APP_FILTER ProblemDetailFilter (RFC 9457 + business extension fields
 *                        per ADR-0038; injects traceId from ClsService)
 *   - OUTBOX_PUBLISHER   cross-context Outbox publisher (per ADR-0033 +
 *                        ADR-0043; outbox/ subdir per ADR-0041 sunset) —
 *                        exported so any context can publish via shared tx
 *
 * "security" is intentionally broader than its original JWT-only scope —
 * it is the platform base layer where common platform infra lives.
 * Consumers MUST NOT bypass this module (no direct `import '../security/X'`
 * for class registration; always via SecurityModule import).
 */
@Module({
  imports: [
    // ConfigModule loads all namespaced configs at boot. Each registerAs()
    // factory runs Zod parse → fail-fast on missing/invalid env *before* any
    // module initializes (no listen, no DB connect). cache: true memoizes
    // parsed values so the schema runs only once per process.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        authConfig,
        dbConfig,
        redisConfig,
        smsConfig,
        jpushConfig,
        deepseekConfig,
        minimaxConfig,
        iqsConfig,
        codeIndexConfig,
        ossConfig,
        wechatConfig,
        marketdataConfig,
        marketdataSyncConfig,
        asrConfig,
        agentBridgeConfig,
        researchOssConfig,
        guestUploadConfig,
        optionsdeskConfig,
      ],
      cache: true,
    }),
    JwtModule.registerAsync({
      inject: [authConfig.KEY],
      useFactory: (cfg: AuthConfig) => ({
        secret: cfg.jwtSecret,
        signOptions: { expiresIn: '15m' },
      }),
    }),
    ClsModule.forRoot({
      global: true,
      // middleware mode (per nestjs-cls docs) covers full request lifecycle —
      // Guards / Interceptors / Pipes / Controller / Filters all see the
      // same CLS context. Interceptor mode (prior) ran its run() wrapper
      // around only the controller phase, so JwtAuthGuard rejections and
      // ProblemDetailFilter both saw `cls.getId() === undefined`.
      // useEnterWith is required for Fastify because Fastify's request
      // lifecycle drops AsyncLocalStorage context across hooks otherwise.
      middleware: {
        mount: true,
        generateId: true,
        useEnterWith: true,
        idGenerator: (req: { headers?: Record<string, string | string[] | undefined> }) => {
          const headerValue = req?.headers?.['x-trace-id'];
          const inbound = Array.isArray(headerValue) ? headerValue[0] : headerValue;
          return typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();
        },
      },
    }),
  ],
  providers: [
    JwtTokenService,
    RefreshTokenService,
    IpGeoService,
    {
      provide: PrismaService,
      useFactory: (cfg: DbConfig) => new PrismaService(cfg.url),
      inject: [dbConfig.KEY],
    },
    {
      provide: REDIS_LIFECYCLE,
      useFactory: (cfg: RedisConfig) => new RedisLifecycle(cfg.url),
      inject: [redisConfig.KEY],
    },
    {
      provide: REDIS_CLIENT,
      useFactory: (lifecycle: RedisLifecycle) => lifecycle.client,
      inject: [REDIS_LIFECYCLE],
    },
    { provide: APP_FILTER, useClass: ProblemDetailFilter },
    // Cross-context Outbox (per ADR-0033 + ADR-0043): publisher lives in the
    // platform base layer (security/outbox/) so account + auth — and any future
    // context — can publish without violating the single-direction import
    // boundary. OUTBOX_PUBLISHER is exported; the cron scanner is a placeholder
    // (W3+ dispatch hook) registered here but not yet exported.
    { provide: OUTBOX_PUBLISHER, useClass: OutboxEventPrismaPublisher },
    // Outbox relay + 消费侧注册表 (ADR-0033 消费补全): registry 让业务 ctx (agent-bridge
    // 等) IoC 自注册消费方; cron 按 eventType 分发。registry 导出供业务 ctx 注入。
    OutboxSubscriberRegistry,
    OutboxEventCronPublisher,
  ],
  exports: [
    JwtTokenService,
    RefreshTokenService,
    IpGeoService,
    JwtModule,
    PrismaService,
    REDIS_CLIENT,
    OUTBOX_PUBLISHER,
    OutboxSubscriberRegistry,
  ],
})
export class SecurityModule {}
