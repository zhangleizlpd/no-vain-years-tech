import { Inject, Injectable } from '@nestjs/common';
import { authConfig, type AuthConfig } from '../config/auth.config';
import { InspectAccountStatusUseCase } from '../account/inspect-account-status.usecase';
import { isWithinGrace } from '../account/account.rules';
import { DeletionCodeStore } from './deletion-code.store';
import { DELETION_CODE_TTL_MIN, SmsPurpose, hashDeletionCode } from './deletion-code.rules';
import { issueSmsCode } from './sms-code.rules';
import { SMS_GATEWAY, type SmsGateway } from './sms-gateway.port';
import { SmsSendFailedException } from './sms-send-failed.exception';
import { TIMING_DEFENSE_EXECUTOR, type TimingDefenseExecutor } from './timing-defense.port';

const MIN_MS = 60_000;

/**
 * SendCancelDeletionCode (auth 编排, **public unauthed**) —— 发撤销验证码
 * (FR-S07/S08/S18)。
 *
 * controller 已校验手机号格式 (E.164, 非法 422)。流: 经 account 读半段判账号生命
 * 周期 → **仅 eligible** (FROZEN ∧ freezeUntil>now, 复用 account.rules.isWithinGrace
 * 同一 `>` 边界) → 生成 6 位码 + HMAC → 落 account_sms_code (purpose=CANCEL_DELETION,
 * 10min, key=inspection 暴露的 accountId) → 发撤销 SMS (CANCEL_DELETION 模板)。
 *
 * 4 ineligible 分支 (未注册 / ACTIVE / ANONYMIZED / grace 已过即 freezeUntil<=now)
 * → 跑 dummy bcrypt pad (timing defense) 对齐时延 → 静默返回, **不写码、不发 SMS**。
 * eligible 与 ineligible 的 body / status / wall-clock 时延对外不可区分 (FR-S07 反枚举);
 * 控制器统一 200, 本 use case 一律返 void。
 *
 * 注: 这里 `freezeUntil>now` 是反枚举软门槛; 撤销的真正 exactly-once 闸在提交路径
 * (T020 commitAccountCancellation 的条件 UPDATE WHERE status=FROZEN AND freezeUntil>now)。
 */
@Injectable()
export class SendCancelDeletionCodeUseCase {
  constructor(
    // CROSS-CONTEXT-SYNC: auth→account 读账号生命周期判 eligible + 取 accountId (R2 只读)
    private readonly inspectAccountStatus: InspectAccountStatusUseCase,
    private readonly deletionCodeStore: DeletionCodeStore,
    @Inject(SMS_GATEWAY) private readonly smsGateway: SmsGateway,
    @Inject(TIMING_DEFENSE_EXECUTOR) private readonly timingDefense: TimingDefenseExecutor,
    @Inject(authConfig.KEY) private readonly authCfg: AuthConfig,
  ) {}

  async execute(phone: string): Promise<void> {
    const now = new Date();
    const inspection = await this.inspectAccountStatus.execute(phone);

    // eligible 仅 FROZEN-in-grace。其余 4 类 (NOT_FOUND / ACTIVE / ANONYMIZED /
    // FROZEN-grace 已过) → pad 对齐时延后静默返回, 不写码不发 SMS (字节级不可区分)。
    if (inspection.kind !== 'FROZEN' || !isWithinGrace(inspection.freezeUntil, now)) {
      await this.timingDefense.pad();
      return;
    }

    const code = issueSmsCode();
    const codeHash = hashDeletionCode(code, this.authCfg.smsCodeHmacSecret);
    const expiresAt = new Date(now.getTime() + DELETION_CODE_TTL_MIN * MIN_MS);
    await this.deletionCodeStore.issue(
      inspection.accountId,
      SmsPurpose.CANCEL_DELETION,
      codeHash,
      expiresAt,
    );

    try {
      await this.smsGateway.sendCode(phone, code, SmsPurpose.CANCEL_DELETION);
    } catch {
      // FR-S21: 网关失败 → 503, 不外泄底层细节。码已落库 → 过期自然清, 重试发新码。
      // (T007b 明列 T017 eligible 路径; 反枚举不可区分性在 SMS 成功的常态路径成立。)
      throw new SmsSendFailedException();
    }
  }
}
