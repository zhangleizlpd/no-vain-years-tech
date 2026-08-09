import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * SMS gateway config — discriminated union so Aliyun credentials are only
 * required when `SMS_GATEWAY=aliyun`. `mock` is the default for dev/test.
 *
 * Boot-time `.parse()` rejects partial Aliyun config (e.g. accessKeyId set
 * but signName missing), surfacing misconfiguration before the first SMS send.
 */
const SmsConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mock') }),
  z.object({
    kind: z.literal('aliyun'),
    accessKeyId: z.string().min(1, 'ALIYUN_ACCESS_KEY_ID required when SMS_GATEWAY=aliyun'),
    accessKeySecret: z.string().min(1, 'ALIYUN_ACCESS_KEY_SECRET required when SMS_GATEWAY=aliyun'),
    signName: z.string().min(1, 'ALIYUN_SMS_SIGN_NAME required when SMS_GATEWAY=aliyun'),
    templateCode: z.string().min(1, 'ALIYUN_SMS_TEMPLATE_CODE required when SMS_GATEWAY=aliyun'),
    // 注销/撤销码独立模板 (FR-S05/S08, 004)。可选 — 缺省则 auth.module 不下发覆盖,
    // AliyunSmsGateway 回退默认 templateCode (登录码模板)。
    deleteAccountTemplateCode: z.string().min(1).optional(),
    cancelDeletionTemplateCode: z.string().min(1).optional(),
  }),
]);

export type SmsConfig = z.infer<typeof SmsConfigSchema>;

/**
 * 空串折叠成 undefined。两个 per-purpose 模板码是 `.min(1).optional()` —— undefined
 * 合法、空串非法；而 compose 的 `KEY: ${VAR:-}` 和 `.env*` 里的 `KEY=""` **都产出空串**。
 * 不折叠则 `.env.example` 写明的「Blank → 回退登录模板」语义在 `SMS_GATEWAY=aliyun`
 * 下反而崩 boot（prod 正是 aliyun）。折叠范式同 `agent-bridge.config.ts` 的 workerToken。
 */
const blankAsAbsent = (raw: string | undefined): string | undefined => raw || undefined;

export const smsConfig = registerAs('sms', (): SmsConfig => {
  const kind = process.env.SMS_GATEWAY ?? 'mock';
  if (kind === 'aliyun') {
    return SmsConfigSchema.parse({
      kind,
      accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
      accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
      signName: process.env.ALIYUN_SMS_SIGN_NAME,
      templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE,
      deleteAccountTemplateCode: blankAsAbsent(process.env.ALIYUN_SMS_TEMPLATE_CODE_DELETE_ACCOUNT),
      cancelDeletionTemplateCode: blankAsAbsent(
        process.env.ALIYUN_SMS_TEMPLATE_CODE_CANCEL_DELETION,
      ),
    });
  }
  return SmsConfigSchema.parse({ kind: 'mock' });
});
