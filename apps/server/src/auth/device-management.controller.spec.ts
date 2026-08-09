import { describe, it, expect, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DeviceManagementController } from './device-management.controller';
import { DeviceListQuery } from './device-list.query';
import { ParseBigIntPipe } from './parse-bigint.pipe';
import { FormValidationException } from '../security/form-validation.exception';
import type { ListDevicesUseCase } from './list-devices.usecase';
import type { RevokeDeviceUseCase } from './revoke-device.usecase';
import type { DeviceListResponse } from './device-list.response';

describe('DeviceManagementController', () => {
  const envelope: DeviceListResponse = {
    page: 0,
    size: 10,
    totalElements: 0,
    totalPages: 0,
    items: [],
  };

  function make() {
    const listExecute = vi.fn().mockResolvedValue(envelope);
    const revokeExecute = vi.fn().mockResolvedValue(undefined);
    const controller = new DeviceManagementController(
      { execute: listExecute } as unknown as ListDevicesUseCase,
      { execute: revokeExecute } as unknown as RevokeDeviceUseCase,
    );
    return { controller, listExecute, revokeExecute };
  }

  it('list: 委托 listDevices.execute(accountId, x-device-id, page, size) + 返回 envelope', async () => {
    const { controller, listExecute } = make();
    const res = await controller.list(
      { user: { accountId: 42n } },
      { page: 2, size: 5 } as DeviceListQuery,
      'cur-device',
    );
    expect(res).toBe(envelope);
    expect(listExecute).toHaveBeenCalledWith(42n, 'cur-device', 2, 5);
  });

  it('list: 缺 x-device-id 头 → 传 null (isCurrent 由 usecase 全置 false)', async () => {
    const { controller, listExecute } = make();
    await controller.list(
      { user: { accountId: 7n } },
      { page: 0, size: 10 } as DeviceListQuery,
      undefined,
    );
    expect(listExecute).toHaveBeenCalledWith(7n, null, 0, 10);
  });

  it('revoke: 委托 revokeDevice.execute(accountId, recordId, x-device-id)', async () => {
    const { controller, revokeExecute } = make();
    await expect(
      controller.revoke({ user: { accountId: 42n } }, 1001n, 'cur-device'),
    ).resolves.toBeUndefined();
    expect(revokeExecute).toHaveBeenCalledWith(42n, 1001n, 'cur-device');
  });

  it('revoke: 缺 x-device-id 头 → 传 null (usecase 据之 401)', async () => {
    const { controller, revokeExecute } = make();
    await controller.revoke({ user: { accountId: 7n } }, 1001n, undefined);
    expect(revokeExecute).toHaveBeenCalledWith(7n, 1001n, null);
  });

  it('revoke: usecase 抛 (404/409) → 控制器透传', async () => {
    const { controller, revokeExecute } = make();
    revokeExecute.mockRejectedValue(new Error('boom-from-usecase'));
    await expect(controller.revoke({ user: { accountId: 1n } }, 9n, 'd')).rejects.toThrow(
      'boom-from-usecase',
    );
  });
});

describe('ParseBigIntPipe', () => {
  const pipe = new ParseBigIntPipe();
  const meta = { type: 'param', data: 'recordId' } as const;

  it('非负整数串 → BigInt', () => {
    expect(pipe.transform('1001', meta)).toBe(1001n);
    expect(pipe.transform('0', meta)).toBe(0n);
  });

  it('非法 (非数字 / 负 / 空) → FormValidationException (400)', () => {
    expect(() => pipe.transform('abc', meta)).toThrow(FormValidationException);
    expect(() => pipe.transform('-1', meta)).toThrow(FormValidationException);
    expect(() => pipe.transform('1.5', meta)).toThrow(FormValidationException);
    expect(() => pipe.transform('', meta)).toThrow(FormValidationException);
  });
});

describe('DeviceListQuery 校验 (全局 ValidationPipe → 400 FORM_VALIDATION)', () => {
  it('缺省 → page=0 size=10, 无错', () => {
    const dto = plainToInstance(DeviceListQuery, {});
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.page).toBe(0);
    expect(dto.size).toBe(10);
  });

  it('合法字符串 → 转 number, 无错', () => {
    const dto = plainToInstance(DeviceListQuery, { page: '2', size: '5' });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.page).toBe(2);
    expect(dto.size).toBe(5);
  });

  it('page 非 int → 校验失败 (→ 400)', () => {
    expect(validateSync(plainToInstance(DeviceListQuery, { page: 'abc' })).length).toBeGreaterThan(
      0,
    );
  });

  it('size < 1 → 校验失败 (size=0 无意义; 上限 100 不在此拒绝而截断)', () => {
    expect(validateSync(plainToInstance(DeviceListQuery, { size: '0' })).length).toBeGreaterThan(0);
    expect(validateSync(plainToInstance(DeviceListQuery, { page: '-1' })).length).toBeGreaterThan(
      0,
    );
  });
});
