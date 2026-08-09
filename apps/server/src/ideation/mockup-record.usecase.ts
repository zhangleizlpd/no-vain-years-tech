import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { ClaimedEventOwnershipProvider } from './claimed-event-ownership.js';
import { assertObjectKeyOwnership, normalizeScreens } from './mockup.rules.js';

/** 写记录入参 (channel 回报体 → UC; eventId 派生 scope, 其余直传产物元数据)。 */
export interface RecordMockupParams {
  eventId: string;
  objectKey: string;
  screens: string[];
  note?: string;
}

/** 落库后的 mockup 交付记录 (贫血 raw row 子集投影; controller 不回显, 201 即可)。 */
export interface RecordMockupResult {
  id: bigint;
  sessionId: bigint;
  createdAt: Date;
}

/**
 * 037 T006 (US1 / FR-001 / FR-010) — channel 直传 mockup HTML 成功后回报落 mockup 交付记录
 * (worker-token; ideation 叶子 ctx, 扁平 + 贫血 per ADR-0043; **直注 PrismaService 写自己
 * ctx 表 `ideationMockup`**, NEVER 跨 ctx 写)。
 *
 * 流程:
 *   ① **scope 据 claimed event 派生** —— (accountId, sessionId) 永远由 server 据 channel
 *      所认领的 `agentQueueEvent`(eventId) 派生, channel **不得自报** (FR-002)。派生失败 →
 *      **404 字节级一致**不泄漏 (反枚举)。
 *   ② **prefix 归属校验** —— `objectKey` MUST 落在 `ideation-mockup/{accountId}/{sessionId}/`
 *      前缀内 (派生出的 scope), 否则拒 (防 channel 谎报他 session 的 key)。403 拒 (越权写,
 *      非 404 —— eventId 合法但 objectKey 越界, 与「事件不存在」语义不同)。
 *   ③ **append-only insert** —— `ideationMockup.create` (无 updatedAt、不覆盖; 同 session 多
 *      版 = 多行)。`screens` 经 `normalizeScreens` 兜底 (channel 上报不可信)。重复回报落多行
 *      无害 (channel 正常一次)。
 */
@Injectable()
export class RecordMockupUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: ClaimedEventOwnershipProvider,
  ) {}

  async execute(params: RecordMockupParams): Promise<RecordMockupResult> {
    const { eventId, objectKey, screens, note } = params;

    // ① scope 据 claimed event 派生; 失败 → 404 不泄漏 (channel 不自报 account/session)。
    const owner = await this.ownership.derive(eventId);
    if (!owner) {
      throw new NotFoundException('EVENT_NOT_FOUND');
    }

    // ② prefix 归属校验: objectKey 必须落在派生 scope 前缀内 (防谎报他 session)。
    if (!assertObjectKeyOwnership(objectKey, owner.accountId, owner.sessionId)) {
      throw new ForbiddenException('OBJECT_KEY_OUT_OF_SCOPE');
    }

    // ③ append-only insert (screens 兜底规整; note 可选)。直注 PrismaService 写自己 ctx 表。
    const created = await this.prisma.ideationMockup.create({
      data: {
        sessionId: owner.sessionId,
        accountId: owner.accountId,
        objectKey,
        screens: normalizeScreens(screens),
        note: note ?? null,
      },
      select: { id: true, sessionId: true, createdAt: true },
    });

    return created;
  }
}
