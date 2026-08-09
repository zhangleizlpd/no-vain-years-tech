import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 012 FR-S05 默认账户不可删: 系统「默认账户」是读侧虚拟派生条目 (不落库, id=accountId),
 * 删除它无意义 → 400 + code `DEFAULT_ACCOUNT_NOT_DELETABLE`。
 *
 * delete UC「先 scoped-delete 后判定」(D3): deleteMany 0 命中且 id===accountId (默认虚拟 id)
 * → 抛本 exception。区别于 id!==accountId 的 404 (反枚举折叠不存在 / 属他人)。
 */
export class DefaultAccountNotDeletableException extends HttpException {
  static readonly code = 'DEFAULT_ACCOUNT_NOT_DELETABLE';

  constructor() {
    super(
      {
        code: DefaultAccountNotDeletableException.code,
        message: '默认账户不可删除',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}
