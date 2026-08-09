/**
 * Account profile-image upload target — the account-domain concept layered on
 * top of the generic OSS PostObject signer (`integrations/oss/oss-policy.ts`,
 * platform层 per ADR-0058 / 036 D3). The signer is business-agnostic (takes a
 * `keyPrefix`); account maps each target to its `<target>/<accountId>/` prefix +
 * byte ceiling at the call site (`issue-upload-credential.usecase.ts`).
 *
 * 009 profile image upload (per ADR-0045 OQ1). The credential signing logic
 * itself moved to the platform layer so account + ideation share one path.
 */

export type ProfileImageTarget = 'avatar' | 'background';
export const PROFILE_IMAGE_TARGETS: readonly ProfileImageTarget[] = ['avatar', 'background'];
