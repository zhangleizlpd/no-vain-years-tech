import { z } from 'zod';

// bio（个人简介）客户端校验，镜像 server FR-S03。权威实现是 server
// apps/server/src/account/account.rules.ts#normalizeBio —— 改一处必同步另一处
// (per memory project_rhf_form_standard_login_golden_sample：同规则写两处防漂移)。
// 口径与 onboarding displayName 一致，仅上限 32→120 且【允许空】(清空 bio)：
//   1. 禁字符查 *raw*（trim() 会吞 BOM / 零宽，故必须先于 trim 检查）；
//   2. trim 后 Unicode 码点数 ≤ 120（spread 计数把 surrogate-pair emoji 当 1 个）；
//   3. 提交 / 存储用 trim 后的值；空串合法（清空）。
export const BIO_MAX_CP = 120;

// 与 server account.rules.ts 的 DISPLAY_NAME_FORBIDDEN 逐字符一致：C0 控制符 / DEL /
// 零宽 / BOM / 行段分隔符（bio 与 displayName 共用同一 deny-list）。
// 控制字符是 deny-list 的有意成分 —— no-control-regex 在此是误报，定向 disable。
// eslint-disable-next-line no-control-regex
const BIO_FORBIDDEN = new RegExp('[\\x00-\\x1F\\x7F\\u200B-\\u200F\\uFEFF\\u2028\\u2029]');

export const bioSchema = z
  .string()
  .refine((raw) => !BIO_FORBIDDEN.test(raw), 'INVALID_BIO')
  .refine((raw) => [...raw.trim()].length <= BIO_MAX_CP, 'INVALID_BIO')
  .transform((raw) => raw.trim());

// RHF object schema —— 单 bio 字段；transform 是 string→string(trim)，input / output
// 类型同为 { bio: string }，useForm<BioEditFormValues> 两端可共用。
export const bioEditFormSchema = z.object({ bio: bioSchema });

export type BioEditFormValues = z.infer<typeof bioEditFormSchema>;
