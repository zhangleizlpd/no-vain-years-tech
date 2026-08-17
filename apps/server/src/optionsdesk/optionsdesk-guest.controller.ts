import { Body, Controller, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
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
 * ## 两个端点、一把 token、两条语义
 *
 * | 端点 | 干什么 | 谁能到 |
 * | --- | --- | --- |
 * | `anchors/model-import` | **直写锚**（无则建、有则按模型语义刷新）| 通道层按访客名 403 分流后**只剩本人** |
 * | `anchors/submissions` | **只写待审表**，锚表零变化 | 所有访客 |
 *
 * 🚨 两个端点持**同一把** `GUEST_UPLOAD_TOKEN` ⇒ **服务端这一层不区分它俩**。「谁能直写」
 * 的判据单点在通道层 nginx 的 `$anchor_write_allowed`（`/anchor-import` location，按
 * `ANCHOR_OWNER_NAME`）—— 那一处配置错、或谁绕过代理直连 loopback，锚表就没有第二道闸。
 * 这是 059 明知并接受的取舍（曾按两把 token 实装、收口时回退），完整理由与「要加回第二把
 * 的门槛」单点写在 `config/guest-upload.config.ts` 顶部。
 *
 * 🚨 因此**分流的实现级保证只剩这一条**：提交端点**绝不调导入 use case、绝不碰锚表** ——
 * FR-012「系统 MUST NOT 存在第二条写锚路径」。采纳 = 本人用自己的凭证把同样的值经导入口
 * 重放一次。改这个 controller 时这条比什么都重。
 *
 * ## `ticker` 走 query string，其余走 body
 *
 * nginx 的 `$arg_*` **只读得到 query** ⇒ 通道层那道市场闸（`$arg_ticker !~ "^(us|hk):"`）只有
 * 在 ticker 位于 query 时才成立；放进 body 的话 nginx 看不见它，闸退化成摆设。理由与 057 研报
 * 把三项必填元数据放 query 完全相同。⚠️ 通道与服务两处的市场判据是**两份独立文本，会漂** ——
 * 服务端那份的单点在 `anchor-import.rules.ts`，nginx 那份旁边写了「改一处必改另一处」，
 * 而钉住它的是 IT 里对 `cn:` 的 400 断言 + `verify-guards.sh` 里的同名反例。
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
  @UseGuards(GuestUploadAuthGuard)
  @ApiBearerAuth('guest-upload-token')
  @ApiOperation({
    summary: '按标的导入模型估值（隧道内本人专用，无锚则建、有锚则刷新）',
    description:
      '调方不必知道任何系统内部标识：按 canonical `market:code` 寻址。响应的 `action` 标明本次是 ' +
      '新建 / 更新 / 值未变未写入；`fallbackEntries` 逐条列出被本次导入冲掉的人工调整（禁静默回落）。' +
      '导入**不重置复审日期、不解除逾期标记** —— 复审语义是「人确认估值仍成立」，模型出新值不构成确认。' +
      '⚠️ 运维约束（非代码约束）：导入须早于当日锚驱动采集轮，当日新增的锚才会被**当轮**纳入工作集。',
  })
  @ApiQuery({
    name: 'ticker',
    required: true,
    example: 'us:AOS',
    description:
      'canonical `market:code`（市场 ∈ us / hk；大小写与前后缀式一律拒，不归一）。' +
      '冒号**不要**做百分号编码 —— 通道层的市场闸读的是未解码的 query。',
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
  async modelImport(
    @Query('ticker') ticker: string,
    @Body() body: ModelImportAnchorRequest,
  ): Promise<AnchorImportResponse> {
    return toAnchorImportResponse(
      await this.importAnchor.execute({
        // 缺 ticker 时是 undefined —— 不在这里特判：值域判定单点在 rules，那边对任何不合
        // canonical 形态的输入都给同一族可区分的 400（少一处特判就少一处会漂的判据）。
        ticker: String(ticker ?? ''),
        v: body.v,
        asof: new Date(body.asof),
        method: body.method,
        confidence: body.confidence,
      }),
    );
  }

  @Post('anchors/submissions')
  @UseGuards(GuestUploadAuthGuard)
  @ApiBearerAuth('guest-upload-token')
  @ApiOperation({
    summary: '提交一条待审估值（其他访客用；只落收件箱，锚表零变化）',
    description:
      '提交方能往收件箱里放东西，但看不到库里有什么，包括他自己刚放的（无读取面）。' +
      '采纳动作由本人在系统外完成：用自己的凭证把同样的值经导入口重放一次 —— 系统**不存在**' +
      '第二条写锚路径。提交方身份取自通道无条件覆写的 `X-Guest` 头，**仅作归属、不作授权**。',
  })
  @ApiQuery({
    name: 'ticker',
    required: true,
    example: 'us:AOS',
    description: 'canonical `market:code`（与导入口同一套判据）',
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
    @Query('ticker') ticker: string,
    @Body() body: SubmitAnchorRequest,
    @Req() request: FastifyRequest,
  ): Promise<AnchorSubmissionResponse> {
    return toAnchorSubmissionResponse(
      await this.submitAnchor.execute({
        // `X-Guest` 由 guest-proxy 无条件覆写 ⇒ 可信作归属、绝不可作授权（授权是上面那把
        // token 的事，两者正交）。通道未覆写（本地直连）时落 'unknown'，不猜也不拒。
        submitter: String(request.headers['x-guest'] ?? 'unknown'),
        ticker: String(ticker ?? ''),
        v: body.v,
        asof: new Date(body.asof),
        method: body.method,
        confidence: body.confidence,
        note: body.note ?? null,
      }),
    );
  }
}
