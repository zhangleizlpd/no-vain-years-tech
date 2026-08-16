import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * guest 投递通道 token config — 057 研报库 guest 投递 (FR-009 / FR-015) + 059 锚导入
 * (FR-010 / FR-015)。
 *
 * `GUEST_UPLOAD_TOKEN` = guest-proxy (隧道内 nginx) 在转发时**无条件覆写**进
 * `Authorization: Bearer` 的常量 token。它是「通道层」凭证 —— 证明请求确实经由那条
 * 隧道代理而来, 与投递方是谁**正交**: 投递方身份走 nginx 同样无条件覆写的 `X-Guest`
 * 头 (可信作归属, 绝不可作授权)。投递方本人从不持有本 token, 也无从获知 (FR-015):
 * 他在隧道内打的是代理, 代理才持有它。
 *
 * 🚨 **059 起是两把, 不是一把** (`ANCHOR_IMPORT_TOKEN` 给直写锚的导入口)。单把时整条授权闸的
 * **唯一支点是 nginx 配置** —— 服务端对「直写锚」与「往待审箱里放」两个端点无法区分, 谁绕过
 * 代理直连 app 的 loopback 端口就能直写锚。ADR-0065 §4 的原则是「通道与服务**两层各自独立**
 * 拒绝」, 单把 token 让第二层根本没有可判之据。成本仅一个 env var。
 * ⚠️ 两把 MUST 取不同值: 取同值等于回到单把, 而**看上去**是两把 (更坏)。
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
  /** 059: 直写锚导入口的第二把 token。未配 → 该端点 fail-closed 拒一切 (同上)。 */
  anchorImportToken: z
    .string()
    .min(32, 'ANCHOR_IMPORT_TOKEN 应 ≥256-bit (建议 randomBytes(32).toString(base64url) = 43 字符)')
    .nullable(),
});

export type GuestUploadConfig = z.infer<typeof GuestUploadConfigSchema>;

/** 空串与未设同义: compose 的 `${VAR:-}` 喂进来的是 `""` 而不是 undefined。 */
const orNull = (raw: string | undefined): string | null => (raw && raw.length > 0 ? raw : null);

export const guestUploadConfig = registerAs('guestUpload', (): GuestUploadConfig => {
  return GuestUploadConfigSchema.parse({
    token: orNull(process.env.GUEST_UPLOAD_TOKEN),
    anchorImportToken: orNull(process.env.ANCHOR_IMPORT_TOKEN),
  });
});
