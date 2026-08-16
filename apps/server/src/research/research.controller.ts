import { Controller, PayloadTooLargeException, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { GuestUploadAuthGuard } from '../security/guest-upload-auth.guard.js';
import { ProblemDetailResponse } from '../security/problem-detail.response.js';
import { FormValidationException } from '../security/form-validation.exception.js';
import { IngestResearchReportUseCase } from './ingest-research-report.usecase.js';
import { ResearchIngestResponse } from './research-ingest.response.js';
import { RESEARCH_MAX_BYTES } from './research-report.rules.js';

/**
 * 研报投递端点（057 guest 面）—— 单向收集箱，**只写不读**。
 *
 * ## 这里只有 POST，而且是刻意的
 *
 * **MUST NOT 实装任何 GET / PATCH / DELETE**（FR-012）：投递方能往库里放东西，但看不到库里
 * 有什么，包括他自己刚放的。通道层（guest-proxy 的 `limit_except POST`）**独立地**再拒一次
 * —— 两层各拒一次，不依赖对方（FR-013）。「服务端恰好没实现」是会被未来某个 PR 悄悄打破的
 * 状态：某天有人加了内部 list 端点、路径前缀一样，就直接对 guest 开放了。
 *
 * ## 三项必填元数据走 query string 而不是 form field
 *
 * nginx 的 `$arg_*` **只读得到 query**，通道层那道市场闸（`$arg_symbol !~ "^(cn|hk|us):"`）
 * 才成立。放进 multipart form field 的话，nginx 看不见它，闸就退化成摆设。
 *
 * ## 投递方归属取 `X-Guest` 头
 *
 * 该头由 guest-proxy **无条件覆写**（server 级 `proxy_set_header X-Guest $guest_name`）⇒
 * **可信作归属、绝不可作授权**。授权是 `GuestUploadAuthGuard` 那一层的事，两者正交。
 */
@ApiTags('research')
@Controller('v1/research')
export class ResearchController {
  constructor(private readonly ingest: IngestResearchReportUseCase) {}

  @Post('reports')
  @UseGuards(GuestUploadAuthGuard)
  @ApiBearerAuth('guest-upload-token')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '投递一份研报 PDF（隧道内投递方专用，单向只写）',
    description:
      '三项必填元数据走 query string（通道层的市场闸只读得到 query）；文件走 multipart 的 `file` 字段，单份上限 16MB。' +
      '同一投递方以**同一标的**重复投递同一份文件是安全的：返回首次那条记录，不新增对象也不新增元数据；' +
      '换一个标的投同一份文件则各自成为独立记录（标的投错可用正确标的重投同一份文件补救）。',
  })
  @ApiQuery({
    name: 'symbol',
    required: true,
    example: 'hk:01698',
    description: '标的。前缀式 `hk:01698` 或后缀式 `01698.HK` 均可，冒号**不要**做百分号编码',
  })
  @ApiQuery({
    name: 'reportDate',
    required: true,
    example: '2026-08-01',
    description: '研报日期 `YYYY-MM-DD`（取投递方声明值，系统不从 PDF 内容反推）',
  })
  @ApiQuery({ name: 'title', required: true, example: '某公司深度研报', description: '标题' })
  @ApiQuery({ name: 'source', required: false, example: '自研', description: '来源，缺省「自研」' })
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'PDF 文件' } },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      '已归档。应答回显的元数据（`title` / `reportDate` / `version`）一律取自**落库的那一行**，不是把请求参数原样回吐；' +
      '`deduplicated: true` 时回显的是**库中那条**的值 —— 重投改不掉已归档的元数据，这件事对投递方显式可见而非静默。' +
      '`version` 是（该投递方, 该标的）版本线上的序号，各条线互不影响、互不可见。' +
      '`instrumentName` 为实时读取的标的名称，查不到或查询失败时为 null，不影响投递成功。',
    type: ResearchIngestResponse,
  })
  @ApiResponse({
    status: 401,
    description: '通道凭证缺失或不符（两者对外不可区分）',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 413,
    description: '单份超过 16MB 上限',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 422,
    description:
      'RESEARCH_FILE_NOT_PDF / RESEARCH_SYMBOL_* / RESEARCH_REPORT_DATE_INVALID —— 各自 code 可区分',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 502,
    description:
      'RESEARCH_STORAGE_REJECTED（重投无意义）/ RESEARCH_STORAGE_INDETERMINATE（重投安全）',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 503,
    description: 'RESEARCH_STORAGE_NOT_CONFIGURED —— 该能力未启用（不是服务故障）',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 507,
    description: 'RESEARCH_QUOTA_EXCEEDED —— 该投递方累计用量已达配额',
    type: ProblemDetailResponse,
  })
  async ingestReport(
    @Req() req: FastifyRequest,
    @Query('symbol') symbol?: string,
    @Query('reportDate') reportDate?: string,
    @Query('title') title?: string,
    @Query('source') source?: string,
  ): Promise<ResearchIngestResponse> {
    const missing: Array<{ field: string; messages: string[] }> = [];
    if (!symbol?.trim()) missing.push({ field: 'symbol', messages: ['symbol 必填 (如 hk:01698)'] });
    if (!reportDate?.trim()) {
      missing.push({ field: 'reportDate', messages: ['reportDate 必填 (YYYY-MM-DD)'] });
    }
    if (!title?.trim()) missing.push({ field: 'title', messages: ['title 必填'] });
    // 缺哪一项就说哪一项（FR/state_branch 15）——「参数不对」这种含糊回答会让 agent 逐个试。
    if (missing.length > 0) throw new FormValidationException(missing);

    // 🚨 上限**必须**在调用点给（plan D-5）：`@fastify/multipart` 的 fileSize 回落到
    // `fastify.initialConfig.bodyLimit`，而 main.ts 已显式给了 2MB ⇒ 路由级 bodyLimit
    // 根本不参与。`index.js` 的 deepmergeAll 是**深合并**，覆盖 fileSize 的同时保留全局
    // `files: 1`（别在这里重复声明）。
    const file = await req.file({ limits: { fileSize: RESEARCH_MAX_BYTES } });
    if (!file) {
      throw new FormValidationException([{ field: 'file', messages: ['multipart file 字段必填'] }]);
    }

    let bytes: Buffer;
    try {
      bytes = await file.toBuffer();
    } catch (err) {
      // ⚠️ `FST_REQ_FILE_TOO_LARGE` 在 **toBuffer() 抛**，不在 req.file() 抛 ——
      // catch 写错位置的表现是超限请求 500 而不是 413。
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new PayloadTooLargeException(`文件超过 ${RESEARCH_MAX_BYTES} 字节上限`);
      }
      throw err;
    }

    // guest-proxy 无条件覆写该头；本地/直连时缺失则记为 unknown（归属仍可追溯到「没经代理」）。
    const guestName = readGuestName(req.headers['x-guest']);

    return this.ingest.execute({
      uploader: { kind: 'guest', guestName },
      symbol: symbol!.trim(),
      reportDate: reportDate!.trim(),
      title: title!.trim(),
      source: source?.trim(),
      file: { bytes, filename: file.filename },
    });
  }
}

function readGuestName(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'unknown';
}
