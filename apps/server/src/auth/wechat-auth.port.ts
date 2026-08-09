/**
 * WechatAuthPort port (010 FR-S02/S09，镜像 SmsGateway 零-class port 范式)。
 *
 * seam（O2 已定）：client 发不透明 authCode，server 仅 `authCode → openid`
 * （AppSecret 留服务端）。Phase 1 = MockWechatAuthGateway（确定性假 openid，
 * web Playwright 全链覆盖）；Phase 2 = WechatAuthGateway（真实 native 授权 code
 * 调微信 API 换 openid/unionid，per FR-S09 + ADR-0037）。契约 phase-stable，
 * Phase 2 仅替换 adapter。生产 boot 拒 mock 由 auth.module env-gated factory 强制。
 *
 * 操作:
 * - resolveIdentity(authCode): 解析微信身份。返回 openid（绑定唯一性闸，FR-S01）
 *   + 可选 unionid（决策3：现在就存，nullable，不用于唯一性）。
 */
export const WECHAT_AUTH = Symbol('WECHAT_AUTH');

export interface WechatIdentity {
  openid: string;
  unionid?: string;
}

export interface WechatAuthPort {
  resolveIdentity(authCode: string): Promise<WechatIdentity>;
}
