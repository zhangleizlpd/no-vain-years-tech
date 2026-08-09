import { describe, expect, it, vi } from 'vitest';
import type Dysmsapi from '@alicloud/dysmsapi20170525';
import { AliyunSmsGateway } from './aliyun-sms.gateway';
import { SmsPurpose } from './deletion-code.rules';
import type { RetryExecutor } from './retry-executor.port';

/**
 * T051 unit spec for AliyunSmsGateway — mock Aliyun SDK + RetryExecutor。
 *
 * 真 SMS env-gated IT defer 到 cred + SignName/TemplateCode 审批后单独 PR
 * (per 2026-05-17 W3 起手 user choice "Skeleton-only")。
 */
describe('AliyunSmsGateway', () => {
  const phone = '+8613800138999';
  const code = '123456';
  const SIGN_NAME = 'TestSign';
  const TEMPLATE_CODE = 'SMS_TEST_001';

  function buildPassThroughRetryMock(): RetryExecutor {
    return {
      execute: vi.fn((op: () => Promise<unknown>) => op()),
    } as unknown as RetryExecutor;
  }

  it('success: 调 client.sendSms 一次, request 字段正确 (phone 去 +86, JSON templateParam)', async () => {
    const sendSms = vi.fn().mockResolvedValue({
      body: { code: 'OK', bizId: 'biz-xxx-1', message: 'OK' },
    });
    const mockClient = { sendSms } as unknown as Dysmsapi;
    const gateway = new AliyunSmsGateway(
      mockClient,
      SIGN_NAME,
      TEMPLATE_CODE,
      buildPassThroughRetryMock(),
    );

    await gateway.sendCode(phone, code);

    expect(sendSms).toHaveBeenCalledTimes(1);
    const req = sendSms.mock.calls[0]![0];
    expect(req.phoneNumbers).toBe('13800138999');
    expect(req.signName).toBe(SIGN_NAME);
    expect(req.templateCode).toBe(TEMPLATE_CODE);
    expect(JSON.parse(req.templateParam)).toEqual({ code: '123456' });
  });

  it('response code != "OK" → throws (Aliyun 业务失败)', async () => {
    const sendSms = vi.fn().mockResolvedValue({
      body: { code: 'isv.BUSINESS_LIMIT_CONTROL', message: '触发流控' },
    });
    const mockClient = { sendSms } as unknown as Dysmsapi;
    const gateway = new AliyunSmsGateway(
      mockClient,
      SIGN_NAME,
      TEMPLATE_CODE,
      buildPassThroughRetryMock(),
    );

    await expect(gateway.sendCode(phone, code)).rejects.toThrow(/Aliyun SMS send failed/);
  });

  it('SDK throw → retryExecutor 接到, error propagate', async () => {
    const sendSms = vi.fn().mockRejectedValue(new Error('network timeout'));
    const mockClient = { sendSms } as unknown as Dysmsapi;
    const retryExecutor = buildPassThroughRetryMock();
    const gateway = new AliyunSmsGateway(mockClient, SIGN_NAME, TEMPLATE_CODE, retryExecutor);

    await expect(gateway.sendCode(phone, code)).rejects.toThrow('network timeout');
    expect(retryExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it('purpose 选独立模板 (T007 FR-S05/S08): 配置的 purpose → override templateCode', async () => {
    const sendSms = vi.fn().mockResolvedValue({ body: { code: 'OK', bizId: 'biz-del' } });
    const mockClient = { sendSms } as unknown as Dysmsapi;
    const gateway = new AliyunSmsGateway(
      mockClient,
      SIGN_NAME,
      TEMPLATE_CODE,
      buildPassThroughRetryMock(),
      {
        [SmsPurpose.DELETE_ACCOUNT]: 'SMS_DEL_777',
        [SmsPurpose.CANCEL_DELETION]: 'SMS_CANCEL_888',
      },
    );

    await gateway.sendCode(phone, code, SmsPurpose.DELETE_ACCOUNT);
    expect(sendSms.mock.calls[0]![0].templateCode).toBe('SMS_DEL_777');

    await gateway.sendCode(phone, code, SmsPurpose.CANCEL_DELETION);
    expect(sendSms.mock.calls[1]![0].templateCode).toBe('SMS_CANCEL_888');
  });

  it('未配 purpose 模板 / 无 purpose → 回退默认 templateCode (001 登录码不变)', async () => {
    const sendSms = vi.fn().mockResolvedValue({ body: { code: 'OK', bizId: 'biz-fb' } });
    const mockClient = { sendSms } as unknown as Dysmsapi;
    // overrides 空 → 任何 purpose 都回退默认
    const gateway = new AliyunSmsGateway(
      mockClient,
      SIGN_NAME,
      TEMPLATE_CODE,
      buildPassThroughRetryMock(),
    );

    await gateway.sendCode(phone, code, SmsPurpose.DELETE_ACCOUNT);
    expect(sendSms.mock.calls[0]![0].templateCode).toBe(TEMPLATE_CODE);

    await gateway.sendCode(phone, code); // 无 purpose (登录/注册码)
    expect(sendSms.mock.calls[1]![0].templateCode).toBe(TEMPLATE_CODE);
  });

  it('non-+86 phone 保持原样 (国际号未来扩展)', async () => {
    const sendSms = vi.fn().mockResolvedValue({
      body: { code: 'OK', bizId: 'biz-xxx-2' },
    });
    const mockClient = { sendSms } as unknown as Dysmsapi;
    const gateway = new AliyunSmsGateway(
      mockClient,
      SIGN_NAME,
      TEMPLATE_CODE,
      buildPassThroughRetryMock(),
    );

    const intlPhone = '8521234567890';
    await gateway.sendCode(intlPhone, code);

    expect(sendSms.mock.calls[0]![0].phoneNumbers).toBe('8521234567890');
  });
});
