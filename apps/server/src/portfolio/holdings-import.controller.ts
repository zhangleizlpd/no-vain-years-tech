import {
  Controller,
  HttpCode,
  PayloadTooLargeException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { Multipart, MultipartFile } from '@fastify/multipart';
import { JwtAuthGuard, type AuthenticatedUser } from '../account/jwt-auth.guard';
import { AccountIdThrottlerGuard } from '../account/account-id-throttler.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import { FormValidationException } from '../security/form-validation.exception';
import {
  DEFAULT_BUCKET,
  SMS_CODE_BUCKETS,
  ME_BUCKETS,
  TOKEN_BUCKETS,
  ALL_DELETION_BUCKETS,
  DEVICE_BUCKETS,
  WECHAT_BUCKETS,
  MARKET_PREF_ALL,
  BROKER_ACCT_ALL,
  MARKETDATA_ALL,
  WATCHLIST_ALL,
  CHAT_ALL,
  IDEATION_ALL,
  ALERT_ALL,
  PORTFOLIO_HOLDINGS_READ_BUCKET,
  OPTIONSDESK_ALL,
} from '../security/throttler-skip-buckets';
import { ImportHoldingsUseCase } from './import-holdings.usecase';
import { HoldingsFileInvalidException } from './holdings-file-invalid.exception';
import { ImportSummaryResponse } from './import-summary.response';

/**
 * 既有桶 (001-021) + 025 同组「除己」(read 桶) —— import EP @Throttle 己桶
 * (portfolio-import-account) + @SkipThrottle 其余全部, 防共享存储被其它桶误限流
 * (own 不在 skip 集内, 沿 015/021 范式)。
 */
const EXISTING_BUCKETS: Record<string, boolean> = {
  ...PORTFOLIO_HOLDINGS_READ_BUCKET,
  ...DEFAULT_BUCKET,
  ...SMS_CODE_BUCKETS,
  ...ME_BUCKETS,
  ...TOKEN_BUCKETS,
  ...ALL_DELETION_BUCKETS,
  ...DEVICE_BUCKETS,
  ...WECHAT_BUCKETS,
  ...MARKET_PREF_ALL,
  ...BROKER_ACCT_ALL,
  ...MARKETDATA_ALL,
  ...WATCHLIST_ALL,
  ...ALERT_ALL,
  ...CHAT_ALL,
  ...IDEATION_ALL,
  ...OPTIONSDESK_ALL,
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** multipart 文件签名校验: 扩展 .xlsx 必须 + mimetype xlsx (octet-stream 容忍 curl/脚本)。 */
function looksLikeXlsx(file: MultipartFile): boolean {
  if (!file.filename?.toLowerCase().endsWith('.xlsx')) return false;
  return file.mimetype === XLSX_MIME || file.mimetype === 'application/octet-stream';
}

/** 取 multipart 文本字段 asOf (fields 在 toBuffer 消费完后完整)。 */
function extractAsOf(file: MultipartFile): string | null {
  const field: Multipart | Multipart[] | undefined = file.fields['asOf'];
  const first = Array.isArray(field) ? field[0] : field;
  if (!first || first.type !== 'field' || typeof first.value !== 'string') return null;
  const trimmed = first.value.trim();
  return trimmed === '' ? null : trimmed;
}

/** asOf 缺省 = 北京时间当日 (plan D4 — 容器 UTC 0-8 点错位, 导出日语义随交易日历)。 */
function beijingToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** YYYY-MM-DD 形态 + 真实历法日 (round-trip 校验拒 2026-02-31)。 */
function isValidDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * POST /api/v1/portfolio/holdings/import (025 EP1, FR-001..006)
 *
 * multipart/form-data: `file` (xlsx ≤2MB, 必填) + `asOf` (YYYY-MM-DD, 可选,
 * 缺省北京时间当日)。authed (JwtAuthGuard: Bearer + ACTIVE → 失败统一 401 反枚举);
 * 限流 per-account 6/60s (AccountIdThrottlerGuard, 本机同步工具日频调用量级)。
 * 超 2MB → multipart limits 层 413; 非 xlsx / 缺 sheet / 不可解析 → 422 整体拒绝。
 */
@ApiTags('portfolio')
@Controller('v1/portfolio/holdings')
@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)
@ApiBearerAuth()
export class HoldingsImportController {
  constructor(private readonly importHoldings: ImportHoldingsUseCase) {}

  @Post('import')
  @HttpCode(200)
  @SkipThrottle(EXISTING_BUCKETS)
  @Throttle({ 'portfolio-import-account': { limit: 6, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: '同花顺汇总持仓 xlsx (3 sheet: 持仓数据/已清仓/交易记录)',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'xlsx 文件 (≤2MB)' },
        asOf: {
          type: 'string',
          description: '快照日 YYYY-MM-DD (可选, 缺省北京时间当日; 脚本传文件名日期)',
          example: '2026-06-06',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Import holdings xlsx (EP1)',
    description:
      'Whole-account replacement in one transaction (deleteMany + createMany ×3 tables, advisory-locked per account). Row-level dirt is tolerated and reported in the summary; structural failure (non-xlsx / missing sheet) rejects the whole file with the DB untouched. Idempotent by construction (FR-006).',
  })
  @ApiResponse({ status: 200, description: 'Import summary', type: ImportSummaryResponse })
  @ApiResponse({
    status: 400,
    description: 'FORM_VALIDATION — file part missing / asOf malformed',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthenticated / account not ACTIVE (anti-enumeration)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds 2MB (multipart limits)',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description: 'HOLDINGS_FILE_INVALID — not xlsx / unparseable / missing sheet or column',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 429,
    description: 'Rate limit (6/60s per account)',
    type: ProblemDetailResponse,
  })
  async import(
    @Req() req: FastifyRequest & { user: AuthenticatedUser },
  ): Promise<ImportSummaryResponse> {
    const file = await req.file();
    if (!file) {
      throw new FormValidationException([
        { field: 'file', messages: ['multipart file 字段必填 (xlsx)'] },
      ]);
    }
    if (!looksLikeXlsx(file)) {
      throw HoldingsFileInvalidException.notXlsx();
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      // multipart limits 超 2MB → fastify FST_REQ_FILE_TOO_LARGE → 413 (FR-001)
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new PayloadTooLargeException('文件超过 2MB 上限');
      }
      throw err;
    }

    const provided = extractAsOf(file);
    if (provided !== null && !isValidDateStr(provided)) {
      throw new FormValidationException([
        { field: 'asOf', messages: ['asOf 须为 YYYY-MM-DD 真实历法日'] },
      ]);
    }
    const asOf = provided ?? beijingToday();

    return this.importHoldings.execute(req.user.accountId, buffer, asOf);
  }
}
