import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 025 FR-001 导入文件整体性失败: 非 xlsx (mimetype/扩展) / 不可解析 / 缺必要 sheet /
 * 缺必要列 → 422 + code `HOLDINGS_FILE_INVALID` (RFC 9457 extension, ADR-0038)。
 *
 * 解析/结构校验全部发生在导入事务之前 → 抛本 exception 时库天然不变
 * (state_branch #4, FR-002 不留半态)。
 */
export class HoldingsFileInvalidException extends HttpException {
  static readonly code = 'HOLDINGS_FILE_INVALID';

  private constructor(message: string) {
    super({ code: HoldingsFileInvalidException.code, message }, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  static notXlsx(): HoldingsFileInvalidException {
    return new HoldingsFileInvalidException('仅支持 .xlsx 文件 (同花顺汇总持仓导出)');
  }

  static invalidXlsx(): HoldingsFileInvalidException {
    return new HoldingsFileInvalidException('文件不是合法 xlsx，无法解析');
  }

  static missingSheets(missing: string[]): HoldingsFileInvalidException {
    return new HoldingsFileInvalidException(`缺少必要 sheet: ${missing.join('、')}`);
  }

  static missingColumns(sheet: string, missing: string[]): HoldingsFileInvalidException {
    return new HoldingsFileInvalidException(`「${sheet}」缺少必要列: ${missing.join('、')}`);
  }
}
