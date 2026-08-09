import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { UnbindWechatUseCase } from './unbind-wechat.usecase';
import { hashDeletionCode } from './deletion-code.rules';
import type { PrismaService } from '../security/prisma.service';
import type { DeletionCodeStore } from './deletion-code.store';
import type { CommitWechatUnbindUseCase } from '../account/commit-wechat-unbind.usecase';
import type { AuthConfig } from '../config/auth.config';

const SECRET = 'unbind-hmac-secret-min-32-bytes-pad-x';
const CODE = '246810';
const TX = { __tx: true };

function build(opts: { stored?: unknown; claimed?: boolean; won?: boolean }) {
  const stored =
    opts.stored === undefined ? { id: 7n, codeHash: hashDeletionCode(CODE, SECRET) } : opts.stored;
  const findActive = vi.fn().mockResolvedValue(stored);
  const markUsed = vi.fn().mockResolvedValue(opts.claimed ?? true);
  const store = { findActive, markUsed } as unknown as DeletionCodeStore;
  const commitExecute = vi.fn().mockResolvedValue({ won: opts.won ?? true });
  const commitUnbind = { execute: commitExecute } as unknown as CommitWechatUnbindUseCase;
  const prisma = {
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(TX)),
  } as unknown as PrismaService;
  const cfg = { smsCodeHmacSecret: SECRET } as AuthConfig;
  const usecase = new UnbindWechatUseCase(prisma, store, commitUnbind, cfg);
  return { usecase, markUsed, commitExecute, prisma };
}

describe('UnbindWechatUseCase (auth 持 tx 跨 account ctx)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy: 码校验 → markUsed → commitUnbind 同 tx, resolve', async () => {
    const { usecase, markUsed, commitExecute } = build({});
    await expect(usecase.execute(1n, CODE)).resolves.toBeUndefined();
    expect(markUsed).toHaveBeenCalledWith(7n, expect.any(Date), TX);
    expect(commitExecute).toHaveBeenCalledWith(TX, 1n);
  });

  it('码哈希不符 → 401, 不进 tx', async () => {
    const { usecase, markUsed } = build({});
    await expect(usecase.execute(1n, '999999')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(markUsed).not.toHaveBeenCalled();
  });

  it('无活码 (findActive null) → 401, 不进 tx', async () => {
    const { usecase, markUsed } = build({ stored: null });
    await expect(usecase.execute(1n, CODE)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(markUsed).not.toHaveBeenCalled();
  });

  it('markUsed lost (claimed=false) → 401 回滚, 不调 commitUnbind', async () => {
    const { usecase, commitExecute } = build({ claimed: false });
    await expect(usecase.execute(1n, CODE)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(commitExecute).not.toHaveBeenCalled();
  });

  it('commitUnbind won:false → 401 回滚 (无副作用)', async () => {
    const { usecase, commitExecute } = build({ won: false });
    await expect(usecase.execute(1n, CODE)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(commitExecute).toHaveBeenCalledOnce();
  });
});
