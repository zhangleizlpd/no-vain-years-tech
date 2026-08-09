import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 013 自选标的不存在: update/delete-item 路径 itemId 在本账号无对应行 (非法 / 属他人 /
 * 已删) → 404 + code `WATCHLIST_ITEM_NOT_FOUND` (反枚举折叠, 同 GroupNotFoundException)。
 */
export class WatchlistItemNotFoundException extends HttpException {
  static readonly code = 'WATCHLIST_ITEM_NOT_FOUND';

  constructor() {
    super(
      {
        code: WatchlistItemNotFoundException.code,
        message: '自选标的不存在',
      },
      HttpStatus.NOT_FOUND,
    );
  }
}
