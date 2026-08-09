import { Injectable, Logger } from '@nestjs/common';
import {
  ALERT_PUSH_CHANNEL_ID,
  type PushGateway,
  type PushSendInput,
  type PushSendResult,
} from './push-gateway.port.js';

const JPUSH_PUSH_URL = 'https://api.jpush.cn/v3/push';

/** 极光「找不到推送目标」错误码 — RegID 无效/未注册 (docs.jiguang.cn http_status_code)。 */
const JPUSH_INVALID_TARGET_CODE = 1011;

/**
 * JpushPushGateway — production PushGateway adapter (022 T002, PoC #364 实证链路)。
 *
 * REST `POST /v3/push`, Basic auth `appKey:masterSecret`。payload per plan
 * §payload 形态: audience registration_id 单推 (V1 自用规模, 不做 batch audience)
 * + android notification 指定自建高优渠道 channel_id (FR-006, heads-up 横幅) +
 * time_to_live 86400 (离线保留天级, spec Edge)。`secondary_push` 为免费版默认
 * 策略不显式传。
 *
 * 错误三分类 (port 契约): 仅 1011 判 invalid_target (误判会删 binding, FR-010);
 * 5xx / 网络 / 429 限流 / 其他 4xx (鉴权/参数错) 一律 retryable — 由 dispatch
 * attempts ≤3 兜底成 FAILED 留痕, 绝不重试风暴。
 */
@Injectable()
export class JpushPushGateway implements PushGateway {
  private readonly logger = new Logger(JpushPushGateway.name);

  constructor(
    private readonly appKey: string,
    private readonly masterSecret: string,
  ) {}

  async send(input: PushSendInput): Promise<PushSendResult> {
    const payload = {
      platform: ['android'],
      audience: { registration_id: [input.registrationId] },
      notification: {
        android: {
          alert: input.body,
          title: input.title,
          channel_id: ALERT_PUSH_CHANNEL_ID,
          extras: { triggerId: input.triggerId.toString() },
        },
      },
      options: { time_to_live: 86400 },
    };

    let res: Response;
    try {
      res = await fetch(JPUSH_PUSH_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${this.appKey}:${this.masterSecret}`).toString('base64')}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { kind: 'retryable', detail: `network: ${message}` };
    }

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { msg_id?: string };
      this.logger.log(
        `jpush push accepted regId=${input.registrationId} triggerId=${input.triggerId} msgId=${body.msg_id ?? 'unknown'}`,
      );
      return { kind: 'ok', detail: body.msg_id };
    }

    if (res.status === 429 || res.status >= 500) {
      return { kind: 'retryable', detail: `http ${res.status}` };
    }

    // 其余 4xx: 解析极光 error body; 仅明确 1011 (找不到目标) 判 invalid_target。
    const errBody = (await res.json().catch(() => null)) as {
      error?: { code?: number; message?: string };
    } | null;
    const code = errBody?.error?.code;
    const detail =
      `http ${res.status} code=${code ?? 'unparsable'} ${errBody?.error?.message ?? ''}`.trim();
    if (code === JPUSH_INVALID_TARGET_CODE) {
      return { kind: 'invalid_target', detail };
    }
    return { kind: 'retryable', detail };
  }
}
