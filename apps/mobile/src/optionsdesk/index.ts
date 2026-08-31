// `~/optionsdesk` — 045 期权台 feature（锚管理 + 击球区雷达）。
// app/ 树下只放薄 route，屏体与逻辑全在本目录（per fe-directory-structure）。
export { RadarScreen } from './radar-screen';
export { AnchorListScreen } from './anchor-list-screen';
// 072 T018：锚待审箱（「我的」审批栏内嵌面板 + 全屏列表 + 批量驳回）
export { AnchorSubmissionListScreen } from './anchor-submission-list-screen';
export { AnchorSubmissionPanel, type AnchorSubmissionPanelProps } from './anchor-submission-panel';
export { AnchorSubmissionRow, type AnchorSubmissionRowProps } from './anchor-submission-row';
// 072 T021：冷启动结局面板（十档全显 / 五档置顶 / 缺席=排队中）
export { AnchorColdStartScreen } from './anchor-cold-start-screen';
// 072 T020：处置后该失效哪些缓存的单一处（采纳 / 驳回共用）
export { useInvalidateAnchorQueries } from './use-anchor-submissions';
// 072 T019：审批详情 + 复述闸 + 三出口
export { AnchorSubmissionDetailScreen } from './anchor-submission-detail-screen';
export { AnchorFormScreen } from './anchor-form-screen';
export { OPTIONSDESK_COPY } from './optionsdesk-copy';
export { ZoneBand, type ZoneBandProps } from './zone-band';
export { useRadar, RADAR_QUERY_KEY, type UseRadarResult } from './use-radar';
// 046 T021 — 标的详情（上半）。子件 `IvpSegmentBar` 供 T022 的 IVP 列表复用（勿重画）。
export {
  UnderlyingDetailScreen,
  type UnderlyingDetailScreenProps,
} from './underlying-detail-screen';
export { IvpSegmentBar, type IvpSegmentBarProps } from './ivp-segment-bar';
// 046 T022 — 波动温度计屏 P7（VIX 表盘 + VVIX / 比值 + 锚定标的 IVP 列表）。
export { ThermometerScreen } from './thermometer-screen';
export { VixGauge, type VixGaugeProps } from './vix-gauge';
export {
  useUnderlyingDetail,
  UNDERLYING_DETAIL_QUERY_KEY,
  type UseUnderlyingDetailResult,
} from './use-underlying-detail';
// 047 T031 — 选约表数据源（详情屏下半；三 Tab 共用同一份全量腿）。
export { useLegTable, LEG_TABLE_QUERY_KEY, type UseLegTableResult } from './use-leg-table';
// 047 T032 — 腿行 + 12 列表头（横向 offset 由调用方持有并共享给两者）。
export { LegRow, type LegRowProps } from './leg-row';
export { LegTableHeader, type LegTableHeaderProps } from './leg-table-header';
// 064 T008 — 区块级档位条（实时 / 收盘 / 未就绪三形态；判定在 leg-tier-bar.rules）。
export { LegTierBar, type LegTierBarProps } from './leg-tier-bar';
// 064 T010 — 成员变化提示（差集在客户端算，服务端不引入会话态）。
export { LegMembershipNotice, type LegMembershipNoticeProps } from './leg-membership-notice';
// 047 T033 — 意图三 Tab + 水位手选 chip（两者都进详情屏那**一个** sticky section header）。
export { LegPickerTabs, type LegPickerTabsProps } from './leg-picker-tabs';
export { PositionBucketChips, type PositionBucketChipsProps } from './position-bucket-chips';
export { LEG_PICKER_TABS, type LegPickerTab } from './leg-picker.rules';
// 047 T034 — 档位着色 / 动作四态 / 财报 chip 的映射层（bid 单元格与页脚图例**同一份**色标）。
export { LEG_TIER_LEGEND, type LegEarningsChip, type LegCellTone } from './leg-picker-copy';
export {
  OPTIONSDESK_RADAR_ROUTE,
  OPTIONSDESK_ANCHOR_COLD_START_ROUTE,
  OPTIONSDESK_ANCHOR_SUBMISSIONS_ROUTE,
  OPTIONSDESK_ANCHORS_ROUTE,
  OPTIONSDESK_ANCHOR_NEW_ROUTE,
  OPTIONSDESK_THERMOMETER_ROUTE,
  OPTIONSDESK_UNDERLYING_PATHNAME,
  optionsdeskAnchorEditRoute,
  optionsdeskChainReportRoute,
  optionsdeskUnderlyingRoute,
} from './optionsdesk-routes';
// 055 T016 — 报表下钻的预填解析（route 层调，屏不认识 query 参数长什么样）。
export { chainReportPrefillOf, type ChainReportPrefill } from './chain-report-drilldown.rules';
// 055 T010 — 标的链分析报表屏（期权台二级页栈，入口在标的详情，T015 接线）。
export { ChainReportScreen, type ChainReportScreenProps } from './chain-report-screen';
export {
  useChainReport,
  CHAIN_REPORT_QUERY_KEY,
  type UseChainReportResult,
} from './use-chain-report';
