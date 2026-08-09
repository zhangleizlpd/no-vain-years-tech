// 045 T022 — 锚表单 zod schema（RHF zodResolver 的唯一校验源，per mobile-impl-playbook § 1）。
//
// 金融数值全部走**字符串**（server DTO 亦然：小数精度不经 JS number 中转），故这里校验的是
// 「数字串」的形状与取值域，不做 number 转换。
//
// 🚨 EC-2：`ticker` 只能由搜票选择器写入（canonical `market:code`），空串即不可提交 ——
//    **不提供自由文本绕过**（FR-002 硬约束）。
// 🚨 EC-3：`V ≤ 0` 前端就拦住（四区间与 W 在 V ≤ 0 无意义；server 也返 400，但不该让它发出去）。
import { z } from 'zod';

/** 数字串（允许负号，负值交由各字段自己的取值域拒绝，好让报错文案更准）。 */
const NUMERIC = /^-?\d+(\.\d+)?$/;
/** 日期列一律 `YYYY-MM-DD`（server 契约）。 */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 与 server DTO 的 `@MaxLength` 对齐，避免前端放行、后端 400。 */
export const METHOD_MAX = 32;
export const EXCLUDE_REASON_MAX = 128;
/** confidence 是 10 分制。 */
export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 10;

export const anchorFormSchema = z.object({
  /** canonical `market:code`，只能来自 `GET /marketdata/search` 的选中项。 */
  ticker: z.string().min(1, '请从标的库中搜索并选中标的'),
  /** 选中项的展示名（仅用于回显，不入 payload）。 */
  tickerName: z.string(),
  v: z
    .string()
    .regex(NUMERIC, 'V 必须是数字')
    .refine((s) => Number(s) > 0, 'V 必须大于 0'),
  asof: z.string().regex(YMD, '估值 as-of 日格式为 YYYY-MM-DD'),
  method: z.string().min(1, '请填写估值方法').max(METHOD_MAX, `估值方法不超过 ${METHOD_MAX} 字`),
  confidence: z
    .string()
    .regex(NUMERIC, 'confidence 必须是数字')
    .refine((s) => {
      const n = Number(s);
      return n >= CONFIDENCE_MIN && n <= CONFIDENCE_MAX;
    }, `confidence 取值 ${CONFIDENCE_MIN}–${CONFIDENCE_MAX}`),
  /** 空串 = 不排下次复审（映射成 payload 的 null）。早于 asof 允许保存，server 标「建锚即逾期」（EC-10）。 */
  nextReview: z.union([z.literal(''), z.string().regex(YMD, '下次复审日格式为 YYYY-MM-DD')]),
  excluded: z.boolean(),
  excludeReason: z.string().max(EXCLUDE_REASON_MAX, `排除原因不超过 ${EXCLUDE_REASON_MAX} 字`),
});

export type AnchorFormValues = z.infer<typeof anchorFormSchema>;
