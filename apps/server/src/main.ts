import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import { ValidationError, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app/app.module';
import { appConfig, parseOrigins, type AppConfig } from './config/index.js';
import { buildOpenApiConfig } from './openapi.config';
import {
  FormValidationException,
  type InvalidAttribute,
} from './security/form-validation.exception';
import { HTTP_ADAPTER_OPTIONS } from './security/http-adapter.options';

// Flatten class-validator ValidationError[] into ProblemDetail
// invalidAttributes shape (per ADR-0038). Nested object errors use
// dot-notation: e.g. `address.city` for { address: { city: ... } }.
function flattenValidationErrors(errors: ValidationError[], parentPath = ''): InvalidAttribute[] {
  return errors.flatMap((err) => {
    const field = parentPath ? `${parentPath}.${err.property}` : err.property;
    const own: InvalidAttribute[] = err.constraints
      ? [{ field, messages: Object.values(err.constraints) }]
      : [];
    const nested = err.children?.length ? flattenValidationErrors(err.children, field) : [];
    return [...own, ...nested];
  });
}

async function bootstrap() {
  // trustProxy 跳数走 HTTP_ADAPTER_OPTIONS（prod 恒在 nginx 之后；理由 + 取证 + 「为什么是 1
  // 不是 true」全在该常量的文档注释，行为契约由 http-adapter.options.spec.ts 钉住）。
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(HTTP_ADAPTER_OPTIONS),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));

  // CORS must register before any route mounts (Fastify plugin order).
  // Origins drawn from typed appConfig — Zod parsed at boot, so `*` (dev) /
  // strict allowlist (prod) is settled before listen.
  const cfg = app.get<AppConfig>(appConfig.KEY);
  await app.register(fastifyCors, {
    origin: parseOrigins(cfg.corsAllowedOrigins),
    credentials: true,
    // @fastify/cors defaults methods to the CORS-safelisted 'GET,HEAD,POST',
    // which rejects PATCH /accounts/me + DELETE device-management preflights on
    // the web build. List every verb the API actually serves.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });

  // Multipart (025 holdings xlsx import). Registered before route mounts
  // (Fastify plugin order, same as CORS). limits 即 DoS 防线: 单文件 ≤2MB、
  // 每请求 1 文件 (FR-001); 超限由 multipart 层直接 413, 不进解析。
  await app.register(fastifyMultipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  });

  // 035 ideation 语音输入: transcribe 端点 (POST /api/v1/ideation/asr/transcribe) 收 base64
  // 音频 inline JSON body (≤10MB 文件 → ~14MB base64), 远超 Fastify 默认 1MB bodyLimit。
  // **仅给该单条路由**抬高 bodyLimit (per-route, 其余端点维持 1MB 默认收紧攻击面); 端点 JWT-
  // guarded + per-account 限流。DTO @MaxLength(~14MB) 是真正干净的 413/400 闸 (ProblemDetail),
  // bodyLimit 略高于 DTO max 以保证 DTO 先拦。onRoute 须在路由 mount 前挂 (Fastify hook 序)。
  const ASR_TRANSCRIBE_PATH = '/api/v1/ideation/asr/transcribe';
  const ASR_TRANSCRIBE_BODY_LIMIT = 15 * 1024 * 1024;
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (routeOptions) => {
      const method = routeOptions.method;
      const isPost = Array.isArray(method) ? method.includes('POST') : method === 'POST';
      if (isPost && routeOptions.url === ASR_TRANSCRIBE_PATH) {
        routeOptions.bodyLimit = ASR_TRANSCRIBE_BODY_LIMIT;
      }
    });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      // Map class-validator errors into FormValidationException so
      // ProblemDetailFilter passes `code: "FORM_VALIDATION"` +
      // `invalidAttributes[]` through to the client (per ADR-0038).
      exceptionFactory: (errors: ValidationError[]) =>
        new FormValidationException(flattenValidationErrors(errors)),
    }),
  );
  const globalPrefix = 'api';
  // /healthz/* and /metrics are k8s probe + Prometheus scrape conventions
  // and must be exposed at the root, not behind /api.
  app.setGlobalPrefix(globalPrefix, {
    exclude: ['healthz/(.*)', 'metrics'],
  });

  const document = SwaggerModule.createDocument(app, buildOpenApiConfig());
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
  });

  // 🚨 优雅关停开关（#824）。**没有这一行，本应用的所有关停钩子在 prod 一个都不会跑** ——
  // NestJS 官方：`onModuleDestroy` / `beforeApplicationShutdown` / `onApplicationShutdown`
  // 只在显式 `app.close()` 或（收到 SIGTERM/SIGINT **且** 调过本方法）时触发
  // （https://docs.nestjs.com/fundamentals/lifecycle-events）。
  //
  // 本仓靠这些钩子做的事：BullMQ Worker `close()`（等 in-flight job 跑完，否则 job 变 stalled，
  // 而我们是**单实例部署**、没有第二个 worker 来接管）+ Redis / Prisma 连接收尾。
  //
  // ⏱ 关停预算必须与容器宽限期自洽，否则「等」是假的 —— 到点照样 SIGKILL：
  //   单个关停点 10s（`security/close-with-timeout.ts`）× 单 provider 内串行 2 次 = 20s 最坏
  //   ⇒ `docker-compose.tight.yml` 的 app 服务设 `stop_grace_period: 40s`（留余量）。
  //   宽限期是**上限不是固定等待**，容器提前退出就立刻走，给足不产生日常代价。
  // 改任一侧（超时值 / 宽限期）都要回来核这笔账。
  app.enableShutdownHooks();

  await app.listen(cfg.port, '0.0.0.0');
  app.get(Logger).log(`🚀 Application is running on: http://localhost:${cfg.port}/${globalPrefix}`);
  app.get(Logger).log(`📘 OpenAPI docs: http://localhost:${cfg.port}/docs`);
}

bootstrap();
