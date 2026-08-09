import { Prisma } from '../generated/prisma/client';

/**
 * 045 US2 — 雷达 keyset 游标 (FR-010 / FR-033, plan D8)。纯函数 + SQL 片段构造, 无 I/O。
 *
 * 🚨 **禁 `OFFSET`**: 排序键距 W% 随 spot **每日变动**, `OFFSET` 在翻页期间数据刷新时会漏行
 * 或重复行 —— 而**漏看一只即等于本功能失效** (spec FR-033 原文)。故分页一律 keyset:
 * 游标 = **`(距 W%, 锚 id)` 二元组**, 下一页取「严格大于游标」的行。
 *
 * 🚨 **tiebreaker 必须有**: 距 W% 会并列 (同一 V/spot 组合、或干脆同价), SQL **不保证并列行
 * 顺序稳定** ⇒ 无唯一 tiebreaker 时同一游标两次翻页可能跳行。锚 id 升序作唯一 tiebreaker,
 * 排序全序、可复现。
 *
 * **行情不可用行 (距 W% = NULL) 排尾段** (`NULLS LAST`) 而不是被剔除 —— EC-15「锚已建但该标的
 * 从未被采集」的行 MUST 仍可见 (FR-017)。游标因此要能表达「已进尾段」= `distanceToWPct: null`。
 *
 * ⚠️ {@link compareRadarKeys} / {@link isAfterRadarCursor} 是 SQL 语义的**内存镜像**
 * (供纯函数单测跑真分页序列), {@link radarKeysetPredicate} 是同一语义的 SQL 谓词 ——
 * **两者必须同义**, 改一个必须改另一个 (真 SQL 行为由 T014 IT 兜底)。
 */

/** 一页默认条数 (下拉增量加载, FR-010 禁页码控件)。 */
export const RADAR_PAGE_SIZE_DEFAULT = 20;

/** 一页上限 —— 防一次拉全表把分页绕过去 (锚表规模上限约 1000)。 */
export const RADAR_PAGE_SIZE_MAX = 100;

/** 排序键 = 游标载荷。距 W% 用 **string** 承载: PG numeric 原文往返, 不过 JS 二进制浮点。 */
export interface RadarSortKey {
  /** 距 W% 的 SQL 求值原文; `null` = 行情不可用 (尾段)。 */
  distanceToWPct: string | null;
  /** 锚 id 数字串 (唯一 tiebreaker)。 */
  anchorId: string;
}

export type RadarCursor = RadarSortKey;

const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;
const DIGITS = /^\d+$/;

/** 游标 → 不透明 token (base64url, URL 安全无需转义)。客户端 MUST NOT 解读它。 */
export function encodeRadarCursor(cursor: RadarCursor): string {
  return Buffer.from(JSON.stringify([cursor.distanceToWPct, cursor.anchorId]), 'utf8').toString(
    'base64url',
  );
}

/**
 * token → 游标; 形状/值域任一不合法 → `null`。
 *
 * 调用方 MUST 折 400 而**不是**静默从头翻页 —— 静默重来会让用户以为自己看全了 (漏看一只
 * 即功能失效)。O(1)。
 */
export function decodeRadarCursor(raw: string): RadarCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [distance, anchorId] = parsed as [unknown, unknown];
  if (typeof anchorId !== 'string' || !DIGITS.test(anchorId)) return null;
  if (distance === null) return { distanceToWPct: null, anchorId };
  if (typeof distance !== 'string' || !NUMERIC_TEXT.test(distance)) return null;
  return { distanceToWPct: distance, anchorId };
}

/**
 * 排序比较器 = `距 W% ASC NULLS LAST, 锚 id ASC` 的内存镜像。
 *
 * 距 W% 走 `Prisma.Decimal` 比较 (不是字符串比较): `-5.0000` 与 `-5` 是**同一个值**,
 * 字符串比会把它们判成不等 ⇒ 并列检测失效 ⇒ tiebreaker 白写。O(1)。
 */
export function compareRadarKeys(a: RadarSortKey, b: RadarSortKey): number {
  if (a.distanceToWPct === null && b.distanceToWPct !== null) return 1; // NULLS LAST
  if (a.distanceToWPct !== null && b.distanceToWPct === null) return -1;
  if (a.distanceToWPct !== null && b.distanceToWPct !== null) {
    const byDistance = new Prisma.Decimal(a.distanceToWPct).comparedTo(
      new Prisma.Decimal(b.distanceToWPct),
    );
    if (byDistance !== 0) return byDistance;
  }
  const left = BigInt(a.anchorId);
  const right = BigInt(b.anchorId);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 该行是否落在游标之后 (严格大于) —— 与 {@link radarKeysetPredicate} 同义。 */
export function isAfterRadarCursor(key: RadarSortKey, cursor: RadarCursor): boolean {
  return compareRadarKeys(key, cursor) > 0;
}

/**
 * keyset SQL 谓词 (作用在**外层**查询, 那里 `distance_to_w_pct` 已是可引用的输出列)。
 *
 * 值一律走参数绑定, 不拼进 SQL 文本。
 */
export function radarKeysetPredicate(cursor: RadarCursor): Prisma.Sql {
  if (cursor.distanceToWPct === null) {
    // 已在 NULLS LAST 尾段: 后续只可能是同样无行情的行, 且严格按 id 递增。
    return Prisma.sql`(distance_to_w_pct IS NULL AND id > ${cursor.anchorId}::bigint)`;
  }
  return Prisma.sql`(distance_to_w_pct > ${cursor.distanceToWPct}::numeric OR (distance_to_w_pct = ${cursor.distanceToWPct}::numeric AND id > ${cursor.anchorId}::bigint) OR distance_to_w_pct IS NULL)`;
}

/** 页长归一 (非法 / 缺省 → 默认值; 超限 → 钳到上限)。 */
export function normalizeRadarLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isInteger(raw) || raw < 1) return RADAR_PAGE_SIZE_DEFAULT;
  return Math.min(raw, RADAR_PAGE_SIZE_MAX);
}
