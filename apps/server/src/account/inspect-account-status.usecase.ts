import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { isAnonymized, isFrozen } from './account.rules';

/**
 * 跨 context 账户状态探查结果 (per ADR-0043 两段式委托 — Saga 第 1 段 read-only)。
 *
 * `auth` 编排 phone-sms-auth 时需在「验证短信码之前」知道账户状态以执行反枚举
 * 防御 (FROZEN → 403 披露 / ANONYMIZED → timing-pad 401 / 状态判定必须先于
 * verifyCode)。该 use case **只读不改**,把状态判定收在 account context 内 ——
 * auth 拿到贫血的判定结果,绝不直接碰 `prisma.account.*` (护城河)。
 */
export type AccountStatusInspection =
  | { kind: 'NOT_FOUND' }
  | { kind: 'ACTIVE' }
  // accountId 随 FROZEN 暴露 (server-internal, 不外泄): 撤销发码/提交 (004 US4/US5)
  // 据此 key account_sms_code 码行 (该表以 accountId 为键, 无 phone 列)。
  | { kind: 'FROZEN'; accountId: bigint; freezeUntil: Date | null }
  | { kind: 'ANONYMIZED' };

@Injectable()
export class InspectAccountStatusUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(phone: string): Promise<AccountStatusInspection> {
    const account = await this.prisma.account.findUnique({ where: { phone } });
    // phone-null row 视为 not-found (沿用旧 repository 守卫语义)。
    if (!account || account.phone === null) {
      return { kind: 'NOT_FOUND' };
    }
    if (isFrozen(account)) {
      return { kind: 'FROZEN', accountId: account.id, freezeUntil: account.freezeUntil };
    }
    if (isAnonymized(account)) {
      return { kind: 'ANONYMIZED' };
    }
    return { kind: 'ACTIVE' };
  }
}
