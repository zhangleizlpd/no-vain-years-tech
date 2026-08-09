/**
 * 灵感会话状态机不变量 (032 T007, plan ③) —— 无状态纯常量 / 纯函数
 * (per ADR-0043 §2 贫血 + 纯函数, 无 DB / 无 LLM)。
 *
 * 状态域 (plan ③ 数据模型): `open | converged | handed-off`。状态机**非单向** ——
 * converged / handed-off 可重开回 open (reopen-session.usecase, conditional UPDATE)。
 * - `open`      —— 访谈进行中 (可继续澄清 / 生成 brief)。
 * - `converged` —— 已生成 brief (收敛产出)。
 * - `handed-off` —— 已导出交接 (粘进 /speckit-specify)。
 */

export const SESSION_STATUS_OPEN = 'open';
export const SESSION_STATUS_CONVERGED = 'converged';
export const SESSION_STATUS_HANDED_OFF = 'handed-off';

/** 全状态域 (DTO 校验 / 文档断言)。 */
export const SESSION_STATUSES = [
  SESSION_STATUS_OPEN,
  SESSION_STATUS_CONVERGED,
  SESSION_STATUS_HANDED_OFF,
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * 可回流 (reopen → open) 的前置状态集 (reopen conditional UPDATE 的 `status in` 谓词)。
 * 仅 converged / handed-off 可回流; open 已是目标态 (重开为幂等 no-op)。
 */
export const REOPENABLE_STATUSES = [SESSION_STATUS_CONVERGED, SESSION_STATUS_HANDED_OFF] as const;

/** 判定某状态是否可回流到 open (纯函数, O(1))。 */
export function isReopenable(status: string): boolean {
  return (REOPENABLE_STATUSES as readonly string[]).includes(status);
}
