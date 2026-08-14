// `~/ui` — component primitive facade. login slice (account-migration p3 T059)
// ports PhoneInput / SmsInput / ErrorRow / LogoMark / SuccessCheck from the
// legacy app's packages/ui; PrimaryButton reuses the existing Button (identical
// shape, per plan「Mobile UI Plan」open-decision #1). Presentational — no unit
// tests (covered by Playwright e2e, per mono vitest architecture).

export { Button, type ButtonProps } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { Spinner, type SpinnerProps, type SpinnerTone } from './Spinner';
export { Switch, type SwitchProps } from './Switch';
export { SwipeRow, type SwipeRowProps } from './SwipeRow';
export { ConfirmModal, type ConfirmModalProps } from './ConfirmModal';
export { SearchBar, type SearchBarProps } from './SearchBar';
export { AlphaIndex, type AlphaIndexProps } from './AlphaIndex';
export {
  BrokerPickerSheet,
  type BrokerPickerSheetProps,
  type BrokerPickerItem,
} from './BrokerPickerSheet';
export { SafeAreaView, type SafeAreaViewProps } from './SafeAreaView';
export { ErrorRow, type ErrorRowProps } from './ErrorRow';
export { PhoneInput, type PhoneInputProps } from './PhoneInput';
export { SmsInput, type SmsInputProps } from './SmsInput';
export { DisplayNameInput, type DisplayNameInputProps } from './DisplayNameInput';
export { LogoMark, type LogoMarkProps } from './LogoMark';
export { SuccessCheck } from './SuccessCheck';
// 027 AI 回复 markdown 渲染（enriched-markdown，web+native）。
export { MarkdownMessage, type MarkdownMessageProps } from './MarkdownMessage';
export { TabBarIcon, type TabIconName } from './TabBarIcon';
export { makeHeaderBackOrParent } from './HeaderBackOrParent';
// 013-watchlist 原语：分组 Tab 横滑 / 长按 sheet 菜单 / 自建拖拽排序列表（D7）。
export { Tabs, type TabsProps, type TabItem } from './Tabs';
// 市场/板块小标签（013 自选行 / 021 屏4 共用，自 021 target-select 提升）。
export { MarketBadge, type MarketBadgeProps } from './MarketBadge';
export { marketBadgeLabel } from './market-badge.rules';
export { LongPressMenu, type LongPressMenuProps } from './LongPressMenu';
// 045 左侧抽屉通用容器（骨架自 chat-drawer 抽出，内容由调用方以 children 传入）。
export { AppDrawer, type AppDrawerProps } from './app-drawer';
export { DraggableList, type DraggableListProps } from './DraggableList';
// 自绘数字键盘（026 自 alert 起，053 T015 上提）——「底部 sheet + 纯数字域」两处复用；
// `applyKey` 是 026 那一屏的规范化判据，新接一屏前先读 `keypad.rules.ts` 文件头。
export { NumericKeypad, type NumericKeypadProps } from './numeric-keypad';
export { applyKey, BACKSPACE } from './keypad.rules';
