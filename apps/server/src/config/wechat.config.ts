import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * WeChat auth config — discriminated union so AppID/AppSecret are only
 * required when `WECHAT_GATEWAY=real`. `mock` is the default for dev/test
 * (Phase 1 stub adapter; mirrors `sms.config.ts`).
 *
 * Boot-time `.parse()` rejects partial real config (e.g. appId set but
 * appSecret missing), surfacing misconfiguration before the first auth-code
 * exchange. Production boot MUST reject `kind==='mock'` (enforced at the
 * auth.module env-gated factory, T011/T029) — this schema only guards the
 * credential shape.
 */
const WechatConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mock') }),
  z.object({
    kind: z.literal('real'),
    appId: z.string().min(1, 'WECHAT_APP_ID required when WECHAT_GATEWAY=real'),
    appSecret: z.string().min(1, 'WECHAT_APP_SECRET required when WECHAT_GATEWAY=real'),
  }),
]);

export type WechatConfig = z.infer<typeof WechatConfigSchema>;

export const wechatConfig = registerAs('wechat', (): WechatConfig => {
  const kind = process.env.WECHAT_GATEWAY ?? 'mock';
  if (kind === 'real') {
    return WechatConfigSchema.parse({
      kind,
      appId: process.env.WECHAT_APP_ID,
      appSecret: process.env.WECHAT_APP_SECRET,
    });
  }
  return WechatConfigSchema.parse({ kind: 'mock' });
});
