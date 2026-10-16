import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import { symbolChangeDateToDb } from './register-symbol-change.usecase.js';

export interface RevokeSymbolChangeInput {
  market: string;
  oldCode: string;
  /** 交易所当地日历日 `'YYYY-MM-DD'`。 */
  effectiveDate: string;
  revokedBy: string;
  reason: string;
}

/**
 * `already_revoked` = 该键只剩已撤销的登记 (撤销命令重跑即落这里, FR-013);
 * `not_found` = 该键从未登记过。
 */
export type RevokeSymbolChangeResult =
  | { status: 'revoked' }
  | { status: 'already_revoked' }
  | { status: 'not_found' };

/**
 * 撤销代码变更登记 (086 T003, FR-003; plan D1)。按自然键 (market, old, effective) 撤销 ——
 * 与登记命令同参数对称, 调用方不需要知道行 id。
 *
 * 单行状态转换 = conditional UPDATE `revoked_at IS NULL` + affected-count: 两路并发撤销只有
 * 一路 count===1, 另一路落 `already_revoked`。只写撤销三列不删行 (留痕, FR-003 / FR-009)。
 */
@Injectable()
export class RevokeSymbolChangeUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    input: RevokeSymbolChangeInput,
    now: Date = new Date(),
  ): Promise<RevokeSymbolChangeResult> {
    const key = {
      market: input.market,
      oldCode: input.oldCode,
      effectiveDate: symbolChangeDateToDb(input.effectiveDate),
    };
    const { count } = await this.prisma.symbolChange.updateMany({
      where: { ...key, revokedAt: null },
      data: { revokedAt: now, revokedBy: input.revokedBy, revokeReason: input.reason },
    });
    if (count > 0) return { status: 'revoked' };
    const any = await this.prisma.symbolChange.findFirst({ where: key, select: { id: true } });
    return any ? { status: 'already_revoked' } : { status: 'not_found' };
  }
}
