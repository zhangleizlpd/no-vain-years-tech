import type { EnsureLatestEodBarUseCase } from '../../src/marketdata/ensure-latest-eod-bar.usecase';

/**
 * 建锚同步取价的 IT 替身 —— 恒返 `null`(= vendor 无数据)。
 *
 * IT **不打真 vendor**: 那会让测试依赖外部可达性与配额, 且断言随行情漂。该路径的三条分支
 * (取到价 / 无数据 / 抛错) 由 `create-anchor.usecase.spec.ts` 以 mock 逐条钉住; IT 这一层只
 * 需要保证「取价这一步不改变建锚本身的结果」—— 恒 `null` 正是其中最保守的那一档, 也让本文件
 * 里既有的 `last_close` 相关断言逐条保持原义。
 */
export function noEodSeed(): EnsureLatestEodBarUseCase {
  return { execute: async () => null } as unknown as EnsureLatestEodBarUseCase;
}
