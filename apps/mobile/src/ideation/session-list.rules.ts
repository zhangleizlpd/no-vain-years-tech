// 032 T018 — 会话列表纯渲染数据准备（无 RN import，per 测试分层 vitest=logic）。
//
// 列表屏（app/(app)/(tabs)/ideation/index.tsx）消费 useSessionControllerList（orval），server 已按
// (updatedAt desc, id desc) 排序且 UC-level accountId scope（仅本账号），前端**不再过滤/重排**
// （防御性 sort 仅兜底 server 偶发乱序，O(n log n)）。本层把宽松 SessionResponse 收敛成带
// 徽标元数据 + 相对时间文案的有序行视图，渲染层直接 map。
//
// 徽标复用 T016 STATUS_BADGE_META + normalizeStatus（禁重造，per 组上下文）。

import {
  STATUS_BADGE_META,
  normalizeStatus,
  type IdeationSessionStatus,
  type StatusBadgeMeta,
} from './brief-view.rules';

/** orval SessionResponse 的结构子集（列表只读 id/title/status/updatedAt）。 */
export interface SessionListItem {
  id: string;
  title: string;
  /** 宽松 status string（orval `status: string`），收敛走 normalizeStatus。 */
  status: string;
  /** ISO-8601 string（server 返回；相对时间 + 排序兜底依据）。 */
  updatedAt: string;
}

/** 一行待渲染会话视图（徽标 + 相对时间已就绪，渲染层零再加工）。 */
export interface SessionRowView {
  id: string;
  title: string;
  /** 收敛后枚举状态。 */
  status: IdeationSessionStatus;
  /** 状态徽标元数据（label + tone）。 */
  badge: StatusBadgeMeta;
  /** updatedAt 原始 ISO（相对时间在渲染层结合 now 算，保持可测/不漂移）。 */
  updatedAt: string;
}

/**
 * 把会话列表收敛为有序行视图（按 updatedAt desc 兜底排序 + 徽标映射）。
 *
 * 复杂度 O(n log n)：单遍 map + 一次稳定 sort，n = 会话数。server 已排好序，sort 仅防御
 * 偶发乱序（near-sorted 下接近 O(n)）。
 */
export function prepareSessionList(items: SessionListItem[]): SessionRowView[] {
  return [...items]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((it) => {
      const status = normalizeStatus(it.status);
      return {
        id: it.id,
        title: it.title,
        status,
        badge: STATUS_BADGE_META[status],
        updatedAt: it.updatedAt,
      };
    });
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * updatedAt → 相对时间中文文案（列表行副标题）。`now` 注入以便测试（不内部 Date.now()）。
 * - < 1 分钟：刚刚
 * - < 1 小时：N 分钟前
 * - < 1 天：  N 小时前
 * - < 30 天： N 天前
 * - 其余：    YYYY-MM-DD（本地日期）
 * 未来时间（时钟偏差）/ 非法串兜底「刚刚」。
 */
export function relativeUpdatedAt(iso: string, now: string | Date): string {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const ts = Date.parse(iso);
  if (Number.isNaN(ts) || Number.isNaN(nowMs)) return '刚刚';
  const diff = nowMs - ts;
  if (diff < MINUTE_MS) return '刚刚';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  if (diff < 30 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
