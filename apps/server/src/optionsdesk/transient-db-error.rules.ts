/**
 * 082 同步失败分类的 DB 半边 (2026-09-14 amend T015; plan D9 第 2 步): 数据库**连接断开 / 连接超时 /
 * 连接池超时 / 服务端关闭连接**判为基础设施失败 (可重试), 让补齐遇到一次连接抖动时走 24 h 内延迟重试,
 * 而不是直接 `failed`。约束冲突 (唯一键等) 与其它确定性 DB 错误不在此列, 仍按数据类处理。
 *
 * 🚨 **不能只看 Prisma 错误码**。Prisma 7 + `@prisma/adapter-pg` 下同一类「连接被杀」有多种形态,
 * 大半不带 P 码, 甚至不带任何 `code`。EVIDENCE: 2026-09-14 探针实测 (PG 16.13, prisma / adapter-pg
 * 7.8.0, pg 8.20.0; 另一客户端 `pg_terminate_backend` 杀 Prisma 连接):
 * - 交互事务内模型写被杀 ⇒ 顶层 `DriverAdapterError` (`code` undefined), `cause = { kind: 'postgres', code: '57P01' }`;
 * - 事务外模型写被杀 ⇒ 裸 `Error('Connection terminated unexpectedly')`, 无 `code`;
 * - 同一事务被杀后续查 ⇒ 裸 `Error('Client has encountered a connection error and is not queryable')`;
 * - 连接池取连接超时 ⇒ 裸 `Error('timeout exceeded when trying to connect')`;
 * - 建连超时 ⇒ 裸 `Error('Connection terminated due to connection timeout')`;
 * - raw 查询被杀 ⇒ `PrismaClientKnownRequestError` `P2010`, `meta.driverAdapterError.cause.code = '57P01'`;
 * - 连不上 ⇒ `P1001`, `meta.driverAdapterError.cause.kind = 'DatabaseNotReachable'`;
 * - 反例 唯一冲突 ⇒ `P2002` (raw 为 `P2010`), `meta.driverAdapterError.cause = { kind: 'UniqueConstraintViolation', originalCode: '23505' }`。
 */

/**
 * EVIDENCE: Prisma error reference (orm/v7/reference/error-reference): P1001 Can't reach database server /
 * P1002 reached but timed out / P1008 Operations timed out / P1017 Server has closed the connection /
 * P2024 Timed out fetching a new connection from the connection pool。
 */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
]);

/**
 * `DriverAdapterError.cause.kind` 的连接类取值, 以及 adapter 把哪些 node socket 错误码映射过去。
 * EVIDENCE: `@prisma/adapter-pg` 7.8.0 `dist/index.js` `mapSocketError`: ENOTFOUND / ECONNREFUSED ⇒
 * DatabaseNotReachable, ECONNRESET ⇒ ConnectionClosed, ETIMEDOUT ⇒ SocketTimeout; client runtime 再映射为
 * P1001 / P1017 / P1008。
 */
const TRANSIENT_ADAPTER_KINDS: ReadonlySet<string> = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
]);
const TRANSIENT_SOCKET_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

/**
 * 服务端以 SQLSTATE 报的连接类错误: 整个 `08` 类 (connection_exception) + `57P01` admin_shutdown /
 * `57P02` crash_shutdown / `57P03` cannot_connect_now。EVIDENCE: 2026-09-14 在 PG 16.13 上用 plpgsql
 * 条件名实测 (`RAISE SQLSTATE '08006'` 被 `connection_exception` 捕获; 57P01/02/03 分别被上述条件名捕获);
 * 探针观测 `pg_terminate_backend` ⇒ `57P01`。
 */
const TRANSIENT_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[123])$/;

/**
 * 不带任何 code 的连接类错误, 按消息**全等**匹配。EVIDENCE: pg 8.20.0 `lib/client.js:180` / `:678`,
 * pg-pool 3.13.0 `index.js:224` / `:276`。🚫 不收 `'Connection terminated'` 与 `'Client was closed and is
 * not queryable'`: 那是本进程主动 `end()` (关停), 不是连接抖动。
 */
const TRANSIENT_DRIVER_MESSAGES: ReadonlySet<string> = new Set([
  'Connection terminated unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
]);

/** 沿 `cause` / `meta.driverAdapterError` 最多看这么多个节点 (防环 + 防病态长链)。 */
const MAX_NODES = 8;

/**
 * DB 连接 / 超时类异常 ⇒ `true`。沿 `cause` 链与 `meta.driverAdapterError` 广度遍历, 任一节点命中即是。
 * 复杂度 O(MAX_NODES) —— 常数。
 */
export function isTransientDbError(err: unknown): boolean {
  const queue: unknown[] = [err];
  const seen = new Set<object>();
  while (queue.length > 0 && seen.size < MAX_NODES) {
    const node = queue.shift();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const fields = node as Record<string, unknown>;
    if (isTransientNode(fields)) return true;
    queue.push(fields.cause);
    const meta = fields.meta;
    if (meta !== null && typeof meta === 'object') {
      queue.push((meta as Record<string, unknown>).driverAdapterError);
    }
  }
  return false;
}

function isTransientNode({ code, originalCode, kind, message }: Record<string, unknown>): boolean {
  if (typeof code === 'string') {
    if (TRANSIENT_PRISMA_CODES.has(code) || TRANSIENT_SOCKET_CODES.has(code)) return true;
    if (TRANSIENT_SQLSTATE.test(code)) return true;
  }
  if (typeof originalCode === 'string' && TRANSIENT_SQLSTATE.test(originalCode)) return true;
  if (typeof kind === 'string' && TRANSIENT_ADAPTER_KINDS.has(kind)) return true;
  return typeof message === 'string' && TRANSIENT_DRIVER_MESSAGES.has(message);
}
