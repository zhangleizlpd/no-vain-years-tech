import { describe, it, expect } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { WechatAlreadyBoundException } from './wechat-already-bound.exception';
import { WechatAccountAlreadyBoundException } from './wechat-account-already-bound.exception';

describe('wechat-binding exceptions (status + code 映射)', () => {
  it('WechatAlreadyBoundException → 409 WECHAT_ALREADY_BOUND_OTHER', () => {
    const ex = new WechatAlreadyBoundException();
    expect(ex.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(WechatAlreadyBoundException.code).toBe('WECHAT_ALREADY_BOUND_OTHER');
    expect(ex.getResponse()).toMatchObject({ code: 'WECHAT_ALREADY_BOUND_OTHER' });
  });

  it('WechatAlreadyBoundException 无参 → 两实例响应体一致 (不泄露他账号, 字节级折叠)', () => {
    expect(new WechatAlreadyBoundException().getResponse()).toEqual(
      new WechatAlreadyBoundException().getResponse(),
    );
  });

  it('WechatAccountAlreadyBoundException → 409 WECHAT_ACCOUNT_ALREADY_BOUND (R2)', () => {
    const ex = new WechatAccountAlreadyBoundException();
    expect(ex.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(WechatAccountAlreadyBoundException.code).toBe('WECHAT_ACCOUNT_ALREADY_BOUND');
    expect(ex.getResponse()).toMatchObject({ code: 'WECHAT_ACCOUNT_ALREADY_BOUND' });
  });

  it('两 exception code 不同 (OTHER vs ACCOUNT_ALREADY_BOUND 客户端可区分)', () => {
    expect(WechatAlreadyBoundException.code).not.toBe(WechatAccountAlreadyBoundException.code);
  });
});
