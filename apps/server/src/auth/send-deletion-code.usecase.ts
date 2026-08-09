import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { authConfig, type AuthConfig } from '../config/auth.config';
import { InspectAccountStatusByIdUseCase } from '../account/inspect-account-status-by-id.usecase';
import { DeletionCodeStore } from './deletion-code.store';
import { DELETION_CODE_TTL_MIN, SmsPurpose, hashDeletionCode } from './deletion-code.rules';
import { issueSmsCode } from './sms-code.rules';
import { SMS_GATEWAY, type SmsGateway } from './sms-gateway.port';
import { SmsSendFailedException } from './sms-send-failed.exception';

const MIN_MS = 60_000;

/**
 * SendDeletionCode (auth 编排, authed) —— 发注销验证码 (FR-S01/S02/S18/S21)。
 *
 * accountId 来自 JWT (controller 透传)。流: 经 account 读半段判定账号状态门槛
 * (仅 ACTIVE 可发码) → 非 ACTIVE 折叠成反枚举 401 `INVALID_CREDENTIALS` (不披露
 * 账号是否存在 / 已冻结 / 已注销) → 生成 6 位码 + HMAC → 落 account_sms_code
 * (purpose=DELETE_ACCOUNT, 10min) → 发 SMS (DELETE_ACCOUNT 模板)。SMS 发送失败
 * → 503 `SMS_SEND_FAILED` (FR-S21, 码已落库, 过期自然清, 用户重试发新码)。
 */
@Injectable()
export class SendDeletionCodeUseCase {
  constructor(
    // CROSS-CONTEXT-SYNC: auth→account 读账号状态门槛 + 取手机号发码 (R2 只读)
    private readonly inspectAccountStatusById: InspectAccountStatusByIdUseCase,
    private readonly deletionCodeStore: DeletionCodeStore,
    @Inject(SMS_GATEWAY) private readonly smsGateway: SmsGateway,
    @Inject(authConfig.KEY) private readonly authCfg: AuthConfig,
  ) {}

  async execute(accountId: bigint): Promise<void> {
    const inspection = await this.inspectAccountStatusById.execute(accountId);
    if (inspection.kind !== 'ACTIVE') {
      // 反枚举折叠: NOT_FOUND / FROZEN / ANONYMIZED 一律同一 401, 字节级一致。
      throw new UnauthorizedException('INVALID_CREDENTIALS');
    }

    const code = issueSmsCode();
    const codeHash = hashDeletionCode(code, this.authCfg.smsCodeHmacSecret);
    const expiresAt = new Date(Date.now() + DELETION_CODE_TTL_MIN * MIN_MS);
    await this.deletionCodeStore.issue(accountId, SmsPurpose.DELETE_ACCOUNT, codeHash, expiresAt);

    try {
      await this.smsGateway.sendCode(inspection.phone, code, SmsPurpose.DELETE_ACCOUNT);
    } catch {
      // 网关失败不外泄底层细节 (FR-S21)。码已落库 → 过期自然清, 重试发新码。
      throw new SmsSendFailedException();
    }
  }
}
