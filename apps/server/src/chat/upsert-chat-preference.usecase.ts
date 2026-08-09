import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

/**
 * 写账号级 chat 自定义指令 (031 T003, plan D1/R1) — chat 叶子 ctx, 扁平 + 贫血 +
 * 直注 PrismaService (无 repository, per ADR-0043)。
 *
 * 单账号单行: 按 `accountId` unique 锚 upsert (创建或更新), 幂等 — 二次写覆盖、不增行。
 * **READ COMMITTED 足够** (单行无状态机争用), 禁 `FOR UPDATE`/Serializable (plan Guardrails)。
 * 空串合法 = 清空语义 (D9: 后续 userCustomLayer 返 null)。长度上限 2000 在 validator 层
 * (T004 `@MaxLength`), 此 UC 不做第二道校验 (DB `@db.Text` 不钉长度, U1)。
 */

@Injectable()
export class UpsertChatPreferenceUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, customInstruction: string): Promise<void> {
    await this.prisma.chatPreference.upsert({
      where: { accountId },
      create: { accountId, customInstruction },
      update: { customInstruction },
    });
  }
}
