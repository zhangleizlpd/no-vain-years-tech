// 072 T018 — 锚待审箱列表的纯判定（FR-001 / US1）。
//
// 抽成纯函数的理由：这些判据每一条都对应「人要不要为这行停一下」——
// disposition 决定采纳会不会冲掉三处人工位，asofFlag 决定口径日能不能信。
// 散在两个宿主（「我的」内嵌面板 + 全屏列表）的 JSX 里就会分叉成两套答案，
// 而分叉不报错、只是屏上不一致。
// 🚨 **只 import type**：`@nvy/api-client` 在 mobile vitest 下解析不到运行时入口
// （logic-only 单测不经 Metro / bundler 别名），import 那两个枚举**常量**会让整个 spec
// 文件 `Failed to resolve entry` —— 0 个用例跑起来，而 exit code 照样是 1（实撞）。
// 判据本来也不需要常量：字面量联合类型在 switch / Record 上已经强制穷举。
import type {
  AnchorSubmissionReviewResponse,
  AnchorSubmissionReviewResponseAsofFlag,
  AnchorSubmissionReviewResponseDisposition,
} from '@nvy/api-client';

import { OPTIONSDESK_COPY } from './optionsdesk-copy';

const COPY = OPTIONSDESK_COPY.anchorSubmission;

/** 市场筛选 chips（单选）。顺序即渲染顺序；`all` 恒在首位。 */
export const SUBMISSION_MARKET_FILTERS = ['all', 'us', 'hk'] as const;
export type SubmissionMarketFilter = (typeof SUBMISSION_MARKET_FILTERS)[number];

/**
 * 处置徽标。
 *
 * 🚨 `refresh` **不是更温和的 `create`** —— 它会冲掉三处人工位并把 confidence_source 翻成
 * model（此后置信度在 App 里改不动）。故两档文案刻意不对称：「将建锚」是中性的，
 * 「将覆盖既有锚」自带警告色（呈现层按此上色）。
 */
export const DISPOSITION_LABEL: Record<AnchorSubmissionReviewResponseDisposition, string> = {
  create: COPY.dispositionCreate,
  refresh: COPY.dispositionRefresh,
};

/**
 * 口径日徽标：可疑档给一句人话，`OK` 给 `null`（**不渲染徽标**）。
 *
 * 🚨 `UNKNOWN` 必须有自己的文案，MUST NOT 与 `OK` 合并 —— 「日历没填到那一段」不等于
 * 「没问题」，把它折进 OK 等于替日历做主（sb-3）。`TODAY` 同理独立：服务端判不了那场
 * 收没收盘，屏上得让人自己看一眼。
 */
export function asofBadgeLabel(flag: AnchorSubmissionReviewResponseAsofFlag): string | null {
  switch (flag) {
    case 'OK':
      return null;
    case 'TODAY':
      return COPY.asofToday;
    case 'FUTURE':
      return COPY.asofFuture;
    case 'NON_TRADING':
      return COPY.asofNonTrading;
    case 'UNKNOWN':
      return COPY.asofUnknown;
  }
}

/** 事实行：`V 49.3400 · 口径日 2026-08-30 · weighted · 6.0`（mockup 帧 ⑤ 第二行）。 */
export function submissionFactsLine(
  item: Pick<AnchorSubmissionReviewResponse, 'v' | 'asof' | 'method' | 'confidence'>,
): string {
  return [COPY.vPrefix(item.v), COPY.asofPrefix(item.asof), item.method, item.confidence].join(
    ' · ',
  );
}

/** 各市场条数（chips 上的计数；`all` = 总数）。 */
export function submissionMarketCounts(
  items: readonly Pick<AnchorSubmissionReviewResponse, 'market'>[],
): Record<SubmissionMarketFilter, number> {
  return {
    all: items.length,
    us: items.filter((i) => i.market === 'us').length,
    hk: items.filter((i) => i.market === 'hk').length,
  };
}

/** 按市场筛（前端切，不打网络 —— 不分页故全量在手）。 */
export function filterSubmissions<T extends Pick<AnchorSubmissionReviewResponse, 'market'>>(
  items: readonly T[],
  filter: SubmissionMarketFilter,
): T[] {
  return filter === 'all' ? [...items] : items.filter((i) => i.market === filter);
}

/** 单项翻选（不可变）。O(n)，n = 已选数。 */
export function toggleSubmissionSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * 选中集与当前可见行取交集。
 *
 * 存在的理由：切市场 chip 会让已选的行离开视野，而**看不见的选中项照样会被驳回**。
 * 驳回是写操作，「屏上选了 3 条、实际驳回 5 条」是不可接受的偏差。
 */
export function visibleSelection(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): string[] {
  return visibleIds.filter((id) => selected.has(id));
}
