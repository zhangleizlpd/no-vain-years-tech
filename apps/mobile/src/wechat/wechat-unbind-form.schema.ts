import { z } from 'zod';

import { SMS_CODE_REGEX } from '~/auth';

// 微信解绑表单 schema (010 FR-C, 镜像 delete-account-form.schema)。仅 6 位码进 RHF
// (铁律 2: 无副作用态进表单)。code regex 复用 login SMS_CODE_REGEX (单源, 锚 server
// DTO `@Matches(/^\d{6}$/)` on UnbindWechatRequest) 避漂移。
export const wechatUnbindFormSchema = z.object({
  code: z.string().regex(SMS_CODE_REGEX, 'INVALID_SMS_CODE_FORMAT'),
});

export type WechatUnbindFormValues = z.infer<typeof wechatUnbindFormSchema>;
