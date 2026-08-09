/**
 * chat 多轮上下文窗口不变量 —— 无状态纯函数 (per ADR-0043 §2 贫血 + 纯函数)。
 *
 * 发给 LLM 的历史上下文 = token 预算滑动窗口 (plan D4 / spec FR-004 / Clarify 2026-06-14):
 * 从最新轮往回累加估算 token,超 budget 丢最早轮次;不做摘要/压缩。纯函数,无 DB / 无 side effect。
 *
 * 入参取**最小必要形状** `{role, content}` —— 不耦合贫血 Prisma `message` row 整型
 * (后续 send-message UC 组的 `messages[]` 即用此形状喂 LlmProvider.stream)。
 */

/**
 * LLM wire-format 类型 (Msg / ToolCall) 058 (ADR-0058) 已上移至 integrations/llm 平台层 port
 * (chat / ideation 双消费方共享的「喂 LLM 的消息契约」)。chat 内部消费方 (send-message UC /
 * 本文件 buildContext / 各 spec) 仍按 `./chat-context.rules` import — 经此处复出保零改。
 */
export type { Msg, ToolCall } from '../integrations/llm/llm-provider.port.js';
import type { Msg } from '../integrations/llm/llm-provider.port.js';
import { msgText } from '../integrations/llm/llm-stream.rules.js';

/**
 * 字符启发式估 token (plan D4 明示): 中文 ~1.5 char/token 粗估,phase 1 **不引精确 tokenizer**。
 * 对中文是合理近似,对英文 (实际 ~4 char/token) 会高估 —— 高估即保守,宁可少塞历史不超模型上限,可接受。
 */
const CHARS_PER_TOKEN = 1.5;

/**
 * 上下文 token 预算默认值 (保守)。具体数值 = 配置常量,留 env 覆盖口子由调用方注入 budget 实现;
 * 本纯函数签名收 budget 作参数,不读 env。8192 ≈ deepseek-chat 输入侧保守取值,留足输出余量。
 */
export const DEFAULT_CONTEXT_BUDGET = 8192;

/** 估单条 content 的 token 数 (ceil,空串 → 0)。复杂度 O(n) n=字符数。 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

/**
 * 组多轮上下文: 从最新一条往回累加 token,累加和 <= budget 的纳入,超出则丢更早的;
 * 返回时恢复原时间序 (oldest→newest)。
 *
 * 边界:
 * - 空历史 → 空数组。
 * - 累加和恰等于 budget → 全纳入 (<= 含等号)。
 * - 即使最新一条单独就超 budget,仍至少保留它 (否则无可发送的消息)。
 *
 * 复杂度 O(n),n = history 长度 (单次反向遍历 + 一次 reverse)。
 */
export function buildContext(history: Msg[], budget: number): Msg[] {
  if (history.length === 0) return [];

  const kept: Msg[] = [];
  let used = 0;
  // 从最新 (末尾) 往回累加
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    // 036: content 可为多模态 MsgPart[],token 估算只计文本部分 (图不计 char-heuristic)。
    const cost = estimateTokens(msgText(msg.content));
    // 至少保留最新一条 (kept 空时无条件纳入,即便单条超 budget)。
    if (kept.length > 0 && used + cost > budget) break;
    kept.push(msg);
    used += cost;
  }
  return kept.reverse();
}
