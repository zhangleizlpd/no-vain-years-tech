import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * ASR (语音转写) config (035 T002) — discriminated union so the DashScope API key is
 * only required when `ASR_PROVIDER=dashscope`. `fake` is the default for dev/test
 * (镜像 iqs/codeindex 体例：fake 分支无 cred → 全新 boot 无需任何 ASR/DASHSCOPE 占位即可起,
 * 避开 deepseek「mock 也要占位 key 否则崩」的坑)。
 *
 * 真转写由 `ASR_PROVIDER=dashscope` + `DASHSCOPE_API_KEY` 启用 (DashscopeAsrProvider 打
 * DashScope compatible-mode chat-completions 一次性文件识别, 北京区);IT/e2e/契约冒烟经
 * fake 走确定性 transcript (FakeAsrProvider, transcribe UC DI override)。
 *
 * Boot-time `.parse()` rejects partial dashscope config (key 缺失即报错),让误配置在 boot
 * 时暴露而非首次转写 (同 sms/iqs/codeindex 范式)。
 *
 * ⚠️ boot healthy ≠ key 有效 (`.parse()` 只校验非空)。key 仅 server env,经
 * `Authorization: Bearer` 注入,**永不下发客户端 (FR-014)、永不入日志**。
 */
const AsrConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fake') }),
  z.object({
    kind: z.literal('dashscope'),
    apiKey: z.string().min(1, 'DASHSCOPE_API_KEY required when ASR_PROVIDER=dashscope'),
  }),
]);

export type AsrConfig = z.infer<typeof AsrConfigSchema>;

export const asrConfig = registerAs('asr', (): AsrConfig => {
  const kind = process.env.ASR_PROVIDER ?? 'fake';
  if (kind === 'dashscope') {
    return AsrConfigSchema.parse({
      kind,
      apiKey: process.env.DASHSCOPE_API_KEY,
    });
  }
  return AsrConfigSchema.parse({ kind: 'fake' });
});
