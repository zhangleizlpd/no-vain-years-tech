import { z } from 'zod';

import { SMS_CODE_REGEX } from './login-form.schema';

// Account-deletion form schema (FR-C02). Only the 6-digit code lives in RHF;
// the two confirmation checkboxes are side-effect state outside the form (铁律
// 2). Code regex reuses SMS_CODE_REGEX (single source, anchored to the server
// DTO `@Matches(/^\d{6}$/)` on DeleteAccountRequest) to avoid drift.
export const deleteAccountFormSchema = z.object({
  code: z.string().regex(SMS_CODE_REGEX, 'INVALID_SMS_CODE_FORMAT'),
});

export type DeleteAccountFormValues = z.infer<typeof deleteAccountFormSchema>;
