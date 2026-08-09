// 028 T006 — 会话时间分组纯函数（无 IO / 无 React，per 测试分层 vitest=logic）。
//
// 抽屉历史列表按 updatedAt 分桶展示（plan D5）：
//   前 7 天   now-7d  ≤ updatedAt              （最近一周）
//   前 30 天  now-30d ≤ updatedAt < now-7d     （一周到一月）
//   YYYY 年   更早，按自然年分组，年份倒序
//
// 🚨 边界 `≥` 含「较近」组（避免跳组歧义）：恰好 7 天前 → 前 7 天组；恰好 30 天前 →
// 前 30 天组。`now` 由调用方注入（可测，**不**内部 Date.now()）。
//
// 复杂度 O(n)：单遍分桶 + 各桶内 O(k log k) 排序，n = 会话数。

/** 分组输入项（orval `ConversationListItemResponse` 的结构子集，纯逻辑只读 updatedAt）。 */
export interface ConversationItem {
  id: string;
  title: string;
  model: string;
  /** ISO-8601 string（server 返回；客户端时间分组依据）。 */
  updatedAt: string;
}

/** 一个时间分组：label 文案 + 组内会话（已按 updatedAt 倒序）。 */
export interface ConversationGroup {
  label: string;
  items: ConversationItem[];
}

const DAY_MS = 86_400_000;
const LABEL_7D = '前 7 天';
const LABEL_30D = '前 30 天';

/**
 * 把会话列表按 updatedAt 分桶为时间分组，组序 = 近→远（前 7 天 / 前 30 天 / 年倒序）。
 *
 * @param items 会话列表（顺序无关，内部各组重排为 updatedAt 倒序）。
 * @param now   当前时间 ISO string 或 Date（注入以便测试）。
 */
export function groupConversations(
  items: ConversationItem[],
  now: string | Date,
): ConversationGroup[] {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const sevenDaysAgo = nowMs - 7 * DAY_MS;
  const thirtyDaysAgo = nowMs - 30 * DAY_MS;

  const recent: ConversationItem[] = [];
  const month: ConversationItem[] = [];
  // 按年（数字键）累积更早项，最后按年份倒序输出。
  const byYear = new Map<number, ConversationItem[]>();

  for (const it of items) {
    const ts = Date.parse(it.updatedAt);
    if (ts >= sevenDaysAgo) {
      recent.push(it);
    } else if (ts >= thirtyDaysAgo) {
      month.push(it);
    } else {
      const year = new Date(ts).getFullYear();
      const bucket = byYear.get(year);
      if (bucket) bucket.push(it);
      else byYear.set(year, [it]);
    }
  }

  const byUpdatedDesc = (a: ConversationItem, b: ConversationItem): number =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

  const groups: ConversationGroup[] = [];
  if (recent.length > 0) groups.push({ label: LABEL_7D, items: [...recent].sort(byUpdatedDesc) });
  if (month.length > 0) groups.push({ label: LABEL_30D, items: [...month].sort(byUpdatedDesc) });

  // 年份倒序（新年在前）。
  for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
    groups.push({ label: `${year} 年`, items: byYear.get(year)!.sort(byUpdatedDesc) });
  }

  return groups;
}
