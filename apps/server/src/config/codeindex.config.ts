import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * code-index client config (034 T001) — discriminated union so the service URL +
 * token are only required when `CODE_INDEX_PROVIDER=http`. `fake` is the default
 * for dev/test (镜像 iqs.config.ts 体例：mock/fake 分支无 cred → 全新 boot 无需任何
 * CODE_INDEX_* 占位即可起，避开 deepseek「mock 也要占位 key 否则崩」的坑)。
 *
 * 真检索由 `CODE_INDEX_PROVIDER=http` + `CODE_INDEX_URL`/`CODE_INDEX_SERVICE_TOKEN`
 * 启用 (HttpCodeIndexProvider 打 services/code-index)；IT/契约冒烟经 fake 走确定性命中
 * (FakeCodeIndexProvider，code-index.module.ts DI)。
 *
 * Boot-time `.parse()` rejects partial http config (url 缺失即报错)，让误配置在 boot
 * 时暴露而非首次检索 (同 sms/iqs 范式)。
 *
 * ⚠️ boot healthy ≠ token 有效 (`.parse()` 只校验非空 + URL 形态)；真连通在 T007
 * env-gated 真 IT (RUN_CODEINDEX_IT) 验证。token 仅 server env，永不下发客户端。
 */
const CodeIndexConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fake') }),
  z.object({
    kind: z.literal('http'),
    baseUrl: z.string().url('CODE_INDEX_URL must be a valid URL when CODE_INDEX_PROVIDER=http'),
    serviceToken: z
      .string()
      .min(1, 'CODE_INDEX_SERVICE_TOKEN required when CODE_INDEX_PROVIDER=http'),
  }),
]);

export type CodeIndexConfig = z.infer<typeof CodeIndexConfigSchema>;

export const codeIndexConfig = registerAs('codeIndex', (): CodeIndexConfig => {
  const kind = process.env.CODE_INDEX_PROVIDER ?? 'fake';
  if (kind === 'http') {
    return CodeIndexConfigSchema.parse({
      kind,
      baseUrl: process.env.CODE_INDEX_URL,
      serviceToken: process.env.CODE_INDEX_SERVICE_TOKEN,
    });
  }
  return CodeIndexConfigSchema.parse({ kind: 'fake' });
});
