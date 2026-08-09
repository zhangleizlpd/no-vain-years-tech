import { describe, expect, it } from 'vitest';
import { scanSpecFiles } from './check-e2e-seed-auth-mock';

const SEED = `
  const seedAuthStore = \`window.localStorage.setItem('nvy-auth', JSON.stringify({ state: {} }));\`;
  test.beforeEach(async ({ page }) => { await page.addInitScript(seedAuthStore); });
`;

const files = (content: string) => ({ 'apps/mobile/e2e/x.spec.ts': content });
const reasons = (content: string) => scanSpecFiles(files(content)).map((v) => v.reason);

describe('check-e2e-seed-auth-mock', () => {
  it('seed-authed spec with NO /me interception → violation (the profile.spec regression)', () => {
    expect(scanSpecFiles(files(SEED))).toHaveLength(1);
  });

  it('seed-authed + mockJson GET /me stub → ok', () => {
    const content = `${SEED}
      const ME_URL = '**/api/v1/accounts/me';
      await mockJson(page, ME_URL, 200, { displayName: '小明', status: 'ACTIVE' }, 'GET');`;
    expect(scanSpecFiles(files(content))).toHaveLength(0);
  });

  it('seed-authed + helper-call body GET /me stub (parens inside body) → ok', () => {
    // wechat-binding.spec.ts shape: body is meBody(wechatBound), whose inner
    // parens must not truncate the match before 'GET'.
    const content = `${SEED}
      const ME_URL = '**/api/v1/accounts/me';
      await mockJson(page, ME_URL, 200, meBody(wechatBound), 'GET');`;
    expect(scanSpecFiles(files(content))).toHaveLength(0);
  });

  it('seed-authed + inline /me glob mockJson GET → ok', () => {
    const content = `${SEED}
      await mockJson(page, '**/api/v1/accounts/me', 200, { displayName: null }, 'GET');`;
    expect(scanSpecFiles(files(content))).toHaveLength(0);
  });

  it('seed-authed + raw page.route on /me (stateful SUT, e.g. tokens-refresh) → ok', () => {
    const content = `${SEED}
      const ME_URL = '**/api/v1/accounts/me';
      await page.route(ME_URL, async (route) => { await route.fulfill({ status: 401 }); });`;
    expect(scanSpecFiles(files(content))).toHaveLength(0);
  });

  it('seed-authed but only a PATCH /me mockJson (no GET) → violation', () => {
    const content = `${SEED}
      const ME_URL = '**/api/v1/accounts/me';
      await mockJson(page, ME_URL, 200, { displayName: 'x' }, 'PATCH');`;
    expect(reasons(content)).toHaveLength(1);
  });

  it('non-seed-authed spec (cold boot, no addInitScript) → not checked', () => {
    const content = `
      test.beforeEach(async ({ page }) => { /* no auth seed */ });
      await mockJson(page, '**/api/v1/accounts/phone-sms-auth', 200, {});`;
    expect(scanSpecFiles(files(content))).toHaveLength(0);
  });

  it('commented-out GET /me stub does NOT satisfy the invariant', () => {
    const content = `${SEED}
      // await mockJson(page, ME_URL, 200, { displayName: 'x' }, 'GET');`;
    expect(reasons(content)).toHaveLength(1);
  });

  it('seed-authed + real-backend-exempt marker (真后端 smoke) → not checked', () => {
    const content = `${SEED}
      // e2e-seed-auth-mock-check: real-backend-exempt — hits the real backend.`;
    expect(scanSpecFiles(files(content))).toHaveLength(0);
  });
});
