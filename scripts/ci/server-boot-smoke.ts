/**
 * Server runtime boot smoke (PR-T1 / 测试基建机制层).
 *
 * Standalone Node.js 脚本（用 tsx 跑）— 不依赖 vitest / nx target / CI.
 * 物理验证 contract:
 *   1. nx build server (ensure fresh dist; bakes SWC + decorator metadata)
 *   2. Testcontainers (Postgres + Redis) 真起
 *   3. 镜像 apps/server/src/main.ts bootstrap (Fastify + ValidationPipe
 *      with FormValidationException exceptionFactory + setGlobalPrefix('api'))
 *   4. 真 HTTP fetch (NOT app.inject) — 跨 process boundary 串联 trace_id
 *   5. 401 路径断言：(a) no 500 crash  (b) RFC 9457 ProblemDetail shape
 *      (c) traceId 字段非空 (CLS middleware → ProblemDetailFilter 链路活)
 *      (c+) x-trace-id response header ≡ body.traceId (双链路同步)
 *   6. 400 FORM_VALIDATION 路径断言 (P4 extension per ADR-0040 follow-up):
 *      (d) status === 400  (e) body.code === 'FORM_VALIDATION'
 *      (f) invalidAttributes 非空数组 (g) traceId 仍非空
 *
 * Why dist import (not src): NestJS DI 依赖 `emitDecoratorMetadata` 输出的
 * `design:paramtypes` 反射元数据. tsx 默认 esbuild transform 不 emit metadata,
 * swc-node 在 monorepo `.js` 后缀 import 解析上有 gap. dist 是 nx build
 * (SWC) 编译产物, metadata 已烧入 — 最稳健.
 *
 * Why "no app.inject": app.inject 走 Fastify in-process injector, 绕过
 * 真实 socket 监听 + CLS request hook lifecycle, 拦不住 PR-79 类
 * "interceptor mode 漏 Guards/Filters" 的 cascade bug. 唯一可靠探针
 * 是真发 HTTP 请求 + 检查 response header + body 双链同步.
 *
 * Usage:
 *   pnpm tsx scripts/ci/server-boot-smoke.ts
 *
 * Prerequisites:
 *   - Docker / OrbStack 运行中 (Testcontainers 拉镜像 + 启容器)
 *   - apps/server/.swcrc + tsconfig.app.json 含 decoratorMetadata=true
 *
 * Expected exit codes:
 *   0 — 全 assertion pass, 终端 echo 真 traceId UUID
 *   1 — 任一 assertion fail, 含原因 + 完整 RFC 9457 body 调试用
 *
 * Maintained as part of multi-layer test gate strategy
 * (ADR-0040 / docs/private/plans/2026-05/05-22-test-infra-master.md).
 */

import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { ValidationError, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

interface ProblemDetail {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  traceId?: string;
  code?: string;
  invalidAttributes?: InvalidAttribute[];
}

interface InvalidAttribute {
  field: string;
  messages: string[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MONO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const SERVER_DIR = path.resolve(MONO_ROOT, 'apps/server');
const SERVER_DIST = path.resolve(SERVER_DIR, 'dist');

function log(msg: string): void {
  console.log(`[smoke] ${msg}`);
}

// Mirrors apps/server/src/main.ts flattenValidationErrors — keep in sync.
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

async function runSmokeTest(): Promise<void> {
  log('[1/6] building server (nx build server) to ensure fresh dist…');
  execFileSync('pnpm', ['exec', 'nx', 'build', 'server'], {
    cwd: MONO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });

  // [asset] 005: built dist 必含 ip2region v4 xdb (SWC 不拷非 TS 资产 → 靠 project.json
  // build assets glob)。缺失则 IpGeoService.onModuleInit readFileSync 在 prod 抛 ENOENT。
  // 显式探活 (boot 前): 给清晰失败信号, 不靠 boot crash 反推。
  const xdbPath = path.resolve(SERVER_DIST, 'security/data/ip2region_v4.xdb');
  log(`[asset] verifying built dist ip2region xdb at ${xdbPath}…`);
  if (!existsSync(xdbPath)) {
    throw new Error(
      `[ASSERT-XDB] built dist missing ip2region_v4.xdb — check apps/server/project.json build assets glob (output ./security/data)`,
    );
  }

  log('[2/6] booting Testcontainers (Postgres + Redis)…');
  const pgContainer: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  )
    .withDatabase('smoke')
    .withUsername('smoke')
    .withPassword('smoke')
    .start();
  const redisContainer: StartedRedisContainer = await new RedisContainer('redis:7-alpine').start();

  let app: NestFastifyApplication | undefined;

  try {
    // Inject env BEFORE NestFactory.create — SecurityModule / AuthModule
    // ConfigService.getOrThrow checks run at module-init time.
    process.env['DATABASE_URL'] = pgContainer.getConnectionUri();
    process.env['REDIS_URL'] = redisContainer.getConnectionUrl();
    process.env['AUTH_JWT_SECRET'] = 'smoke-test-jwt-secret-min-32-bytes-pad-abcdef';
    process.env['SMS_CODE_HMAC_SECRET'] = 'smoke-test-hmac-secret-min-32-bytes-pad-zzzzzz';
    process.env['SMS_GATEWAY'] = 'mock';
    // deepseekConfig (027 T005, SecurityModule load array) boot-time .parse()
    // requires a non-empty DEEPSEEK_API_KEY — provide a placeholder so smoke boot
    // succeeds without the real secret (boot healthy ≠ key valid, 同 JWT/HMAC 占位).
    process.env['DEEPSEEK_API_KEY'] = 'smoke-placeholder-deepseek-key';
    // minimaxConfig (029 收口, SecurityModule load array) 同样 boot-time .parse() 要求
    // 非空 MINIMAX_API_KEY — 占位让 smoke boot 过 (缺则整 server boot crash → smoke 红).
    process.env['MINIMAX_API_KEY'] = 'smoke-placeholder-minimax-key';
    // vendor 数据源恒 mock (与 vitest.config.ts test.env 同口径): smoke 只验 boot 能起,
    // 不打真 vendor。**必须显式赋值而非依赖 config 的 ?? 'mock' 默认** — 那个默认只在变量
    // **缺失**时生效, 而本脚本继承调用者 shell; worktree 的 .envrc 带 `=live` 进来就会走 live
    // 分支、缺 futuShimUrl/futuShimToken → boot ZodError, smoke 在本地恒红 CI 恒绿
    // (2026-08-02 踩过)。CI 环境干净, 这行对 CI 是 no-op.
    process.env['MARKETDATA_PROVIDER'] = 'mock';

    log('[3/6] applying Prisma migrations against smoke Postgres…');
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: SERVER_DIR,
      env: process.env,
      stdio: 'inherit',
    });

    log('[4/6] dynamic-importing compiled AppModule + FormValidationException…');
    const appModuleUrl = pathToFileURL(path.resolve(SERVER_DIST, 'app/app.module.js')).href;
    const fveUrl = pathToFileURL(
      path.resolve(SERVER_DIST, 'security/form-validation.exception.js'),
    ).href;
    const { AppModule } = (await import(appModuleUrl)) as {
      AppModule: unknown;
    };
    const { FormValidationException } = (await import(fveUrl)) as {
      FormValidationException: new (errors: InvalidAttribute[]) => Error;
    };

    log('[5/6] booting NestFastifyApplication (mirrors main.ts)…');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app = await NestFactory.create<NestFastifyApplication>(AppModule as any, new FastifyAdapter(), {
      logger: ['error', 'warn'],
      bufferLogs: true,
    });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        exceptionFactory: (errors: ValidationError[]) =>
          new FormValidationException(flattenValidationErrors(errors)),
      }),
    );
    app.setGlobalPrefix('api');
    // Explicit IPv4 — NestFastifyApplication on dual-stack hosts may default
    // to '::' and surprise fetch with mixed v4/v6 resolution races.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') {
      throw new Error('smoke: failed to read bound port from Fastify');
    }
    const url = `http://127.0.0.1:${address.port}/api/v1/accounts/me`;
    log(`         listening on http://127.0.0.1:${address.port}`);

    log(`[6/6] probing ${url} with invalid bearer (expect 401 ProblemDetail)…`);
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/problem+json',
        Authorization: 'Bearer smoke.invalid.token',
      },
    });
    const body = (await res.json()) as ProblemDetail;

    log(`       received status=${res.status}, asserting 401 contract…`);

    // (a) Must not be 500 — Guard/Filter must catch invalid bearer cleanly.
    if (res.status === 500) {
      throw new Error(`[ASSERT-A] server crashed with 500; body=${JSON.stringify(body)}`);
    }

    // (b) RFC 9457 ProblemDetail shape: type+title+status all present.
    if (!body.type || !body.title || typeof body.status !== 'number') {
      throw new Error(
        `[ASSERT-B] response missing RFC 9457 shape (type/title/status); body=${JSON.stringify(body)}`,
      );
    }

    // (c) traceId must be present + non-empty (CLS middleware + filter live).
    if (typeof body.traceId !== 'string' || body.traceId.length === 0) {
      throw new Error(
        `[ASSERT-C] response missing traceId — check CLS middleware + ProblemDetailFilter; body=${JSON.stringify(body)}`,
      );
    }

    // (c+) Cross-check: x-trace-id response header should mirror body.traceId.
    const headerTraceId = res.headers.get('x-trace-id');
    if (headerTraceId !== body.traceId) {
      throw new Error(
        `[ASSERT-C+] x-trace-id header (${headerTraceId}) ≠ body.traceId (${body.traceId}); cross-link broken`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // [P4 extension] POST 400 FORM_VALIDATION probe (per ADR-0040 follow-up)
    // ─────────────────────────────────────────────────────────────────────
    // Asserts that ValidationPipe + FormValidationException chain is
    // wired end-to-end. Without this probe, smoke would pass even if the
    // ValidationPipe drops out (returning vanilla 400 BadRequestException
    // instead of code:FORM_VALIDATION + invalidAttributes[]) — exactly
    // the Bug #2 cascade PR #79 retro flagged.
    //
    // Endpoint: POST /api/v1/accounts/sms-codes with empty body — the
    // ValidationPipe must trigger phone-field validation, throw
    // FormValidationException, which ProblemDetailFilter formats into the
    // expected shape.
    const validateUrl = `http://127.0.0.1:${address.port}/api/v1/accounts/sms-codes`;
    log(`       probing ${validateUrl} with empty body (expect 400 FORM_VALIDATION)…`);
    const postRes = await fetch(validateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/problem+json',
      },
      body: JSON.stringify({}),
    });
    const postBody = (await postRes.json()) as ProblemDetail;
    log(`       received status=${postRes.status}, asserting 400 contract…`);

    // (d) status must be 400 — ValidationPipe must trigger.
    if (postRes.status !== 400) {
      throw new Error(
        `[ASSERT-D] ValidationPipe missing or misconfigured — expected 400, got ${postRes.status}; body=${JSON.stringify(postBody)}`,
      );
    }

    // (e) body.code must equal 'FORM_VALIDATION' — FormValidationException
    //     must be the exceptionFactory result of ValidationPipe.
    if (postBody.code !== 'FORM_VALIDATION') {
      throw new Error(
        `[ASSERT-E] FormValidationException not wired — expected body.code='FORM_VALIDATION', got '${postBody.code}'; body=${JSON.stringify(postBody)}`,
      );
    }

    // (f) invalidAttributes must be non-empty array per ADR-0038 contract.
    if (!Array.isArray(postBody.invalidAttributes) || postBody.invalidAttributes.length === 0) {
      throw new Error(
        `[ASSERT-F] ProblemDetail missing invalidAttributes — ADR-0038 contract broken; body=${JSON.stringify(postBody)}`,
      );
    }

    // (g) traceId still present on the 400 path (same CLS chain).
    if (typeof postBody.traceId !== 'string' || postBody.traceId.length === 0) {
      throw new Error(
        `[ASSERT-G] 400 response missing traceId — CLS middleware not covering ValidationPipe → Filter path; body=${JSON.stringify(postBody)}`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // [devices] 005: GET /api/v1/auth/devices 端点契约探活 (invalid bearer → 401)。
    // boot 成功本身已隐式验 IpGeoService.onModuleInit 载 xdb (否则 crash); 此探针显式
    // 确认 device 路由挂载 + JwtAccessGuard 活 (route 真注册进 AppModule)。
    // ─────────────────────────────────────────────────────────────────────
    const devicesUrl = `http://127.0.0.1:${address.port}/api/v1/auth/devices`;
    log(`       probing ${devicesUrl} with invalid bearer (expect 401, device route mounted)…`);
    const devRes = await fetch(devicesUrl, {
      method: 'GET',
      headers: { Accept: 'application/problem+json', Authorization: 'Bearer smoke.invalid.token' },
    });
    if (devRes.status !== 401) {
      const devBody = (await devRes.json()) as ProblemDetail;
      throw new Error(
        `[ASSERT-DEV] GET /v1/auth/devices expected 401 (JwtAccessGuard), got ${devRes.status}; body=${JSON.stringify(devBody)}`,
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // [portfolio] 011: GET /api/v1/portfolio/market-preferences 端点契约探活
    // (invalid bearer → 401)。显式确认 PortfolioModule 路由挂载 + JwtAuthGuard 活
    // (EP1 真注册进 AppModule, 与 /me 一致反枚举路径)。
    // ─────────────────────────────────────────────────────────────────────
    const marketPrefUrl = `http://127.0.0.1:${address.port}/api/v1/portfolio/market-preferences`;
    log(
      `       probing ${marketPrefUrl} with invalid bearer (expect 401, portfolio route mounted)…`,
    );
    const mktRes = await fetch(marketPrefUrl, {
      method: 'GET',
      headers: { Accept: 'application/problem+json', Authorization: 'Bearer smoke.invalid.token' },
    });
    if (mktRes.status !== 401) {
      const mktBody = (await mktRes.json()) as ProblemDetail;
      throw new Error(
        `[ASSERT-MKT] GET /v1/portfolio/market-preferences expected 401 (JwtAuthGuard), got ${mktRes.status}; body=${JSON.stringify(mktBody)}`,
      );
    }

    log(
      `✅ ALL ASSERTIONS PASSED — 401 traceId=${body.traceId}, 400 code=${postBody.code} invalidAttributes=${postBody.invalidAttributes.length} entries, devices 401 ✓, portfolio 401 ✓, xdb asset ✓`,
    );
  } catch (err) {
    console.error('[smoke] ❌ FAILED:', err);
    throw err;
  } finally {
    log('cleanup: closing Nest app + stopping containers…');
    if (app) await app.close();
    await redisContainer.stop();
    await pgContainer.stop();
  }
}

runSmokeTest().then(
  () => process.exit(0),
  () => process.exit(1),
);
