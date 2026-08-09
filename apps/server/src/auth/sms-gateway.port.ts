import type { SmsPurpose } from './deletion-code.rules';

/**
 * SmsGateway port (FR-S03 Template A unified).
 *
 * mono W2 implement 用 MockSmsGateway (in-memory log);
 * W3 replace 为 AliyunSmsGateway (cockatiel retry wrapper, per plan R0.5).
 *
 * 操作:
 * - sendCode(phone, code, purpose?): 发送验证码。`purpose` 省略 → 登录/注册码
 *   (Template A unified, 反枚举不区分注册/登录, per FR-S03); 传 DELETE_ACCOUNT /
 *   CANCEL_DELETION → 注销/撤销码 (按 purpose 选独立 Aliyun 模板, 缺模板配置回退
 *   默认)。phone / code 均为已校验 string (per ADR-0043 R-VO)。
 */
export const SMS_GATEWAY = Symbol('SMS_GATEWAY');

export interface SmsGateway {
  sendCode(phone: string, code: string, purpose?: SmsPurpose): Promise<void>;
}
