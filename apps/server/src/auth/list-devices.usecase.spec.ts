import { describe, it, expect, vi } from 'vitest';
import { ListDevicesUseCase } from './list-devices.usecase';
import type { RefreshTokenService } from '../security/refresh-token.service';
import type { IpGeoService } from '../security/ip-geo.service';
import type { RefreshToken } from '../generated/prisma/client';

function row(over: Partial<RefreshToken>): RefreshToken {
  return {
    id: 1n,
    tokenHash: 'h',
    accountId: 42n,
    expiresAt: new Date('2026-06-26T08:00:00.000Z'),
    revokedAt: null,
    createdAt: new Date('2026-05-26T08:00:00.000Z'),
    deviceId: 'd1',
    deviceName: null,
    deviceType: 'UNKNOWN',
    ipAddress: null,
    loginMethod: 'PHONE_SMS',
    ...over,
  } as RefreshToken;
}

function make(
  listResult: { rows: RefreshToken[]; total: number },
  resolveImpl: (ip: string | null) => Promise<string | null> = async () => null,
) {
  const listActiveByAccount = vi.fn().mockResolvedValue(listResult);
  const resolve = vi.fn(resolveImpl);
  const svc = { listActiveByAccount } as unknown as RefreshTokenService;
  const geo = { resolve } as unknown as IpGeoService;
  return { uc: new ListDevicesUseCase(svc, geo), listActiveByAccount, resolve };
}

describe('ListDevicesUseCase', () => {
  it('geo enrich + isCurrent(x-device-id 头比对) + 剥 raw IP + envelope', async () => {
    const { uc, listActiveByAccount } = make(
      {
        rows: [
          row({
            id: 10n,
            deviceId: 'cur',
            ipAddress: '114.114.114.114',
            deviceName: 'iPhone',
            deviceType: 'PHONE',
          }),
          row({ id: 11n, deviceId: 'other', ipAddress: '10.0.0.1' }),
        ],
        total: 2,
      },
      async (ip) => (ip === '114.114.114.114' ? '江苏省南京市' : null),
    );

    const res = await uc.execute(42n, 'cur', 0, 10);

    expect(listActiveByAccount).toHaveBeenCalledWith(42n, 0, 10);
    expect(res).toMatchObject({ page: 0, size: 10, totalElements: 2, totalPages: 1 });
    expect(res.items[0]).toEqual({
      id: '10',
      deviceId: 'cur',
      deviceName: 'iPhone',
      deviceType: 'PHONE',
      location: '江苏省南京市',
      loginMethod: 'PHONE_SMS',
      lastActiveAt: '2026-05-26T08:00:00.000Z',
      isCurrent: true,
    });
    expect(res.items[1].location).toBeNull(); // 私网行 geo → null
    expect(res.items[1].isCurrent).toBe(false);
    // FR-S04: 响应任何字段无原始 IP 字面值
    expect(res.items[0]).not.toHaveProperty('ipAddress');
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('114.114.114.114');
    expect(serialized).not.toContain('10.0.0.1');
  });

  it('缺 x-device-id 头 (currentDeviceId=null) → isCurrent 全 false, 列表仍返', async () => {
    const { uc } = make({ rows: [row({ deviceId: 'a' }), row({ deviceId: 'b' })], total: 2 });
    const res = await uc.execute(42n, null, 0, 10);
    expect(res.items).toHaveLength(2);
    expect(res.items.every((i) => i.isCurrent === false)).toBe(true);
  });

  it('size 超 100 → envelope size 截断 100 + totalPages 据生效页大小算', async () => {
    const { uc } = make({ rows: [], total: 250 });
    const res = await uc.execute(42n, null, 0, 500);
    expect(res.size).toBe(100);
    expect(res.totalPages).toBe(3); // ceil(250/100)
  });

  it('空列表 → totalPages 0, items []', async () => {
    const { uc } = make({ rows: [], total: 0 });
    const res = await uc.execute(42n, null, 0, 10);
    expect(res.totalPages).toBe(0);
    expect(res.items).toEqual([]);
  });
});
