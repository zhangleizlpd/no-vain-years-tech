import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * JPush (极光推送) gateway config — discriminated union so JPush credentials
 * are only required when `JPUSH_GATEWAY=jpush`. `mock` is the default for
 * dev/test (镜像 sms.config.ts 体例, 022 T002).
 *
 * Boot-time `.parse()` rejects partial config (e.g. appKey set but
 * masterSecret missing), surfacing misconfiguration before the first push.
 * Master Secret 仅存在于 server env — 永不入库 / 永不下发客户端 (FR-001)。
 */
const JpushConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mock') }),
  z.object({
    kind: z.literal('jpush'),
    appKey: z.string().min(1, 'JPUSH_APP_KEY required when JPUSH_GATEWAY=jpush'),
    masterSecret: z.string().min(1, 'JPUSH_MASTER_SECRET required when JPUSH_GATEWAY=jpush'),
  }),
]);

export type JpushConfig = z.infer<typeof JpushConfigSchema>;

export const jpushConfig = registerAs('jpush', (): JpushConfig => {
  const kind = process.env.JPUSH_GATEWAY ?? 'mock';
  if (kind === 'jpush') {
    return JpushConfigSchema.parse({
      kind,
      appKey: process.env.JPUSH_APP_KEY,
      masterSecret: process.env.JPUSH_MASTER_SECRET,
    });
  }
  return JpushConfigSchema.parse({ kind: 'mock' });
});
