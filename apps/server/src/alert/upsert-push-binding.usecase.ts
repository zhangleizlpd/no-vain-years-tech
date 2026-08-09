import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import type { PushBinding } from '../generated/prisma/client';

/**
 * 022 US3 — 设备绑定上报 (EP9, intra 写)。
 *
 * `upsert where registrationId` (clarify Q1 一设备一账号): RegID 全局唯一 —
 * 他账号已绑 → update 整体改绑当前账号 (旧绑定原行覆写即失效, FR-001)；同账号
 * 重报 → 仅刷新 updatedAt (FR-002 幂等, 无 409 分支)。where 单唯一键 + update
 * 无嵌套查询 → Prisma 走 native INSERT..ON CONFLICT (原子, 无 P2002 并发窗口)。
 */
@Injectable()
export class UpsertPushBindingUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    accountId: bigint,
    input: { registrationId: string; platform: string },
  ): Promise<PushBinding> {
    return this.prisma.pushBinding.upsert({
      where: { registrationId: input.registrationId },
      create: { accountId, registrationId: input.registrationId, platform: input.platform },
      update: { accountId, platform: input.platform },
    });
  }
}
