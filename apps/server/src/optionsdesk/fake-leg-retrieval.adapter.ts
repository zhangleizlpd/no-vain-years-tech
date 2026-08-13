import { recallCandidates, type RecallContext } from './leg-recall.rules';
import type {
  LegChainMeta,
  LegChainRow,
  LegRetrievalPort,
  LegRetrievalQuery,
  LegRetrievalResult,
} from './leg-retrieval.port';

/**
 * 052 检索 port 的**假实现** —— 内存链, 供召回判据脱离真库单测 (FR-032 / SC-009,
 * plan D-PORT-1「接缝的直接收益」)。体例沿 `fake-search.provider.ts` 等既有 fake。
 *
 * 🚨 **它假的是数据来源, 不是判据** —— 与 Prisma 实现共用 `leg-recall.rules.ts` 的层入口
 * {@link recallCandidates}。若这里自己写一份成员判定, 单测就变成「测我刚写的那份 mock」:
 * 断言照样绿, 而真实现改坏了没有任何一条会红。这正是本 fake 存在的**唯一**理由。
 *
 * 🚫 **MUST NOT 注册进 `OptionsdeskModule`** —— 它只服务测试。运行时的唯一实现是
 * `PrismaLegRetrievalAdapter`; ADR-0064 sunset #3 (规模突破阈值) 才是第二个实现的触发条件。
 *
 * 复杂度: 查种子 `O(1)` + 召回 `O(n)`。
 */
export class FakeLegRetrievalAdapter implements LegRetrievalPort {
  /**
   * @param chains 标的 → 一条链 (链级上下文 + 该链**全部**腿的裸行, 含会被门槛挡下的那些)。
   *   🚨 种子 MUST 给全量而非「已合格的那批」—— 否则两道门槛的排除计数恒为 0, 断言变平凡绿。
   *   未登记的标的 ⇒ `null` (链未就绪), 与「链在但候选为空」是两条分支。
   */
  constructor(private readonly chains: ReadonlyMap<string, FakeLegChain>) {}

  retrieveCandidates(query: LegRetrievalQuery): Promise<LegRetrievalResult | null> {
    const seeded = this.chains.get(query.symbol);
    if (seeded === undefined) return Promise.resolve(null);
    const context: RecallContext = { spot: seeded.chain.spot };
    const outcome = recallCandidates(
      context,
      query.perspectives,
      seeded.legs,
      query.candidateCap,
      query.override,
    );
    return Promise.resolve({
      chain: seeded.chain,
      ...outcome,
      // 053 FR-009: 与 Prisma 实现同一条落法 —— 对**同一批已在内存的腿**用「无覆盖」再判一次。
      // 语义与三条禁忌见 `LegRetrievalResult.memberCount`。
      memberCount:
        query.override === null
          ? outcome.candidates.length
          : recallCandidates(context, query.perspectives, seeded.legs, query.candidateCap)
              .candidates.length,
    });
  }
}

/** 一条种子链。`legs` 的 `dteDays` 由测试直接给 —— 假实现不接时钟 (钉住的是判据, 不是日历)。 */
export interface FakeLegChain {
  readonly chain: LegChainMeta;
  readonly legs: readonly LegChainRow[];
}
