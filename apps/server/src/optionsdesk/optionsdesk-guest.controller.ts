import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { GuestUploadAuthGuard } from '../security/guest-upload-auth.guard';
import { ProblemDetailResponse } from '../security/problem-detail.response';
import { ImportAnchorFromModelUseCase } from './import-anchor-from-model.usecase';
import { SubmitAnchorFromGuestUseCase } from './submit-anchor-from-guest.usecase';
import {
  AnchorImportResponse,
  AnchorSubmissionResponse,
  ModelImportAnchorRequest,
  SubmitAnchorRequest,
  toAnchorImportResponse,
  toAnchorSubmissionResponse,
} from './optionsdesk.dto';

/**
 * 059 锚导入的 guest 面 —— 隧道内的两个 POST，**只写不读**。
 *
 * ## 为什么另起一个 controller 而不是加进 `optionsdesk.controller.ts`
 *
 * 那个 controller 是**类级** `@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` —— 类级 guard
 * 对每个路由生效且**无法在方法上摘掉**。要把 guest 端点塞进去，只能把 13 个既有端点的鉴权
 * 逐个下放到方法级，那是「为了少建一个文件而动整个 App 的鉴权面」，风险与收益完全不成比例。
 * 体例同 `research.controller.ts`（同为 guest 面、同为只写）。
 *
 * ## 这里只有 POST，而且是刻意的
 *
 * **MUST NOT 实装任何 GET / PATCH / DELETE**（FR-013）：通道层（guest-proxy 的
 * `limit_except POST`）**独立地**再拒一次 —— 两层各拒一次，不依赖对方。「服务端恰好没实现」
 * 是会被未来某个 PR 悄悄打破的状态：某天有人在这个前缀下加了个 list 端点，就直接对 guest
 * 开放了。
 *
 * ## 两个端点、两把 token、两条语义
 *
 * | 端点 | token | 干什么 |
 * | --- | --- | --- |
 * | `anchors/model-import` | `ANCHOR_IMPORT_TOKEN` | **直写锚**（无则建、有则按模型语义刷新）|
 * | `anchors/submissions` | `GUEST_UPLOAD_TOKEN` | **只写待审表**，锚表零变化 |
 *
 * 🚨 抄错 token 的表现**不是 401**（那还好查），而是**授权分流形同虚设**：他人持有的提交
 * token 也能打直写口，服务端那层就再也拒不住，只剩 nginx 一层（Guardrail 6）。
 *
 * 🚨 提交端点**绝不调导入 use case、绝不碰锚表** —— 那是 FR-012「系统 MUST NOT 存在第二条
 * 写锚路径」的实现级保证。采纳 = 本人用自己的凭证把同样的值经导入口重放一次。
 *
 * ## 无 server 侧 throttler 桶（同 research，刻意）
 *
 * guest-proxy 与 app 同机、其 `proxy_set_header` 组不带 XFF ⇒ server 侧只能按 `req.ip` 计而它
 * 恒为 `127.0.0.1`，一个桶会把两个调用方焊在一起。限频由通道层 nginx 的 `limit_req_zone`
 * （按 `$guest_name` 分，天然 per-guest）承担，两个口各自独立的 zone（FR-017）。
 */
@ApiTags('optionsdesk')
@Controller('v1/optionsdesk')
export class OptionsdeskGuestController {
  constructor(
    private readonly importAnchor: ImportAnchorFromModelUseCase,
    private readonly submitAnchor: SubmitAnchorFromGuestUseCase,
  ) {}

  @Post('anchors/model-import')
  @UseGuards(GuestUploadAuthGuard('anchorImport'))
  @ApiBearerAuth('anchor-import-token')
  @ApiOperation({
    summary: '按标的导入模型估值（隧道内本人专用，无锚则建、有锚则刷新）',
    description:
      '调方不必知道任何系统内部标识：按 canonical `market:code` 寻址。响应的 `action` 标明本次是 ' +
      '新建 / 更新 / 值未变未写入；`fallbackEntries` 逐条列出被本次导入冲掉的人工调整（禁静默回落）。' +
      '导入**不重置复审日期、不解除逾期标记** —— 复审语义是「人确认估值仍成立」，模型出新值不构成确认。' +
      '⚠️ 运维约束（非代码约束）：导入须早于当日锚驱动采集轮，当日新增的锚才会被**当轮**纳入工作集。',
  })
  @ApiResponse({ status: 201, description: '导入完成', type: AnchorImportResponse })
  @ApiResponse({
    status: 400,
    description: '标的写法 / 市场 / 置信度 / 估值不合法（原因可区分）',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: '通道凭证缺失或不符（两者对外不可区分）',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 404,
    description: '读写窗内该锚被并发删除（以不存在收敛）',
    type: ProblemDetailResponse,
  })
  async modelImport(@Body() body: ModelImportAnchorRequest): Promise<AnchorImportResponse> {
    return toAnchorImportResponse(
      await this.importAnchor.execute({
        ticker: body.ticker,
        v: body.v,
        asof: new Date(body.asof),
        method: body.method,
        confidence: body.confidence,
      }),
    );
  }

  @Post('anchors/submissions')
  @UseGuards(GuestUploadAuthGuard('upload'))
  @ApiBearerAuth('guest-upload-token')
  @ApiOperation({
    summary: '提交一条待审估值（其他访客用；只落收件箱，锚表零变化）',
    description:
      '提交方能往收件箱里放东西，但看不到库里有什么，包括他自己刚放的（无读取面）。' +
      '采纳动作由本人在系统外完成：用自己的凭证把同样的值经导入口重放一次 —— 系统**不存在**' +
      '第二条写锚路径。提交方身份取自通道无条件覆写的 `X-Guest` 头，**仅作归属、不作授权**。',
  })
  @ApiResponse({ status: 201, description: '已收件（待审）', type: AnchorSubmissionResponse })
  @ApiResponse({
    status: 400,
    description: '标的写法 / 市场 / 置信度不合法（与导入口同一套判据）',
    type: ProblemDetailResponse,
  })
  @ApiResponse({
    status: 401,
    description: '通道凭证缺失或不符（两者对外不可区分）',
    type: ProblemDetailResponse,
  })
  async submit(
    @Body() body: SubmitAnchorRequest,
    @Req() request: FastifyRequest,
  ): Promise<AnchorSubmissionResponse> {
    return toAnchorSubmissionResponse(
      await this.submitAnchor.execute({
        // `X-Guest` 由 guest-proxy 无条件覆写 ⇒ 可信作归属、绝不可作授权（授权是上面那把
        // token 的事，两者正交）。通道未覆写（本地直连）时落 'unknown'，不猜也不拒。
        submitter: String(request.headers['x-guest'] ?? 'unknown'),
        ticker: body.ticker,
        v: body.v,
        asof: new Date(body.asof),
        method: body.method,
        confidence: body.confidence,
        note: body.note ?? null,
      }),
    );
  }
}
