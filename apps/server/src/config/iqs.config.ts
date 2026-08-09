import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * IQS (阿里云智能搜索) config — discriminated union so the API key is only required
 * when `IQS_PROVIDER=aliyun`. `mock` is the default for dev/test (030 plan D2).
 *
 * 镜像 sms.config.ts 体例。与 deepseek.config 不同:**mock 分支无 key** →
 * config 在 test/dev 下无需任何 IQS_* 占位即可 boot (避开 deepseek「mock 模式也要
 * 占位 key 否则 boot crash」的坑)。真检索由 `IQS_PROVIDER=aliyun` 启用、或 IT 经
 * `CHAT_FAKE_SEARCH=1` 绑 FakeSearchProvider (chat.module.ts DI)。
 *
 * Boot-time `.parse()` rejects partial aliyun config (apiKey 缺失即报错),
 * 让误配置在 boot 时暴露而非首次检索 (同 sms/deepseek 范式)。
 *
 * ⚠️ boot healthy ≠ key 有效 (`.parse()` 只校验非空);真连通在 T003 env-gated
 * 真 IT (RUN_IQS_IT) 验证 (plan D2 硬前置:HTTP 主路不通则切 SDK 回退)。
 */
const IqsConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mock') }),
  z.object({
    kind: z.literal('aliyun'),
    apiKey: z.string().min(1, 'IQS_API_KEY required when IQS_PROVIDER=aliyun'),
    baseUrl: z.string().url(),
  }),
]);

export type IqsConfig = z.infer<typeof IqsConfigSchema>;

export const iqsConfig = registerAs('iqs', (): IqsConfig => {
  const kind = process.env.IQS_PROVIDER ?? 'mock';
  if (kind === 'aliyun') {
    return IqsConfigSchema.parse({
      kind,
      apiKey: process.env.IQS_API_KEY,
      // IQS GenericSearch HTTP 端点 (X-API-Key 主路, plan D2);可 env 覆盖。
      baseUrl: process.env.IQS_BASE_URL ?? 'https://cloud-iqs.aliyuncs.com',
    });
  }
  return IqsConfigSchema.parse({ kind: 'mock' });
});
