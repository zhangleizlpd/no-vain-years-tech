import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { BindWechatUseCase } from './bind-wechat.usecase';
import type { WechatAuthPort } from './wechat-auth.port';
import type { InspectAccountStatusByIdUseCase } from '../account/inspect-account-status-by-id.usecase';
import type {
  CommitWechatBindUseCase,
  WechatBindResult,
} from '../account/commit-wechat-bind.usecase';
import { WechatAlreadyBoundException } from './wechat-already-bound.exception';
import { WechatAccountAlreadyBoundException } from './wechat-account-already-bound.exception';

const OPENID = 'oMOCKDEV0000000000000000abcd';

function makeUsecase(opts: { inspectionKind?: string; bindResult?: WechatBindResult }) {
  const wechatAuth = {
    resolveIdentity: vi.fn().mockResolvedValue({ openid: OPENID }),
  } satisfies WechatAuthPort;
  const inspect = {
    execute: vi
      .fn()
      .mockResolvedValue({ kind: opts.inspectionKind ?? 'ACTIVE', phone: '+8613800000000' }),
  } as unknown as InspectAccountStatusByIdUseCase;
  const commitBind = {
    execute: vi.fn().mockResolvedValue(opts.bindResult ?? 'CREATED'),
  } as unknown as CommitWechatBindUseCase;
  const usecase = new BindWechatUseCase(wechatAuth, inspect, commitBind);
  return { usecase, wechatAuth, inspect, commitBind };
}

describe('BindWechatUseCase (auth 编排)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ACTIVE + 未绑 (CREATED) → resolve 无异常 (201)', async () => {
    const { usecase } = makeUsecase({ bindResult: 'CREATED' });
    await expect(usecase.execute(1n, 'authcode')).resolves.toBeUndefined();
  });

  it('ACTIVE + 自号同 openid (IDEMPOTENT) → resolve 无异常 (幂等 201)', async () => {
    const { usecase } = makeUsecase({ bindResult: 'IDEMPOTENT' });
    await expect(usecase.execute(1n, 'authcode')).resolves.toBeUndefined();
  });

  it('ACTIVE + 他号同 openid (CONFLICT) → 409 WECHAT_ALREADY_BOUND_OTHER', async () => {
    const { usecase } = makeUsecase({ bindResult: 'CONFLICT' });
    await expect(usecase.execute(1n, 'authcode')).rejects.toBeInstanceOf(
      WechatAlreadyBoundException,
    );
  });

  it('ACTIVE + 自号绑不同 openid (SELF_DIFFERENT) → 409 WECHAT_ACCOUNT_ALREADY_BOUND (R2)', async () => {
    const { usecase } = makeUsecase({ bindResult: 'SELF_DIFFERENT' });
    await expect(usecase.execute(1n, 'authcode')).rejects.toBeInstanceOf(
      WechatAccountAlreadyBoundException,
    );
  });

  it('非 ACTIVE → 401 折叠 + 不调 commit 写半段', async () => {
    const { usecase, commitBind } = makeUsecase({ inspectionKind: 'FROZEN' });
    await expect(usecase.execute(1n, 'authcode')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(commitBind.execute).not.toHaveBeenCalled();
  });
});
