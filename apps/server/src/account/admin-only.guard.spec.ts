import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AdminOnlyGuard } from './admin-only.guard';
import type { AuthenticatedUser } from './jwt-auth.guard';

/**
 * 经 DI 容器取实例, **不 `new AdminOnlyGuard()`** —— `no-bad-mocks` 闸禁隔离实例化
 * lifecycle component (per ADR-0040 / PR-79 retro: 隔离 new 抹掉 lifecycle 顺序,
 * 当时漏掉了 CLS interceptor 的 Guards/Filters cascade bug)。
 *
 * ⚠️ 这里**不 import 整个 `AccountModule`**: 那会拖起 SecurityModule → PrismaService/ioredis,
 * 把一个零 DI、零 I/O 的判据变成需要容器与外部依赖的测试 (同「测 swagger metadata 用
 * controllers-only module、禁 full boot」的判据)。本 guard 无注入、无生命周期钩子 ⇒
 * 最小 providers 容器已经覆盖它全部的构造面。
 */
function ctx(user: AuthenticatedUser | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AdminOnlyGuard (072)', () => {
  let guard: AdminOnlyGuard;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ providers: [AdminOnlyGuard] }).compile();
    guard = moduleRef.get(AdminOnlyGuard);
  });

  it('isAdmin=true → 放行', () => {
    expect(guard.canActivate(ctx({ accountId: 42n, isAdmin: true }))).toBe(true);
  });

  it('isAdmin=false → 403 (不是 401 —— 端点存在与否不是秘密, 反枚举口径在这里不适用)', () => {
    expect(() => guard.canActivate(ctx({ accountId: 42n, isAdmin: false }))).toThrow(
      ForbiddenException,
    );
  });

  // 🚨 本文件存在的**主要理由**。判据若写成 `user && !user.isAdmin`,「本 guard 被挂到了没有
  //    JwtAuthGuard 的 controller 上」这种接线错误会**静默放行**给任何匿名请求 —— 而那是
  //    最该拒的情形。这条断言就是那发变异的靶子。
  it('request.user 缺失 → 403 fail-closed, MUST NOT 放行', () => {
    expect(() => guard.canActivate(ctx(undefined))).toThrow(ForbiddenException);
  });
});
