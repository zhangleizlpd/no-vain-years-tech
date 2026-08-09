// `~/portfolio` — 证券市场准入设置 feature（011 portfolio 首特性）+ 012 券商账户绑定。
export {
  BROKER_CATALOG,
  BROKER_PICKER_ITEMS,
  brokerNameOf,
  type BrokerCatalogEntry,
} from './broker-catalog';
export { MARKET_COPY } from './market-copy';
export { BROKER_COPY } from './broker-copy';
export {
  useBrokerAccounts,
  removeAccount,
  bindErrorMessage,
  deleteErrorToast,
  type BrokerAccountsStatus,
} from './use-broker-accounts';
export {
  useMarketPreferences,
  predictMinOneViolation,
  applyToggle,
  marketToggleErrorToast,
  type MarketPrefsStatus,
} from './use-market-preferences';
export { MarketRow, type MarketRowProps } from './market-row';
export { StockMarketScreen } from './stock-market-screen';
export { BrokerRow, type BrokerRowProps } from './broker-row';
export { BrokerAccountListScreen } from './broker-account-list-screen';
export { BrokerBindScreen } from './broker-bind-screen';
// 013-watchlist：自选列表 3 屏 + 长按菜单 + 颜色调色板 + 文案。
export { WATCHLIST_COPY } from './watchlist-copy';
export { TAG_COLORS, tagDotClass, type TagColor } from './watchlist-palette';
export { WatchlistItemMenu, type WatchlistItemMenuProps } from './watchlist-item-menu';
export {
  reorderEntriesAfterMove,
  reorderEntriesWithVisibilityToggled,
} from './group-management.helpers';
export { GroupManagementScreen } from './group-management-screen';
export { AddWatchlistEntry, type AddWatchlistEntryProps } from './add-watchlist-entry';
export { WatchlistRow, WatchlistColumnHeader, type WatchlistRowProps } from './watchlist-row';
export { WatchlistMainScreen } from './watchlist-main-screen';
// 014-stock-detail：详情纯逻辑 + 自选态 hook + 文案 + 详情页骨架（nav/tabs/screen）。
export {
  parseSymbol,
  canDrillDown,
  membershipMap,
  detailQuoteDirection,
  formatDetailPrice,
  formatDetailChange,
  formatDetailChangePct,
  formatAsOf,
} from './stock-detail.helpers';
export {
  useWatchlistStatus,
  type WatchlistStatus,
  type WatchlistStatusState,
} from './use-watchlist-status';
export { STOCK_DETAIL_COPY } from './stock-detail-copy';
export { DetailTabs, type DetailTab, type DetailTabsProps } from './detail-tabs';
export { DetailTopNav, type DetailTopNavProps } from './detail-top-nav';
export { BottomBar, type BottomBarProps } from './bottom-bar';
export { AnalysisTab } from './analysis-tab';
export { EditGroupsSheet, type EditGroupsSheetProps } from './edit-groups-sheet';
export { CreateGroupDialog, type CreateGroupDialogProps } from './create-group-dialog';
export { StockDetailScreen, type StockDetailScreenProps } from './stock-detail-screen';
// 025-portfolio-holdings：持仓两屏（helpers/hooks/rows/copy）。
export {
  marketValue,
  floatPnl,
  floatPnlPct,
  summarizeHoldings,
  groupTradesByMonth,
  formatAmount,
  formatSignedAmount,
  formatQty,
  formatRatioPct,
  pnlDirection,
  type HoldingsSummary,
  type TradeMonthGroup,
} from './holdings.helpers';
export { useHoldings, type Holdings, type HoldingsStatus } from './use-holdings';
export { useTrades, type Trades, type TradesStatus } from './use-trades';
export { HOLDINGS_COPY } from './holdings-copy';
export { HoldingRow, ClosedRow, type HoldingRowProps, type ClosedRowProps } from './holdings-rows';
export { HoldingsScreen } from './holdings-screen';
export { TradeHistoryScreen, type TradeHistoryScreenProps } from './trade-history-screen';
