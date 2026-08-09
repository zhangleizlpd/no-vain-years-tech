// Alert-push init — web stub. Real implementation in push-init.native.ts;
// Metro resolves this file for web bundles so the native-only SDK never
// enters the web module graph (D7: web 零采集 SDK)。

export function getRegistrationId(): string | null {
  return null;
}

export function setRegistrationIdListener(_listener: (regId: string) => void): void {
  // no-op on web — RegID never materializes
}

export async function initAlertPush(): Promise<void> {
  // no-op on web
}
