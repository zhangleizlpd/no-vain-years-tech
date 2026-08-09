import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Aliyun OSS config — 009 profile image upload (per ADR-0045 + ADR-0037).
 *
 * All-or-nothing presence gate (mirrors sms.config's discriminated union):
 * dev/test boot with *no* OSS_* set → kind='unconfigured' (no creds required,
 * same spirit as SMS mock default). Once *any* OSS_* is set, all four become
 * required — boot-time `.parse()` rejects partial config, surfacing
 * misconfiguration before the first credential issuance.
 *
 * Credentials = Aliyun *account B* (`mbw-server-xt`), scoped to minimal
 * `oss:PutObject` on the `avatar/` + `background/` prefixes (per the OSS
 * provisioning runbook / ADR-0037). Secret is never logged; injected via
 * deploy env only. Note these are a *different* Aliyun account than the SMS
 * `ALIYUN_*` creds (account A) — the two coexist.
 */
const OssAliyunSchema = z.object({
  kind: z.literal('aliyun'),
  // Endpoint-form region incl. the `oss-` prefix, e.g. `oss-cn-shanghai`
  // (the host segment uses it verbatim; oss-policy strips the prefix for the
  // V4 signing scope's bare region — per the OSS PostObject V4 spec).
  region: z.string().min(1, 'OSS_REGION required when OSS is configured'),
  bucket: z.string().min(1, 'OSS_BUCKET required when OSS is configured'),
  accessKeyId: z.string().min(1, 'OSS_ACCESS_KEY_ID required when OSS is configured'),
  accessKeySecret: z.string().min(1, 'OSS_ACCESS_KEY_SECRET required when OSS is configured'),
  // Optional custom-domain display base, e.g. `https://img.shintongtech.com`.
  // When set, persisted avatar/background URLs use it instead of the default OSS
  // endpoint — bypasses Aliyun's 内地-bucket default-domain force-download
  // (`Content-Disposition: attachment`, breaks browser inline <img>). Unset →
  // fallback to `https://<bucket>.<region>.aliyuncs.com`. Requires the custom
  // domain be ICP-备案'd + bound to the bucket — see the OSS custom-domain runbook.
  publicBaseUrl: z.string().url().optional(),
});

const OssConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unconfigured') }),
  OssAliyunSchema,
]);

export type OssConfig = z.infer<typeof OssConfigSchema>;
export type OssAliyunConfig = z.infer<typeof OssAliyunSchema>;

export const ossConfig = registerAs('oss', (): OssConfig => {
  const region = process.env.OSS_REGION;
  const bucket = process.env.OSS_BUCKET;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  // Optional (empty → undefined so the Zod url() check is skipped, not failed).
  const publicBaseUrl = process.env.OSS_PUBLIC_BASE_URL || undefined;

  // All-or-nothing: every OSS_* empty/unset → unconfigured (dev/test default,
  // keeps boot green without OSS creds). Otherwise strict-parse the aliyun
  // variant so a *partial* config (e.g. bucket set, secret missing) throws.
  // publicBaseUrl is NOT part of the gate — it is an optional display override.
  if (!region && !bucket && !accessKeyId && !accessKeySecret) {
    return OssConfigSchema.parse({ kind: 'unconfigured' });
  }
  return OssConfigSchema.parse({
    kind: 'aliyun',
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    publicBaseUrl,
  });
});

/**
 * OSS public-read base URL (no trailing slash), used to compose the stored
 * avatarUrl/backgroundImageUrl and the confirm-step HEAD probe (public-read →
 * anonymous HEAD, no signing needed).
 *
 * - `publicBaseUrl` set → returned verbatim (trailing slashes stripped). This is
 *   the bound custom domain (e.g. `https://img.shintongtech.com`), which Aliyun
 *   does NOT force-download, so browsers render it inline.
 * - unset → fallback `https://<bucket>.<region>.aliyuncs.com` (endpoint-form
 *   region, e.g. `oss-cn-shanghai`). Note: on 内地 buckets this default domain
 *   force-downloads images — fine for the server HEAD probe, broken for browser
 *   <img>. Set publicBaseUrl in prod once the custom domain is bound.
 */
export function ossPublicBaseUrl(region: string, bucket: string, publicBaseUrl?: string): string {
  if (publicBaseUrl) return publicBaseUrl.replace(/\/+$/, '');
  return `https://${bucket}.${region}.aliyuncs.com`;
}
