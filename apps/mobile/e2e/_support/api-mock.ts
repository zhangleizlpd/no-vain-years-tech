import { type Page, type Route } from '@playwright/test';

// Shared Expo Web e2e backend mock. apps/mobile's axios baseURL defaults to
// http://localhost:3000, so API traffic is cross-origin vs the Expo web origin —
// every mocked call therefore needs its CORS preflight (OPTIONS) answered too,
// not just the actual verb. No credentials are sent pre-auth (accessToken is
// null), so `Access-Control-Allow-Headers: *` covers the custom headers
// (x-trace-id / x-device-*); add the verb to allow-methods if a UC needs it.
//
// Extracted from the login slice (T066) so every API-calling UC e2e (onboarding
// PATCH displayName, …) reuses the preflight handling instead of re-deriving it.
//
// `method` pins the handler to one verb (e.g. GET vs PATCH on the same /me glob):
// a non-matching verb falls through to another handler registered for the same
// glob. Needed since AuthGate now issues GET /me on every authed boot, which must
// return a different body than the form's PATCH /me on the same URL.
export async function mockJson(
  page: Page,
  urlGlob: string,
  status: number,
  body: unknown,
  method?: string,
) {
  await page.route(urlGlob, async (route: Route) => {
    const reqMethod = route.request().method();
    if (reqMethod === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
        },
      });
      return;
    }
    if (method && reqMethod !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(body),
    });
  });
}
