import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * 研报归档 OSS config — 057 研报库 guest 投递 (per ADR-0065)。
 *
 * **刻意不并进 `oss.config.ts` 的 union**，虽然两者都是「阿里云 OSS 凭证」：
 * 它们是两个阿里云账号、两种 ACL、两种用途 —— `oss` 是账号 B 的 public-read 图片桶
 * (头像 / 背景 / 灵感附件, **客户端直传**); 本 config 是账号 C 的 **private** 桶, 只给
 * server 自己写 PDF, RAM 策略仅 `research/` 前缀的 `oss:PutObject` (Phase 0 已用反例
 * 实证: 写该前缀之外 → 403 AccessDenied)。挤进同一个 union 会让「哪把 AK 写哪个桶」
 * 变成运行时才发现的错, 而两把 AK 的权限交集是空的。
 *
 * All-or-nothing presence gate (镜像 `oss.config.ts`): 四个 `RESEARCH_OSS_*` 全空 →
 * `kind='unconfigured'` (dev/test 无凭证也能 boot); 任一非空 → 四个全必填, boot 时
 * `.parse()` 拒绝半配, 把配置错误提前到启动而非首次投递。
 *
 * `unconfigured` 不是故障态: 投递端点在该态下明确回「该能力未启用」(spec state_branch 9),
 * 而不是 500 —— 未接通存储与服务坏掉是两回事。
 *
 * ⚠️ 无 `publicBaseUrl` 对应物 (与 `oss.config.ts` 的差异): 私有桶零读取面, server 自己
 * 也不读 (RAM 只有 PutObject, per FR-018), 没有任何 URL 需要对外拼。
 */
const ResearchOssAliyunSchema = z.object({
  kind: z.literal('aliyun'),
  // Endpoint-form region incl. the `oss-` prefix, e.g. `oss-cn-shanghai`
  // (host 段逐字用它; oss-policy 在 V4 签名 scope 里自己剥前缀取 bare region)。
  region: z.string().min(1, 'RESEARCH_OSS_REGION required when research OSS is configured'),
  bucket: z.string().min(1, 'RESEARCH_OSS_BUCKET required when research OSS is configured'),
  accessKeyId: z
    .string()
    .min(1, 'RESEARCH_OSS_ACCESS_KEY_ID required when research OSS is configured'),
  accessKeySecret: z
    .string()
    .min(1, 'RESEARCH_OSS_ACCESS_KEY_SECRET required when research OSS is configured'),
});

const ResearchOssConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unconfigured') }),
  ResearchOssAliyunSchema,
]);

export type ResearchOssConfig = z.infer<typeof ResearchOssConfigSchema>;
export type ResearchOssAliyunConfig = z.infer<typeof ResearchOssAliyunSchema>;

export const researchOssConfig = registerAs('researchOss', (): ResearchOssConfig => {
  // 空串折叠: compose 的 `KEY: ${VAR:-}` 与 `.env*` 的 `KEY=""` 都产出**空串而非
  // undefined**, 不折叠则「四个全空 = unconfigured」这一闸在容器里永不成立, prod 未配
  // 研报存储时会 boot crash 而不是优雅降级 (范式同 sms.config.ts / agent-bridge.config.ts)。
  const region = process.env.RESEARCH_OSS_REGION || undefined;
  const bucket = process.env.RESEARCH_OSS_BUCKET || undefined;
  const accessKeyId = process.env.RESEARCH_OSS_ACCESS_KEY_ID || undefined;
  const accessKeySecret = process.env.RESEARCH_OSS_ACCESS_KEY_SECRET || undefined;

  if (!region && !bucket && !accessKeyId && !accessKeySecret) {
    return ResearchOssConfigSchema.parse({ kind: 'unconfigured' });
  }
  return ResearchOssConfigSchema.parse({
    kind: 'aliyun',
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
  });
});
