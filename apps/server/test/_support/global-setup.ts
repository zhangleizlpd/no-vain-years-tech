/**
 * server IT 的共享 PG fixture（`vitest.config.ts` 的 `it` project globalSetup）。
 *
 * 改造前：每个起容器的 spec 各起一个 PG 容器 + 各自 shell 出去跑一遍 `prisma migrate deploy`
 * （重放 56 个 migration）。实测单文件固定开销 3477 ms，且并行时因抢 Docker 再放大 2.6×。
 *
 * 现在：整轮只起 **1 个 PG**（Redis 蓄意不共享，见下），migrate 只跑一次灌进 `template_mbw`；
 * 各文件用 `CREATE DATABASE … TEMPLATE`（实测 45 ms）拿到自己的隔离库。
 *
 * ⚠️ 本文件只挂在 `it` project 上。挂到 `unit` project（或直接挂 root）会让**每次单测单跑**
 * 都白起一个 PG —— 实测单测内环 0.58s → 约 4s。vitest 只为「本轮真有 spec 命中」的 project
 * 初始化 globalSetup，这条语义正是快速内环得以保留的原因，改 config 时别拆掉。
 *
 * `it` project 的成员判据是**文件名后缀 `.it.spec.ts`**，不是「住哪个目录」：T-1 之后
 * `src/**` 下 46 个起容器的 spec 也归 `it`（`unit` 因此是零容器的硬不变量，由
 * `scripts/checks/check-test-size.ts` 钉死）。
 *
 * globalSetup 在**主进程**跑、且早于 worker fork，故这里写的 process.env 会被 worker 继承。
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';

let pg: StartedPostgreSqlContainer;

export async function setup(): Promise<void> {
  const t0 = Date.now();

  pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('template_mbw')
    .withUsername('test')
    .withPassword('test')
    // PGDATA 放 tmpfs + 关掉三项持久化保证。测试容器一停数据就该没，**持久性在这里零价值**，
    // 而它换来的是全链路少一次 fsync：实测 globalSetup 3.36s → 1.78s、79 文件 wall 46.8s → 41s、
    // `tests` CPU 207.8s → 158.3s（CI 是 4 vCPU，CPU 这一维才是真约束）。
    // size=2g 是余量取值：实测峰值仅 ~148MB（克隆库在 afterAll 就 drop，同时存活数 ≈ worker 数）。
    .withTmpFs({ '/var/lib/postgresql/data': 'rw,size=2g' })
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'synchronous_commit=off',
    ])
    .start();
  const tPg = Date.now();

  const adminUri = pg.getConnectionUri();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: adminUri },
    stdio: 'ignore',
  });
  const tMigrate = Date.now();

  // worker 靠这个变量找到共享 PG；隔离库由 isolated-db.ts 按需从 template 克隆。
  // ⚠️ **只共享 PG，不共享 Redis** —— Redis 容器仅 127ms，共享它收益微乎其微却带来
  // 整类隐蔽的跨文件串台（详见 isolated-db.ts 的 🚨 段）。故此处不起 Redis。
  process.env.POC_PG_ADMIN_URI = adminUri;

  console.log(
    `[it globalSetup] pg=${tPg - t0}ms migrate=${tMigrate - tPg}ms ` +
      `total=${tMigrate - t0}ms（整轮只付一次，替代原来的每文件各付一次）`,
  );
}

export async function teardown(): Promise<void> {
  await pg?.stop();
}
