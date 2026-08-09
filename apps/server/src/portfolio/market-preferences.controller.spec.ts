import { describe, it, expect, vi } from 'vitest';
import { MarketPreferencesController } from './market-preferences.controller';
import type { GetMarketPreferencesUseCase } from './get-market-preferences.usecase';
import type { UpdateMarketPreferenceUseCase } from './update-market-preference.usecase';
import type { MarketPreferencesResult } from './get-market-preferences.usecase';
import { MinOneMarketRequiredException } from './min-one-market-required.exception';

const FULL_STATE: MarketPreferencesResult = {
  markets: [
    {
      marketCode: 'cn',
      displayName: 'A 股',
      isoCurrency: 'CNY',
      group: 'core',
      v1Available: true,
      active: true,
    },
    {
      marketCode: 'hk',
      displayName: '港股',
      isoCurrency: 'HKD',
      group: 'core',
      v1Available: true,
      active: false,
    },
    {
      marketCode: 'us',
      displayName: '美股',
      isoCurrency: 'USD',
      group: 'core',
      v1Available: true,
      active: false,
    },
  ],
};

function build() {
  const getExecute = vi.fn().mockResolvedValue(FULL_STATE);
  const updateExecute = vi.fn().mockResolvedValue(FULL_STATE);
  const controller = new MarketPreferencesController(
    { execute: getExecute } as unknown as GetMarketPreferencesUseCase,
    { execute: updateExecute } as unknown as UpdateMarketPreferenceUseCase,
  );
  return { controller, getExecute, updateExecute };
}

const REQ = { user: { accountId: 42n } };

describe('MarketPreferencesController', () => {
  it('GET → 200 返回全量态 (delegates accountId)', async () => {
    const { controller, getExecute } = build();
    const res = await controller.getPreferences(REQ);
    expect(getExecute).toHaveBeenCalledWith(42n);
    expect(res.markets).toHaveLength(3);
    expect(res.markets[0].marketCode).toBe('cn');
  });

  it('PUT → 200 透传 (accountId, market, active) 给 usecase', async () => {
    const { controller, updateExecute } = build();
    const res = await controller.updatePreference(REQ, 'hk', { active: true });
    expect(updateExecute).toHaveBeenCalledWith(42n, 'hk', true);
    expect(res.markets).toHaveLength(3);
  });

  it('PUT 透传 usecase 业务异常 (min-1 → 422 由 filter 映射)', async () => {
    const { controller, updateExecute } = build();
    updateExecute.mockRejectedValueOnce(new MinOneMarketRequiredException());
    await expect(controller.updatePreference(REQ, 'cn', { active: false })).rejects.toBeInstanceOf(
      MinOneMarketRequiredException,
    );
  });
});
