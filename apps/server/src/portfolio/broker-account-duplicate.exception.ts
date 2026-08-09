import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 012 FR-S04 券商账户重复绑定: 同账号已存在相同 {brokerCode, clientNo} → 拒绝重复落库。
 *
 * bind UC create 撞唯一索引 (account_id, broker_code, client_no) → Prisma P2002 → catch
 * 后抛本 exception → ProblemDetailFilter 映射为 409 + code `BROKER_ACCOUNT_DUPLICATE`
 * (镜像 011 MarketNotAvailableException HttpException 子类 + RFC 9457 extension, ADR-0038)。
 * 唯一索引天然串行化并发同键插入 (无 FOR UPDATE / 无预查重, D1)。
 */
export class BrokerAccountDuplicateException extends HttpException {
  static readonly code = 'BROKER_ACCOUNT_DUPLICATE';

  constructor() {
    super(
      {
        code: BrokerAccountDuplicateException.code,
        message: '该券商账户已绑定',
      },
      HttpStatus.CONFLICT,
    );
  }
}
