import { Inject, Injectable } from '@nestjs/common';
import { issueSmsCode } from './sms-code.rules';
import { SmsCodeStore } from './sms-code.store';
import { SMS_GATEWAY, type SmsGateway } from './sms-gateway.port';

const TTL_SEC = 300;

@Injectable()
export class RequestSmsCodeUseCase {
  constructor(
    private readonly smsCodeStore: SmsCodeStore,
    @Inject(SMS_GATEWAY) private readonly smsGateway: SmsGateway,
  ) {}

  async execute(phone: string): Promise<{ ttlSec: number }> {
    const code = issueSmsCode();
    await this.smsCodeStore.store(phone, code, TTL_SEC);
    await this.smsGateway.sendCode(phone, code);
    return { ttlSec: TTL_SEC };
  }
}
