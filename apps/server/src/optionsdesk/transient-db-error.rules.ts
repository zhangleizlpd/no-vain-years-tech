/**
 * 082 同步失败分类的 DB 半边 (2026-09-14 amend T015; plan D9 第 2 步): 数据库**连接断开 / 连接超时 /
 * 连接池超时 / 服务端关闭连接**判为基础设施失败 (可重试), 让补齐遇到一次连接抖动时走 24 h 内延迟重试,
 * 而不是直接 `failed`。约束冲突 (唯一键等) 与其它确定性 DB 错误不在此列, 仍按数据类处理。
 * amend 2 (同日): **连接数耗尽** (53300 / P2037) 与**事务写冲突** (40001 串行化失败 / 40P01 死锁 / P2034)
 * 同归基础设施; 语句超时 (57014) 与 Prisma 交互式事务超时 (P2028) 仍按数据类处理。
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
 *
 * EVIDENCE (amend 2): 2026-09-14 探针实测 (同上版本; `setupIsolatedDb` 隔离库, 另一 pg 客户端制造冲突):
 * - 事务内模型写 40001 (RR 并发更新 / Serializable 读写依赖, 均在写语句处报错) ⇒ `P2034`,
 *   `meta.driverAdapterError.cause = { kind: 'TransactionWriteConflict', originalCode: '40001' }` (无 `cause.code`);
 * - 交互事务 COMMIT 时 40001 (Serializable 写偏斜, 对方先提交) ⇒ 顶层 `DriverAdapterError` (`code` undefined, **无 P 码**),
 *   `cause = { kind: 'TransactionWriteConflict', originalCode: '40001' }`;
 * - raw 写 40001 ⇒ `P2010`, `meta.driverAdapterError.cause` 同上;
 * - 事务内模型写死锁 ⇒ 顶层 `DriverAdapterError` (`code` undefined), `cause = { kind: 'postgres', code: '40P01' }`;
 * - raw 写死锁 ⇒ `P2010`, `meta.driverAdapterError.cause.code = '40P01'`;
 * - 连接数耗尽 (角色 `CONNECTION LIMIT 1` 被占满) ⇒ 模型读 / 交互事务 / 批量事务 `P2037`, raw `P2010`,
 *   `meta.driverAdapterError.cause = { kind: 'TooManyConnections', originalCode: '53300' }`;
 * - 反例 语句超时 (事务内外同形态) ⇒ 顶层 `DriverAdapterError`, `cause = { kind: 'postgres', code: '57014' }`;
 *   交互式事务超时 ⇒ `P2028`, `meta = { operation: 'query', timeout, timeTaken }`, 无 `driverAdapterError`。
 * ASSUMED: `max_connections` 全局占满与角色上限报同一 SQLSTATE 53300 —— 未实测 (探针只占满了角色上限);
 * adapter 按 SQLSTATE 映射 (`mapDriverError` 的 `case "53300"`), 码相同则形态相同。若不同, 全局占满会落 `data`,
 * 补齐直接 `failed` 而不重试。
 */

/**
 * EVIDENCE: Prisma error reference (orm/v7/reference/error-reference): P1001 Can't reach database server /
 * P1002 reached but timed out / P1008 Operations timed out / P1017 Server has closed the connection /
 * P2024 Timed out fetching a new connection from the connection pool。
 * amend 2 EVIDENCE: `@prisma/client` 7.8.0 `runtime/client.js` 把 adapter kind `TransactionWriteConflict` ⇒ P2034
 * (「Transaction failed due to a write conflict or a deadlock」)、`TooManyConnections` ⇒ P2037
 * (「Too many database connections opened」); 探针实测见文件头。
 */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2034',
  'P2037',
]);

/**
 * `DriverAdapterError.cause.kind` 的连接类取值, 以及 adapter 把哪些 node socket 错误码映射过去。
 * EVIDENCE: `@prisma/adapter-pg` 7.8.0 `dist/index.js` `mapSocketError`: ENOTFOUND / ECONNREFUSED ⇒
 * DatabaseNotReachable, ECONNRESET ⇒ ConnectionClosed, ETIMEDOUT ⇒ SocketTimeout; client runtime 再映射为
 * P1001 / P1017 / P1008。
 * amend 2 EVIDENCE: 同文件 `mapDriverError`: `case "40001"` ⇒ TransactionWriteConflict, `case "53300"` ⇒
 * TooManyConnections; 40P01 无专属 kind, 落 `default` ⇒ `{ kind: 'postgres', code }`, 由 SQLSTATE 判据接住。
 */
const TRANSIENT_ADAPTER_KINDS: ReadonlySet<string> = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TransactionWriteConflict',
  'TooManyConnections',
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
 * amend 2: `53300` too_many_connections / `40001` serialization_failure / `40P01` deadlock_detected ——
 * EVIDENCE: 探针实测的 `originalCode` / `cause.code` 取值 (文件头)。🚫 不收 `57014` (语句超时, 维护者定为数据类)。
 */
const TRANSIENT_SQLSTATE = /^(08[0-9A-Z]{3}|57P0[123]|53300|40001|40P01)$/;

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
 * DB 连接 / 超时 / 连接数耗尽 / 事务写冲突类异常 ⇒ `true`。沿 `cause` 链与 `meta.driverAdapterError` 广度遍历,
 * 任一节点命中即是。复杂度 O(MAX_NODES) —— 常数。
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
