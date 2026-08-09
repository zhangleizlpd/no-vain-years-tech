import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { RevokeDeviceUseCase } from './revoke-device.usecase';
import { DeviceNotFoundException } from './device-not-found.exception';
import { CannotRemoveCurrentDeviceException } from './cannot-remove-current-device.exception';
import { DEVICE_REVOKED_EVENT_TYPE } from './device-revoked.event';
import type { PrismaService } from '../security/prisma.service';
import type { RefreshTokenService } from '../security/refresh-token.service';
import type { OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import type { RefreshToken } from '../generated/prisma/client';

const ACCOUNT = 42n;
const RECORD = 1001n;
const CURRENT = 'cur-device';
const OTHER = 'other-device';

// sentinel tx — collaborators 全 mock, 仅断言被透传同一引用。
const TX = { __tx: true } as const;

function ownRow(over: Partial<RefreshToken> = {}): RefreshToken {
  return { id: RECORD, accountId: ACCOUNT, deviceId: OTHER, ...over } as RefreshToken;
}

describe('RevokeDeviceUseCase (auth 持 tx 编排)', () => {
  let findById: ReturnType<typeof vi.fn>;
  let revokeOne: ReturnType<typeof vi.fn>;
  let publish: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;
  let usecase: RevokeDeviceUseCase;

  beforeEach(() => {
    findById = vi.fn().mockResolvedValue(ownRow());
    revokeOne = vi.fn().mockResolvedValue({ won: true });
    publish = vi.fn().mockResolvedValue(undefined);
    transaction = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(TX));
    usecase = new RevokeDeviceUseCase(
      { $transaction: transaction } as unknown as PrismaService,
      { findById, revokeOneForAccount: revokeOne } as unknown as RefreshTokenService,
      { publish } as unknown as OutboxPublisher,
    );
  });

  it('happy: 本账号非当前设备 → findById → revokeOne(won) → publish 顺序 + 同 tx + payload', async () => {
    await expect(usecase.execute(ACCOUNT, RECORD, CURRENT)).resolves.toBeUndefined();

    expect(findById.mock.invocationCallOrder[0]!).toBeLessThan(
      revokeOne.mock.invocationCallOrder[0]!,
    );
    expect(revokeOne.mock.invocationCallOrder[0]!).toBeLessThan(
      publish.mock.invocationCallOrder[0]!,
    );

    const [rid, acc, now, tx] = revokeOne.mock.calls[0]!;
    expect(rid).toBe(RECORD);
    expect(acc).toBe(ACCOUNT);
    expect(now).toBeInstanceOf(Date);
    expect(tx).toBe(TX);

    const [pubTx, eventType, payload] = publish.mock.calls[0]!;
    expect(pubTx).toBe(TX);
    expect(eventType).toBe(DEVICE_REVOKED_EVENT_TYPE);
    expect(payload).toMatchObject({ accountId: '42', recordId: '1001', deviceId: OTHER });
    expect((payload as { revokedAt: string }).revokedAt).toBe(
      (payload as { occurredAt: string }).occurredAt,
    );
  });

  it('缺 x-device-id (null) → 401, 不查不开 tx (FR-S12 防自撤前置)', async () => {
    await expect(usecase.execute(ACCOUNT, RECORD, null)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(findById).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('findById null → 404 DEVICE_NOT_FOUND, 不开 tx', async () => {
    findById.mockResolvedValue(null);
    await expect(usecase.execute(ACCOUNT, RECORD, CURRENT)).rejects.toBeInstanceOf(
      DeviceNotFoundException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('跨账号行 → 404 DEVICE_NOT_FOUND (与 null 同折叠, 反枚举), 不开 tx', async () => {
    findById.mockResolvedValue(ownRow({ accountId: 999n }));
    await expect(usecase.execute(ACCOUNT, RECORD, CURRENT)).rejects.toBeInstanceOf(
      DeviceNotFoundException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('目标 deviceId == 当前设备 → 409 CANNOT_REMOVE_CURRENT_DEVICE, 不开 tx', async () => {
    findById.mockResolvedValue(ownRow({ deviceId: CURRENT }));
    await expect(usecase.execute(ACCOUNT, RECORD, CURRENT)).rejects.toBeInstanceOf(
      CannotRemoveCurrentDeviceException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('won=false (已撤 / 竞态败者) → 幂等, 不发事件', async () => {
    revokeOne.mockResolvedValue({ won: false });
    await expect(usecase.execute(ACCOUNT, RECORD, CURRENT)).resolves.toBeUndefined();
    expect(revokeOne).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it('publish 抛 → 整 tx 回滚 (异常透传)', async () => {
    publish.mockRejectedValue(new Error('publish boom'));
    await expect(usecase.execute(ACCOUNT, RECORD, CURRENT)).rejects.toThrow('publish boom');
  });
});
