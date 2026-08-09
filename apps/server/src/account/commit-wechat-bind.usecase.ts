import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';

const WECHAT_PROVIDER = 'WECHAT';

/**
 * 微信绑定写半段判别结果 (010 FR-S02, O7/R2 已定 2026-05-31):
 * - CREATED        : 新建绑定成功
 * - IDEMPOTENT     : 本账号已绑**同** openid → 幂等 (O7: 同 CREATED 返 201)
 * - SELF_DIFFERENT : 本账号已绑**不同** openid → 拒 (R2: 不静默替换身份)
 * - CONFLICT       : openid 已被**他**账号占 → 拒 (不泄露他账号, FR-S02)
 */
export type WechatBindResult = 'CREATED' | 'IDEMPOTENT' | 'SELF_DIFFERENT' | 'CONFLICT';

/**
 * CommitWechatBind — account context 独占 `wechat_binding` 表写 (per ADR-0043 §5
 * 护城河 + 两段式委托写半段)。auth 编排 (bind-wechat) 经此跨 moat 写, 不直碰
 * `prisma.wechatBinding.*`。
 *
 * **并发原语** (READ COMMITTED, 禁 FOR UPDATE/Serializable): 直接 `create`, 两个
 * 唯一约束 (openid 全局唯一 / (accountId,provider) 一账号一绑) 即冲突闸。撞**任意**
 * P2002 后**查本账号现有 WECHAT 绑定** —— 与 DB 报哪个 constraint 无关 (自号重绑
 * 同 openid 会同时违反两约束, 触发顺序不确定), 由"本账号有无绑定 + openid 是否相同"
 * 三态裁决, 避免依赖 Prisma 的 constraint target。
 *
 * **MUST NOT** 改 displayName/bio/gender (绑定不回填 profile, FR-S02)。
 */
@Injectable()
export class CommitWechatBindUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(accountId: bigint, openid: string, unionid?: string): Promise<WechatBindResult> {
    try {
      await this.prisma.wechatBinding.create({
        data: { accountId, provider: WECHAT_PROVIDER, openid, unionid: unionid ?? null },
      });
      return 'CREATED';
    } catch (e) {
      if (!isPrismaUniqueViolation(e)) throw e;
      const existing = await this.prisma.wechatBinding.findFirst({
        where: { accountId, provider: WECHAT_PROVIDER },
      });
      if (existing) {
        return existing.openid === openid ? 'IDEMPOTENT' : 'SELF_DIFFERENT';
      }
      // 本账号无绑定 → 冲突来自 openid 全局唯一 = openid 被他账号占
      return 'CONFLICT';
    }
  }
}

function isPrismaUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 'P2002'
  );
}
