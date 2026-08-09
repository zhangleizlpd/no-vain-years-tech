/**
 * Brief 收敛门 —— 无状态纯函数 (per ADR-0043 §2 贫血 + 纯函数，无 DB / 无 LLM)。
 *
 * 收敛判据 (D5 / FR-011 / SC-007 / 契约 doc §3.4)：**只查 T1 五段齐**。
 * 🚨 **绝不含 T2 接地段** —— 否则 B1 standalone / 无 repo 脑暴会话永远收敛不了
 * (接地 stub 期 T2 留空也必须能收敛)。T3 可选段同样不参与收敛。
 *
 * 「齐」= T1 五段每段都是 trim 后非空 string。生成 brief 相 (T009 generate-brief.usecase)
 * 在 zod 校验后调 `isConverged`：齐→落 requirements_draft + session converged；
 * 缺→返缺失段列表，回「继续追问缺失段」信号。
 */
import { T1_SEGMENT_KEYS, type T1SegmentKey } from './brief.schema';

/** `isConverged` 结果：是否收敛 + 缺失的 T1 段 key 列表 (齐时 `missing` 为空数组)。 */
export interface ConvergenceResult {
  converged: boolean;
  /** 缺失 (不存在 / 非 string / trim 后为空) 的 T1 段 key，按 `T1_SEGMENT_KEYS` 顺序。 */
  missing: T1SegmentKey[];
}

/**
 * 判定 brief 是否收敛 —— 只检查 T1 五段是否齐 (非空 string)。
 *
 * 入参 `briefJson` 为**未校验**的任意对象 (落库 JSON / 模型 emit 产物)，故不依赖
 * zod 解析后类型：逐段做 runtime null/类型/空白校验，缺一段即记入 `missing`。
 * T2 / T3 段无论填没填都**不影响**结果 (门只看 T1)。
 *
 * 复杂度 O(k)，k = T1 段数 (常量 5)。
 */
export function isConverged(briefJson: unknown): ConvergenceResult {
  const obj =
    briefJson !== null && typeof briefJson === 'object'
      ? (briefJson as Record<string, unknown>)
      : {};

  const missing = T1_SEGMENT_KEYS.filter((key) => {
    const value = obj[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  return { converged: missing.length === 0, missing };
}
