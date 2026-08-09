import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * MiniMax LLM config (029 收口, MiniMax M3 接入) — OpenAI 兼容流式 provider 凭证。
 *
 * key 仅存在于 server env (`MINIMAX_API_KEY`),永不入库 / 永不下发客户端 (FR-007 同款)。
 * baseURL 默认国内站 OpenAI 兼容端点 `https://api.minimaxi.com/v1` (与 sk 注册区域对齐;
 * 国际站换 `https://api.minimax.io/v1`, 经 `MINIMAX_BASE_URL` 覆盖)。镜像 deepseek.config.ts
 * 体例: registerAs + boot-time `.parse()` 兜底 (key 缺失在 boot 时报错而非首次调用)。
 *
 * ⚠️ baseURL 必须带 `/v1` (不同于 DeepSeek 的 `https://api.deepseek.com` 无 /v1) —— OpenAI
 * SDK 把 `/chat/completions` 直接拼到 baseURL 后。model id 是 provider 内常量 (`MiniMax-M3`),
 * 故本 config 无 `model` 字段 (不同于 deepseek 保留的 legacy model 字段)。
 *
 * ⚠️ boot healthy ≠ key 有效 (`.parse()` 只校验非空,不校验可用性 / 区域匹配);真连通需
 * 上线后真发一条 MiniMax 消息验证 (401 = host/key 区域不匹配)。
 */
const MinimaxConfigSchema = z.object({
  apiKey: z.string().min(1, 'MINIMAX_API_KEY required'),
  baseUrl: z.string().url(),
});

export type MinimaxConfig = z.infer<typeof MinimaxConfigSchema>;

export const minimaxConfig = registerAs('minimax', (): MinimaxConfig => {
  return MinimaxConfigSchema.parse({
    apiKey: process.env.MINIMAX_API_KEY,
    baseUrl: process.env.MINIMAX_BASE_URL ?? 'https://api.minimaxi.com/v1',
  });
});
