import { describe, expect, it, vi } from 'vitest';
import { CockatielRetryExecutor } from './cockatiel-retry.executor';

/**
 * T048 unit spec for CockatielRetryExecutor。
 *
 * cockatiel 语义: `maxAttempts: 3` = 3 retries + 1 initial = 4 total attempts。
 *
 * 验证 3 个核心场景:
 * 1. 首次 success → operation 调 1 次, 返回值
 * 2. transient failure → retry → 第 4 次 success (operation 调 4 次)
 * 3. max attempts 全 fail → throws last error (operation 调 4 次)
 *
 * 注: 每 test new instance 避免 breaker state 跨 test 累积 (ConsecutiveBreaker
 * 5 阈值; 单 test 4 次 fail 仍未触发 breaker open, 但 fresh instance 隔离更稳)。
 */
describe('CockatielRetryExecutor', () => {
  it('成功路径: operation 第 1 次 succeed → 返回值, 仅调 1 次', async () => {
    const executor = new CockatielRetryExecutor();
    const operation = vi.fn().mockResolvedValue('ok');

    const result = await executor.execute(operation);

    expect(result).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('transient retry: 前 3 次 fail, 第 4 次 success → 返回值, 调 4 次', async () => {
    const executor = new CockatielRetryExecutor();
    let calls = 0;
    const operation = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 4) {
        throw new Error('transient');
      }
      return 'recovered';
    });

    const result = await executor.execute(operation);

    expect(result).toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('exhausted: 4 次 attempt 全 fail → throws last error', async () => {
    const executor = new CockatielRetryExecutor();
    const operation = vi.fn().mockRejectedValue(new Error('persistent'));

    await expect(executor.execute(operation)).rejects.toThrow('persistent');
    expect(operation).toHaveBeenCalledTimes(4);
  });
});
