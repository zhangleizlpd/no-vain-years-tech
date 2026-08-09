import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service';
import { DEFAULT_ACTIVE_MARKETS, isCoreMarket, isKnownMarket } from './market-catalog';
import { projectMarkets } from './portfolio.rules';
import type { MarketPreferencesResult } from './get-market-preferences.usecase';
import { MarketNotFoundException } from './market-not-found.exception';
import { MarketNotAvailableException } from './market-not-available.exception';
import { MinOneMarketRequiredException } from './min-one-market-required.exception';

/**
 * 011 US2 — 切换核心市场激活态 (单行聚合模型, per ADR-0046)。
 *
 * 字典校验 (无 DB): 未知码 → 404 MARKET_NOT_FOUND; 海外码 → 422 MARKET_NOT_AVAILABLE。
 *
 * **min-1 跨行不变性塌缩成单行非空** (ADR-0046)：偏好 = 单行 `active_markets text[]`。
 *  1. upsert 默认行 (ON CONFLICT DO NOTHING) — 新用户首 PUT materialize 默认 {cn},幂等。
 *  2. **conditional single-row UPDATE + affected-count**（playbook 默认范式）：
 *     - 关：`array_remove` 仅当移除后仍 ≥1 才执行 → 0 affected ⟺ 关的是最后一个激活核心 →
 *       min-1 拒（该谓词同时兼容幂等：关一个本就 inactive 的码 → 数组不变仍 ≥1 → 命中返回）。
 *     - 开：CASE 去重 append（幂等），无 min-1 顾虑。
 *  靠单行 row-lock + READ COMMITTED **EvalPlanQual** 重检谓词天然串行（无 FOR UPDATE / 无
 *  materialize-3-行 / 无 retry）。🔒 谓词纯落单行，禁碰他行（ADR-0046 § Decision 铁律）。
 */
@Injectable()
export class UpdateMarketPreferenceUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(
    accountId: bigint,
    market: string,
    active: boolean,
  ): Promise<MarketPreferencesResult> {
    // 1. 字典校验 (无 DB): 未知码 404 / 海外码 422 (FR-S05)。
    if (!isKnownMarket(market)) {
      throw new MarketNotFoundException(market);
    }
    if (!isCoreMarket(market)) {
      throw new MarketNotAvailableException(market);
    }

    // 2. 确保单行存在 (新用户首 PUT 落默认 {cn},幂等;无 FOR UPDATE)。
    await this.prisma.$executeRaw`
      INSERT INTO portfolio.portfolio_preference (account_id, active_markets)
      VALUES (${accountId}, ${[...DEFAULT_ACTIVE_MARKETS]})
      ON CONFLICT (account_id) DO NOTHING`;

    // 3. conditional single-row UPDATE (ADR-0046)。
    const rows = active
      ? await this.prisma.$queryRaw<{ active_markets: string[] }[]>`
          UPDATE portfolio.portfolio_preference
          SET active_markets = CASE
            WHEN ${market} = ANY(active_markets) THEN active_markets
            ELSE array_append(active_markets, ${market})
          END
          WHERE account_id = ${accountId}
          RETURNING active_markets`
      : await this.prisma.$queryRaw<{ active_markets: string[] }[]>`
          UPDATE portfolio.portfolio_preference
          SET active_markets = array_remove(active_markets, ${market})
          WHERE account_id = ${accountId}
            AND array_length(array_remove(active_markets, ${market}), 1) >= 1
          RETURNING active_markets`;

    // 关市场时 0 affected ⟺ 移除后会归 0 ⟺ min-1 违反 (FR-S04)。
    if (!active && rows.length === 0) {
      throw new MinOneMarketRequiredException();
    }

    // 返回全量最新态供客户端对账 (D7)。
    return { markets: projectMarkets(rows[0]?.active_markets ?? null) };
  }
}
