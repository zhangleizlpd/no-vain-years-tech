import { Injectable, Logger } from '@nestjs/common';
import type { PushGateway, PushSendInput, PushSendResult } from './push-gateway.port.js';

/**
 * MockPushGateway — dev/test 默认 PushGateway (022 T002, 镜像 MockSmsGateway 体例)。
 *
 * 记录全部 send 输入 + 可注入结果队列: IT 用 `enqueueResult` 预置三态
 * (ok / retryable / invalid_target) 驱动 dispatch worker 态机分支; 队列耗尽
 * 回落 `defaultResult` (ok)。
 */
@Injectable()
export class MockPushGateway implements PushGateway {
  private readonly logger = new Logger(MockPushGateway.name);
  private readonly queued: PushSendResult[] = [];
  readonly sent: PushSendInput[] = [];
  defaultResult: PushSendResult = { kind: 'ok' };

  enqueueResult(...results: PushSendResult[]): void {
    this.queued.push(...results);
  }

  async send(input: PushSendInput): Promise<PushSendResult> {
    this.sent.push(input);
    const result = this.queued.shift() ?? this.defaultResult;
    this.logger.log(
      `[MOCK PUSH] regId=${input.registrationId} triggerId=${input.triggerId} "${input.title}" → ${result.kind}`,
    );
    return result;
  }

  clearAll(): void {
    this.sent.length = 0;
    this.queued.length = 0;
    this.defaultResult = { kind: 'ok' };
  }
}
