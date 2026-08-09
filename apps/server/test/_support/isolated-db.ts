/**
 * server IT 的隔离库入口，按需选（都跑在 globalSetup 起的那一个共享 PG 容器上）：
 *
 * | 用哪个                      | 什么时候                                          |
 * | --------------------------- | ------------------------------------------------- |
 * | `setupIsolatedStores()`     | 要 PG 也要 Redis                                  |
 * | `setupIsolatedDb()`         | **只要 PG**（别用上面那个，会白起一个 Redis）     |
 * | `setupEmptyDb()`            | **自己要跑 `migrate deploy` 并验证其产物**        |
 * | 都不用——自起 RedisContainer | **只要 Redis、不要 PG**（三入口都会白克隆 PG 库） |
 *
 * 消费方**不止 `test/integration/`** —— `apps/server/src` 下的 `*.it.spec.ts` 也从这里取库。
 * 它们蓄意留在 `src` 而没搬进 `test/`（Narrow scope colocate，testing.md §3；`test/**` 已全量
 * 进 typecheck + lint，搬动是零收益 churn），`tsconfig.spec.json` 的 `rootDir` 为此提到 `.`
 * —— 不这么改，跨目录 import 直接 TS6059 + TS6307。
 */
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { RedisContainer } from '@testcontainers/redis';

export interface IsolatedDb {
  databaseUrl: string;
  drop: () => Promise<void>;
}

export interface IsolatedStores extends IsolatedDb {
  redisUrl: string;
}

/**
 * 🚨 admin 连接必须连**别的库**（这里用 `postgres`），绝不能连模板库本身。
 * PostgreSQL 的 `CREATE DATABASE … TEMPLATE` 要求源库没有其它活动会话，而如果每个
 * worker 都用「指向模板库的 URI」建 admin 连接，它们就各自持有一条到模板库的连接、
 * 互相等对方释放 —— **11 个 worker 全部卡死到 180s hook 超时**（2026-08-02 原型实测；
 * 单连接标定时不暴露，必须并发才看得见）。
 */
function adminUriFor(baseUri: string): string {
  const u = new URL(baseUri);
  u.pathname = '/postgres';
  return u.toString();
}

/**
 * 即便 admin 连接已避开模板库，并发 CREATE DATABASE 仍可能短暂撞上
 * `source database is being accessed by other users`（如上一个 worker 的连接尚未回收）。
 * 这不是错误状态、只是需要排队，故退避重试而非直接失败。
 */
async function createFromTemplate(admin: Client, dbName: string, template: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query(`CREATE DATABASE "${dbName}" TEMPLATE "${template}"`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('being accessed by other users') || attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 25 + attempt * 15));
    }
  }
}

function requireAdminUri(): string {
  const adminUri = process.env.POC_PG_ADMIN_URI;
  if (!adminUri) {
    throw new Error('[it] globalSetup 未跑 —— 缺 POC_PG_ADMIN_URI');
  }
  return adminUri;
}

async function dropDb(adminUri: string, dbName: string): Promise<void> {
  const c = new Client({ connectionString: adminUriFor(adminUri) });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

/**
 * 拿一个**空库**（不套模板），给「自己要跑 `prisma migrate deploy` 并验证其产物」的文件用。
 *
 * 🚨 这类文件（`*.schema.it.spec.ts`）**不能用 `setupIsolatedDb()`** —— 它们的 describe 标题就写着
 * `(Testcontainers PG migrate deploy)`，测的就是「migrate 之后表 / PK / 唯一约束是否正确」。
 * 给它们一个已迁移好的模板克隆，等于把被测对象整个抽掉。
 * 这里只省掉「起一个 PG 容器」那 2.3s，migrate 该跑照跑。
 */
export async function setupEmptyDb(): Promise<IsolatedDb> {
  const adminUri = requireAdminUri();
  const dbName = `poc_${randomUUID().replace(/-/g, '')}`;
  const admin = new Client({ connectionString: adminUriFor(adminUri) });
  await admin.connect();
  try {
    // 不带 TEMPLATE ⇒ 用 PG 默认的 template1（干净空库），migration 从零应用。
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const databaseUrl = new URL(adminUri);
  databaseUrl.pathname = `/${dbName}`;
  return { databaseUrl: databaseUrl.toString(), drop: () => dropDb(adminUri, dbName) };
}

/**
 * 只要一份隔离库、不要 Redis。
 *
 * ⚠️ **不需要 Redis 的文件必须用这个，别图省事用 `setupIsolatedStores()`** —— 后者会白起
 * 一个 Redis 容器。`test/integration/` 里有 54 个文件本来就只起 PG，给它们套上带 Redis 的
 * 版本等于凭空新增 54 个容器（约 7 秒 + Docker 争抢），是净退化。
 */
export async function setupIsolatedDb(): Promise<IsolatedDb> {
  const adminUri = requireAdminUri();
  const dbName = `poc_${randomUUID().replace(/-/g, '')}`;
  const admin = new Client({ connectionString: adminUriFor(adminUri) });
  await admin.connect();
  try {
    await createFromTemplate(admin, dbName, 'template_mbw');
  } finally {
    await admin.end();
  }

  const databaseUrl = new URL(adminUri);
  databaseUrl.pathname = `/${dbName}`;

  return { databaseUrl: databaseUrl.toString(), drop: () => dropDb(adminUri, dbName) };
}

export async function setupIsolatedStores(): Promise<IsolatedStores> {
  const db = await setupIsolatedDb();

  // 🚨 **Redis 不共享，每个文件仍起自己的容器** —— 这是本原型最重要的一条结论。
  //
  // 回看固定开销构成：PG 容器 2273ms + migrate 1204ms = 3477ms（大头），Redis 容器
  // 仅 127ms。共享 Redis 的收益是 102 文件 × 127ms ≈ 13 秒，**却带来了全部的隔离风险**：
  //   · 只分 db index → 跨文件状态残留（24/79 红）
  //   · 改用 VITEST_POOL_ID 分槽 + FLUSHDB → 仍 24/79 红
  //   · 单独跑同一个文件 13/13 全过 ⇒ 确认是跨文件串台而非转换错误
  // Redis 里有若干**非 db 作用域**的东西（pub/sub 通道全局、连接未随 app.close() 立刻
  // 释放的 BullMQ 轮询等），单靠 db index + FLUSHDB 隔不干净。
  // ⇒ 用 13 秒换掉整类隐蔽串台，不划算。共享只做在真正贵的那一侧（PG）。
  const redisContainer = await new RedisContainer('redis:7-alpine').start();

  return {
    databaseUrl: db.databaseUrl,
    redisUrl: redisContainer.getConnectionUrl(),
    drop: async () => {
      await redisContainer.stop();
      await db.drop();
    },
  };
}
