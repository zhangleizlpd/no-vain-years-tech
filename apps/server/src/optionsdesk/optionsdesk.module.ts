import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module.js';
import { AccountModule } from '../account/account.module.js';
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
import { SyncAnchorQuoteUseCase } from './sync-anchor-quote.js';
import { SyncAnchorQuoteScheduler } from './sync-anchor-quote.scheduler.js';
import { OptionsdeskController } from './optionsdesk.controller.js';

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
  imports: [SecurityModule, AccountModule],
  controllers: [OptionsdeskController],
  providers: [
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
    SyncAnchorQuoteUseCase,
    // 上一行那个 use case 的**触发器** —— 没有它 `last_close` 投影在 prod 永不执行
    // (045 T012 只定义了怎么算、没定义谁来调), 雷达的距 W% / zone / 复核锚红标全部出不了真值。
    SyncAnchorQuoteScheduler,
  ],
})
export class OptionsdeskModule {}
