import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module.js';
import { AccountModule } from '../account/account.module.js';
import { MarketdataModule } from '../marketdata/marketdata.module.js';
import { CreateAnchorUseCase } from './create-anchor.usecase.js';
import { UpdateAnchorUseCase } from './update-anchor.usecase.js';
import { DeleteAnchorUseCase } from './delete-anchor.usecase.js';
import { ReviewAnchorUseCase } from './review-anchor.usecase.js';
import { SetPositionBucketUseCase } from './set-position-bucket.usecase.js';
import { GetAnchorAtUseCase } from './get-anchor-at.usecase.js';
import { ListAnchorsUseCase } from './list-anchors.usecase.js';
import { GetAnchorUseCase } from './get-anchor.usecase.js';
import { GetRadarUseCase } from './get-radar.usecase.js';
import { GetUnderlyingDetailUseCase } from './get-underlying-detail.usecase.js';
import { GetThermometerUseCase } from './get-thermometer.usecase.js';
import { GetLegsUseCase } from './get-legs.usecase.js';
import { GetChainReportUseCase } from './get-chain-report.usecase.js';
import { LEG_RETRIEVAL_PORT } from './leg-retrieval.port.js';
import { PrismaLegRetrievalAdapter } from './leg-retrieval.adapter.js';
import { SyncAnchorLastCloseUseCase } from './sync-anchor-last-close.js';
import { SyncAnchorLastCloseScheduler } from './sync-anchor-last-close.scheduler.js';
import { SyncAnchorIntradayUseCase } from './sync-anchor-intraday.js';
import { SyncAnchorIntradayScheduler } from './sync-anchor-intraday.scheduler.js';
import { OptionsdeskController } from './optionsdesk.controller.js';
import { OptionsdeskGuestController } from './optionsdesk-guest.controller.js';
import { AnchorSubmissionController } from './anchor-submission.controller.js';
import { ListAnchorSubmissionsUseCase } from './list-anchor-submissions.usecase.js';
import { ApproveAnchorSubmissionUseCase } from './approve-anchor-submission.usecase.js';
import { RejectAnchorSubmissionsUseCase } from './reject-anchor-submissions.usecase.js';
import { ImportAnchorFromModelUseCase } from './import-anchor-from-model.usecase.js';
import { SubmitAnchorFromGuestUseCase } from './submit-anchor-from-guest.usecase.js';

/**
 * optionsdesk bounded context (第 10 ctx; ADR-0062 — 045 期权台锚管理 + 击球区雷达)。
 *
 * 锚 (估值 V + 置信度 + 人工位) 是本 ctx 的自有事实; 雷达按「距 W%」排序把「今天该看哪几只」
 * 收敛成一屏。范式 = ADR-0043 扁平 + 贫血 (文件平铺, 直注 PrismaService, 无 repository port,
 * 无 Domain Class)。
 *
 * **叶子 ctx**: 依赖 security 平台基座 (PrismaService 直查自有锚表/痕迹表 + ProblemDetailFilter)
 * + account (JwtAuthGuard/AccountIdThrottlerGuard 经 export 复用)。唯一业务读边 = marketdata
 * 行情 (Instrument → DailyBar 最新未复权收盘价, Q7-B 只读直查 + `CROSS-CONTEXT-READ` 注释,
 * 零 `@Inject()` 对方 use case); 反向 marketdata 侧采集闸读锚表同样走 Q7-B, 故无人 import 本 ctx。
 *
 * T001: ctx 物理落地 + 5 条机器强制注册面 (boundaries elements/rules ×2、check-server-moat
 * BUSINESS_CTX、business-naming、根 module 注册)。T006-T009 逐 task 接入写侧 usecase;
 * T010 接入读侧 + controller (鉴权沿用 AccountModule 导出的 JwtAuthGuard /
 * AccountIdThrottlerGuard, **不新增对外服务化面** — FR-009 本片零消费方)。
 */
@Module({
  // 061 T008: `MarketdataModule` 是本 ctx **唯一**一条 module 边 (plan D1)。它导出的
  // `REALTIME_QUOTE_PORT` / `MARKET_STATE_PORT` 两个 token 供盘中价 tick 强一致同步读 ——
  // 注入的是 **port token + interface** 而非对方的 use case (catalog Q7-C 放行判据),
  // 方向仍单向: marketdata 对锚表零感知。ESLint boundaries 本就放行 optionsdesk → marketdata。
  imports: [SecurityModule, AccountModule, MarketdataModule],
  // 059 guest 面**另起一个 controller**: 上面那个是类级 JwtAuthGuard, 类级 guard 摘不掉。
  // 072 审批面**另起第三个 controller**: 类级 AdminOnlyGuard 是构造上的保证,
  // 挂在上面那个共享 controller 上逐方法加 guard 则是会被未来某个 PR 悄悄漏掉的纪律。
  controllers: [OptionsdeskController, OptionsdeskGuestController, AnchorSubmissionController],
  providers: [
    // 072 待审箱审阅面
    ListAnchorSubmissionsUseCase,
    ApproveAnchorSubmissionUseCase,
    RejectAnchorSubmissionsUseCase,
    CreateAnchorUseCase,
    UpdateAnchorUseCase,
    DeleteAnchorUseCase,
    ReviewAnchorUseCase,
    // 047 T028 水位手选写端 —— 意图矩阵第三个输入的降级录入路径 (本片无数据面, FR-017)。
    SetPositionBucketUseCase,
    ListAnchorsUseCase,
    GetAnchorUseCase,
    GetAnchorAtUseCase,
    GetRadarUseCase,
    // 046 T015 详情读端 —— 唯一新增的跨 ctx 读边 (marketdata 的 IV 日快照, Q7-B 只读直查)。
    GetUnderlyingDetailUseCase,
    // 046 T017 温度计读端 —— 同上再加 marketdata 的指数日线 (VIX/VVIX), 同为 Q7-B 只读直查。
    GetThermometerUseCase,
    // 047 T027 选约表读端 —— 跨 ctx 只读直查 marketdata 三张期权/财报表 (Q7-B), 同为零 @Inject()。
    GetLegsUseCase,
    // 055 T005 标的链分析报表读端 —— 独立聚合读端点 (plan D-API-1)。跨 ctx 读**零新增**:
    // 链走检索 port、IV 分位复用 046 详情读端 (同 ctx 组合, plan D-CTX-1)。
    GetChainReportUseCase,
    // 052 T001 检索 port (ADR-0064 决策 4 —— ADR-0043 §4 三分法的第四类: 跨 ctx 只读查询)。
    // 🚨 **单实现**: 假实现 (`fake-leg-retrieval.adapter.ts`) 只服务测试, MUST NOT 注册在此;
    // 第二个运行时实现的触发条件是 ADR-0064 sunset #3 (规模突破阈值), 今天未命中。
    { provide: LEG_RETRIEVAL_PORT, useClass: PrismaLegRetrievalAdapter },
    // 059 T005/T006 模型导入 —— 无锚则建 (复用 CreateAnchorUseCase)、有锚则按模型语义刷新。
    // 🚨 **不复用 UpdateAnchorUseCase**: 它对 confidence_source='model' 的锚拒改 confidence,
    // 复用的表现是首日全绿、次日静默停止更新已有锚 (见该 use case 文件头三个雷)。
    ImportAnchorFromModelUseCase,
    // 059 待审收件箱写端 —— **不 import 任何锚写侧 use case**, 结构上保证「不存在第二条写锚路径」。
    SubmitAnchorFromGuestUseCase,
    SyncAnchorLastCloseUseCase,
    // 上一行那个 use case 的**触发器** —— 没有它 `last_close` 投影在 prod 永不执行
    // (045 T012 只定义了怎么算、没定义谁来调), 雷达的距 W% / zone / 复核锚红标全部出不了真值。
    SyncAnchorLastCloseScheduler,
    // 061 盘中价投影 —— 与上面那条**并列的第二列**, 不是替代: `last_close` 仍是当日收盘的
    // 权威值与一切降级的落脚点 (FR-015), 盘中两列只在 90 秒新鲜度闸内接管排序与呈现。
    SyncAnchorIntradayUseCase,
    // 它的触发器 (30 秒 tick + 熔断 + mock 闸 + 收盘补一拍)。mock 档下起手即 return,
    // 零 port 调用 —— dev 机上本 tick 完全静默 (Guardrail 6 第一层防线)。
    SyncAnchorIntradayScheduler,
  ],
})
export class OptionsdeskModule {}
