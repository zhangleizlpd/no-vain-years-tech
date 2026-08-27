import { describe, expect, it } from 'vitest';
import { extractRegistryPaths, findDrift, isRegistered } from './check-golden-sample-registry';

const REG = [
  '| CRUD | `apps/server/src/account/update-display-name.usecase.ts` | x | — |',
  '| 跨 ctx | `apps/server/src/auth/phone-sms-auth.usecase.ts`（+ `account/commit-phone-login.usecase.ts`） | x | — |',
  '| e2e | `apps/mobile/e2e/foo.spec.ts` | x | — |',
].join('\n');

describe('check-golden-sample-registry — 注册表 ↔ banner 双向（纯函数，无磁盘 I/O）', () => {
  it('只抽反引号内仓根相对的 .ts/.tsx 全路径（companion 简写不算全路径）', () => {
    expect(extractRegistryPaths(REG)).toEqual([
      'apps/mobile/e2e/foo.spec.ts',
      'apps/server/src/account/update-display-name.usecase.ts',
      'apps/server/src/auth/phone-sms-auth.usecase.ts',
    ]);
  });

  it('companion 简写（去 apps/server/src/ 前缀）算已登记', () => {
    expect(isRegistered(REG, 'apps/server/src/account/commit-phone-login.usecase.ts')).toBe(true);
    expect(isRegistered(REG, 'apps/server/src/account/not-listed.usecase.ts')).toBe(false);
  });

  it('全部一致 → 零 drift', () => {
    const all = [
      'apps/server/src/account/update-display-name.usecase.ts',
      'apps/server/src/auth/phone-sms-auth.usecase.ts',
      'apps/server/src/account/commit-phone-login.usecase.ts',
      'apps/mobile/e2e/foo.spec.ts',
    ];
    const d = findDrift(
      REG,
      all,
      () => true,
      () => true,
    );
    expect(d).toEqual({ missingFile: [], missingBanner: [], orphanBanner: [] });
  });

  it('注册表引用的文件不存在 → missingFile', () => {
    const d = findDrift(
      REG,
      [],
      (p) => p !== 'apps/mobile/e2e/foo.spec.ts',
      () => true,
    );
    expect(d.missingFile).toEqual(['apps/mobile/e2e/foo.spec.ts']);
  });

  it('注册表样板存在但缺 banner → missingBanner', () => {
    const d = findDrift(
      REG,
      [],
      () => true,
      (p) => !p.endsWith('phone-sms-auth.usecase.ts'),
    );
    expect(d.missingBanner).toEqual(['apps/server/src/auth/phone-sms-auth.usecase.ts']);
  });

  it('有 banner 但注册表未登记 → orphanBanner', () => {
    const d = findDrift(
      REG,
      ['apps/mobile/app/(auth)/login.tsx'],
      () => true,
      () => true,
    );
    expect(d.orphanBanner).toEqual(['apps/mobile/app/(auth)/login.tsx']);
  });
});
