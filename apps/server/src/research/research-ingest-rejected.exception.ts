import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 研报投递被拒（057）。RFC 9457 ProblemDetail + `code` extension（ADR-0038），
 * 范式同 `portfolio/holdings-file-invalid.exception.ts`。
 *
 * 🚨 **每种拒绝一个独立 `code`** —— 投递方是大模型驱动的 agent，含糊的拒绝会让它反复重试，
 * 既烧限频也污染日志（SC-004）。`code` 是 skill 文案里那张错误码对照表的锚（T014）。
 *
 * HTTP 状态的选择：
 * - **422** 输入本身不合规（非 PDF / 标的写法）—— 请求形态没问题，内容不接受。
 * - **507** 配额耗尽 —— 「服务端存不下」，与 413（单份超大，由 multipart 那层给）刻意分开，
 *   否则 agent 分不清「这份太大」和「你没额度了」。
 * - **502** 对象存储侧的两种结局 —— 都不是投递方的错。**确认被拒**与**无法确定**用不同
 *   `code`：前者重投无意义，后者重投是安全的（同字节会就地续做，不会产生第二份）。
 */
export class ResearchIngestRejectedException extends HttpException {
  private constructor(code: string, message: string, status: HttpStatus) {
    super({ code, message }, status);
  }

  static notPdf(): ResearchIngestRejectedException {
    return new ResearchIngestRejectedException(
      'RESEARCH_FILE_NOT_PDF',
      '文件内容不是 PDF（判据是文件头魔数，与扩展名无关）',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static symbolPercentEncoded(message: string): ResearchIngestRejectedException {
    return new ResearchIngestRejectedException(
      'RESEARCH_SYMBOL_ENCODED',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static symbolMarketUnsupported(message: string): ResearchIngestRejectedException {
    return new ResearchIngestRejectedException(
      'RESEARCH_SYMBOL_MARKET_UNSUPPORTED',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static symbolInvalid(message: string): ResearchIngestRejectedException {
    return new ResearchIngestRejectedException(
      'RESEARCH_SYMBOL_INVALID',
      message,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static reportDateInvalid(raw: string): ResearchIngestRejectedException {
    return new ResearchIngestRejectedException(
      'RESEARCH_REPORT_DATE_INVALID',
      `研报日期形态不认: ${raw}（应为 YYYY-MM-DD）`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  static quotaExceeded(usedBytes: number, limitBytes: number): ResearchIngestRejectedException {
    return new ResearchIngestRejectedException(
      'RESEARCH_QUOTA_EXCEEDED',
      `累计用量已达配额（已用 ${usedBytes} / 上限 ${limitBytes} 字节）`,
      HttpStatus.INSUFFICIENT_STORAGE,
    );
  }

  static storageRejected(): ResearchIngestRejectedException {
    return new ResearchIngestRejectedException(
      'RESEARCH_STORAGE_REJECTED',
      '归档存储拒绝了这次写入，重投同一份不会改变结果',
      HttpStatus.BAD_GATEWAY,
    );
  }

  static storageIndeterminate(): ResearchIngestRejectedException {
    return new ResearchIngestRejectedException(
      'RESEARCH_STORAGE_INDETERMINATE',
      '归档存储可达性不确定，这次投递的结果未知。重投同一份是安全的：系统会就地续做，不会产生第二份',
      HttpStatus.BAD_GATEWAY,
    );
  }
}
