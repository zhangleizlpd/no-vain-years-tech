// 072 T019 — 审批表单 zod schema（RHF zodResolver 的唯一校验源，per mobile-impl-playbook § 1）。
//
// 金融数值一律**字符串**（server DTO 亦然：小数精度不经 JS number 中转）；这里校验数字串的
// 形状与取值域，不做 number 转换。
//
// 🚨 FR-006：`ticker` **不在表单里** —— 不是 disabled 输入框，是压根没有编辑路径。
//    「改标的」等于换了一条估值，那该由提交方重投，而不是审阅方在这里改。
import { z } from 'zod';

import { CONFIDENCE_MAX, CONFIDENCE_MIN, METHOD_MAX } from './anchor-form.schema';

const NUMERIC = /^-?\d+(\.\d+)?$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 审核备注上限（与 server DTO 的 @MaxLength 对齐）。 */
export const REVIEW_NOTE_MAX = 512;

export const anchorSubmissionFormSchema = z.object({
  v: z
    .string()
    .regex(NUMERIC, 'V 必须是数字')
    .refine((s) => Number(s) > 0, 'V 必须大于 0'),
  asof: z.string().regex(YMD, '口径日格式为 YYYY-MM-DD'),
  method: z.string().min(1, '请填写估值方法').max(METHOD_MAX, `估值方法不超过 ${METHOD_MAX} 字`),
  confidence: z
    .string()
    .regex(NUMERIC, 'confidence 必须是数字')
    .refine((s) => {
      const n = Number(s);
      return n >= CONFIDENCE_MIN && n <= CONFIDENCE_MAX;
    }, `confidence 取值 ${CONFIDENCE_MIN}–${CONFIDENCE_MAX}`),
  /** 审阅方的处置附言（与提交方的 note 是两个人写的两件事，不合并）。 */
  reviewNote: z.string().max(REVIEW_NOTE_MAX, `审核备注不超过 ${REVIEW_NOTE_MAX} 字`),
});

export type AnchorSubmissionFormValues = z.infer<typeof anchorSubmissionFormSchema>;
