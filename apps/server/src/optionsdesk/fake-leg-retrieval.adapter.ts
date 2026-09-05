import { crossedQuoteDisposalOf, recallCandidates, type RecallContext } from './leg-recall.rules';
import type {
  ChainAbsenceReason,
  LegChainMeta,
  LegChainQuery,
  LegChainRow,
  LegChainSnapshot,
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
 * 📌 **064 起 `query.realtime` 在这里被有意忽略**: 假实现回放的是种子, 而实时覆盖是 Prisma
 * 实现对**外部行情源**的一次调用 —— 在这里模拟它就等于「测我刚写的那份 mock」。档位由种子的
 * `priceKind` 直接给, 想验哪一档就种哪一档; 覆盖本身的正确性归 `optionsdesk-064.overlay.it.spec.ts`
 * (真 adapter + 真库 + 被 override 的读取口)。
 *
 * 复杂度: 查种子 `O(1)` + 召回 `O(n)`。
 */
export class FakeLegRetrievalAdapter implements LegRetrievalPort {
  /**
   * @param chains 标的 → 一条链 (链级上下文 + 该链**全部**腿的裸行, 含会被门槛挡下的那些)。
   *   🚨 种子 MUST 给全量而非「已合格的那批」—— 否则两道门槛的排除计数恒为 0, 断言变平凡绿。
   *   未登记的标的 ⇒ `null` (链未就绪), 与「链在但候选为空」是两条分支。
   */
  /**
   * @param noListedOptions 这些标的的「链未就绪」成因是 **`no_listed_options`** (#361) ——
   *   即交易所根本没给它挂期权。未列入的标的一律 `not_ready`。
   *   🚨 **蓄意与 `chains` 分成两个入参而不是在种子里加一个字段**: 本成因只在链**不在**
   *   `chains` 里时才有意义, 塞进 `FakeLegChain` 会造出「链在、却说它没有挂牌期权」这种
   *   构造得出来但现实里不存在的组合, 而测试会照样绿。
   */
  constructor(
    private readonly chains: ReadonlyMap<string, FakeLegChain>,
    private readonly noListedOptions: ReadonlySet<string> = new Set(),
  ) {}

  /**
   * 链缺席的成因 (#361)。🚨 **种子里有链就恒 `not_ready`** —— 与真实现同向: 那边一旦合约计数
   * 非 0 就直接返 `not_ready`, 轮不到问链发现。
   */
  chainAbsenceReason(query: LegChainQuery): Promise<ChainAbsenceReason> {
    if (this.chains.has(query.symbol)) return Promise.resolve('not_ready');
    return Promise.resolve(
      this.noListedOptions.has(query.symbol) ? 'no_listed_options' : 'not_ready',
    );
  }

  /** 整条链 —— 种子原样回放。判据一条不跑, 与 Prisma 实现同形 (那边也只是不喂进召回)。 */
  retrieveChain(query: LegChainQuery): Promise<LegChainSnapshot | null> {
    const seeded = this.chains.get(query.symbol);
    return Promise.resolve(
      seeded === undefined ? null : { chain: seeded.chain, legs: seeded.legs },
    );
  }

  retrieveCandidates(query: LegRetrievalQuery): Promise<LegRetrievalResult | null> {
    const seeded = this.chains.get(query.symbol);
    if (seeded === undefined) return Promise.resolve(null);
    const context: RecallContext = { spot: seeded.chain.spot, w: seeded.w };
    // 070 剔→标: 与 Prisma 实现同一条映射 —— 处置由**种子链的口径**说了算 (想验哪种处置就
    // 种哪一档), 🚫 MUST NOT 在这里写死: 那会让假实现驱动的判据测永远测不到 retain 分支。
    const disposal = crossedQuoteDisposalOf(seeded.chain.priceKind);
    const outcome = recallCandidates(
      context,
      query.perspectives,
      seeded.legs,
      query.candidateCap,
      disposal,
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
          : recallCandidates(context, query.perspectives, seeded.legs, query.candidateCap, disposal)
              .candidates.length,
    });
  }
}

/** 一条种子链。`legs` 的 `dteDays` 由测试直接给 —— 假实现不接时钟 (钉住的是判据, 不是日历)。 */
export interface FakeLegChain {
  readonly chain: LegChainMeta;
  /**
   * 愿买价 W (067) —— 测试面**显式给数** (真实现经 anchor 点查走 `resolveEffectiveAnchorValues`
   * + `computeW` 单点派生; 假实现不接库, 在这里模拟那次点查就是「测我刚写的那份 mock」)。
   */
  readonly w: RecallContext['w'];
  readonly legs: readonly LegChainRow[];
}
