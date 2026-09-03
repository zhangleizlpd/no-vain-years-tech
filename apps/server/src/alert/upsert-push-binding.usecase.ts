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
 *
 * EVIDENCE: 该优化的判据是**五条全满足**, 官方原文 (PostgreSQL 支持):
 * 只改一个 model · create 与 update 里无嵌套查询 · selection 里无嵌套读 · where 只指定
 * **一个**唯一字段 · 该字段在 where 与 create 里**取值相同**。任一条不满足, Prisma 就退回
 * 自己先查后写。https://www.prisma.io/docs/orm/reference/prisma-client-reference
 * (2026-09-03 复核)。
 * 🚨 本注释此前只列了其中两条 —— 退化是**静默**的: 加一个嵌套 select 或让 create 的
 * registrationId 与 where 取值不同, 原子性就没了、P2002 并发窗口回来, 而没有任何断言会红。
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
