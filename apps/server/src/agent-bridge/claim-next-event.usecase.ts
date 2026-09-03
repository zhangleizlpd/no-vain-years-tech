import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { JwtTokenService } from '../security/jwt-token.service';
import { LEASE_SECONDS } from './agent-queue.constants.js';

/**
 * $queryRaw 返回的 claimed 行 (DB 列名 snake_case; PrismaPg 驱动: BIGINT→bigint,
 * UUID→string, timestamptz→Date)。
 */
interface ClaimedRow {
  id: string;
  account_id: bigint;
  biz_type: string;
  biz_id: string;
  lease_expires_at: Date;
}

/** claim 成功的瘦事件 + 委托 token (controller 经 agent-event.response.ts 映射)。 */
export interface ClaimedEvent {
  eventId: string;
  bizType: string;
  bizId: string;
  delegationToken: string;
  leaseExpiresAt: Date;
}

/**
 * P1.4 poll: 原子 claim 最老 claimable 事件 + 签委托 token。
 *
 * claimable = `status='pending'` (从未 claim) 或 (`status='claimed'` 且租约已过期) —— 后者
 * 是 worker claim 后未在租约内 result/ack 的重投递 (可见性超时)。`FOR UPDATE SKIP LOCKED`
 * 让并发 poll 各自跳过被锁行 → 各拿不同事件, 零重复投递 (Prisma 原生 API 不支持 SKIP
 * LOCKED, 故走 $queryRaw; 全仓首例 —— EVIDENCE: 生成的 client
 * `apps/server/src/generated/prisma` (Prisma 7.8.0) 里 `skipLocked` / `skip locked` **零命中**,
 * 2026-09-03 复算; 升 Prisma 大版本时值得回来复查一次)。
 * 单语句 UPDATE...WHERE id=(SELECT...FOR UPDATE SKIP
 * LOCKED LIMIT 1) RETURNING = 隐式事务内原子 claim。
 *
 * 委托 token (拉取层鉴权): claim 时即时签, **不落表** (避免在队列里坐等过期, mirror IM
 * file_id→短时 URL)。PoC 期直接复用 account access token (决策门3: signAccessToken,
 * sub=accountId, 15min; ideation 端点现成 JwtAuthGuard 零改直接收)。子plan3 收紧为 scoped
 * 只读委托 token —— 换此一处签发点即可。
 */
@Injectable()
export class ClaimNextEventUseCase {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtTokenService: JwtTokenService,
  ) {}

  async execute(): Promise<ClaimedEvent | null> {
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE "agent_queue_event"
      SET status = 'claimed',
          claimed_at = now(),
          lease_expires_at = now() + ${LEASE_SECONDS} * interval '1 second',
          attempts = attempts + 1,
          updated_at = now()
      WHERE id = (
        SELECT id FROM "agent_queue_event"
        WHERE status = 'pending'
           OR (status = 'claimed' AND lease_expires_at < now())
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING id, account_id, biz_type, biz_id, lease_expires_at;
    `;
    const row = rows[0];
    if (!row) return null;

    const delegationToken = this.jwtTokenService.signAccessToken({ accountId: row.account_id });
    return {
      eventId: row.id,
      bizType: row.biz_type,
      bizId: row.biz_id,
      delegationToken,
      leaseExpiresAt: row.lease_expires_at,
    };
  }
}
