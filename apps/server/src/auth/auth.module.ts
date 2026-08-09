import { Module } from '@nestjs/common';
import { ThrottlerModule, type ThrottlerOptions } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { Redis } from 'ioredis';
import {
  authConfig,
  redisConfig,
  smsConfig,
  wechatConfig,
  type AuthConfig,
  type RedisConfig,
  type SmsConfig,
  type WechatConfig,
} from '../config/index.js';
import { SecurityModule } from '../security/security.module.js';
import { AccountModule } from '../account/account.module.js';
import { REDIS_CLIENT } from '../security/redis.token.js';
import { hashRefreshToken } from '../security/refresh-token-hasher.js';
import { RETRY_EXECUTOR, type RetryExecutor } from './retry-executor.port.js';
import { SMS_GATEWAY } from './sms-gateway.port.js';
import { TIMING_DEFENSE_EXECUTOR } from './timing-defense.port.js';
import { PhoneSmsAuthUseCase } from './phone-sms-auth.usecase.js';
import { RequestSmsCodeUseCase } from './request-sms-code.usecase.js';
import { AliyunSmsGateway, type SmsTemplateOverrides } from './aliyun-sms.gateway.js';
import { SmsPurpose } from './deletion-code.rules.js';
import { DeletionCodeStore } from './deletion-code.store.js';
import { SendDeletionCodeUseCase } from './send-deletion-code.usecase.js';
import { DeleteAccountUseCase } from './delete-account.usecase.js';
import { SendCancelDeletionCodeUseCase } from './send-cancel-deletion-code.usecase.js';
import { CancelDeletionUseCase } from './cancel-deletion.usecase.js';
import { AccountDeletionController } from './account-deletion.controller.js';
import { CancelDeletionController } from './cancel-deletion.controller.js';
import { CancelCodePhoneThrottlerGuard } from './cancel-code-phone-throttler.guard.js';
import { AuthFailureLockService } from './auth-failure-lock.service.js';
import { BcryptTimingDefenseExecutor } from './bcrypt-timing-defense.executor.js';
import { CockatielRetryExecutor } from './cockatiel-retry.executor.js';
import { MockSmsGateway } from './mock-sms.gateway.js';
import { SmsCodeStore } from './sms-code.store.js';
import { AccountPhoneSmsAuthController } from './account-phone-sms-auth.controller.js';
import { AccountSmsCodeController } from './account-sms-code.controller.js';
import { AccountTokenController } from './account-token.controller.js';
import { RefreshTokenUseCase } from './refresh-token.usecase.js';
import { LogoutAllUseCase } from './logout-all.usecase.js';
import { DeviceManagementController } from './device-management.controller.js';
import { ListDevicesUseCase } from './list-devices.usecase.js';
import { RevokeDeviceUseCase } from './revoke-device.usecase.js';
import { JwtAccessGuard } from './jwt-access.guard.js';
import { SmsPhoneThrottlerGuard } from './sms-phone-throttler.guard.js';
import { WECHAT_AUTH } from './wechat-auth.port.js';
import { MockWechatAuthGateway } from './mock-wechat-auth.gateway.js';
import { BindWechatUseCase } from './bind-wechat.usecase.js';
import { SendUnbindWechatCodeUseCase } from './send-unbind-wechat-code.usecase.js';
import { UnbindWechatUseCase } from './unbind-wechat.usecase.js';
import { WechatBindingController } from './wechat-binding.controller.js';

/**
 * 005 设备 EP 限流桶 (FR-S13) —— 提取为模块常量,避免 ThrottlerModule useFactory
 * 超 max-lines-per-function。list 30/account·100/IP;revoke 5/account·20/IP (均 /60s)。
 * account 桶 getTracker 读 req.user.accountId (JwtAccessGuard 先填);IP 桶读 req.ip。
 */
const DEVICE_THROTTLERS: ThrottlerOptions[] = [
  {
    name: 'dev-list-account',
    limit: 30,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`dev-list-account:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
  {
    name: 'dev-list-ip',
    limit: 100,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const ip = req['ip'];
      return Promise.resolve(`dev-list-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
    },
  },
  {
    name: 'dev-revoke-account',
    limit: 5,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`dev-revoke-account:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
  {
    name: 'dev-revoke-ip',
    limit: 20,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const ip = req['ip'];
      return Promise.resolve(`dev-revoke-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
    },
  },
];

/**
 * 010 微信绑定/解绑 EP 限流桶 (FR-S06) —— 提取为模块常量 (同 DEVICE_THROTTLERS,
 * 避免 useFactory 超 max-lines)。bind 5/account·10/IP;unbind-code 1/account·5/IP;
 * unbind 5/account·10/IP (均 /60s)。account 桶 getTracker 读 req.user.accountId
 * (JwtAuthGuard 先填);IP 桶读 req.ip。
 */
const WECHAT_THROTTLERS: ThrottlerOptions[] = [
  {
    name: 'wx-bind',
    limit: 5,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`wx-bind:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
  {
    name: 'wx-bind-ip',
    limit: 10,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const ip = req['ip'];
      return Promise.resolve(`wx-bind-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
    },
  },
  {
    name: 'wx-unbind-code',
    limit: 1,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`wx-unbind-code:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
  {
    name: 'wx-unbind-code-ip',
    limit: 5,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const ip = req['ip'];
      return Promise.resolve(`wx-unbind-code-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
    },
  },
  {
    name: 'wx-unbind',
    limit: 5,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`wx-unbind:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
  {
    name: 'wx-unbind-ip',
    limit: 10,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const ip = req['ip'];
      return Promise.resolve(`wx-unbind-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
    },
  },
];

/**
 * 011 证券市场偏好 EP 限流桶 (FR-S08) —— 提取为模块常量 (同 DEVICE/WECHAT_THROTTLERS,
 * 避免 useFactory 超 max-lines)。get 60/60s · put 30/60s (plan D3), 均 per-account
 * (AccountIdThrottlerGuard 先填 req.user.accountId)。portfolio EP 复用全局 ThrottlerModule
 * (storage 跨 controller 共享, 故注册集中于此; PortfolioModule 经 @Throttle 名引用)。
 */
const MARKET_PREF_THROTTLERS: ThrottlerOptions[] = [
  {
    name: 'mkt-pref-get-account',
    limit: 60,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`mkt-pref-get-account:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
  {
    name: 'mkt-pref-put-account',
    limit: 30,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`mkt-pref-put-account:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
];

/**
 * 012 券商账户绑定 EP 限流桶 (FR-S08, plan D4) —— 提取为模块常量 (同 MARKET_PREF_THROTTLERS,
 * 避免 useFactory 超 max-lines)。get 60/60s · post 30/60s · delete 30/60s, 均 per-account
 * (AccountIdThrottlerGuard 先填 req.user.accountId)。broker EP 复用全局 ThrottlerModule
 * (storage 跨 controller 共享, 故注册集中于此; BrokerAccountsController 经 @Throttle 名引用)。
 */
const BROKER_ACCT_THROTTLERS: ThrottlerOptions[] = [
  {
    name: 'broker-acct-get-account',
    limit: 60,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`broker-acct-get-account:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
  {
    name: 'broker-acct-post-account',
    limit: 30,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`broker-acct-post-account:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
  {
    name: 'broker-acct-delete-account',
    limit: 30,
    ttl: 60_000,
    getTracker: (req: Record<string, unknown>) => {
      const user = req['user'] as { accountId?: unknown } | undefined;
      return Promise.resolve(`broker-acct-delete-account:${user?.accountId ?? 'unauthenticated'}`);
    },
  },
];

/**
 * 015 marketdata 读端点限流桶 (FR-S13) —— 提取为模块常量 (同 BROKER_ACCT_THROTTLERS)。
 * search 60/quote 120/detail 60/bars 60 (均 /60s), 均 per-account (AccountIdThrottlerGuard
 * 先填 req.user.accountId)。marketdata EP 复用全局 ThrottlerModule (storage 跨 controller 共享,
 * 故注册集中于此; MarketdataController 经 @Throttle 名引用)。search 桶端点落 PR3 (T014)。
 */
const MARKETDATA_THROTTLERS: ThrottlerOptions[] = (
  [
    ['mktdata-search-account', 60],
    ['mktdata-quote-account', 120],
    ['mktdata-detail-account', 60],
    ['mktdata-bars-account', 60],
  ] as const
).map(([name, limit]) => ({
  name,
  limit,
  ttl: 60_000,
  getTracker: (req: Record<string, unknown>) => {
    const user = req['user'] as { accountId?: unknown } | undefined;
    return Promise.resolve(`${name}:${user?.accountId ?? 'unauthenticated'}`);
  },
}));

/**
 * 013 自选列表限流桶 (FR-S08, plan D5) —— 提取为模块常量 (同 MARKETDATA_THROTTLERS)。
 * read 120/write 60 (均 /60s), 均 per-account (AccountIdThrottlerGuard 先填 req.user.accountId)。
 * watchlist EP 复用全局 ThrottlerModule (storage 跨 controller 共享, 故注册集中于此;
 * WatchlistGroupsController / WatchlistItemsController 经 @Throttle 名引用)。items 桶端点落 T009。
 */
const WATCHLIST_THROTTLERS: ThrottlerOptions[] = (
  [
    ['watchlist-read-account', 120],
    ['watchlist-write-account', 60],
  ] as const
).map(([name, limit]) => ({
  name,
  limit,
  ttl: 60_000,
  getTracker: (req: Record<string, unknown>) => {
    const user = req['user'] as { accountId?: unknown } | undefined;
    return Promise.resolve(`${name}:${user?.accountId ?? 'unauthenticated'}`);
  },
}));

/**
 * 021 alert 预警限流桶 (plan §API Contracts) —— 提取为模块常量 (同 WATCHLIST_THROTTLERS)。
 * read 120/write 30 (均 /60s), 均 per-account (AccountIdThrottlerGuard 先填 req.user.accountId)。
 * alert EP 复用全局 ThrottlerModule (storage 跨 controller 共享, 故注册集中于此;
 * AlertsController / AlertMessagesController 经 @Throttle 名引用)。
 */
const ALERT_THROTTLERS: ThrottlerOptions[] = (
  [
    ['alert-read-account', 120],
    ['alert-write-account', 30],
  ] as const
).map(([name, limit]) => ({
  name,
  limit,
  ttl: 60_000,
  getTracker: (req: Record<string, unknown>) => {
    const user = req['user'] as { accountId?: unknown } | undefined;
    return Promise.resolve(`${name}:${user?.accountId ?? 'unauthenticated'}`);
  },
}));

/**
 * 025 持仓导入/读限流桶 (plan §API Contracts) —— 提取为模块常量 (同 ALERT_THROTTLERS)。
 * import 6/60s · read 120/60s (EP2/EP3 共用), per-account (AccountIdThrottlerGuard
 * 先填 req.user.accountId)。portfolio EP 复用全局 ThrottlerModule (storage 跨
 * controller 共享, 故注册集中于此; 025 各 controller 经 @Throttle 名引用)。
 */
const PORTFOLIO_HOLDINGS_THROTTLERS: ThrottlerOptions[] = (
  [
    ['portfolio-import-account', 6],
    ['portfolio-holdings-read-account', 120],
  ] as const
).map(([name, limit]) => ({
  name,
  limit,
  ttl: 60_000,
  getTracker: (req: Record<string, unknown>) => {
    const user = req['user'] as { accountId?: unknown } | undefined;
    return Promise.resolve(`${name}:${user?.accountId ?? 'unauthenticated'}`);
  },
}));

/**
 * 027 chat AI 对话限流桶 (plan §Cross-cutting) —— 提取为模块常量 (同
 * PORTFOLIO_HOLDINGS_THROTTLERS)。read 120/60s (取消息) · write 30/60s (建会话 +
 * T007 SSE 发消息), 均 per-account (AccountIdThrottlerGuard 先填 req.user.accountId)。
 * chat EP 复用全局 ThrottlerModule (storage 跨 controller 共享, 故注册集中于此;
 * ConversationController + T007 ChatStreamController 经 @Throttle 名引用)。
 */
const CHAT_THROTTLERS: ThrottlerOptions[] = (
  [
    ['chat-read-account', 120],
    ['chat-write-account', 30],
  ] as const
).map(([name, limit]) => ({
  name,
  limit,
  ttl: 60_000,
  getTracker: (req: Record<string, unknown>) => {
    const user = req['user'] as { accountId?: unknown } | undefined;
    return Promise.resolve(`${name}:${user?.accountId ?? 'unauthenticated'}`);
  },
}));

/**
 * 032 ideation 灵感会话 EP 限流桶 (T007 CRUD/生命周期 + T008/T009 SSE) — 均 per-account
 * (AccountIdThrottlerGuard 先填 req.user.accountId)。ideation EP 复用全局 ThrottlerModule
 * (storage 跨 controller 共享, 故注册集中于此; SessionController 经 @Throttle 名引用)。
 * read 120/60s (列/查) · write 30/60s (建/删/重开)。镜像 CHAT_THROTTLERS。
 */
const IDEATION_THROTTLERS: ThrottlerOptions[] = (
  [
    ['ideation-read-account', 120],
    ['ideation-write-account', 30],
  ] as const
).map(([name, limit]) => ({
  name,
  limit,
  ttl: 60_000,
  getTracker: (req: Record<string, unknown>) => {
    const user = req['user'] as { accountId?: unknown } | undefined;
    return Promise.resolve(`${name}:${user?.accountId ?? 'unauthenticated'}`);
  },
}));

/**
 * 045 optionsdesk 锚管理 + 击球区雷达 EP 限流桶 (T010 锚 CRUD/复审/PIT + T013 雷达) — 均
 * per-account (AccountIdThrottlerGuard 先填 req.user.accountId)。optionsdesk EP 复用全局
 * ThrottlerModule (storage 跨 controller 共享, 故注册集中于此; OptionsdeskController 经
 * @Throttle 名引用)。read 120/60s · write 30/60s。镜像 IDEATION_THROTTLERS。
 */
const OPTIONSDESK_THROTTLERS: ThrottlerOptions[] = (
  [
    ['optionsdesk-read-account', 120],
    ['optionsdesk-write-account', 30],
  ] as const
).map(([name, limit]) => ({
  name,
  limit,
  ttl: 60_000,
  getTracker: (req: Record<string, unknown>) => {
    const user = req['user'] as { accountId?: unknown } | undefined;
    return Promise.resolve(`${name}:${user?.accountId ?? 'unauthenticated'}`);
  },
}));

/**
 * Auth bounded context (per ADR-0032 + post-A-002 retro).
 *
 * The编排 layer — composes SecurityModule (token + DB + Redis) + AccountModule
 * (account aggregate + JwtAuthGuard) to implement the phone-sms-auth use case
 * (login = register, SMS-code based, anti-enumeration timing defense).
 *
 * Owns:
 *   - SMS code domain (sms-code.vo) + SmsCodeStore (Redis-backed concrete
 *     service per ADR-0043 §4) + Aliyun/mock gateway + bcrypt-timing-defense
 *   - phone-sms-auth + request-sms-code use cases (编排 — 直注 PrismaService
 *     读写 account 表 + JwtTokenService (via SecurityModule), per ADR-0043
 *     扁平贫血: 无 repository port)
 *   - phone/sms throttler guards (FR-S07)
 *   - ProblemDetailFilter (global APP_FILTER; PR-5 will refactor with
 *     traceId / invalidAttributes per ADR-0038)
 *   - Global ThrottlerModule with 5 throttlers (sms-* + me-* mixed —
 *     me-* registration stays here because the storage layer is shared
 *     across all controllers; AccountModule consumes via @Throttle()
 *     decorators from the global instance)
 */
@Module({
  imports: [
    SecurityModule,
    AccountModule,
    ThrottlerModule.forRootAsync({
      inject: [redisConfig.KEY],
      useFactory: (cfg: RedisConfig) => {
        return {
          throttlers: [
            // FR-S07 第 1 条: sms:<phone> 60s 1 次 (default → 标准 Retry-After)
            { limit: 1, ttl: 60_000 },
            // FR-S07 第 2 条: sms:<phone> 24h 10 次 (复用 guard phone tracker)
            { name: 'sms-phone-24h', limit: 10, ttl: 86_400_000 },
            // FR-S07 第 3 条: sms:<ip> 24h 50 次 (per-throttler getTracker = IP)
            {
              name: 'sms-ip-24h',
              limit: 50,
              ttl: 86_400_000,
              getTracker: (req: Record<string, unknown>) => {
                const ip = req['ip'];
                return Promise.resolve(`ip:${typeof ip === 'string' ? ip : 'unknown'}`);
              },
            },
            // FR-008: GET /me 60s 60 次, tracker = accountId (JwtAuthGuard 先行，req.user 已填)
            {
              name: 'me-get',
              limit: 60,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const user = req['user'] as { accountId?: string } | undefined;
                return Promise.resolve(`me:${user?.accountId ?? 'unauthenticated'}`);
              },
            },
            // FR-008: PATCH /me 60s 10 次, tracker = accountId
            {
              name: 'me-patch',
              limit: 10,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const user = req['user'] as { accountId?: string } | undefined;
                return Promise.resolve(`me:${user?.accountId ?? 'unauthenticated'}`);
              },
            },
            // FR-S14: refresh-token EP per-IP 100/60s
            {
              name: 'refresh-ip',
              limit: 100,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const ip = req['ip'];
                return Promise.resolve(`refresh-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
              },
            },
            // FR-S14: refresh-token EP per-token-hash 5/60s (键 = refresh:<sha256(token)>)
            {
              name: 'refresh-token',
              limit: 5,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const body = req['body'] as { refreshToken?: unknown } | undefined;
                const raw = body && typeof body.refreshToken === 'string' ? body.refreshToken : '';
                return Promise.resolve(`refresh:${raw ? hashRefreshToken(raw) : 'empty'}`);
              },
            },
            // FR-S14: logout-all EP per-IP 50/60s
            {
              name: 'logout-all-ip',
              limit: 50,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const ip = req['ip'];
                return Promise.resolve(`logout-all-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
              },
            },
            // FR-S14: logout-all EP per-account 5/60s (JwtAccessGuard 先填 req.user)
            {
              name: 'logout-all-account',
              limit: 5,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const user = req['user'] as { accountId?: unknown } | undefined;
                return Promise.resolve(
                  `logout-all-account:${user?.accountId ?? 'unauthenticated'}`,
                );
              },
            },
            // FR-S18 (004 EP1 注销发码): per-account 1/60s (JwtAuthGuard 先填 req.user)
            {
              name: 'del-code-account',
              limit: 1,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const user = req['user'] as { accountId?: unknown } | undefined;
                return Promise.resolve(`del-code-account:${user?.accountId ?? 'unauthenticated'}`);
              },
            },
            // FR-S18 (004 EP1 注销发码): per-IP 5/60s
            {
              name: 'del-code-ip',
              limit: 5,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const ip = req['ip'];
                return Promise.resolve(`del-code-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
              },
            },
            // FR-S18 (004 EP2 注销提交): per-account 5/60s (JwtAuthGuard 先填 req.user)
            {
              name: 'del-submit-account',
              limit: 5,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const user = req['user'] as { accountId?: unknown } | undefined;
                return Promise.resolve(
                  `del-submit-account:${user?.accountId ?? 'unauthenticated'}`,
                );
              },
            },
            // FR-S18 (004 EP2 注销提交): per-IP 10/60s
            {
              name: 'del-submit-ip',
              limit: 10,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const ip = req['ip'];
                return Promise.resolve(`del-submit-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
              },
            },
            // FR-S18 (004 EP3 撤销发码, public): per-phone-hash 1/60s。无自带 getTracker
            // → 走 CancelCodePhoneThrottlerGuard 的 phone-hash tracker (不明文落限流器)。
            { name: 'cancel-code', limit: 1, ttl: 60_000 },
            // FR-S18 (004 EP3 撤销发码, public): per-IP 5/60s
            {
              name: 'cancel-code-ip',
              limit: 5,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const ip = req['ip'];
                return Promise.resolve(`cancel-code-ip:${typeof ip === 'string' ? ip : 'unknown'}`);
              },
            },
            // FR-S18 (004 EP4 撤销提交, public): per-phone-hash 5/60s。无自带 getTracker
            // → 走 CancelCodePhoneThrottlerGuard 的 phone-hash tracker (同 EP3 复用)。
            { name: 'cancel-submit', limit: 5, ttl: 60_000 },
            // FR-S18 (004 EP4 撤销提交, public): per-IP 10/60s
            {
              name: 'cancel-submit-ip',
              limit: 10,
              ttl: 60_000,
              getTracker: (req: Record<string, unknown>) => {
                const ip = req['ip'];
                return Promise.resolve(
                  `cancel-submit-ip:${typeof ip === 'string' ? ip : 'unknown'}`,
                );
              },
            },
            // FR-S13 (005) 设备列表 + 单设备撤销 4 桶 (auth EP, 提取到模块常量见下)
            ...DEVICE_THROTTLERS,
            // FR-S06 (010) 微信绑定/解绑发码/解绑提交 6 桶 (auth EP, 提取到模块常量见下)
            ...WECHAT_THROTTLERS,
            // FR-S08 (011) 证券市场偏好 get/put 2 桶 (portfolio EP, 提取到模块常量见上)
            ...MARKET_PREF_THROTTLERS,
            // FR-S08 (012) 券商账户 get/post/delete 3 桶 (portfolio EP, 提取到模块常量见上)
            ...BROKER_ACCT_THROTTLERS,
            // FR-S13 (015) marketdata 搜索/报价/详情/K线 4 桶 (marketdata EP, 提取到模块常量见上)
            ...MARKETDATA_THROTTLERS,
            // FR-S08 (013) 自选列表 read/write 2 桶 (portfolio EP, 提取到模块常量见上)
            ...WATCHLIST_THROTTLERS,
            // 021 alert 预警 read/write 2 桶 (alert EP, 提取到模块常量见上)
            ...ALERT_THROTTLERS,
            // 025 持仓导入/读 2 桶 (portfolio EP, 提取到模块常量见上)
            ...PORTFOLIO_HOLDINGS_THROTTLERS,
            // 027 chat 会话 read/write 2 桶 (chat EP, 提取到模块常量见上)
            ...CHAT_THROTTLERS,
            ...IDEATION_THROTTLERS,
            ...OPTIONSDESK_THROTTLERS,
          ],
          storage: new ThrottlerStorageRedisService(cfg.url),
        };
      },
    }),
  ],
  controllers: [
    AccountSmsCodeController,
    AccountPhoneSmsAuthController,
    AccountTokenController,
    AccountDeletionController,
    CancelDeletionController,
    DeviceManagementController,
    WechatBindingController,
  ],
  providers: [
    {
      // Per ADR-0023: HMAC-SHA256 + timingSafeEqual 替换 bcrypt cost=12.
      // SMS_CODE_HMAC_SECRET fail-fast at boot via authConfig Zod schema.
      // Concrete service (no port) per ADR-0043 §4 — 自有非 DB 基建。
      provide: SmsCodeStore,
      useFactory: (redis: Redis, cfg: AuthConfig) => new SmsCodeStore(redis, cfg.smsCodeHmacSecret),
      inject: [REDIS_CLIENT, authConfig.KEY],
    },
    {
      // smsConfig is a discriminated union: kind='mock' (default) or
      // kind='aliyun' (Aliyun creds validated at boot — partial config rejected).
      provide: SMS_GATEWAY,
      useFactory: (cfg: SmsConfig, retryExecutor: RetryExecutor) => {
        if (cfg.kind === 'aliyun') {
          const client = AliyunSmsGateway.createClient({
            accessKeyId: cfg.accessKeyId,
            accessKeySecret: cfg.accessKeySecret,
            signName: cfg.signName,
            templateCode: cfg.templateCode,
          });
          // purpose → 模板覆盖 (注销/撤销码独立模板, FR-S05/S08); 缺配置 → 回退默认。
          const templateOverrides: SmsTemplateOverrides = {};
          if (cfg.deleteAccountTemplateCode) {
            templateOverrides[SmsPurpose.DELETE_ACCOUNT] = cfg.deleteAccountTemplateCode;
          }
          if (cfg.cancelDeletionTemplateCode) {
            templateOverrides[SmsPurpose.CANCEL_DELETION] = cfg.cancelDeletionTemplateCode;
          }
          return new AliyunSmsGateway(
            client,
            cfg.signName,
            cfg.templateCode,
            retryExecutor,
            templateOverrides,
          );
        }
        return new MockSmsGateway();
      },
      inject: [smsConfig.KEY, RETRY_EXECUTOR],
    },
    {
      // wechatConfig discriminated union: kind='mock' (Phase 1 stub, default) or
      // kind='real' (Phase 2 native adapter, T029)。Phase 1 仅交付 mock stub；绑定端点是桩、
      // 无生产消费方 —— prod 也按 mock boot，待 Phase 2 real 适配器 (T029) 落地后再收紧 prod 守卫。
      provide: WECHAT_AUTH,
      useFactory: (cfg: WechatConfig) => {
        if (cfg.kind === 'real') {
          // Phase 2 real adapter (T029) 未实现 —— Phase 1 仅交付 mock stub。
          throw new Error('WechatAuthGateway (real) lands in Phase 2 (T029)');
        }
        return new MockWechatAuthGateway();
      },
      inject: [wechatConfig.KEY],
    },
    { provide: TIMING_DEFENSE_EXECUTOR, useClass: BcryptTimingDefenseExecutor },
    { provide: RETRY_EXECUTOR, useClass: CockatielRetryExecutor },
    AuthFailureLockService,
    RequestSmsCodeUseCase,
    PhoneSmsAuthUseCase,
    RefreshTokenUseCase,
    LogoutAllUseCase,
    ListDevicesUseCase,
    RevokeDeviceUseCase,
    DeletionCodeStore,
    SendDeletionCodeUseCase,
    DeleteAccountUseCase,
    SendCancelDeletionCodeUseCase,
    CancelDeletionUseCase,
    BindWechatUseCase,
    SendUnbindWechatCodeUseCase,
    UnbindWechatUseCase,
    JwtAccessGuard,
    SmsPhoneThrottlerGuard,
    CancelCodePhoneThrottlerGuard,
    // ProblemDetailFilter (APP_FILTER) moved to SecurityModule in PR-5a —
    // it's a cross-context concern, owned by the platform infra layer.
  ],
})
export class AuthModule {}
