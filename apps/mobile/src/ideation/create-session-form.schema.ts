import { z } from 'zod';

// 032 T013 — 创建会话标题表单校验。规则与 server DTO **互锚**，改一处必同步：
//   server: apps/server/src/ideation/create-session.request.ts（title trim 后非空, 1..60）
//   orval: CreateSessionRequest（@minLength 1 @maxLength 60）
// trim 后非空 + ≤ 60。空/纯空白 → 校验错（server 也会 400，前端先挡省一次往返）。
export const TITLE_MAX_LENGTH = 60;

export const createSessionFormSchema = z.object({
  title: z.string().trim().min(1, 'TITLE_REQUIRED').max(TITLE_MAX_LENGTH, 'TITLE_TOO_LONG'),
});

export type CreateSessionFormValues = z.infer<typeof createSessionFormSchema>;
