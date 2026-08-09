import { Injectable, Logger } from '@nestjs/common';
import Dysmsapi, { SendSmsRequest } from '@alicloud/dysmsapi20170525';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import type { SmsPurpose } from './deletion-code.rules';
import type { RetryExecutor } from './retry-executor.port';
import type { SmsGateway } from './sms-gateway.port';

/** purpose → Aliyun templateCode 覆盖表 (缺 → 回退默认 templateCode)。 */
export type SmsTemplateOverrides = Partial<Record<SmsPurpose, string>>;

export interface AliyunSmsGatewayCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  endpoint?: string;
  regionId?: string;
}

const DEFAULT_ENDPOINT = 'dysmsapi.aliyuncs.com';
const DEFAULT_REGION = 'cn-hangzhou';

/**
 * AliyunSmsGateway — production SmsGateway adapter (W3 A4, FR-S03)。
 *
 * Skeleton-only (per 2026-05-17 W3 起手 user choice "Skeleton-only 没 cred"):
 * - 完整 SDK 调用 + RetryExecutor 包 retry 策略
 * - ENV-gated provider 切换 (mock 默认 dev/test, aliyun 仅在 SMS_GATEWAY=aliyun 时启用)
 * - 真 SMS env-gated IT defer 到 cred + SignName/TemplateCode 审批后单独 PR
 *
 * Client + signName + templateCode 通过 ctor 显式注入 (testable), provider
 * factory 在 auth.module.ts 内部 new client + new gateway。
 *
 * Phone format conversion: Aliyun 国内短信接 11 digit (no +86 prefix), strip
 * +86 if present。
 */
@Injectable()
export class AliyunSmsGateway implements SmsGateway {
  private readonly logger = new Logger(AliyunSmsGateway.name);

  constructor(
    private readonly client: Dysmsapi,
    private readonly signName: string,
    private readonly templateCode: string,
    private readonly retryExecutor: RetryExecutor,
    // purpose → templateCode 覆盖; 注销/撤销码用独立模板 (FR-S05/S08)。缺省 {} →
    // 一律用默认 templateCode (001 登录/注册码 + 未配模板的 purpose 回退)。
    private readonly templateOverrides: SmsTemplateOverrides = {},
  ) {}

  static createClient(cred: AliyunSmsGatewayCredentials): Dysmsapi {
    const config = new $OpenApiUtil.Config({
      accessKeyId: cred.accessKeyId,
      accessKeySecret: cred.accessKeySecret,
      endpoint: cred.endpoint ?? DEFAULT_ENDPOINT,
      regionId: cred.regionId ?? DEFAULT_REGION,
    });
    return new Dysmsapi(config);
  }

  async sendCode(phone: string, code: string, purpose?: SmsPurpose): Promise<void> {
    const phoneNumber = phone.startsWith('+86') ? phone.slice(3) : phone;
    const templateCode = (purpose && this.templateOverrides[purpose]) || this.templateCode;

    const request = new SendSmsRequest({
      phoneNumbers: phoneNumber,
      signName: this.signName,
      templateCode,
      templateParam: JSON.stringify({ code }),
    });

    const response = await this.retryExecutor.execute(() => this.client.sendSms(request));

    if (response.body?.code !== 'OK') {
      throw new Error(
        `Aliyun SMS send failed: code=${response.body?.code ?? 'UNKNOWN'} message=${response.body?.message ?? ''}`,
      );
    }
    this.logger.log(`Aliyun SMS sent to ${phone} (bizId=${response.body.bizId ?? 'unknown'})`);
  }
}
