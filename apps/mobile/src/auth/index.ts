// Public surface for the auth module (apps/mobile/src/auth/). T031 introduced
// store + token-refresh modules; T034 (AuthGate root layout) is the first
// consumer and lifts these names into the module facade.

export { useAuthStore } from './store';
export type { AuthState, Session } from './store';

export {
  refreshOnce,
  refreshTokenFlow,
  rehydrateSession,
  makeAuthRefreshResponseInterceptor,
} from './token-refresh';

export { logoutAll } from './logout-all';

export { useDeviceStore, getDeviceHeaders } from './device-store';
export type { DeviceState, DeviceType } from './device-store';

// login slice (account-migration p3): phone-sms-auth mutation wrapper + form schema.
export { usePhoneSmsAuth } from './phone-sms-auth';
export {
  phoneSmsAuthSchema,
  PHONE_REGEX,
  SMS_CODE_REGEX,
  type PhoneSmsAuthValues,
} from './login-form.schema';
export { useLoginForm, loginErrorToast } from './use-login-form';
export type { LoginFormState, ErrorScope } from './use-login-form';

// FROZEN 登录拦截 (004 FR-C03): 剩余天数 + 撤销分支路由（纯函数）。403 识别复用
// canonical ProblemDetail 层 ~/core/api/errors isFreezePeriod（单一真理源）。
export { remainingFreezeDays, cancelDeletionPath } from './freeze-interception';

// cancel-deletion slice (004): cancel mutation wrapper + error map + form hook.
// Reuses login-form.schema (CancelDeletionRequest 与 PhoneSmsAuthRequest 正则字节一致).
export { useCancelDeletion } from './cancel-deletion';
export { cancelDeletionErrorToast } from './cancel-deletion-errors';
export { useCancelDeletionForm } from './use-cancel-deletion-form';
export type { CancelDeletionFormState, CancelErrorScope } from './use-cancel-deletion-form';

// account-deletion 发起 slice (004 US10 / B3): request-code + delete wrappers,
// error map, RHF form hook. Code regex reuses login-form.schema SMS_CODE_REGEX.
export { useRequestDeletionCode, useDeleteAccount } from './delete-account';
export { deleteAccountErrorToast } from './deletion-errors';
export { useDeleteAccountForm } from './use-delete-account-form';
export type { DeleteAccountFormState } from './use-delete-account-form';

// onboarding slice (account-migration p3): displayName form schema + wrapper + hook.
export { useUpdateDisplayName } from './update-display-name';
export {
  onboardingFormSchema,
  displayNameSchema,
  type OnboardingFormValues,
} from './onboarding-form.schema';
export { useOnboardingForm, onboardingErrorToast } from './use-onboarding-form';
export type { OnboardingFormState } from './use-onboarding-form';
