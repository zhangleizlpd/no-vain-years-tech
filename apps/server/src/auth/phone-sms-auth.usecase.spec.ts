import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { PhoneSmsAuthUseCase } from './phone-sms-auth.usecase';
import { AccountInFreezePeriodException } from '../account/account-in-freeze-period.exception';
import type { SmsCodeStore } from './sms-code.store';
import type {
  InspectAccountStatusUseCase,
  AccountStatusInspection,
} from '../account/inspect-account-status.usecase';
import type { CommitPhoneLoginUseCase } from '../account/commit-phone-login.usecase';
import type { TimingDefenseExecutor } from './timing-defense.port';
import type { JwtTokenService } from '../security/jwt-token.service';
import type { AuthFailureLockService } from './auth-failure-lock.service';
import type { RefreshTokenService } from '../security/refresh-token.service';

// Ctor (post-ADR-0043 R-4 两段式委托): 直注 account 的 Inspect(读) + Commit(写)
// use case,auth 不碰 prisma.account.*。+ security RefreshTokenService (签发即持久化)。7 args。
type UseCaseCtor = new (
  smsCodeStore: SmsCodeStore,
  jwtTokenService: JwtTokenService,
  inspectAccountStatus: InspectAccountStatusUseCase,
  commitPhoneLogin: CommitPhoneLoginUseCase,
  timingDefense: TimingDefenseExecutor,
  authFailureLock: AuthFailureLockService,
  refreshTokenService: RefreshTokenService,
) => PhoneSmsAuthUseCase;

type Fn = ReturnType<typeof vi.fn>;

function buildAuthFailureLockMock(): AuthFailureLockService {
  return {
    assertNotLocked: vi.fn().mockResolvedValue(undefined),
    recordFailure: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuthFailureLockService;
}

interface Harness {
  inspect: Fn;
  commit: Fn;
  storeVerify: Fn;
  storeClear: Fn;
  timingPad: Fn;
  persist: Fn;
  jwtTokenService: JwtTokenService;
  useCase: PhoneSmsAuthUseCase;
}

function buildHarness(): Harness {
  const inspect = vi.fn();
  const commit = vi.fn();
  const storeVerify = vi.fn();
  const storeClear = vi.fn().mockResolvedValue(undefined);
  const timingPad = vi.fn().mockResolvedValue(undefined);
  const smsCodeStore = {
    store: vi.fn().mockResolvedValue(undefined),
    verify: storeVerify,
    clear: storeClear,
  } as unknown as SmsCodeStore;
  const jwtTokenService = {
    signAccessToken: vi.fn().mockReturnValue('access-token-xyz'),
    generateRefreshToken: vi.fn().mockReturnValue('refresh-token-xyz'),
  } as unknown as JwtTokenService;
  const inspectAccountStatus = { execute: inspect } as unknown as InspectAccountStatusUseCase;
  const commitPhoneLogin = { execute: commit } as unknown as CommitPhoneLoginUseCase;
  const timingDefense = { pad: timingPad } as unknown as TimingDefenseExecutor;
  const persist = vi.fn().mockResolvedValue(undefined);
  const refreshTokenService = { persist } as unknown as RefreshTokenService;
  const useCase = new (PhoneSmsAuthUseCase as unknown as UseCaseCtor)(
    smsCodeStore,
    jwtTokenService,
    inspectAccountStatus,
    commitPhoneLogin,
    timingDefense,
    buildAuthFailureLockMock(),
    refreshTokenService,
  );
  return { inspect, commit, storeVerify, storeClear, timingPad, persist, jwtTokenService, useCase };
}

const ACTIVE: AccountStatusInspection = { kind: 'ACTIVE' };
const NOT_FOUND: AccountStatusInspection = { kind: 'NOT_FOUND' };

const phone = '+8613800138401';
const code = '123456';

describe('PhoneSmsAuthUseCase ACTIVE path (US1)', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
    h.inspect.mockResolvedValue(ACTIVE);
    h.commit.mockResolvedValue({ accountId: 42n });
  });

  it('ACTIVE + matching code → tokens + commit (login) + code cleared', async () => {
    h.storeVerify.mockResolvedValue(true);

    const result = await h.useCase.execute(phone, code);

    expect(result.accountId).toBe(42n);
    expect(result.accessToken).toBe('access-token-xyz');
    expect(result.refreshToken).toBe('refresh-token-xyz');
    expect(h.storeClear).toHaveBeenCalledWith(phone);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledWith(phone);
    // 签发即持久化: refresh token 落库 (loginMethod=PHONE_SMS), 返回 shape 不漂。
    expect(h.persist).toHaveBeenCalledTimes(1);
    expect(h.persist).toHaveBeenCalledWith(
      42n,
      'refresh-token-xyz',
      expect.objectContaining({ loginMethod: 'PHONE_SMS' }),
    );
  });

  it('threads device context (deviceId/name/type + clientIp) into persist (FR-S14)', async () => {
    h.storeVerify.mockResolvedValue(true);
    await h.useCase.execute(phone, code, {
      deviceId: 'dev-abc',
      deviceName: 'iPhone 15',
      deviceType: 'PHONE',
      clientIp: '8.8.8.8',
    });
    expect(h.persist).toHaveBeenCalledWith(42n, 'refresh-token-xyz', {
      deviceId: 'dev-abc',
      deviceName: 'iPhone 15',
      deviceType: 'PHONE',
      clientIp: '8.8.8.8',
      loginMethod: 'PHONE_SMS',
    });
  });

  it('不带 name/type 头 → persist 收 undefined (回归: 持久化层降级 null/UNKNOWN)', async () => {
    h.storeVerify.mockResolvedValue(true);
    await h.useCase.execute(phone, code, { deviceId: 'dev-abc', clientIp: '8.8.8.8' });
    const meta = h.persist.mock.calls[0]![2] as Record<string, unknown>;
    expect(meta.deviceName).toBeUndefined();
    expect(meta.deviceType).toBeUndefined();
  });

  it('code mismatch → does NOT persist (持久化仅成功路径)', async () => {
    h.storeVerify.mockResolvedValue(false);
    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('ACTIVE + code mismatch (verify false) → 401, no commit', async () => {
    h.storeVerify.mockResolvedValue(false);
    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.storeClear).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('ACTIVE + code expired (verify null) → 401, no commit', async () => {
    h.storeVerify.mockResolvedValue(null);
    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('signs access token with bigint accountId from commit', async () => {
    h.storeVerify.mockResolvedValue(true);
    await h.useCase.execute(phone, code);
    expect(h.jwtTokenService.signAccessToken).toHaveBeenCalledWith({ accountId: 42n });
    expect(h.jwtTokenService.generateRefreshToken).toHaveBeenCalledTimes(1);
  });
});

describe('PhoneSmsAuthUseCase US2 unregistered auto-register path', () => {
  let h: Harness;
  beforeEach(() => {
    h = buildHarness();
    h.inspect.mockResolvedValue(NOT_FOUND);
    h.commit.mockResolvedValue({ accountId: 99n });
    h.storeVerify.mockResolvedValue(true);
  });

  it('unregistered + matching code → commit (create) + tokens', async () => {
    const result = await h.useCase.execute(phone, code);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledWith(phone);
    expect(result.accountId).toBe(99n);
    expect(result.accessToken).toBe('access-token-xyz');
    expect(result.refreshToken).toBe('refresh-token-xyz');
  });

  it('unregistered + verify false → 401 (code must match before auto-register)', async () => {
    h.storeVerify.mockResolvedValue(false);
    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.commit).not.toHaveBeenCalled();
  });

  it('unregistered → byte-equal response shape vs ACTIVE path', async () => {
    const result = await h.useCase.execute(phone, code);
    expect(Object.keys(result).sort()).toEqual(['accessToken', 'accountId', 'refreshToken'].sort());
  });
});

describe('PhoneSmsAuthUseCase US3 FROZEN disclosure path (CL-006)', () => {
  const freezeUntil = new Date('2026-06-17T00:00:00Z');

  it('FROZEN → 403 AccountInFreezePeriodException(freezeUntil), no pad / verify / commit', async () => {
    const h = buildHarness();
    h.inspect.mockResolvedValue({ kind: 'FROZEN', freezeUntil });

    let caught: unknown;
    try {
      await h.useCase.execute(phone, code);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AccountInFreezePeriodException);
    expect((caught as AccountInFreezePeriodException).freezeUntil).toEqual(freezeUntil);
    expect(h.timingPad).not.toHaveBeenCalled();
    expect(h.storeVerify).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.jwtTokenService.signAccessToken).not.toHaveBeenCalled();
  });

  it('FROZEN with null freezeUntil → falls back to a Date (no crash)', async () => {
    const h = buildHarness();
    h.inspect.mockResolvedValue({ kind: 'FROZEN', freezeUntil: null });
    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(
      AccountInFreezePeriodException,
    );
  });
});

describe('PhoneSmsAuthUseCase US3 ANONYMIZED anti-enumeration (CL-006)', () => {
  it('ANONYMIZED → timingPad called → 401, no commit / token', async () => {
    const h = buildHarness();
    h.inspect.mockResolvedValue({ kind: 'ANONYMIZED' });

    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.timingPad).toHaveBeenCalledTimes(1);
    expect(h.storeVerify).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.jwtTokenService.signAccessToken).not.toHaveBeenCalled();
  });
});

describe('PhoneSmsAuthUseCase US3 timing defense across 3 anti-enum 401 paths', () => {
  it('path 1 ACTIVE + verify false → pad before 401', async () => {
    const h = buildHarness();
    h.inspect.mockResolvedValue(ACTIVE);
    h.storeVerify.mockResolvedValue(false);
    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.timingPad).toHaveBeenCalledTimes(1);
  });

  it('path 2 ACTIVE + verify null (expired) → pad before 401', async () => {
    const h = buildHarness();
    h.inspect.mockResolvedValue(ACTIVE);
    h.storeVerify.mockResolvedValue(null);
    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.timingPad).toHaveBeenCalledTimes(1);
  });

  it('path 3 ANONYMIZED → pad before 401', async () => {
    const h = buildHarness();
    h.inspect.mockResolvedValue({ kind: 'ANONYMIZED' });
    await expect(h.useCase.execute(phone, code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.timingPad).toHaveBeenCalledTimes(1);
  });
});
