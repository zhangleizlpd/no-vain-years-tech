// GOLDEN SAMPLE — server 跨 ctx 档（写半段，companion 于 auth/phone-sms-auth.usecase.ts）。
// 两段式 Saga 的 Commit 段：独占 account 表写、让 auth 不碰 prisma.account.*。正向教训 =
// 并发同号注册 race 的 P2002（unique 撞，tx 内 fallback）+ P2034（序列化失败，外层 retry
// 整 tx）双形态处理（per server-impl-playbook P3）。⚠ isWriteConflict 的 P2034 code 检测在
// Prisma 7+adapter-pg 下漏（DriverAdapterError code undefined，playbook P3 已记 shipped bug）。
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { OUTBOX_PUBLISHER, type OutboxPublisher } from '../security/outbox/outbox-publisher.port';
import { ACCOUNT_CREATED_EVENT_TYPE, buildAccountCreatedEvent } from './account-created.event';

/**
 * 跨 context 账户登录落地 (per ADR-0043 两段式委托 — Saga 第 2 段 mutate)。
 *
 * 由 `auth` 在**短信码验证通过后**调用 (调用方 = InspectAccountStatusUseCase 探到
 * ACTIVE 或 NOT_FOUND 的路径)。本 use case 独占 account 表写入,让 auth 不碰
 * `prisma.account.*` / `tx.account.*` (护城河,per ADR-0043 §5):
 *
 *   - 已存在 → 更新 lastLoginAt (登录)。
 *   - 不存在 → create + publish AccountCreatedEvent (自动注册, FR-S11)。
 *
 * FR-S08 并发同号注册 race 在 Serializable 下有两种失败形态,两条都收敛到登录:
 *   - **P2002**(unique violation,insert 时即触)→ tx 内 fallback 重查 + 更新 lastLoginAt。
 *   - **P2034**(write conflict / deadlock,commit 时序列化失败,整 tx abort)→ `execute`
 *     层重试整个 tx;重试时顶层 `findUnique` 命中已 commit 的 row 落登录路径。
 *
 * 自持 `$transaction({ Serializable })` 让 create 与 outbox 写共享 tx
 * (业务 rollback 时 outbox row 也撤,per ADR-0033)。AccountCreatedEvent 是
 * account context 的事件,故 publish 收在此处 (而非 auth) —— 符合依赖方向。
 */
const MAX_SERIALIZATION_RETRIES = 3;

@Injectable()
export class CommitPhoneLoginUseCase {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OUTBOX_PUBLISHER)
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(phone: string): Promise<{ accountId: bigint }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.commitOnce(phone);
      } catch (e) {
        // P2034 = Serializable 序列化失败,整 tx 已 abort → 重试(下一轮顶层命中已 commit row)。
        if (isWriteConflict(e) && attempt < MAX_SERIALIZATION_RETRIES) {
          continue;
        }
        throw e;
      }
    }
  }

  private async commitOnce(phone: string): Promise<{ accountId: bigint }> {
    return this.prisma.$transaction(
      async (tx) => {
        const existing = await tx.account.findUnique({ where: { phone } });
        if (existing && existing.phone !== null) {
          await tx.account.update({
            where: { id: existing.id },
            data: { lastLoginAt: new Date() },
          });
          return { accountId: existing.id };
        }

        try {
          const created = await tx.account.create({
            data: { phone, status: 'ACTIVE', lastLoginAt: new Date() },
          });
          const payload = buildAccountCreatedEvent(created.id, phone, created.createdAt);
          await this.outboxPublisher.publish(
            tx,
            ACCOUNT_CREATED_EVENT_TYPE,
            payload as unknown as Record<string, unknown>,
          );
          return { accountId: created.id };
        } catch (e) {
          // FR-S08 race fallback: 并发同号注册 → unique violation 落到登录路径.
          if (isPrismaUniqueViolation(e)) {
            const raced = await tx.account.findUnique({ where: { phone } });
            if (!raced) throw e;
            await tx.account.update({
              where: { id: raced.id },
              data: { lastLoginAt: new Date() },
            });
            return { accountId: raced.id };
          }
          throw e;
        }
      },
      { isolationLevel: 'Serializable' },
    );
  }
}

function isPrismaUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
  );
}

// Prisma P2034: "Transaction failed due to a write conflict or a deadlock" —
// Postgres Serializable 序列化失败 (40001),整 tx 已 abort,retryable。
function isWriteConflict(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2034'
  );
}
