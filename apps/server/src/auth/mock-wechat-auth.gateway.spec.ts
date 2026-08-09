import { describe, it, expect } from 'vitest';
import { MockWechatAuthGateway } from './mock-wechat-auth.gateway';

describe('MockWechatAuthGateway — 确定性 stub openid', () => {
  const gw = new MockWechatAuthGateway();

  it('同 authCode → 同 openid (供冲突 IT)', async () => {
    const a = await gw.resolveIdentity('auth-code-1');
    const b = await gw.resolveIdentity('auth-code-1');
    expect(a.openid).toBe(b.openid);
  });

  it('不同 authCode → 不同 openid', async () => {
    const a = await gw.resolveIdentity('auth-code-1');
    const b = await gw.resolveIdentity('auth-code-2');
    expect(a.openid).not.toBe(b.openid);
  });

  it('openid 格式贴齐真微信: 28 位, o 开头', async () => {
    const { openid } = await gw.resolveIdentity('some-auth-code');
    expect(openid).toMatch(/^o[A-Za-z0-9]{27}$/);
    expect(openid).toHaveLength(28);
  });

  it('Phase 1 stub 不返 unionid (决策3: nullable, 真值待 Phase 2)', async () => {
    const { unionid } = await gw.resolveIdentity('some-auth-code');
    expect(unionid).toBeUndefined();
  });
});
