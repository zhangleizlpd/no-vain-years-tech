import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { authConfig, type AuthConfig } from '../config/auth.config';
import { InspectAccountStatusByIdUseCase } from '../account/inspect-account-status-by-id.usecase';
import { InspectWechatBindingUseCase } from '../account/inspect-wechat-binding.usecase';
import { DeletionCodeStore } from './deletion-code.store';
import { DELETION_CODE_TTL_MIN, SmsPurpose, hashDeletionCode } from './deletion-code.rules';
import { issueSmsCode } from './sms-code.rules';
import { SMS_GATEWAY, type SmsGateway } from './sms-gateway.port';
import { SmsSendFailedException } from './sms-send-failed.exception';

const MIN_MS = 60_000;

/**
 * SendUnbindWechatCode (auth 编排, authed) —— 发微信解绑验证码 (010 FR-S03/S08,
 * 1:1 镜像 SendDeletionCode + 多一道绑定门槛)。
 *
 * accountId 来自 JWT。流: 读账号状态门槛 (仅 ACTIVE) + 读绑定门槛 (已绑微信) →
 * 任一不满足 (非 ACTIVE 或 未绑) 折叠字节级一致 401 `INVALID_CREDENTIALS` (FR-S03
 * 反枚举, 不披露账号是否存在 / 是否已绑) → 生成 6 位码 + HMAC → 落 account_sms_code
 * (purpose=UNBIND_WECHAT, 10min) → 发 SMS (UNBIND_WECHAT)。两道 inspect 恒执行
 * (constant work) 再 fold, 保时延均一。MUST NOT 改绑定、MUST NOT 发事件。
 * SMS 失败 → 503 `SMS_SEND_FAILED` (码已落库, 过期自然清, 重试发新码)。
 */
@Injectable()
export class SendUnbindWechatCodeUseCase {
  constructor(
    // CROSS-CONTEXT-SYNC: auth→account 读账号状态门槛 + 取手机号发码 (R2 只读)
    private readonly inspectAccountStatusById: InspectAccountStatusByIdUseCase,
    // CROSS-CONTEXT-SYNC: auth→account 读绑定门槛 (R2 只读)
    private readonly inspectWechatBinding: InspectWechatBindingUseCase,
    private readonly deletionCodeStore: DeletionCodeStore,
    @Inject(SMS_GATEWAY) private readonly smsGateway: SmsGateway,
    @Inject(authConfig.KEY) private readonly authCfg: AuthConfig,
  ) {}

  async execute(accountId: bigint): Promise<void> {
    // 两道门槛恒执行 (constant work, 反枚举时延均一)。
    const inspection = await this.inspectAccountStatusById.execute(accountId);
    const { bound } = await this.inspectWechatBinding.execute(accountId);
    if (inspection.kind !== 'ACTIVE' || !bound) {
      // 反枚举折叠: 非 ACTIVE / NOT_FOUND / 未绑 一律同一 401。抛**裸**
      // UnauthorizedException() (detail='Unauthorized') 而非自定义 code —— 因为
      // FROZEN 被 JwtAuthGuard 在 usecase 前拦成 guard 的 'Unauthorized', 未绑 ACTIVE
      // 走到此处。若此处用自定义 code 则两路径 401 body 可区分 (未绑 vs 冻结/无 token),
      // 破反枚举。裸折叠让 未绑 / 冻结 / 无 token 三者 401 字节级一致 (FR-S03)。
      throw new UnauthorizedException();
    }

    const code = issueSmsCode();
    const codeHash = hashDeletionCode(code, this.authCfg.smsCodeHmacSecret);
    const expiresAt = new Date(Date.now() + DELETION_CODE_TTL_MIN * MIN_MS);
    await this.deletionCodeStore.issue(accountId, SmsPurpose.UNBIND_WECHAT, codeHash, expiresAt);

    try {
      await this.smsGateway.sendCode(inspection.phone, code, SmsPurpose.UNBIND_WECHAT);
    } catch {
      // 网关失败不外泄底层细节。码已落库 → 过期自然清, 重试发新码。
      throw new SmsSendFailedException();
    }
  }
}
