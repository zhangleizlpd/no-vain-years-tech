import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { isTransientDbError } from './transient-db-error.rules';

/**
 * `transient-db-error.rules.ts` 纯单测 (082 T015 amend 2026-09-14; plan D9 第 2 步)。
 *
 * 正例 = 2026-09-14 探针实测捕获的错误形态 (脱敏: 去掉调用栈与本机路径, 其余字段照抄); 形态清单见被测文件头。
 * 🚨 最重要的是 ①②③④: 它们**不带任何 P 码**, 只查 `code` 的实现会全部漏判, 连接一抖补齐就直接 `failed`。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1):
 *   改坏: 遍历循环里命中分支 `return true` 改为 `return false` (判据恒 false, 类型合法)
 *   结果 (2026-09-14 实跑, nx test 含 typecheck 过): 21 failed | 3 passed —— 红的恰是全部正例,
 *         绿的 3 条是反例 ⑬ ⑬b ⑭; 还原后 `cmp` 与备份逐字节相同, 24/24 绿
 *   复跑: pnpm nx test server src/optionsdesk/transient-db-error.rules.spec.ts --skip-nx-cache
 */

const CLIENT_VERSION = '7.8.0';

/** adapter 抛出的 `DriverAdapterError` 形态: `name` + `cause` 对象, 顶层无 `code`。 */
const driverAdapterError = (cause: Record<string, unknown>) =>
  Object.assign(new Error(String(cause.message ?? cause.kind)), {
    name: 'DriverAdapterError',
    cause,
  });

const knownRequestError = (code: string, cause: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`Invalid invocation (redacted)`, {
    code,
    clientVersion: CLIENT_VERSION,
    meta: { driverAdapterError: driverAdapterError(cause) },
  });

const ADMIN_SHUTDOWN = {
  originalCode: '57P01',
  originalMessage: 'terminating connection due to administrator command',
  kind: 'postgres',
  code: '57P01',
  severity: 'FATAL',
  message: 'terminating connection due to administrator command',
};

const plainError = (message: string, cause?: unknown) =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    clientVersion: CLIENT_VERSION,
  });

describe('isTransientDbError — 实测形态正例 (连接断开 / 超时 / 池超时 / 服务端关闭)', () => {
  it('① 交互事务内模型写被杀: DriverAdapterError, 顶层 code undefined, cause.code 57P01', () => {
    const err = driverAdapterError({
      kind: 'postgres',
      code: '57P01',
      message: ADMIN_SHUTDOWN.message,
    });
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(isTransientDbError(err)).toBe(true);
  });

  it('② 事务外模型写被杀: 裸 Error「Connection terminated unexpectedly」, 无 code', () => {
    expect(isTransientDbError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('③ 被杀后同一事务续查: 裸 Error「… is not queryable」', () => {
    expect(
      isTransientDbError(
        plainError('Client has encountered a connection error and is not queryable'),
      ),
    ).toBe(true);
  });

  it('④ 连接池取连接超时: 裸 Error「timeout exceeded when trying to connect」', () => {
    expect(isTransientDbError(plainError('timeout exceeded when trying to connect'))).toBe(true);
  });

  it('⑤ 建连超时: 外层消息 + cause 链', () => {
    expect(
      isTransientDbError(
        plainError(
          'Connection terminated due to connection timeout',
          new Error('Connection terminated unexpectedly'),
        ),
      ),
    ).toBe(true);
  });

  it('⑥ raw 查询被杀: P2010, 连接类信息只在 meta.driverAdapterError.cause', () => {
    expect(isTransientDbError(knownRequestError('P2010', ADMIN_SHUTDOWN))).toBe(true);
  });

  it('⑦ 连不上: P1001 + cause.kind DatabaseNotReachable', () => {
    expect(
      isTransientDbError(
        knownRequestError('P1001', { kind: 'DatabaseNotReachable', host: '127.0.0.1', port: 1 }),
      ),
    ).toBe(true);
  });

  it('⑧ 包在别的错误里 (cause 链第二层) 也认得', () => {
    expect(
      isTransientDbError(
        new Error('wrapped', { cause: new Error('Connection terminated unexpectedly') }),
      ),
    ).toBe(true);
  });
});

describe('isTransientDbError — 文档 / adapter 源码形态正例', () => {
  it.each(['P1002', 'P1008', 'P1017', 'P2024'])('⑨ Prisma 连接类错误码 %s', (code) => {
    expect(
      isTransientDbError(
        new Prisma.PrismaClientKnownRequestError('redacted', {
          code,
          clientVersion: CLIENT_VERSION,
        }),
      ),
    ).toBe(true);
  });

  it.each(['ConnectionClosed', 'SocketTimeout'])('⑩ adapter cause.kind %s', (kind) => {
    expect(isTransientDbError(driverAdapterError({ kind }))).toBe(true);
  });

  it.each(['08006', '08P01', '57P02', '57P03'])('⑪ SQLSTATE %s (08 类 / 57P0x)', (code) => {
    expect(isTransientDbError(driverAdapterError({ kind: 'postgres', code, message: 'x' }))).toBe(
      true,
    );
  });

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'])(
    '⑫ 未经 adapter 转换的 socket 错误 %s',
    (code) => {
      expect(
        isTransientDbError(
          Object.assign(new Error('socket'), { code, syscall: 'read', errno: -54 }),
        ),
      ).toBe(true);
    },
  );
});

describe('isTransientDbError — 反例 (仍归数据类)', () => {
  it('⑬ 模型写唯一冲突 P2002 (实测形态)', () => {
    expect(
      isTransientDbError(
        knownRequestError('P2002', {
          originalCode: '23505',
          originalMessage: 'duplicate key value violates unique constraint "uk_redacted"',
          kind: 'UniqueConstraintViolation',
          constraint: { fields: ['ticker'] },
        }),
      ),
    ).toBe(false);
  });

  it('⑬b raw 唯一冲突 P2010 + 23505 (实测形态)', () => {
    expect(
      isTransientDbError(
        knownRequestError('P2010', { originalCode: '23505', kind: 'UniqueConstraintViolation' }),
      ),
    ).toBe(false);
  });

  it('⑭ 普通业务错误 / 非对象 / 循环 cause 不误判且不挂', () => {
    const cyclic = new Error('loop') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isTransientDbError(new Error('boom'))).toBe(false);
    expect(isTransientDbError(cyclic)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError('Connection terminated unexpectedly')).toBe(false);
  });
});
