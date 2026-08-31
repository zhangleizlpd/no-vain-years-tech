import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from './jwt-auth.guard';

/**
 * 072: 系统维护面 (锚待审箱审批等) 的准入闸。**必须挂在 `JwtAuthGuard` 之后** ——
 * 它读的是那个 guard 已经解析好的 `request.user`。
 *
 * **零 DI、零 I/O 是刻意的**: `JwtAuthGuard` 每请求已经 `findUnique` 了整行 Account,
 * 这里注 `PrismaService` 只会把同一行读第二遍。
 *
 * 🚨 **`user` 缺失时 fail-closed** —— 判据写成 `!user?.isAdmin` 而**不是**
 * `user && !user.isAdmin`。后者在「本 guard 被挂到了没有 JwtAuthGuard 的 controller 上」
 * 这种接线错误下会**静默放行**, 而那正是最该拒的情形 (谁都没被认证)。
 * `admin-only.guard.spec.ts` 专门打这一发变异。
 *
 * 🚨 **403 而不是 404**: `openapi.json` 是 tracked 产物、生成的客户端还要发进 App,
 * 端点存在与否本就不是秘密 ⇒ 401 那套反枚举口径 (per 001 US4) 在这里不适用。
 * 可区分的 403 才让客户端渲染得出「无审批权限」而不是一个说不清的错误页。
 *
 * 📌 **它只决定「能不能进这个面」, 不参与任何数据过滤** —— 锚域本就无 `account_id` 列,
 * 鉴权与归属在这里是正交的两件事 (同 `optionsdesk.controller.ts` 头注释的立论)。
 */
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!request.user?.isAdmin) {
      throw new ForbiddenException('ADMIN_ONLY');
    }
    return true;
  }
}
