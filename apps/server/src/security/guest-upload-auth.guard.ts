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
 * guest 通道鉴权 guard（057）：校验请求是否确实经由隧道内的 guest-proxy 转发而来。
 * `Authorization: Bearer <token>` constant-time 比对，fail-closed（token 未配 / 缺失 /
 * 不符 → 401）。
 *
 * **平台层落点（security/，per ADR-0041）**：通道层鉴权与具体业务 ctx 无关，与
 * `WorkerAuthGuard` 同类同处；research / optionsdesk 单向 import 挂到自己的 guest 端点上。
 *
 * **零用户 principal**：不验 account、**不设 `request.user`**。经本 guard 的请求没有任何用户
 * API 权限 —— 这正是刻意不给投递方系统账号 token 走 `JwtAuthGuard` 的原因：那是全站鉴权面，
 * 给他一个能过它的 token 等于把持仓 / 交易记录 / 自选 / 期权锚 / chat 会话全部给他
 * （ADR-0065 plan D-3）。
 *
 * 🚨 **「过了本 guard 就只有『往收集箱里放东西』这一个权限」自 059 起不成立**（本注释随之
 * 订正 —— 注释与实际能力不符比没有注释更危险）：同一把 token 现在也守着 `anchors/model-import`，
 * 那个端点**直接改锚表**。谁能同时做到「持有本 token」+「够得到 app 的 loopback 端口」，谁就
 * 能直写锚 —— 服务端这一层**不再区分**直写与提交。分流判据只剩通道层 nginx 的
 * `$anchor_write_allowed`（按访客名）。为什么接受这个代价、以及要加回第二把 token 的门槛，
 * 单点写在 `config/guest-upload.config.ts` 顶部，别在这里重复。
 *
 * 对**其他访客**而言「单向收集箱」性质原样成立：他们的请求在通道层被 403 挡在直写口外、
 * 只能走提交端点，落待审表、锚表零变化（059 plan Gate 0.4）。
 *
 * 🚨 **「只写」这个词自本次起也不成立了**（同上，注释与实际能力不符比没有注释更危险）：同一把
 * token 现在还守着 `marketdata` 的两个**读**端点（标的枚举 / 批量基础信息）。它们不改任何数据，
 * 读的是上市公司公开元数据，但「过了本 guard 能做什么」的答案已经是**写三条 + 读两条**，不再是
 * 单一方向。要不要为读面另开一把 token 的判定（结论：不开）同样单点写在
 * `config/guest-upload.config.ts` 顶部。
 *
 * ⚠️ **本 guard 只回答「持的是不是这把 token」，不回答「是谁」**。投递方身份走 nginx
 * 无条件覆写的 `X-Guest` 头 —— 那个头**可信作归属、绝不可作授权**（它没有任何密码学保证，
 * 只是「代理覆写过」这一事实的记录）。两件事正交，别把它们合并。
 *
 * 失败一律裸 401（`UnauthorizedException`），不泄原因：token 未配与 token 不符对外**不可
 * 区分**（059 state_branch 15 / 16），否则这个端点就成了「凭证是否已配置」的探测器。
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
