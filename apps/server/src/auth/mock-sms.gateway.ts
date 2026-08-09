import { Injectable, Logger } from '@nestjs/common';
import type { SmsPurpose } from './deletion-code.rules';
import type { SmsGateway } from './sms-gateway.port';

/**
 * MockSmsGateway — W2 placeholder for AliyunSmsGateway (W3 replacement).
 *
 * Stores the last code + purpose emitted per phone in an in-memory Map.
 * `getLastCode(phone)` / `getLastPurpose(phone)` let E2E / IT tests retrieve
 * what was "sent" (purpose lets 004 IT assert the right SMS type went out).
 *
 * Not for production — Aliyun cockatiel-wrapped impl lands in W3.
 */
@Injectable()
export class MockSmsGateway implements SmsGateway {
  private readonly logger = new Logger(MockSmsGateway.name);
  private readonly lastCode = new Map<string, string>();
  private readonly lastPurpose = new Map<string, SmsPurpose | undefined>();

  async sendCode(phone: string, code: string, purpose?: SmsPurpose): Promise<void> {
    this.lastCode.set(phone, code);
    this.lastPurpose.set(phone, purpose);
    this.logger.log(`[MOCK SMS] sent ${code} to ${phone} (purpose=${purpose ?? 'login'})`);
  }

  getLastCode(phone: string): string | undefined {
    return this.lastCode.get(phone);
  }

  getLastPurpose(phone: string): SmsPurpose | undefined {
    return this.lastPurpose.get(phone);
  }

  clearAll(): void {
    this.lastCode.clear();
    this.lastPurpose.clear();
  }
}
