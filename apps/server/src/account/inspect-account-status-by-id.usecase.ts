import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { isAnonymized, isFrozen } from './account.rules';

/**
 * by-id 探查结果 (per ADR-0043 两段式委托 — read-only)。ACTIVE 携带 `phone` ——
 * auth 编排发注销码 (send-deletion-code) 只持 accountId (来自 JWT), 需对方手机号
 * 才能发 SMS; 经此读半段跨 moat 取 (R2 只读, 不让 auth 直读 account 表)。
 * FROZEN/ANONYMIZED/NOT_FOUND 与 by-phone 同 kind 语义, 但**不复用同一 type**:
 * by-id 出 phone (caller 有 id 缺 phone), by-phone 出 accountId (caller 有 phone
 * 缺 id), 各按 caller 需要裁剪。
 */
export type AccountStatusInspectionById =
  | { kind: 'NOT_FOUND' }
  | { kind: 'ACTIVE'; phone: string }
  | { kind: 'FROZEN'; freezeUntil: Date | null }
  | { kind: 'ANONYMIZED' };

/**
 * 按 accountId 探查账户状态。refresh 流 (只持 accountId) + send-deletion-code 编排
 * 复用: 非 ACTIVE → auth 折叠成反枚举 401 (refresh / 注销码无 FROZEN 披露语义)。
 */
@Injectable()
export class InspectAccountStatusByIdUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint): Promise<AccountStatusInspectionById> {
    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    // phone-null row 视为 not-found (沿用旧 repository 守卫语义)。
    if (!account || account.phone === null) {
      return { kind: 'NOT_FOUND' };
    }
    if (isFrozen(account)) {
      return { kind: 'FROZEN', freezeUntil: account.freezeUntil };
    }
    if (isAnonymized(account)) {
      return { kind: 'ANONYMIZED' };
    }
    return { kind: 'ACTIVE', phone: account.phone };
  }
}
