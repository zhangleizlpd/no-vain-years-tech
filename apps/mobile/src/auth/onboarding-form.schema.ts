import { z } from 'zod';

// onboarding displayName 客户端校验，镜像 server FR-005。权威实现是 server
// apps/server/src/account/account.rules.ts#normalizeDisplayName —— 改一处必同步另一处
// (per memory project_rhf_form_standard_login_golden_sample (b)：同规则写两处防漂移)。
// 三条规则：
//   1. 禁字符查 *raw*（trim() 会吞 BOM / 零宽，故必须先于 trim 检查）；
//   2. trim 后 Unicode 码点数 ∈ [1, 32]（spread 计数把 surrogate-pair emoji 当 1 个）；
//   3. 提交 / 存储用 trim 后的值。
export const DISPLAY_NAME_MIN_CP = 1;
export const DISPLAY_NAME_MAX_CP = 32;

// 与 server account.rules.ts 的 DISPLAY_NAME_FORBIDDEN 逐字符一致：C0 控制符 / DEL /
// 零宽 / BOM / 行段分隔符。注意只含 \x7F(DEL)，不含 C1(\x80-\x9F) —— 与 server 对齐
// (legacy app 旧 client 实现误含 C1，已随本次 port 废)。
// 控制字符是 deny-list 的有意成分 —— no-control-regex 在此是误报，定向 disable。
// eslint-disable-next-line no-control-regex
const DISPLAY_NAME_FORBIDDEN = new RegExp('[\\x00-\\x1F\\x7F\\u200B-\\u200F\\uFEFF\\u2028\\u2029]');

export const displayNameSchema = z
  .string()
  .refine((raw) => !DISPLAY_NAME_FORBIDDEN.test(raw), 'INVALID_DISPLAY_NAME')
  .refine((raw) => {
    const cp = [...raw.trim()].length;
    return cp >= DISPLAY_NAME_MIN_CP && cp <= DISPLAY_NAME_MAX_CP;
  }, 'INVALID_DISPLAY_NAME')
  .transform((raw) => raw.trim());

// RHF object schema —— 单 displayName 字段；transform 是 string→string(trim)，故 input /
// output 类型同为 { displayName: string }，useForm<OnboardingFormValues> 两端可共用。
export const onboardingFormSchema = z.object({ displayName: displayNameSchema });

export type OnboardingFormValues = z.infer<typeof onboardingFormSchema>;
