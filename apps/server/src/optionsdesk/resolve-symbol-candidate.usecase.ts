import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { parseAnchorTicker } from './anchor.rules';
import {
  CANDIDATE_STATUS,
  type CandidateStatus,
  type CodeSuggestion,
} from './symbol-candidate.rules';

/** 维护者视图的一行 (`candidates` 子命令)。 */
export interface SymbolCandidateView {
  id: bigint;
  ticker: string;
  signal: string;
  /** 空数组 = 「代码失效」(无新码建议, branch 22)。 */
  suggestions: CodeSuggestion[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  status: string;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  symbolChangeId: bigint | null;
}

export type DismissCandidateResult =
  | { status: 'dismissed' }
  | { status: 'not_found' }
  | { status: 'not_pending'; current: string };

/** `apply --from-candidate` 的参数推导结果。 */
export type CandidateRemediationTarget =
  | { status: 'ok'; market: string; oldCode: string; newCode: string }
  | {
      status: 'rejected';
      reason: 'not_found' | 'not_pending' | 'no_suggestion' | 'bad_ticker';
      message: string;
    };

export type ConfirmCandidateResult =
  | { status: 'confirmed' }
  | { status: 'already_confirmed' }
  | { status: 'not_found' }
  | { status: 'not_pending'; current: string };

/**
 * 疑似改名候选的处置 (086 T019, FR-019; plan D8; state_branches 22 / 23 / 24)。
 *
 * - `dismiss`: PENDING → DISMISSED 带备注 (之后同 ticker 不再生成候选, branch 24 由产生端保证);
 * - `targetOf`: 从候选推导修正参数 (market / 旧码取自候选; 新码 = 显式 `--new` ?? 建议第一名;
 *   「代码失效」且未给新码 ⇒ 拒绝, branch 22);
 * - `confirm`: 编排 apply 写入登记后由确认步骤调用, PENDING → CONFIRMED + 记登记 id。
 *
 * 状态翻转一律 conditional `updateMany(where status=PENDING)`: 并发处置时只有一路命中 (count=1),
 * 另一路看到 count=0 再读一次给出现状。🚨 不用 upsert —— 部分唯一索引 `(ticker) WHERE PENDING`
 * 在生成客户端里被当成全表复合唯一。
 */
@Injectable()
export class ResolveSymbolCandidateUseCase {
  constructor(private readonly prisma: PrismaService) {}

  /** 默认只列 PENDING; 传 `'all'` 列全部。按 id 升序。只读。 */
  async list(
    status: CandidateStatus | 'all' = CANDIDATE_STATUS.PENDING,
  ): Promise<SymbolCandidateView[]> {
    const rows = await this.prisma.symbolChangeCandidate.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => ({ ...r, suggestions: r.suggestions as unknown as CodeSuggestion[] }));
  }

  async get(id: bigint): Promise<SymbolCandidateView | null> {
    const r = await this.prisma.symbolChangeCandidate.findUnique({ where: { id } });
    return r === null ? null : { ...r, suggestions: r.suggestions as unknown as CodeSuggestion[] };
  }

  async dismiss(id: bigint, note: string, now: Date = new Date()): Promise<DismissCandidateResult> {
    const { count } = await this.prisma.symbolChangeCandidate.updateMany({
      where: { id, status: CANDIDATE_STATUS.PENDING },
      data: { status: CANDIDATE_STATUS.DISMISSED, resolvedAt: now, resolutionNote: note },
    });
    if (count === 1) return { status: 'dismissed' };
    const current = await this.get(id);
    return current === null
      ? { status: 'not_found' }
      : { status: 'not_pending', current: current.status };
  }

  /** 只读: 候选 → 修正参数。只接受 PENDING 候选 (已处置的不该再走一遍)。 */
  async targetOf(id: bigint, explicitNewCode?: string): Promise<CandidateRemediationTarget> {
    const c = await this.get(id);
    if (c === null)
      return { status: 'rejected', reason: 'not_found', message: `候选 #${id} 不存在` };
    if (c.status !== CANDIDATE_STATUS.PENDING) {
      return { status: 'rejected', reason: 'not_pending', message: `候选 #${id} 已是 ${c.status}` };
    }
    const parsed = parseAnchorTicker(c.ticker);
    if (parsed === null) {
      return {
        status: 'rejected',
        reason: 'bad_ticker',
        message: `候选 #${id} ticker 非法: ${c.ticker}`,
      };
    }
    const newCode = explicitNewCode ?? c.suggestions[0]?.code;
    if (newCode === undefined) {
      return {
        status: 'rejected',
        reason: 'no_suggestion',
        message: `候选 #${id} (${c.ticker}) 无新码建议 (代码失效), 须显式 --new <code>`,
      };
    }
    return { status: 'ok', market: parsed.market, oldCode: parsed.code, newCode };
  }

  /** PENDING → CONFIRMED 并记登记 id。已是 CONFIRMED 且指向同一登记 ⇒ 幂等。 */
  async confirm(
    id: bigint,
    symbolChangeId: bigint,
    now: Date = new Date(),
  ): Promise<ConfirmCandidateResult> {
    const { count } = await this.prisma.symbolChangeCandidate.updateMany({
      where: { id, status: CANDIDATE_STATUS.PENDING },
      data: { status: CANDIDATE_STATUS.CONFIRMED, resolvedAt: now, symbolChangeId },
    });
    if (count === 1) return { status: 'confirmed' };
    const current = await this.get(id);
    if (current === null) return { status: 'not_found' };
    if (
      current.status === CANDIDATE_STATUS.CONFIRMED &&
      current.symbolChangeId === symbolChangeId
    ) {
      return { status: 'already_confirmed' };
    }
    return { status: 'not_pending', current: current.status };
  }
}
