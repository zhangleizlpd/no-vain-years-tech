import { PrismaService } from '../security/prisma.service.js';
import { anchoredCodesForScope } from './anchor-scoped-dimensions.rules.js';
import type { WorkingInstrument } from './dimension-executor.js';

/**
 * 锚作用域维度的工作集 = scope 内**有锚**的在市标的。排序与另一支路逐字相同
 * (`syncTier` asc → id asc), 换判据不换消费顺序。
 *
 * 079 T016 从 `dimension-executor.ts` 原样搬出: `SyncEarningsFiscalProfileUseCase` 调它, 而
 * `dimension-executor.ts` 要为 `hk_earnings_date` 注册 `SyncEarningsDatesUseCase` (后者依赖前者)
 * ⇒ 留在原处就成了 dimension-executor → sync-earnings-dates → sync-earnings-fiscal-profile →
 * dimension-executor 的运行期 import 环。本文件对 dimension-executor 只有 `import type` (编译期擦除)。
 *
 * 复杂度: 1 次锚表全量读 (只取 ticker 一列) + 1 次 `Instrument` 批查。
 */
export async function loadAnchoredInstruments(
  prisma: PrismaService,
  scope: string[],
): Promise<WorkingInstrument[]> {
  // CROSS-CONTEXT-READ: 只读 optionsdesk.anchor 全量 ticker (catalog Q7-B 只读逃生口,
  // ADR-0062 已记), 算 marketdata 自有的工作集。零写对方表、零 @Inject() 对方 use case
  // —— 与 `anchor-driven-sync-gate.ts` / `sync-option-contract.usecase.ts` 是**同一条**既有
  // 只读路径, 不开新口子 (护城河: NEVER 写 tx.<otherTable>.*)。
  const anchors = await prisma.anchor.findMany({ select: { ticker: true } });
  const byMarket = anchoredCodesForScope(
    anchors.map((a) => a.ticker),
    scope,
  );
  // 零锚 ⇒ 空工作集 (SC-002: 零对外请求且判定成功)。**必须提前返回** —— 空 `OR: []` 在
  // Prisma 里匹配全表, 那会把「零锚」翻成「全量采」, 且不会红。
  if (byMarket.size === 0) return [];

  return prisma.instrument.findMany({
    where: {
      status: 'active',
      OR: [...byMarket].map(([market, codes]) => ({ market, code: { in: codes } })),
    },
    select: { id: true, market: true, code: true },
    orderBy: [{ syncTier: 'asc' }, { id: 'asc' }],
  });
}
