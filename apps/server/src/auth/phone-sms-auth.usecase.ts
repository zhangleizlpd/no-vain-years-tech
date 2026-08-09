// GOLDEN SAMPLE — server 跨 ctx 档。新跨 bounded context 编排 use case 起手对照此文件
// （+ 写半段 account/commit-phone-login.usecase.ts）。正向教训 = 两段式 Inspect（只读）/
// Commit（写）护城河 + 注入点上的 CROSS-CONTEXT-SYNC 注释（per ADR-0043）。⚠ 其 timing
// pad + 反枚举折叠是 public auth 探测面专属（见就地标注），非跨 ctx 通用范式。
// 分层声明见 docs/conventions/server-impl-playbook.md § Golden Sample。
import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { SmsCodeStore } from './sms-code.store';
import { InspectAccountStatusUseCase } from '../account/inspect-account-status.usecase';
import { CommitPhoneLoginUseCase } from '../account/commit-phone-login.usecase';
import { TIMING_DEFENSE_EXECUTOR, type TimingDefenseExecutor } from './timing-defense.port';
import { AuthFailureLockService } from './auth-failure-lock.service';
import { JwtTokenService } from '../security/jwt-token.service';
import { RefreshTokenService } from '../security/refresh-token.service';
import { AccountInFreezePeriodException } from '../account/account-in-freeze-period.exception';

export interface PhoneSmsAuthResult {
  accountId: bigint;
  accessToken: string;
  refreshToken: string;
}

/**
 * 登录设备上下文 —— 由控制器从 x-device-id / x-device-name / x-device-type 头 + 请求 IP
 * 透传 (签发即持久化用)。deviceName/deviceType 为 005 采集补强 (FR-S14): client 已发,
 * 不带头时 persist 降级 deviceName=null / deviceType=UNKNOWN (既有行为)。
 */
export interface LoginDeviceContext {
  deviceId?: string;
  deviceName?: string;
  deviceType?: string;
  clientIp?: string | null;
}

/**
 * phone-sms-auth 编排 (per ADR-0032 auth = 编排层 + ADR-0043 两段式委托护城河)。
 *
 * auth 不碰 `prisma.account.*` —— account 表的读/写全部委托给 account context
 * 的 use case (R2 跨 ctx sync,DI 注入):
 *   1. InspectAccountStatusUseCase (read) → 状态判定,反枚举防御先于 verifyCode。
 *   2. 验证短信码 (auth 自有 SmsCodeStore)。
 *   3. CommitPhoneLoginUseCase (write) → find-or-create + record login + 事件。
 *   4. RefreshTokenService.persist (write, security) → 签发即落库 refresh-token。
 */
@Injectable()
export class PhoneSmsAuthUseCase {
  constructor(
    private readonly smsCodeStore: SmsCodeStore,
    private readonly jwtTokenService: JwtTokenService,
    // CROSS-CONTEXT-SYNC: auth → account 读状态 (两段式 Saga 第 1 段,只读)
    private readonly inspectAccountStatus: InspectAccountStatusUseCase,
    // CROSS-CONTEXT-SYNC: auth → account 落地登录/注册 (第 2 段,写)
    private readonly commitPhoneLogin: CommitPhoneLoginUseCase,
    @Inject(TIMING_DEFENSE_EXECUTOR)
    private readonly timingDefense: TimingDefenseExecutor,
    private readonly authFailureLock: AuthFailureLockService,
    // CROSS-CONTEXT-SYNC: auth → security 持久化 refresh-token (签发即落库)
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  async execute(
    phone: string,
    code: string,
    device: LoginDeviceContext = {},
  ): Promise<PhoneSmsAuthResult> {
    // FR-S07 #4: lock check — locked phone 直接 throw 429 + Retry-After。
    await this.authFailureLock.assertNotLocked(phone);
    try {
      return await this.executeInternal(phone, code, device);
    } catch (err) {
      // 仅 UnauthorizedException 算认证失败 (码错 / 码过期 / ANONYMIZED 反枚举)。
      // FROZEN 抛 AccountInFreezePeriodException 不算失败 (合法 403)。
      if (err instanceof UnauthorizedException) {
        await this.authFailureLock.recordFailure(phone);
      }
      throw err;
    }
  }

  private async executeInternal(
    phone: string,
    code: string,
    device: LoginDeviceContext,
  ): Promise<PhoneSmsAuthResult> {
    // 状态判定必须先于 verifyCode (反枚举时序,per CL-006)。
    const inspection = await this.inspectAccountStatus.execute(phone);

    // CL-006 FROZEN disclosure — 403 + freezeUntil, NOT in timing pad scope.
    if (inspection.kind === 'FROZEN') {
      throw new AccountInFreezePeriodException(inspection.freezeUntil ?? new Date());
    }

    // ⚠ 反枚举折叠 + dummy timing pad 本 feature 专属（public 无 token 探测面），
    // 标准跨 ctx use case 勿照抄 → 见 server-impl-playbook S1。
    // CL-006 ANONYMIZED anti-enumeration — 401 + dummy bcrypt timing pad.
    if (inspection.kind === 'ANONYMIZED') {
      await this.timingDefense.pad();
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    // ACTIVE 或 NOT_FOUND → 验证短信码 (码必须先匹配才允许登录 / 自动注册)。
    const verifyResult = await this.smsCodeStore.verify(phone, code);
    if (verifyResult !== true) {
      // FR-S06 timing defense: 码错 / 码过期 / 未注册+码错 → pad before throw.
      await this.timingDefense.pad();
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    await this.smsCodeStore.clear(phone);

    // 验证通过 → 委托 account context 落地 (login 更新 lastLoginAt / 注册 create+event)。
    const { accountId } = await this.commitPhoneLogin.execute(phone);

    const accessToken = this.jwtTokenService.signAccessToken({ accountId });
    const refreshToken = this.jwtTokenService.generateRefreshToken();

    // 签发即持久化: 登录成功后落 1 条 active refresh-token 行 (device 血缘 + IP)。
    await this.refreshTokenService.persist(accountId, refreshToken, {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      deviceType: device.deviceType,
      clientIp: device.clientIp,
      loginMethod: 'PHONE_SMS',
    });

    return { accountId, accessToken, refreshToken };
  }
}
