import { Module } from '@nestjs/common';
import { SecurityModule } from '../security/security.module.js';
import { AccountModule } from '../account/account.module.js';
import { MarketPreferencesController } from './market-preferences.controller.js';
import { GetMarketPreferencesUseCase } from './get-market-preferences.usecase.js';
import { UpdateMarketPreferenceUseCase } from './update-market-preference.usecase.js';
import { BrokerAccountsController } from './broker-accounts.controller.js';
import { ListBrokerAccountsUseCase } from './list-broker-accounts.usecase.js';
import { BindBrokerAccountUseCase } from './bind-broker-account.usecase.js';
import { DeleteBrokerAccountUseCase } from './delete-broker-account.usecase.js';
import { WatchlistGroupsController } from './watchlist-groups.controller.js';
import { WatchlistItemsController } from './watchlist-items.controller.js';
import { ListWatchlistGroupsUseCase } from './list-watchlist-groups.usecase.js';
import { CreateWatchlistGroupUseCase } from './create-watchlist-group.usecase.js';
import { UpdateWatchlistGroupUseCase } from './update-watchlist-group.usecase.js';
import { DeleteWatchlistGroupUseCase } from './delete-watchlist-group.usecase.js';
import { ReorderWatchlistGroupsUseCase } from './reorder-watchlist-groups.usecase.js';
import { ListWatchlistItemsUseCase } from './list-watchlist-items.usecase.js';
import { AddWatchlistItemUseCase } from './add-watchlist-item.usecase.js';
import { UpdateWatchlistItemUseCase } from './update-watchlist-item.usecase.js';
import { DeleteWatchlistItemUseCase } from './delete-watchlist-item.usecase.js';
import { WatchlistStatusController } from './watchlist-status.controller.js';
import { GetWatchlistStatusUseCase } from './get-watchlist-status.usecase.js';
import { HoldingsImportController } from './holdings-import.controller.js';
import { ImportHoldingsUseCase } from './import-holdings.usecase.js';
import { HoldingsController } from './holdings.controller.js';
import { ListHoldingsUseCase } from './list-holdings.usecase.js';
import { TradesController } from './trades.controller.js';
import { ListTradesUseCase } from './list-trades.usecase.js';

/**
 * Portfolio bounded context (011, 第 4 个 — 与 security/account/auth 平级,
 * per ADR-0032 Q4 判定 + ADR-0043 扁平贫血)。
 *
 * Owns the market-preference read/write use cases (anemic — operate on raw
 * `market_preference` rows + `portfolio.rules.ts` pure invariants, no aggregate /
 * repository port) + the static MarketCatalog dictionary. Both use cases inject
 * PrismaService directly and only touch `prisma.marketPreference.*` (R1 own table,
 * data moat enforced by check-server-moat.ts).
 *
 * Depends on SecurityModule for PrismaService + global ProblemDetailFilter +
 * JwtModule; on AccountModule for the account-bound auth artefacts JwtAuthGuard +
 * AccountIdThrottlerGuard (reused via export — account-bound, not a business
 * use-case call → no R2/R3 cross-context annotation). Zero cross-ctx business
 * call (intra only). The 2 named throttlers (mkt-pref-get/put-account) are
 * registered in AuthModule's global ThrottlerModule (shared storage).
 */
@Module({
  imports: [SecurityModule, AccountModule],
  controllers: [
    MarketPreferencesController,
    BrokerAccountsController,
    WatchlistGroupsController,
    WatchlistItemsController,
    WatchlistStatusController,
    HoldingsImportController,
    HoldingsController,
    TradesController,
  ],
  providers: [
    GetMarketPreferencesUseCase,
    UpdateMarketPreferenceUseCase,
    ListBrokerAccountsUseCase,
    BindBrokerAccountUseCase,
    DeleteBrokerAccountUseCase,
    ListWatchlistGroupsUseCase,
    CreateWatchlistGroupUseCase,
    UpdateWatchlistGroupUseCase,
    DeleteWatchlistGroupUseCase,
    ReorderWatchlistGroupsUseCase,
    ListWatchlistItemsUseCase,
    AddWatchlistItemUseCase,
    UpdateWatchlistItemUseCase,
    DeleteWatchlistItemUseCase,
    GetWatchlistStatusUseCase,
    ImportHoldingsUseCase,
    ListHoldingsUseCase,
    ListTradesUseCase,
  ],
})
export class PortfolioModule {}
