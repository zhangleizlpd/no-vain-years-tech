import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * agent-bridge 通道层 worker token config (P1.2)。AGENT_WORKER_TOKEN = 远程常驻 agent
 * (OpenClaw worker) 出站轮询碰 agent-queue 端点的长期凭证 (≥256-bit, 经 SOPS 注入,
 * 可轮换)。这是「通道层」鉴权 (worker 有没有资格碰队列), 与事件内嵌的「拉取层」委托
 * token (能不能拿某条 bizId 数据, P1.3) 正交。
 *
 * **可选** (nullable): 未配 → null, app 正常 boot (dev/test 不轮询队列, 无需占位 —
 * 镜像 codeindex.config.ts 的 fake 默认, 避开 deepseek「mock 也要占位 key」坑),
 * WorkerAuthGuard fail-closed 拒一切请求 (镜像 code-index isAuthorized: expected 未设
 * 永不授权)。已配但 < 32 字符 → boot 时 .parse() 报错 (弱 token 早暴露, 同 sms/iqs 范式)。
 *
 * ⚠️ boot healthy ≠ token 已配 (.parse() 只在已配时校验长度); 仅 server env, 永不下发
 * 客户端。生产由 config gate (SOPS / B2) 保证已设。
 *
 * 生成: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
 */
const AgentBridgeConfigSchema = z.object({
  workerToken: z
    .string()
    .min(32, 'AGENT_WORKER_TOKEN 应 ≥256-bit (建议 randomBytes(32).toString(base64url) = 43 字符)')
    .nullable(),
});

export type AgentBridgeConfig = z.infer<typeof AgentBridgeConfigSchema>;

export const agentBridgeConfig = registerAs('agentBridge', (): AgentBridgeConfig => {
  const raw = process.env.AGENT_WORKER_TOKEN;
  return AgentBridgeConfigSchema.parse({ workerToken: raw && raw.length > 0 ? raw : null });
});
