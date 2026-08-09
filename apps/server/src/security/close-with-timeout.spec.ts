import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { closeWithTimeout } from './close-with-timeout';

describe('closeWithTimeout', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('正常关停：等 close() 完成，不 warn', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    await closeWithTimeout('x', close, 1_000);
    expect(close).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it('🚨 close() 永不 resolve → 到点放行而不是把关停吊死（BullMQ close() 自身不超时）', async () => {
    // 这条是本函数存在的全部理由：没有它，一个卡住的 job 就能让进程永远关不掉。
    const never = () => new Promise<void>(() => {});
    const t0 = Date.now();
    await closeWithTimeout('stuck-worker', never, 40);
    expect(Date.now() - t0).toBeLessThan(1_000); // 真的返回了，没被吊住
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('stuck-worker');
  });

  it('close() 抛错 → 吞掉并继续（关停路径上再抛只会把"慢"升级成"关不掉"）', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(closeWithTimeout('y', boom, 1_000)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('close() 同步抛错也不外溢', async () => {
    const throws = () => {
      throw new Error('sync boom');
    };
    await expect(closeWithTimeout('z', throws as never, 1_000)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
