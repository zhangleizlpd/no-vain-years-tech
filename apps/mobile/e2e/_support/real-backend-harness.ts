/**
 * 真后端 harness — boot + 程序化登录的共享底座。
 *
 * 抽自 real-backend-runner.ts（原 P2「真后端 smoke」orchestrator）：把「testcontainers
 * PG+Redis → prisma migrate deploy → spawn 真 server(:3000) → poll /healthz/ready →
 * 程序化登录拿真 token」这段脏活抽成可复用 `bootRealBackend()`，供两个消费方共享：
 *   1. real-backend-runner.ts —— boot 后 spawn Playwright 跑浏览器冷启动鉴权链冒烟。
 *   2. contract-smoke/run.ts —— boot 后 node 层用生成的 @nvy/api-client 打真 server
 *      验每 feature 的核心写入端到端 + 真落库（契约对齐 + 基建，无浏览器）。
 *
 * env-gate（RUN_REAL_BACKEND_SMOKE）由各 entry 脚本自己把守，本 harness 是纯 boot 逻辑。
 *
 * Why spawn 真 artifact（node dist/main.js）而非 in-process NestFactory：转译器不发
 * decorator metadata → NestFactory.create(AppModule) DI 失败；spawn server 自己的
 * swc-built artifact 保 metadata 完整、镜像 prod，且 teardown 保证容器回收。
 *
 * Login 黑盒：account 首次 phone-sms-auth 自动注册，issueSmsCode() 在 NODE_ENV=development
 * 且无 VITEST 时返固定 999999。boot 后 PATCH /me 设 displayName（浏览器消费方需名字才
 * 路由到 authed tabs；contract 消费方无害）。
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_PORT = 3000; // app axios baseURL default — do NOT change (web build bakes it).
const API = `http://127.0.0.1:${SERVER_PORT}`;
const PHONE = '+8613800138999';
const DEV_FIXED_CODE = '999999'; // issueSmsCode() under NODE_ENV=development (sms-code.rules.ts).
const DEFAULT_DISPLAY_NAME = '真后端冒烟';

// 037 ideation mockup 交付: worker-token 端点 (签凭证 / 写记录) 经 WorkerAuthGuard 鉴权 —— guard
// fail-closed (AGENT_WORKER_TOKEN 未配 → workerToken=null → 拒一切)。contract-smoke 打 node
// dist/main.js 真 boot **无 DI override** (IT 那套用不了)，故须经 env 注入一个确定性 worker token
// 让 worker 端点可达 (镜像 IT 的 agentBridgeConfig.KEY override)。值确定性占位，非真凭证。
const WORKER_TOKEN = 'w'.repeat(43);

export interface RealBackendCtx {
  /** server base URL（http://127.0.0.1:3000）。 */
  readonly api: string;
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly displayName: string;
  /** worker-token 端点（037 ideation mockup 签凭证 / 写记录）的 Bearer 凭证（env 注入的确定性占位）。 */
  readonly workerToken: string;
  /** 裸 HTTP POST + Bearer（登录 / 不经生成客户端的辅助调用）。 */
  postJson(path: string, body: unknown, bearer?: string): Promise<unknown>;
  /** 裸 HTTP PATCH + Bearer。 */
  patchJson(path: string, body: unknown, bearer: string): Promise<unknown>;
  /** PG 容器内 psql 执行 SQL —— 种「无公开写端点」的行（如 021 alert trigger 直插）。 */
  execSql(sql: string): Promise<void>;
  /** 杀 server + 停容器（幂等）。 */
  teardown(): Promise<void>;
}

// Fail fast（不自动杀）if :3000 占用 —— web build bake 了 localhost:3000 作 API base，
// 无法迁移，且占用者可能是用户自己的 dev server。清晰报错胜过 cryptic EADDRINUSE。
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      rejectProbe(
        new Error(
          `:${port} is already in use. The real-backend harness needs it free (the web build ` +
            `bakes localhost:${port} as the API base). Stop whatever is listening — e.g. ` +
            `\`lsof -tnP -i:${port} -sTCP:LISTEN | xargs kill\` — and retry.`,
        ),
      );
    });
    socket.once('error', () => {
      socket.destroy();
      resolveProbe(); // connection refused → port is free
    });
  });
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await sleep(500);
  }
  throw new Error(`server not ready at ${url} within ${timeoutMs}ms (last: ${lastErr})`);
}

async function postJson(path: string, body: unknown, bearer?: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function patchJson(path: string, body: unknown, bearer: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`PATCH ${path} → ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/**
 * boot 一个真后端（testcontainers + 真 server on :3000）+ 程序化登录拿真 token。
 * cwd 约定 = apps/mobile（两个 nx target 都以此为 cwd），server dist 在 ../server。
 */
export async function bootRealBackend(opts?: { displayName?: string }): Promise<RealBackendCtx> {
  const displayName = opts?.displayName ?? DEFAULT_DISPLAY_NAME;
  const MOBILE_DIR = process.cwd();
  const SERVER_DIR = resolve(MOBILE_DIR, '..', 'server');

  // 可变 holder：teardown / signal trap 在 boot 任意阶段失败都要能停已起的部分（部分初始化
  // 容错），故引用 holder 而非 const 局部（后者要等赋值才存在）。非空使用走下方 const 局部。
  const live: {
    pg?: StartedPostgreSqlContainer;
    redis?: StartedRedisContainer;
    server?: ChildProcess;
  } = {};

  const teardown = async (): Promise<void> => {
    if (live.server && !live.server.killed) live.server.kill('SIGTERM');
    await Promise.allSettled([live.pg?.stop(), live.redis?.stop()]);
  };

  // 被 abruptly kill（nx/CI 信号 tsx child 或 Ctrl-C）时正常 teardown 不跑、server orphan
  // 在 :3000 毒化下次 run → 同步 SIGKILL child 让 OS 立即回收 :3000，再退出。
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (live.server && !live.server.killed) live.server.kill('SIGKILL');
      process.exit(1);
    });
  }

  await assertPortFree(SERVER_PORT);

  console.log('[real-backend] starting PostgreSQL + Redis testcontainers…');
  const pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('smoke')
    .withUsername('smoke')
    .withPassword('smoke')
    .start();
  live.pg = pg;
  const redis = await new RedisContainer('redis:7-alpine').start();
  live.redis = redis;

  // Env for BOTH migrate deploy and the spawned server. NODE_ENV=development + no VITEST →
  // issueSmsCode() 返固定 999999（黑盒登录）。剥继承的 VITEST 让固定码分支可达。
  // 显式标注 ProcessEnv：spread 推断会丢 index signature，让下方 `delete serverEnv.VITEST`
  // （载荷代码，剥 VITEST 使固定码分支可达）报 TS2339。
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(SERVER_PORT),
    DATABASE_URL: pg.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
    AUTH_JWT_SECRET: 'real-backend-smoke-jwt-secret-min-32-bytes-pad-abcdef',
    SMS_CODE_HMAC_SECRET: 'real-backend-smoke-hmac-secret-min-32-bytes-pad-zzz',
    // 🚨 恒钉 mock，**不看 shell 环境**（hermetic）。marketdataConfig 只在
    // `MARKETDATA_PROVIDER` **整个变量缺失**时才落 mock（054 起非法值与空串一律 boot 抛）；而
    // `apps/server/.env` 里写的就是 `=live` 且零 FUTU_SHIM_* 真值，本地跑时它会经 shell
    // 继承进来 → boot 死在 futuShimUrl/futuShimToken 的 ZodError，且错误点离真因很远。
    // 与 `apps/server/vitest.config.ts` 的 test.env、`scripts/ci/server-boot-smoke.ts`
    // 同一范式：**在 boot 路径的属主内部钉死**，而不是要求每个调用方记得带前缀。
    MARKETDATA_PROVIDER: 'mock',
    // 027 chat: 占位 DeepSeek key 让 deepseekConfig.parse() 过 boot（非空校验，不打真 API），
    // CHAT_FAKE_LLM=1 让 chat.module 绑确定性 FakeLlmProvider（contract-smoke 不依赖外网）。
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'real-backend-smoke-deepseek-placeholder',
    // 029 收口 chat: minimaxConfig.parse() 同样要求 MINIMAX_API_KEY 非空过 boot（CHAT_FAKE_LLM
    // 下绑 Fake、不打真 API；缺此 key 整 server boot 失败 → contract-smoke 全红）。
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY ?? 'real-backend-smoke-minimax-placeholder',
    CHAT_FAKE_LLM: '1',
    // 032 ideation: IDEATION_FAKE_LLM=1 让 ideation.module 绑确定性 FakeIdeationLlmProvider
    // (bake 默认两相剧本 IDEATION_FAKE_SCRIPT; 访谈轮出 question+chips, 产出轮出 T1 齐 brief)
    // → 契约冒烟读到 token + suggestion 帧 + 落 brief, 不打真 LLM / 不依赖外网。
    IDEATION_FAKE_LLM: '1',
    // 035 ideation 语音输入: ASR_PROVIDER=fake → FakeAsrProvider bake 默认 partial→final 剧本
    // (ideation.module ASR_FAKE_SCRIPT) → WS 契约冒烟读到 partial + 非空 final 帧, 不打真
    // DashScope / 不依赖外网 / 无需真 DASHSCOPE_API_KEY (fake 分支 asrConfig 不校验 key)。
    ASR_PROVIDER: 'fake',
    // 030 chat web-search: CHAT_FAKE_SEARCH=1 让 chat.module 绑确定性 FakeSearchProvider
    // （IQS 默认 mock 不打真外网；T016 契约冒烟靠消息内嵌关键字驱动 content-driven 联网 loop）。
    CHAT_FAKE_SEARCH: '1',
    // 034 ideation 接地: 恒钉 fake code-index。CI 无 .env 时默认本就是 fake，但本地
    // apps/server/.env 配的 CODE_INDEX_PROVIDER=http 会经 ...process.env 继承进来 →
    // GET /ideation/repos 打真隧道端点，隧道没开就 503（2026-08-03 本地实证）。与上面
    // MARKETDATA_PROVIDER 同款范式：在 boot 属主内钉死 hermetic 默认。
    CODE_INDEX_PROVIDER: 'fake',
    // 036 ideation 图片标注: 确定性 fake-aliyun OSS 配置 (非真 bucket — 凭证签发只签 V4
    // 表单, 不打真 OSS)。无 OSS_* → ossConfig kind='unconfigured' → 凭证 EP 降级 503; 有此
    // 4 件套 → kind='aliyun' → 凭证签发 200 + image_url 经 ossPublicBaseUrl 派生 (对齐 T007
    // IT 的 appOss 分支)。值确定性: contract-smoke 验签发 scope + 带图 turn 落库, 不验真直传
    // (真 OSS bucket/CORS = 部署前置)。OSS_ACCESS_KEY_SECRET 仅本机/nightly 占位、非真凭证。
    OSS_REGION: 'oss-cn-shanghai',
    OSS_BUCKET: 'mbw-test-images',
    OSS_ACCESS_KEY_ID: 'LTAI-contract-smoke-access-key-id',
    OSS_ACCESS_KEY_SECRET: 'contract-smoke-access-key-secret-deterministic',
    // 037 mockup 读列表断言假设「OSS_PUBLIC_BASE_URL 未配 → regional 默认 host 派生」；
    // 本地 apps/server/.env 有真值会经 ...process.env 漏进来把 mockupUrl 派生到备案域 →
    // 断言红（2026-08-03 本地实证）。空串经 ossConfig 的 `|| undefined` 折叠 = 与 CI 等价。
    OSS_PUBLIC_BASE_URL: '',
    // 037 ideation mockup 交付: worker-token 端点鉴权 (WorkerAuthGuard)。未注入 → workerToken=null
    // → guard fail-closed 拒一切 → 037 contract-smoke 全 401。注入确定性占位让 worker 端点可达
    // (镜像 T008 IT 的 agentBridgeConfig.KEY override；nullable .default(null)、非 boot-required、
    // 不进 vitest/example/compose 9-位置)。
    AGENT_WORKER_TOKEN: WORKER_TOKEN,
    // CORS_ALLOWED_ORIGINS unset → '*'（宽松）so the :4173 web origin is allowed.
  };
  delete serverEnv.VITEST;

  console.log('[real-backend] prisma migrate deploy…');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: SERVER_DIR,
    env: serverEnv,
    stdio: 'inherit',
  });

  console.log('[real-backend] spawning server (node dist/main.js) on :3000…');
  const server = spawn('node', ['dist/main.js'], {
    cwd: SERVER_DIR,
    env: serverEnv,
    stdio: 'inherit',
  });
  live.server = server;
  server.on('exit', (code) => {
    if (code && code !== 0) console.error(`[real-backend] server exited early (${code})`);
  });

  // /healthz/ready exercises Prisma + Redis → 证后端全连通，不只是 Node 进程起来。
  await waitForReady(`${API}/healthz/ready`, 60_000);

  console.log('[real-backend] programmatic API login…');
  await postJson('/api/v1/accounts/sms-codes', { phone: PHONE });
  const auth = (await postJson('/api/v1/accounts/phone-sms-auth', {
    phone: PHONE,
    code: DEV_FIXED_CODE,
  })) as { accountId: string; accessToken: string; refreshToken: string };

  // PATCH /me 设 displayName（浏览器消费方需名字落 authed tabs，非 onboarding）。
  await patchJson('/api/v1/accounts/me', { displayName }, auth.accessToken);

  console.log(`[real-backend] login OK (accountId=${auth.accountId}).`);

  // 容器内 psql（local trust auth），ON_ERROR_STOP 让 SQL 错误以非零 exit 浮出。
  const execSql = async (sql: string): Promise<void> => {
    const res = await pg.exec([
      'psql',
      '-U',
      'smoke',
      '-d',
      'smoke',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ]);
    if (res.exitCode !== 0) {
      throw new Error(`psql failed (exit ${res.exitCode}): ${res.output}`);
    }
  };

  return {
    api: API,
    accountId: auth.accountId,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    displayName,
    workerToken: WORKER_TOKEN,
    postJson,
    patchJson,
    execSql,
    teardown,
  };
}
