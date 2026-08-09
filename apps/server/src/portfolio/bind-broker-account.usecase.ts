import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { FormValidationException } from '../security/form-validation.exception';
import { isKnownBroker, brokerNameOf } from './broker-catalog';
import { normalizeClientNo, type BrokerAccountListItem } from './portfolio.rules';
import { BrokerAccountDuplicateException } from './broker-account-duplicate.exception';

/**
 * 012 US2 — 绑定券商账户 (intra 写, ADR-0043 直注 PrismaService 无 repository)。
 *
 *  1. 字典校验 (无 DB): 未知 brokerCode → 400 FORM_VALIDATION。
 *  2. normalizeClientNo (无 DB): 禁控制字符 / trim 后空 → 400 FORM_VALIDATION。
 *  3. create → 撞唯一索引 (account_id, broker_code, client_no) 抛 P2002 → 409
 *     BROKER_ACCOUNT_DUPLICATE。**无 FOR UPDATE / 无预查重** (D1): 行相互独立无跨行
 *     不变性, 唯一索引天然串行化并发同键插入, 败者抛 P2002。
 */
@Injectable()
export class BindBrokerAccountUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    accountId: bigint,
    brokerCode: string,
    rawClientNo: string,
  ): Promise<BrokerAccountListItem> {
    if (!isKnownBroker(brokerCode)) {
      throw new FormValidationException([{ field: 'brokerCode', messages: ['未知券商'] }]);
    }

    let clientNo: string;
    try {
      clientNo = normalizeClientNo(rawClientNo);
    } catch {
      throw new FormValidationException([{ field: 'clientNo', messages: ['客户号格式不合法'] }]);
    }

    try {
      const row = await this.prisma.brokerAccount.create({
        data: { accountId, brokerCode, clientNo },
      });
      return {
        id: row.id.toString(),
        brokerCode: row.brokerCode,
        brokerName: brokerNameOf(row.brokerCode) ?? row.brokerCode,
        clientNo: row.clientNo,
        isDefault: false,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (e) {
      if (isPrismaUniqueViolation(e)) {
        throw new BrokerAccountDuplicateException();
      }
      throw e;
    }
  }
}

function isPrismaUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
  );
}
