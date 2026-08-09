import { z } from 'zod';

// login form 校验规则。phone / code 正则与 server DTO **互锚**，改一处必同步另一处：
//   server: apps/server/src/auth/phone-sms-auth.request.ts
//     @Matches(/^\+861[3-9]\d{9}$/) phone (L14) + @Matches(/^\d{6}$/) code (L25)
//   （per memory project_rhf_form_standard_login_golden_sample (b)：同规则写两处防漂移）
// 字段名 phone / code 对齐 Orval `PhoneSmsAuthRequest`（packages/api-client 生成）。
export const PHONE_REGEX = /^\+861[3-9]\d{9}$/;
export const SMS_CODE_REGEX = /^\d{6}$/;

export const phoneSmsAuthSchema = z.object({
  phone: z.string().regex(PHONE_REGEX, 'INVALID_PHONE_FORMAT'),
  code: z.string().regex(SMS_CODE_REGEX, 'INVALID_SMS_CODE_FORMAT'),
});

export type PhoneSmsAuthValues = z.infer<typeof phoneSmsAuthSchema>;
