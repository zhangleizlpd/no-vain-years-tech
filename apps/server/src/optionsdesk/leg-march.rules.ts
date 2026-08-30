import { Prisma } from '../generated/prisma/client';
import { marchEvidence, type MarchAuditEntry, type NetChainNode } from './leg-fwd-chain.rules';
import { TIER_FLOORS_BY_BASIS, type LegTierWithFloor } from './leg-tier.rules';

/**
 * 069 optionsdesk **精排层**行军选档纯函数 (ADR-0068 决策 4, plan D1)。无 I/O、无 DI。
 * θ 相关层: 消费特征加工层 (`leg-fwd-chain.rules.ts`) 的净链, 产出每 K 三态判决。
 *
 * 🚨 **φ 禁新造数值** (FR-010 / ADR-0064 不变量 ③): φ = 收租年化档界**引用**
 * ({@link resolveMarchPhi} → `leg-tier.rules.ts` `TIER_FLOORS_BY_BASIS.annualized`),
 * 「可配置」= 选用哪个档界, 档界数值恰好一处不破。
 *
 * 🚨 **签名无财报入参** (FR-012 结构保证): 段内事件溢价灌在 fwd 里由行军自动伺服 ——
 * 拿不到那个维度就不可能对它特判, 想加必须先改签名, review 看得见。
 *
 * 🚨 **排序零改动** (FR-018): 本层产出是**行上叠加的判决标注**, 不触 `layeredRanker`、
 * 不重排行序 —— 接线点 (get-legs.usecase) 在排序旁路挂结果。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 行军参数 (FR-010 / plan D4; β/γ 入 check-optionsdesk-rule-constants 守卫表)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 形状条件的衰减比例帽 β (FR-006): 延伸要求每日衰减不回升 —— `δᵢ ≤ β × δᵢ₋₁`。
 *
 * ✅ **T011 实测标定值** (2026-08-30, dev 库 `2026-08-28` 收盘全量: 111 锚 / 319 条收租 K 梯 /
 * 净链相邻段衰减比值 48 个样本)。分布是**双模**: 正常延伸簇 ≤ 1.229 (37 个) 与回升尾
 * ≥ 1.714 (11 个), 取两模间隙 `[1.229, 1.714]` 的**中点 1.47** (距两侧各 ~0.24 —— 同
 * `QUALITY_CEILING_SPOT_RATIO` 那条「取中点防刀口」纪律)。
 * 📌 尾部比值最大 18.8×, 其成因是**基准段为亚 tick 噪声斜率时的除法放大** —— 生产形态下
 * 共线并段先行, 噪声基准大多已被并掉; 标定分布本身取自并段后的净链, 口径同生产。
 * 🚨 改值避开既有阈值/档界**子串**撞车 (守门脚本认值不认名): `1.47` 实测全 ctx 零命中。
 */
export const MARCH_DECAY_REBOUND_BETA = new Prisma.Decimal('1.47');

/**
 * 形状条件的绝对帽 γ (FR-006): 前段衰减 ≤ 0 (平/回升) 时比例帽无基准, 退化为
 * `δᵢ ≤ γ` (量纲: 年化费率 / 日历日)。
 *
 * ✅ **T011 定稿维持 `0.0022`, 并把「为什么标不动」写死在这里** (2026-08-30): 该分支在生产
 * 管道**结构上不可达** —— 凸包保证净链 fwd 严格递减 ⇒ 前段衰减恒 > 0 (回放 319 梯实证
 * 触发样本 = 0), 它是给手构链 / 未来 mid 口径重算留的防御值, 分布无从标定也无需标定。
 * 🚫 MUST NOT 因不可达而删除: 删掉后「前段 ≤ 0」输入直接除负数比例帽, 静默反向。
 */
export const MARCH_DECAY_ABSOLUTE_CAP_GAMMA = new Prisma.Decimal('0.0022');

/**
 * 停点可成交闸的收租 OI 口径下限 (FR-008)。张数, 整数。
 *
 * ✅ **T011 定稿维持 `50`** (2026-08-30, 同一数据面): 回放 70 个推荐停点的 OI 分布
 * p5=69 / p25=194 / p50=641, `< 50` 者 0 个 —— 取 50 落在观测下沿之下 (不误杀现役推荐),
 * 同时拦得住实抓的 `OI=1` 段尾档 (us:GDDY 90P 175d, 经段内回退落 140d/OI 192)。
 *
 * 📌 整数进不了守门脚本的阈值子串扫描 (同 `OPEN_INTEREST_FLOOR` 那条限制) —— 单点性靠
 * review 与本文件唯一导出守。🚨 它与召回层活性条件的 `OPEN_INTEREST_FLOOR`(=1) 是**两个
 * 判据**: 那条问「合约活着吗」(三视角一律), 本条问「停点档挂这一腿出得去吗」(仅收租行军)。
 */
export const RENT_MARCH_OI_MIN = 50;

/** 两个选档模式 (FR-011): φ=档界行军 (默认) / θ=自身年化 argmax (费率最大化备选)。 */
export const MARCH_MODES = ['phi', 'theta'] as const;

export type MarchMode = (typeof MARCH_MODES)[number];

/** 三态判决 (FR-009): 推荐档 / 无合格档 / 整梯无可成交 —— 后两者是诚实空态非错误。 */
export const MARCH_VERDICTS = ['recommended', 'no_qualified', 'untradable'] as const;

export type MarchVerdict = (typeof MARCH_VERDICTS)[number];

/**
 * φ 取值 = 收租年化档界引用 (FR-010)。`O(1)`。
 * 默认档界 `good` (0.15), 选用哪个档界走 server 配置 (T006 接线; UI 不暴露, clarify Q3)。
 */
export function resolveMarchPhi(tier: LegTierWithFloor): Prisma.Decimal {
  const band = TIER_FLOORS_BY_BASIS.annualized.find((b) => b.tier === tier);
  if (band === undefined) throw new Error(`unknown annualized tier: ${tier}`);
  return band.floor;
}

/** 一次行军的全部旋钮 —— φ 兼作档界终检下限 (同一档界旋钮的两个消费点)。 */
export interface MarchParams {
  readonly phi: Prisma.Decimal;
  readonly beta: Prisma.Decimal;
  readonly gamma: Prisma.Decimal;
  readonly oiMin: number;
  readonly mode: MarchMode;
}

/** 档界 + 模式 → 参数集 (β/γ/OI_MIN 单点取本文件常量)。`O(1)`。 */
export function resolveMarchParams(tier: LegTierWithFloor, mode: MarchMode): MarchParams {
  return {
    phi: resolveMarchPhi(tier),
    beta: MARCH_DECAY_REBOUND_BETA,
    gamma: MARCH_DECAY_ABSOLUTE_CAP_GAMMA,
    oiMin: RENT_MARCH_OI_MIN,
    mode,
  };
}

/** 每 K 判决 —— 净链上每个非推荐档在 `audits` 里**恰一条** (FR-014 的 B/C 家族半)。 */
export interface MarchDecision {
  readonly verdict: MarchVerdict;
  /** `verdict === 'recommended'` 时 = 推荐档 (段尾) DTE, 其余恒 null。 */
  readonly recommendedDteDays: number | null;
  readonly audits: readonly MarchAuditEntry[];
}

/**
 * 行军选档 (FR-006–FR-012)。`O(n)` (φ 模式) / `O(n log n)` (θ 模式排序)。
 *
 * φ 模式管道: 沿净链正序判延伸 (①水平 `fwd ≥ φ` ∧ ②形状 `δᵢ ≤ β·δᵢ₋₁`, 前段 ≤ 0 退化
 * `δᵢ ≤ γ`; δ = fwd 的每日衰减, i=1 无前段作基线不判形状) → 首违规**停截链尾** (🚫 禁中段
 * 剔除重连, FR-007; 停点之后的档留在审计里带原因) → 停点闸: 沿净链回退首个 `OI ≥ OI_MIN`
 * 的合格档 (`OI = null` 是「没采到」按不过闸处置; **行军起点不设闸**, FR-008 —— 短端 thin
 * 不误杀) → 档界终检 → 三态判决。净链空 ⇒ 整梯无可成交 (FR-009)。
 *
 * θ 模式 (FR-011): 同一副停点闸 + 终检骨架, 延伸判据换成年化 argmax —— 候选序 = 年化降序
 * (平手取更短档, 少锁期限), 判决 ≡ 年化 argmax (预言机恒等式, 同名 spec 三行锁死)。
 */
export function marchSelect(chain: readonly NetChainNode[], params: MarchParams): MarchDecision {
  if (chain.length === 0) {
    // 净链空 = 候选全被清链剔除 ⇒ 整梯无可成交 (FR-009); 成因逐档在清链家族条目里, 本层零条目。
    return { verdict: 'untradable', recommendedDteDays: null, audits: [] };
  }

  const audits: MarchAuditEntry[] = [];
  const entry = (
    node: NetChainNode,
    category: MarchAuditEntry['category'],
    evidence: Parameters<typeof marchEvidence>[0],
  ) => {
    audits.push({
      category,
      dteDays: node.dteDays,
      mergedIntoDteDays: null,
      evidence: marchEvidence(evidence),
    });
  };

  // ── 延伸判定: 候选序 = 停点闸的回退次序 (φ = 合格前缀最长优先 / θ = 年化降序) ──
  let candidateOrder: number[];
  if (params.mode === 'phi') {
    const violation = firstViolation(chain, params);
    const stop = violation?.index ?? chain.length;
    if (stop === 0) {
      // 链头首档即违规 ⇒ 无合格档 (FR-009); 行军起点不设 OI 闸 (FR-008) —— 这里连闸都不到。
      annotateFromStop(chain, violation!, params, entry);
      return { verdict: 'no_qualified', recommendedDteDays: null, audits };
    }
    if (violation !== null) annotateFromStop(chain, violation, params, entry);
    candidateOrder = [];
    for (let i = stop - 1; i >= 0; i -= 1) candidateOrder.push(i);
  } else {
    // θ 模式: 判决 ≡ 年化 argmax (FR-011 恒等式); 平手取更短档 (少锁期限), 序确定。
    candidateOrder = chain
      .map((_, i) => i)
      .sort(
        (a, b) =>
          chain[b].annualized.comparedTo(chain[a].annualized) ||
          chain[a].dteDays - chain[b].dteDays,
      );
  }

  // ── 停点闸 (FR-008): 沿候选序找首个过闸档; OI = null 是「没采到」按不过闸处置。
  // 合并段**段内回退** (T011 标定实抓 us:GDDY 90P): 共线成员费率等值 ⇒ 段尾不过闸时沿段内
  // 成员从长到短找首个过闸者作停点 —— 丢这半会让并段开关反转判决 (SC-002 无损性)。
  // 弃档逐**成员**记 #10 (FR-014 恰一条: 成员是真实档)。
  interface MemberGateFail {
    readonly nodeIndex: number;
    readonly dteDays: number;
    readonly oi: number | null;
  }
  const gateFailed: MemberGateFail[] = [];
  const failedNodes = new Set<number>();
  let winner: { readonly nodeIndex: number; readonly dteDays: number } | null = null;
  outer: for (const idx of candidateOrder) {
    const node = chain[idx];
    for (let m = node.memberDteDays.length - 1; m >= 0; m -= 1) {
      const oi = node.memberOpenInterest[m] ?? null;
      if (oi !== null && oi >= params.oiMin) {
        winner = { nodeIndex: idx, dteDays: node.memberDteDays[m] };
        break outer;
      }
      gateFailed.push({ nodeIndex: idx, dteDays: node.memberDteDays[m], oi });
    }
    failedNodes.add(idx);
  }

  const memberEntry = (
    fail: MemberGateFail,
    category: 'stop_oi_below_min' | 'ladder_oi_all_below_min',
  ) => {
    audits.push({
      category,
      dteDays: fail.dteDays,
      mergedIntoDteDays: null,
      evidence: marchEvidence({ oi: fail.oi, oiMin: params.oiMin }),
    });
  };

  if (winner === null) {
    // 整梯无过闸 ⇒ 整梯无可成交; 每个合格候选档恰一条 #11 (弹层双成因判别的 OI 半, clarify Q2)。
    for (const fail of gateFailed) memberEntry(fail, 'ladder_oi_all_below_min');
    sortAudits(audits);
    return { verdict: 'untradable', recommendedDteDays: null, audits };
  }

  // ── 档界终检 (FR-008 末道): φ 模式下合格档年化 = 各段 fwd 的时间加权 ≥ φ, 结构上恒过 ——
  // 本分支的现实作用面是 θ 模式 (argmax 也够不到档界 ⇒ 全链皆够不到)。
  if (chain[winner.nodeIndex].annualized.lessThan(params.phi)) {
    const failedDtes = new Set(gateFailed.map((f) => f.dteDays));
    for (const idx of candidateOrder) {
      if (failedNodes.has(idx)) continue;
      if (failedDtes.has(chain[idx].dteDays)) continue; // 段尾成员已记 #10, 不叠 #8 (恰一条)
      entry(chain[idx], 'tier_floor_failed', {
        annualized: chain[idx].annualized,
        tierFloor: params.phi,
      });
    }
    for (const fail of gateFailed) memberEntry(fail, 'stop_oi_below_min');
    sortAudits(audits);
    return { verdict: 'no_qualified', recommendedDteDays: null, audits };
  }

  // ── 判决 + 其余候选的条目: 回退弃档逐成员 #10, 未及停点的合格档 #9 ──
  for (const fail of gateFailed) memberEntry(fail, 'stop_oi_below_min');
  for (const idx of candidateOrder) {
    if (idx === winner.nodeIndex || failedNodes.has(idx)) continue;
    entry(chain[idx], 'qualified_not_stop', { recommendedDteDays: winner.dteDays });
  }
  sortAudits(audits);
  return { verdict: 'recommended', recommendedDteDays: winner.dteDays, audits };
}

/** 审计按 DTE 升序 —— 弹层逐档行的稳定次序。 */
function sortAudits(audits: MarchAuditEntry[]): void {
  audits.sort((a, b) => a.dteDays - b.dteDays);
}

interface MarchViolation {
  readonly index: number;
  readonly category: 'fwd_below_phi' | 'decay_rebound_above_beta' | 'decay_above_gamma_cap';
  readonly evidence: Partial<Parameters<typeof marchEvidence>[0]>;
}

/** fwd 进入第 i 档的每日衰减 δᵢ = (fwdᵢ₋₁ − fwdᵢ) / (Tᵢ − Tᵢ₋₁)。i ≥ 1。 */
function perDayDecay(chain: readonly NetChainNode[], i: number): Prisma.Decimal {
  return chain[i - 1].fwd.minus(chain[i].fwd).div(chain[i].dteDays - chain[i - 1].dteDays);
}

/**
 * 正序找首个延伸违规档 (FR-006): ①水平 fwd ≥ φ ②形状 δᵢ ≤ β·δᵢ₋₁ (δᵢ₋₁ ≤ 0 退化 δᵢ ≤ γ)。
 * 形状从 i ≥ 2 起判 —— δ₁ 是曲率基线, 无前段可比 (i=1 只判水平)。无违规 ⇒ null。
 */
function firstViolation(
  chain: readonly NetChainNode[],
  params: MarchParams,
): MarchViolation | null {
  for (let i = 0; i < chain.length; i += 1) {
    if (chain[i].fwd.lessThan(params.phi)) {
      return {
        index: i,
        category: 'fwd_below_phi',
        evidence: { fwd: chain[i].fwd, phi: params.phi },
      };
    }
    if (i < 2) continue;
    const decay = perDayDecay(chain, i);
    const previous = perDayDecay(chain, i - 1);
    if (previous.greaterThan(0)) {
      const cap = params.beta.times(previous);
      if (decay.greaterThan(cap)) {
        return {
          index: i,
          category: 'decay_rebound_above_beta',
          evidence: { decay, decayCap: cap },
        };
      }
    } else if (decay.greaterThan(params.gamma)) {
      return {
        index: i,
        category: 'decay_above_gamma_cap',
        evidence: { decay, decayCap: params.gamma },
      };
    }
  }
  return null;
}

/**
 * 停 = 截链尾 (FR-007): 违规档记自身类目; 停点之后的档不再逐档评延伸 (🚫 中段剔除重连),
 * 但**留在审计里带原因** —— 自身 fwd < φ 的记 #5 (净链 fwd 单调递减 ⇒ 这是常态), 否则
 * 继承截尾断口的类目与证据 (它被排除的原因就是路径在断口处断了)。
 */
function annotateFromStop(
  chain: readonly NetChainNode[],
  violation: MarchViolation,
  params: MarchParams,
  entry: (
    node: NetChainNode,
    category: MarchAuditEntry['category'],
    evidence: Parameters<typeof marchEvidence>[0],
  ) => void,
): void {
  entry(chain[violation.index], violation.category, violation.evidence);
  for (let j = violation.index + 1; j < chain.length; j += 1) {
    if (chain[j].fwd.lessThan(params.phi)) {
      entry(chain[j], 'fwd_below_phi', { fwd: chain[j].fwd, phi: params.phi });
    } else {
      entry(chain[j], violation.category, violation.evidence);
    }
  }
}
