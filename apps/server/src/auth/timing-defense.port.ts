/**
 * TimingDefenseExecutor port (FR-S06 反枚举 timing defense).
 *
 * 失败路径调用 `pad()` 计算 dummy BCrypt hash (cost=12, 5-15ms) 让响应时延与
 * 已注册 ACTIVE 成功 / 未注册自动注册成功 路径对齐, 避免攻击者通过 timing
 * 区分账号状态.
 *
 * 范围 (per spec FR-S06 + CL-006):
 * - ANONYMIZED + 正确码 → pad() 后 throw
 * - ACTIVE + 码错 → pad() 后 throw
 * - ACTIVE + 码过期 → pad() 后 throw
 * - 未注册 + 码错 → pad() 后 throw
 * - FROZEN → **NOT** pad(), disclosure 路径直接 throw AccountInFreezePeriodException
 *
 * Impl: BcryptTimingDefenseExecutor (bcrypt.compare with precomputed dummy hash).
 */
export const TIMING_DEFENSE_EXECUTOR = Symbol('TIMING_DEFENSE_EXECUTOR');

export interface TimingDefenseExecutor {
  pad(): Promise<void>;
}
