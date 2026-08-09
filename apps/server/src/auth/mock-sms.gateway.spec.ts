import { describe, it, expect } from 'vitest';
import { MockSmsGateway } from './mock-sms.gateway';
import { SmsPurpose } from './deletion-code.rules';

// T007: mock 记录 purpose, 供 004 IT 断言发出的 SMS 类型 (DELETE_ACCOUNT / CANCEL_DELETION /
// login)。purpose 缺省 (登录码) → getLastPurpose 返 undefined。
describe('MockSmsGateway — code + purpose recording', () => {
  it('records last code + purpose per phone', async () => {
    const gw = new MockSmsGateway();
    await gw.sendCode('+8613800138000', '111111', SmsPurpose.DELETE_ACCOUNT);

    expect(gw.getLastCode('+8613800138000')).toBe('111111');
    expect(gw.getLastPurpose('+8613800138000')).toBe(SmsPurpose.DELETE_ACCOUNT);
  });

  it('no purpose (login/register码) → getLastPurpose undefined', async () => {
    const gw = new MockSmsGateway();
    await gw.sendCode('+8613800138001', '222222');

    expect(gw.getLastCode('+8613800138001')).toBe('222222');
    expect(gw.getLastPurpose('+8613800138001')).toBeUndefined();
  });

  it('clearAll wipes code + purpose', async () => {
    const gw = new MockSmsGateway();
    await gw.sendCode('+8613800138002', '333333', SmsPurpose.CANCEL_DELETION);
    gw.clearAll();

    expect(gw.getLastCode('+8613800138002')).toBeUndefined();
    expect(gw.getLastPurpose('+8613800138002')).toBeUndefined();
  });
});
