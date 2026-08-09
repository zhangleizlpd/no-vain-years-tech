import { describe, expect, it } from 'vitest';
import { scanTestFiles, stripComments } from './check-test-size';

const rules = (files: Record<string, string>) => scanTestFiles(files).map((v) => v.rule);

const PG_IMPORT = `
import { PostgreSqlContainer } from '@testcontainers/postgresql';
describe('x', () => { it('y', () => {}); });
`;

describe('check-test-size / small-stays-small', () => {
  it('plain *.spec.ts importing @testcontainers → violation (the T-1 regression)', () => {
    expect(rules({ 'apps/server/src/portfolio/x.usecase.spec.ts': PG_IMPORT })).toEqual([
      'small-stays-small',
    ]);
  });

  it('same content as *.it.spec.ts → ok', () => {
    expect(rules({ 'apps/server/src/portfolio/x.usecase.it.spec.ts': PG_IMPORT })).toEqual([]);
  });

  it('shared-PG fixture counts too (no @testcontainers import at all)', () => {
    const c = `import { setupIsolatedDb } from '../../test/_support/isolated-db';`;
    expect(rules({ 'apps/server/src/a/b.spec.ts': c })).toEqual(['small-stays-small']);
  });

  it('aliased import still caught (matched on specifier, not class name)', () => {
    const c = `import { PostgreSqlContainer as PG } from '@testcontainers/postgresql';`;
    expect(rules({ 'apps/server/src/a/b.spec.ts': c })).toEqual(['small-stays-small']);
  });
});

describe('check-test-size / vendor-must-be-gated', () => {
  it('ungated real-vendor env → violation', () => {
    const c = `const on = process.env.RUN_MARKETDATA_IT === 'true';\ndescribe('v', () => {});`;
    expect(rules({ 'apps/server/test/integration/a.it.spec.ts': c })).toEqual([
      'vendor-must-be-gated',
    ]);
  });

  it('gated directly → ok', () => {
    const c = `const RUN = process.env.RUN_MARKETDATA_IT === 'true';\ndescribe.skipIf(!RUN)('v', () => {});`;
    expect(rules({ 'apps/server/test/integration/a.it.spec.ts': c })).toEqual([]);
  });

  it('gated through one level of indirection → ok (the futu-shim shape)', () => {
    const c = [
      `const RUN_MARKETDATA_IT = process.env.RUN_MARKETDATA_IT === 'true';`,
      `const ENABLED = RUN_MARKETDATA_IT && BASE !== '';`,
      `describe.skipIf(!ENABLED)('v', () => {});`,
    ].join('\n');
    expect(rules({ 'apps/server/test/integration/a.it.spec.ts': c })).toEqual([]);
  });

  it('RUN_PERF_IT is Medium, not vendor → no violation', () => {
    const c = `const p = process.env.RUN_PERF_IT === 'true';\ndescribe('perf', () => {});`;
    expect(rules({ 'apps/server/test/integration/a.it.spec.ts': c })).toEqual([]);
  });

  it('a comment merely MENTIONING the env is not a vendor read (the adapter-spec false positive)', () => {
    const c = `/** 真端点由 env-gated 真 vendor IT 校真 (marketdata.tencent.vendor, RUN_MARKETDATA_IT)。 */\ndescribe('unit', () => {});`;
    expect(rules({ 'apps/server/src/marketdata/tencent-calendar.adapter.spec.ts': c })).toEqual([]);
  });
});

describe('check-test-size / vendor-file-fully-gated', () => {
  it('*.vendor.spec.ts with an ungated top-level describe → violation', () => {
    const c = [
      `const RUN = process.env.RUN_SMS_IT === 'true';`,
      `describe.skipIf(!RUN)('gated', () => {});`,
      `describe('NOT gated', () => {});`,
    ].join('\n');
    expect(rules({ 'apps/server/test/integration/a.vendor.spec.ts': c })).toEqual([
      'vendor-file-fully-gated',
    ]);
  });

  it('*.vendor.spec.ts with every top-level describe gated → ok', () => {
    const c = [
      `const RUN = process.env.RUN_SMS_IT === 'true';`,
      `describe.skipIf(!RUN)('a', () => {});`,
      `describe.skipIf(!RUN)('b', () => {});`,
    ].join('\n');
    expect(rules({ 'apps/server/test/integration/a.vendor.spec.ts': c })).toEqual([]);
  });

  it('nested (indented) describes do not count as top-level', () => {
    const c = [
      `const RUN = process.env.RUN_SMS_IT === 'true';`,
      `describe.skipIf(!RUN)('outer', () => {`,
      `  describe('inner', () => {});`,
      `});`,
    ].join('\n');
    expect(rules({ 'apps/server/test/integration/a.vendor.spec.ts': c })).toEqual([]);
  });
});

describe('check-test-size / mobile + suffix vocabulary', () => {
  it('Playwright under apps/mobile/src → violation', () => {
    const c = `import { test } from '@playwright/test';`;
    expect(rules({ 'apps/mobile/src/a/b.spec.ts': c })).toEqual(['mobile-unit-is-logic-only']);
  });

  it('a bare *.spec.ts under apps/server/test/ → unknown size suffix', () => {
    expect(rules({ 'apps/server/test/integration/a.spec.ts': 'describe("x", () => {});' })).toEqual(
      ['no-unknown-size-suffix'],
    );
  });

  it('a resurrected *.e2e.spec.ts under apps/server/test/ → unknown size suffix', () => {
    expect(
      rules({
        'apps/server/test/integration/accounts.us1.e2e.spec.ts': 'describe("x", () => {});',
      }),
    ).toEqual(['no-unknown-size-suffix']);
  });
});

describe('check-test-size / single-tier dirs (e2e + checks)', () => {
  it('a *.it.spec.ts under apps/mobile/e2e → suffix violation (the dir is the coordinate)', () => {
    expect(rules({ 'apps/mobile/e2e/flows/login.it.spec.ts': 'describe("x", () => {});' })).toEqual(
      ['e2e-stays-suffix-free'],
    );
  });

  it('a plain *.spec.ts under apps/mobile/e2e → ok (suffix-free is the point)', () => {
    expect(rules({ 'apps/mobile/e2e/flows/login.spec.ts': 'describe("x", () => {});' })).toEqual(
      [],
    );
  });

  it('a size suffix under scripts/checks → violation', () => {
    expect(rules({ 'scripts/checks/foo.it.spec.ts': 'describe("x", () => {});' })).toEqual([
      'checks-stay-small',
    ]);
  });

  it('a checks spec importing @testcontainers → violation', () => {
    expect(rules({ 'scripts/checks/foo.spec.ts': PG_IMPORT })).toEqual(['checks-stay-small']);
  });

  it('FIXTURE_SPECS: the checker spec itself is content-exempt (fixtures are violations-as-data)', () => {
    const withVendorFixture = `${PG_IMPORT}\nconst sample = "process.env.RUN_MARKETDATA_IT";`;
    expect(rules({ 'scripts/checks/check-test-size.spec.ts': withVendorFixture })).toEqual([]);
  });
});

describe('check-test-size / stripComments', () => {
  it('removes block and whole-line comments but keeps code', () => {
    const out = stripComments('/* BLOCKGONE */\n// LINEGONE\nconst c = 1; // TRAILINGKEPT\n');
    expect(out).not.toContain('BLOCKGONE');
    expect(out).not.toContain('LINEGONE');
    expect(out).toContain('const c = 1;');
    // Trailing `//` after code is deliberately NOT stripped — only whole-line comments are.
    // Stripping mid-line would need real tokenizing (string literals containing `//`).
    expect(out).toContain('TRAILINGKEPT');
  });
});
