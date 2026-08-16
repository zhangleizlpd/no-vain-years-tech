import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Type,
  UnauthorizedException,
  mixin,
} from '@nestjs/common';
import { guestUploadConfig, type GuestUploadConfig } from '../config/index.js';
import { extractBearerToken, isGuestUploadAuthorized } from './guest-upload-auth.rules.js';

/**
 * guest 通道鉴权 guard（057，059 参数化）：校验请求是否确实经由隧道内的 guest-proxy 转发
 * 而来。`Authorization: Bearer <token>` constant-time 比对，fail-closed（token 未配 / 缺失 /
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
 * 🚨 **「投递方只有『往收集箱里放东西』这一个权限」这句话自 059 起不再准确**（本注释随之
 * 订正 —— 注释与实际能力不符比没有注释更危险）：本 guard 现在守着**两把**语义不同的 token，
 * 其中 {@link GuestTokenKind} `anchorImport` 那把**能直接改业务数据**（写锚）。对**其他访客**
 * 而言「单向收集箱」性质原样成立：他们的请求在通道层被分流到提交端点，落待审表、锚表零变化
 * （059 plan Gate 0.4）。
 *
 * ⚠️ **本 guard 只回答「持的是不是这一把 token」，不回答「是谁」**。投递方身份走 nginx
 * 无条件覆写的 `X-Guest` 头 —— 那个头**可信作归属、绝不可作授权**（它没有任何密码学保证，
 * 只是「代理覆写过」这一事实的记录）。两件事正交，别把它们合并。
 *
 * 失败一律裸 401（`UnauthorizedException`），不泄原因：token 未配与 token 不符对外**不可
 * 区分**（059 state_branch 15 / 16），否则这个端点就成了「凭证是否已配置」的探测器。
 */

/** 认哪一把 token。**无默认值**是刻意的：抄漏 kind 会编译不过，而不是静默认成另一把。 */
export type GuestTokenKind = 'upload' | 'anchorImport';

const TOKEN_OF = {
  upload: (cfg: GuestUploadConfig) => cfg.token,
  anchorImport: (cfg: GuestUploadConfig) => cfg.anchorImportToken,
} as const satisfies Record<GuestTokenKind, (cfg: GuestUploadConfig) => string | null>;

/**
 * 用法：`@UseGuards(GuestUploadAuthGuard('upload'))`。
 *
 * 🚨 **参数化而不是复制第二份 guard**：constant-time 比对 / fail-closed / 零 user principal /
 * 裸 401 四条纪律只有一处实现，两个端点共享。复制一份的代价不是重复代码，是**两份会漂**。
 *
 * 每次调用产生一个独立的 mixin class（`mixin()` 给它唯一名字），故两个端点各自拿到自己的
 * guard 实例、各自认各自那把 token。
 */
export const GuestUploadAuthGuard = (kind: GuestTokenKind): Type<CanActivate> => {
  @Injectable()
  class GuestTokenGuard implements CanActivate {
    constructor(@Inject(guestUploadConfig.KEY) private readonly cfg: GuestUploadConfig) {}

    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<{ headers: { authorization?: string } }>();
      const presented = extractBearerToken(request.headers.authorization);
      if (!isGuestUploadAuthorized(presented, TOKEN_OF[kind](this.cfg))) {
        throw new UnauthorizedException();
      }
      return true;
    }
  }

  return mixin(GuestTokenGuard);
};
