// `~/alert` — 021 预警管理 feature（与 server `apps/server/src/alert/` 同名，business-naming）。
// T015 基础件：涨跌停纯函数 / 文案 / 图标 / 圆 checkbox / 行情条 / 预警卡片。
export { limitPct, limitPrices, prevCloseOf, type LimitPrices } from './limit-price.rules';
export {
  ALERT_COPY,
  formatConditionLine,
  formatMessageBody,
  formatMessageTime,
} from './alert-copy';
export { AlertIcon, type AlertIconName, type AlertIconProps } from './alert-icon';
export { CheckCircle, type CheckCircleProps } from './check-circle';
export { QuoteStrip, type QuoteStripProps } from './quote-strip';
export { AlertCard, type AlertCardProps } from './alert-card';
// T016 hooks：CRUD（乐观 toggle + 错误分流）+ 消息（未读角标 + 屏级置已读）。
export {
  alertErrorToast,
  applyToggleOptimistic,
  groupAlertsByInstrument,
  NOTE_MAX_CODE_POINTS,
  noteCodePointCount,
  useAlertMutations,
  useAllAlerts,
  useInstrumentAlerts,
  type AlertsStatus,
  type InstrumentAlertsGroup,
} from './use-alerts';
export {
  unreadBadgeVisible,
  useAlertMessages,
  useMarkMessagesRead,
  useUnreadCount,
  type MessagesStatus,
} from './use-alert-messages';
// T017 屏 1：多选纯函数 + 底栏两态（屏 5 复用）+ 个股预警列表屏。
export { isAllSelected, toggleSelectAll, toggleSelection } from './alert-selection';
export {
  AlertActionFooter,
  AlertDeleteFooter,
  type AlertActionFooterProps,
  type AlertDeleteFooterProps,
} from './alert-footer';
export { AlertListScreen, type AlertListScreenProps } from './alert-list-screen';
// T018 屏 2/3 + sheets：跨 route 草稿 store + 行情条 wrapper + 编辑/添加条件屏。
export {
  draftSubmittable,
  MAX_CONDITIONS,
  removeCondition,
  thresholdValid,
  toConditionEntries,
  upsertCondition,
  useAlertDraft,
  type AlertDraftState,
  type DraftCondition,
} from './use-alert-draft';
export { InstrumentQuoteStrip, type InstrumentQuoteStripProps } from './instrument-quote-strip';
export { FrequencySheet, type FrequencySheetProps } from './frequency-sheet';
export { ValueInputSheet, type ValueInputSheetProps } from './value-input-sheet';
export { AlertEditScreen, type AlertEditScreenProps } from './alert-edit-screen';
export { AddConditionScreen } from './add-condition-screen';
// T019 屏 5/4：共用 tab 行 + 对象选择纯函数 + 全部预警/对象选择屏。
export { AlertTabRow, type AlertTab, type AlertTabRowProps } from './alert-tab-row';
export { splitNameHighlight, type NameSegment } from './target-select.helpers';
export { AllAlertsScreen } from './all-alerts-screen';
export { TargetSelectScreen } from './target-select-screen';
// T020 屏 6：消息通知（进入即置已读 D6）。
export { MessageCenterScreen } from './message-center-screen';
