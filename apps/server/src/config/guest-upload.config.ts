import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * guest 投递通道 token config — 057 研报库 guest 投递 (FR-009 / FR-015)。
 *
 * `GUEST_UPLOAD_TOKEN` = guest-proxy (隧道内 nginx) 在转发时**无条件覆写**进
 * `Authorization: Bearer` 的常量 token。它是「通道层」凭证 —— 证明请求确实经由那条
 * 隧道代理而来, 与投递方是谁**正交**: 投递方身份走 nginx 同样无条件覆写的 `X-Guest`
 * 头 (可信作归属, 绝不可作授权)。投递方本人从不持有本 token, 也无从获知 (FR-015):
 * 他在隧道内打的是代理, 代理才持有它。
 *
 * **可选** (nullable): 未配 → null, app 正常 boot (dev/test 不跑 guest 通道), 而
 * `GuestUploadAuthGuard` fail-closed **拒一切请求** —— 未配 token 不等于放行, 等于
 * 关门 (镜像 agent-bridge.config.ts 的 workerToken + WorkerAuthGuard)。已配但 < 32
 * 字符 → boot 时 `.parse()` 报错, 弱 token 早暴露。
 *
 * ⚠️ boot healthy ≠ token 已配 (`.parse()` 只在已配时校验长度)。生产由 SOPS 注入,
 * 且**必须与 guest 机 `render-env.sh` 渲染进 nginx 的值逐字节一致** —— 两侧不一致的
 * 表现是恒 401, 而 401 按设计不泄露原因, 排障只能靠对账。
 *
 * 生成: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
 */
const GuestUploadConfigSchema = z.object({
  token: z
    .string()
    .min(32, 'GUEST_UPLOAD_TOKEN 应 ≥256-bit (建议 randomBytes(32).toString(base64url) = 43 字符)')
    .nullable(),
});

export type GuestUploadConfig = z.infer<typeof GuestUploadConfigSchema>;

export const guestUploadConfig = registerAs('guestUpload', (): GuestUploadConfig => {
  const raw = process.env.GUEST_UPLOAD_TOKEN;
  return GuestUploadConfigSchema.parse({ token: raw && raw.length > 0 ? raw : null });
});
