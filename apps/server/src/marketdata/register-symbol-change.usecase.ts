import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../security/prisma.service.js';
import { exchangeCalendarDate } from './session-clock.js';
import {
  SYMBOL_CHANGE_EVENT_TYPE,
  validateRegistration,
  type SymbolChangeRegistration,
  type SymbolChangeRejectReason,
} from './symbol-lineage.rules.js';

export interface RegisterSymbolChangeInput {
  market: string;
  oldCode: string;
  newCode: string;
  /** 交易所当地日历日 `'YYYY-MM-DD'` (与 `daily_bar.trade_date` 同轴)。 */
  effectiveDate: string;
  /** 缺省 `rename`; 其它取值由 rules 拒掉 (branch 11)。 */
  eventType?: string;
  /** `SYMBOL_CHANGE_SOURCE` 值域。 */
  source: string;
  evidence: string;
  registeredBy: string;
}

/**
 * 登记结果。`already_exists` = 同 (market, old, effective) 且同新码的未撤销登记已在库 ——
 * 修正编排据此判「已完成 ⇒ 跳过」(FR-013); 新码不同的同键登记是 `rejected/duplicate`。
 */
export type RegisterSymbolChangeResult =
  | { status: 'registered'; id: bigint }
  | { status: 'already_exists'; id: bigint }
  | { status: 'rejected'; reason: SymbolChangeRejectReason; message: string };

/** 维护者视图的一行 (FR-009: 含已撤销)。日期列已转 `'YYYY-MM-DD'`。 */
export interface SymbolChangeView {
  id: bigint;
  market: string;
  oldCode: string;
  newCode: string;
  effectiveDate: string;
  eventType: string;
  source: string;
  evidence: string;
  registeredBy: string;
  registeredAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `'YYYY-MM-DD'` ↔ `@db.Date` (Prisma 以 UTC 零点承载纯日期, 不含时区语义)。 */
export const symbolChangeDateToDb = (d: string): Date => {
  if (!DATE_ONLY.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    throw new Error(`INVALID_EFFECTIVE_DATE: ${d}`);
  }
  return new Date(`${d}T00:00:00Z`);
};
export const symbolChangeDateFromDb = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * 代码变更登记 (086 T003, FR-001 / FR-002 / FR-009; plan D1)。
 *
 * 读未撤销登记 → `validateRegistration` → 插入。部分唯一索引 `uk_symbol_change_active`
 * 才是并发下的真守门人, 前面的读只是快路径: 两路并发登记同参数时后到的一路撞 P2002,
 * 折叠为 `already_exists` (而非抛错), 让编排可以安全重跑。
 */
@Injectable()
export class RegisterSymbolChangeUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    input: RegisterSymbolChangeInput,
    now: Date = new Date(),
  ): Promise<RegisterSymbolChangeResult> {
    const effectiveDateDb = symbolChangeDateToDb(input.effectiveDate);
    const candidate: SymbolChangeRegistration = {
      market: input.market,
      oldCode: input.oldCode,
      newCode: input.newCode,
      effectiveDate: input.effectiveDate,
      eventType: input.eventType ?? SYMBOL_CHANGE_EVENT_TYPE.RENAME,
    };

    const active = await this.prisma.symbolChange.findMany({
      where: { market: input.market, revokedAt: null },
    });
    const same = active.find(
      (r) =>
        r.oldCode === candidate.oldCode &&
        r.newCode === candidate.newCode &&
        symbolChangeDateFromDb(r.effectiveDate) === candidate.effectiveDate,
    );
    if (same) return { status: 'already_exists', id: same.id };

    const verdict = validateRegistration(
      active.map((r) => ({
        market: r.market,
        oldCode: r.oldCode,
        newCode: r.newCode,
        effectiveDate: symbolChangeDateFromDb(r.effectiveDate),
        eventType: r.eventType,
      })),
      candidate,
      exchangeCalendarDate(input.market, now),
    );
    if (!verdict.ok) {
      return { status: 'rejected', reason: verdict.reason, message: verdict.message };
    }

    try {
      const row = await this.prisma.symbolChange.create({
        data: {
          market: candidate.market,
          oldCode: candidate.oldCode,
          newCode: candidate.newCode,
          effectiveDate: effectiveDateDb,
          eventType: candidate.eventType,
          source: input.source,
          evidence: input.evidence,
          registeredBy: input.registeredBy,
        },
        select: { id: true },
      });
      return { status: 'registered', id: row.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // 读与插之间另一路插进了同一 (market, old, effective)。重读那一行定性。
      const raced = await this.prisma.symbolChange.findFirst({
        where: {
          market: candidate.market,
          oldCode: candidate.oldCode,
          effectiveDate: effectiveDateDb,
          revokedAt: null,
        },
      });
      if (raced && raced.newCode === candidate.newCode) {
        return { status: 'already_exists', id: raced.id };
      }
      return {
        status: 'rejected',
        reason: 'duplicate',
        message: `已存在 ${candidate.market} ${candidate.oldCode} @ ${candidate.effectiveDate} 的登记`,
      };
    }
  }

  /** 全部登记 (含已撤销, FR-009), 按市场 / 生效日 / id 升序。只读。 */
  async list(market?: string): Promise<SymbolChangeView[]> {
    const rows = await this.prisma.symbolChange.findMany({
      where: market === undefined ? {} : { market },
      orderBy: [{ market: 'asc' }, { effectiveDate: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({ ...r, effectiveDate: symbolChangeDateFromDb(r.effectiveDate) }));
  }
}

/** P2002 = 唯一约束冲突 (这里只可能是 `uk_symbol_change_active`)。 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
