import { z } from 'zod';

// 自定义指令客户端校验，对齐 server FR-005（`@MaxLength(2000)`，upsert-chat-preference.request.ts）。
// 权威实现是 server validator —— 改一处必同步另一处。与 bio 不同：自定义指令是自由文本，
// 不做 trim / 禁字符过滤（注入隔离由 server 端 delimiter + 平台基座硬化声明承担，per plan D7，
// 客户端不做输入侧 pattern 黑名单）。空串合法 = 清空（D9）。
export const CUSTOM_INSTRUCTION_MAX = 2000;

export const customInstructionSchema = z.string().max(CUSTOM_INSTRUCTION_MAX);

// RHF object schema —— 单 customInstruction 字段；string→string，input / output 类型同为
// { customInstruction: string }，useForm<CustomInstructionFormValues> 两端可共用。
export const customInstructionFormSchema = z.object({
  customInstruction: customInstructionSchema,
});

export type CustomInstructionFormValues = z.infer<typeof customInstructionFormSchema>;
