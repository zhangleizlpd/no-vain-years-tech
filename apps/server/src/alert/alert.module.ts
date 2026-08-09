import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module.js';
import { AccountModule } from '../account/account.module.js';
import { jpushConfig, type JpushConfig } from '../config/index.js';
import { CreateAlertsBatchUseCase } from './create-alerts-batch.usecase.js';
import { UpdateAlertUseCase } from './update-alert.usecase.js';
import { DeleteAlertsBatchUseCase } from './delete-alerts-batch.usecase.js';
import { ListInstrumentAlertsUseCase } from './list-instrument-alerts.usecase.js';
import { ListAlertsUseCase } from './list-alerts.usecase.js';
import { ListMessagesUseCase } from './list-messages.usecase.js';
import { GetUnreadCountUseCase } from './get-unread-count.usecase.js';
import { MarkMessagesReadUseCase } from './mark-messages-read.usecase.js';
import { EvaluateAlertsUseCase } from './evaluate-alerts.usecase.js';
import { EvaluateIntradayAlertsUseCase } from './evaluate-intraday-alerts.usecase.js';
import { DispatchPushDeliveriesUseCase } from './dispatch-push-deliveries.usecase.js';
import { UpsertPushBindingUseCase } from './upsert-push-binding.usecase.js';
import { DeletePushBindingUseCase } from './delete-push-binding.usecase.js';
import { alertQueueRedisProviders } from './alert-queue-connection.js';
import { PUSH_GATEWAY } from './push-gateway.port.js';
import { MockPushGateway } from './mock-push.gateway.js';
import { JpushPushGateway } from './jpush-push.gateway.js';
import { AlertEvalQueue, AlertEvalWorker } from './alert-eval.processor.js';
import { IntradayEvalProcessor } from './intraday-eval.processor.js';
import { REALTIME_QUOTE_PORT } from './realtime-quote.port.js';
import { TencentRealtimeAdapter } from './tencent-realtime.adapter.js';
import { SinaRealtimeAdapter } from './sina-realtime.adapter.js';
import { RealtimeQuoteFallbackChainAdapter } from './realtime-quote-fallback-chain.adapter.js';
import { PushDispatchQueue, PushDispatchWorker } from './push-dispatch.processor.js';
import { AlertsController } from './alerts.controller.js';
import { AlertMessagesController } from './messages.controller.js';
import { PushBindingController } from './push-binding.controller.js';

/**
 * alert bounded context (021, 第 6 个 — 与 security/account/auth/portfolio/marketdata
 * 平级, per ADR-0052 / ADR-0032 Q4)。EOD 价格预警: CRUD + 调度自治评估引擎 + 应用内
 * 消息中心 (AlertTrigger 兼任消息源 + per-account 已读水位线)。
 *
 * 依赖 SecurityModule (PrismaService + Redis + 全局 ProblemDetailFilter + JwtModule)
 * + AccountModule (JwtAuthGuard + AccountIdThrottlerGuard, account-bound 鉴权 artefact
 * 经 export 复用 — 非业务 use-case 调用, 无 R2/R3 跨 ctx 注释)。alert 是**叶子**:
 * 零跨 ctx 业务调用; 对 marketdata 仅 Q7-B Prisma 只读直查 (CROSS-CONTEXT-READ 注释,
 * moat 探针强制), 无 import 依赖; 无人依赖 alert。
 *
 * PR-1 (T003-T006): CRUD 5 端点 + 消息 3 端点。PR-2 (T010-T012): 评估引擎 — 自持
 * BullMQ queue `alert-eval` (repeatable 23:00 + 08:00 catch-up, Asia/Shanghai) +
 * worker (CLI sentinel 启停门) + 评估 UC (Q7-B 只读 + 触发 tx 三档后置)。
 */
@Module({
  imports: [SecurityModule, AccountModule],
  controllers: [AlertsController, AlertMessagesController, PushBindingController],
  providers: [
    CreateAlertsBatchUseCase,
    UpdateAlertUseCase,
    DeleteAlertsBatchUseCase,
    ListInstrumentAlertsUseCase,
    ListAlertsUseCase,
    ListMessagesUseCase,
    GetUnreadCountUseCase,
    MarkMessagesReadUseCase,
    EvaluateAlertsUseCase,
    EvaluateIntradayAlertsUseCase,
    DispatchPushDeliveriesUseCase,
    UpsertPushBindingUseCase,
    DeletePushBindingUseCase,
    ...alertQueueRedisProviders,
    AlertEvalQueue,
    AlertEvalWorker,
    IntradayEvalProcessor,
    PushDispatchQueue,
    PushDispatchWorker,
    {
      // jpushConfig is a discriminated union: kind='mock' (default) or
      // kind='jpush' (极光 creds boot-time validated — partial config rejected)。
      // 推送出口 vendor I/O (022 T002), per ADR-0052 复审记录: 非跨 ctx 边。
      provide: PUSH_GATEWAY,
      useFactory: (cfg: JpushConfig) =>
        cfg.kind === 'jpush'
          ? new JpushPushGateway(cfg.appKey, cfg.masterSecret)
          : new MockPushGateway(),
      inject: [jpushConfig.KEY],
    },
    {
      // 024 实时行情 port (plan D2): 腾讯主 → 新浪备 FallbackChain (alert ctx 自持外部 IO,
      // 不 import marketdata)。adapter 用 realtime-fetch.ts 默认轻量 fetch (无 DI 依赖)。
      provide: REALTIME_QUOTE_PORT,
      useFactory: () =>
        new RealtimeQuoteFallbackChainAdapter([
          new TencentRealtimeAdapter(),
          new SinaRealtimeAdapter(),
        ]),
    },
  ],
})
export class AlertModule {}
