import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * DeepSeek LLM config (027 T005, plan D7) — OpenAI 兼容流式 provider 凭证。
 *
 * key 仅存在于 server env (`DEEPSEEK_API_KEY`),永不入库 / 永不下发客户端 (FR-007)。
 * baseURL 固定 DeepSeek OpenAI 兼容端点;model 默认 `deepseek-chat` (027 单模型,
 * 可 env 覆盖)。镜像 jpush.config.ts 体例: registerAs + boot-time `.parse()` 兜底
 * (key 缺失在 boot 时报错而非首次调用)。
 *
 * ⚠️ boot healthy ≠ key 有效 (`.parse()` 只校验非空,不校验可用性);真连通在
 * T008 env-gated 真 IT (RUN_LLM_IT) 验证。
 */
const DeepseekConfigSchema = z.object({
  apiKey: z.string().min(1, 'DEEPSEEK_API_KEY required'),
  baseUrl: z.string().url(),
  model: z.string().min(1),
});

export type DeepseekConfig = z.infer<typeof DeepseekConfigSchema>;

export const deepseekConfig = registerAs('deepseek', (): DeepseekConfig => {
  return DeepseekConfigSchema.parse({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  });
});
