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
 * **一把 token 守三条 location**: 研报投递 / 锚待审提交 / **锚直写**。
 *
 * 🚨 **「直写锚要不要第二把 token」曾按两把实装过 (059 T003), 059 收口时回退成一把** ——
 * 后来者别照 ADR-0065 §4「通道与服务两层各自独立拒绝」的字面把它加回来, 先读完这段:
 *
 * - 两把**共命**: 同一个 SOPS blob → 同一台 guest 机的同一个 `/etc/nvy/nvy-guest-proxy.env`
 *   → 同一份渲染出来的 nginx conf。读得到其中一把的位置基本都读得到另一把。
 * - 而「绕过 nginx 直连 app loopback」这个第二把唯一防的位置, `docker-compose.guest.yml` 是
 *   `network_mode: host` ⇒ 恰恰就是那台 guest 机本机。攻击位置与密钥存放地重合。
 * - 剩下的边际价值只有两个窄场景: 同机上够得到 loopback 但读不到那个 env 的东西 (非特权
 *   进程 / 另一个容器), 以及本 token 的单独泄漏 (日志回显 / 误贴)。
 *
 * ⚠️ **由此接受的代价, 写明在这里而不是让人自己发现**: 直写锚的授权判据现在**只在通道层**
 * (nginx `/anchor-import` 的 `$anchor_write_allowed`, 按 `ANCHOR_OWNER_NAME` 分流)。服务端
 * 这一层对「直写」与「提交待审」**没有可判之据** —— 拿到本 token 且够得到 loopback 的人,
 * 能直写锚表。
 *
 * 🚨 **要开第二把 token, 门槛是先证明它与本把不共命** (另一台宿主 / 另一个 secret store /
 * 另一个渲染管道)。共命的第二把只是「看上去是两把」, 那比诚实的一把更坏。
 * 分法按**权限层**、不按端点数 —— 加多少条 guest location 都不改变这个数。
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

/** 空串与未设同义: compose 的 `${VAR:-}` 喂进来的是 `""` 而不是 undefined。 */
const orNull = (raw: string | undefined): string | null => (raw && raw.length > 0 ? raw : null);

export const guestUploadConfig = registerAs('guestUpload', (): GuestUploadConfig => {
  return GuestUploadConfigSchema.parse({
    token: orNull(process.env.GUEST_UPLOAD_TOKEN),
  });
});
