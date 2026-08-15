import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { guestUploadConfig, type GuestUploadConfig } from '../config/index.js';
import { extractBearerToken, isGuestUploadAuthorized } from './guest-upload-auth.rules.js';

/**
 * guest 投递通道鉴权 guard（057）：校验请求是否确实经由隧道内的 guest-proxy 转发而来。
 * `Authorization: Bearer <GUEST_UPLOAD_TOKEN>` constant-time 比对，fail-closed
 * （token 未配 / 缺失 / 不符 → 401）。
 *
 * **平台层落点（security/，per ADR-0041）**：通道层鉴权与具体业务 ctx 无关，与
 * `WorkerAuthGuard` 同类同处；research ctx 单向 import 挂到自己的投递端点上。
 *
 * **零用户 principal**：不验 account、**不设 `request.user`**。投递方只有「往收集箱里放
 * 东西」这一个权限，没有任何用户 API 权限 —— 这正是刻意不给他系统账号 token 走
 * `JwtAuthGuard` 的原因：那是全站鉴权面，给他一个能过它的 token 等于把持仓 / 交易记录 /
 * 自选 / 期权锚 / chat 会话全部给他（plan D-3）。
 *
 * ⚠️ **本 guard 只回答「是不是那条代理转发来的」，不回答「是谁」**。投递方身份走 nginx
 * 无条件覆写的 `X-Guest` 头 —— 那个头**可信作归属、绝不可作授权**（它没有任何密码学保证，
 * 只是「代理覆写过」这一事实的记录）。两件事正交，别把它们合并。
 *
 * 失败一律裸 401（`UnauthorizedException`），不泄原因：token 未配与 token 不符对外**不可
 * 区分**（spec state_branch 11 / 12），否则这个端点就成了「凭证是否已配置」的探测器。
 */
@Injectable()
export class GuestUploadAuthGuard implements CanActivate {
  constructor(@Inject(guestUploadConfig.KEY) private readonly cfg: GuestUploadConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
    const presented = extractBearerToken(request.headers.authorization);
    if (!isGuestUploadAuthorized(presented, this.cfg.token)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
