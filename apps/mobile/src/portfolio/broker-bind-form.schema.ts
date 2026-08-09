import { z } from 'zod';

// 绑定券商表单 schema（012 页 B，FR-M04）。客户端只做最小可提交校验：券商已选 +
// 客户号 trim 后非空 → 「绑定」enabled（formState.isValid 驱动，不发请求）。深度校验
// （禁控制 / 零宽 / 行分隔符、字典命中）是 server 真相（FR-S07，400 FORM_VALIDATION），
// 不在客户端重复镜像 deny-list。
export const brokerBindFormSchema = z.object({
  brokerCode: z.string().min(1),
  clientNo: z.string().trim().min(1),
});

export type BrokerBindFormValues = z.infer<typeof brokerBindFormSchema>;
