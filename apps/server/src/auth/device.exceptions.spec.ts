import { describe, it, expect } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { DeviceNotFoundException } from './device-not-found.exception';
import { CannotRemoveCurrentDeviceException } from './cannot-remove-current-device.exception';

describe('device exceptions (status + code 映射)', () => {
  it('DeviceNotFoundException → 404 DEVICE_NOT_FOUND', () => {
    const ex = new DeviceNotFoundException();
    expect(ex.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(DeviceNotFoundException.code).toBe('DEVICE_NOT_FOUND');
    expect(ex.getResponse()).toMatchObject({ code: 'DEVICE_NOT_FOUND' });
  });

  it('DeviceNotFoundException 无参 → 两实例响应体一致 (反枚举字节级折叠)', () => {
    expect(new DeviceNotFoundException().getResponse()).toEqual(
      new DeviceNotFoundException().getResponse(),
    );
  });

  it('CannotRemoveCurrentDeviceException → 409 CANNOT_REMOVE_CURRENT_DEVICE', () => {
    const ex = new CannotRemoveCurrentDeviceException();
    expect(ex.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(CannotRemoveCurrentDeviceException.code).toBe('CANNOT_REMOVE_CURRENT_DEVICE');
    expect(ex.getResponse()).toMatchObject({ code: 'CANNOT_REMOVE_CURRENT_DEVICE' });
  });
});
