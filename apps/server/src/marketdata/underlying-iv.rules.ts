/**
 * 标的级 IV 采集侧纯函数 (046 T004, FR-024/FR-034 / plan D4/D7)。
 *
 * 三件事，全部无 IO：
 *   ① {@link computeIvPercentile}   —— 由 `his_volatility` 历史序列自算 IV 分位（IVP）
 *   ② {@link classifyIvpDivergence} —— 自算值 vs 富途 `overview` 直读值的三档差异判定
 *   ③ {@link splitBackfillWindows}  —— 回填总区间 → vendor 单次跨度上限内的窗口序列
 *
 * ## ① / ② 为什么存在（plan D4，代码里看不出来的那半）
 *
 * 富途 `overview` 的 `iv_percentile` 是 vendor 结论，其**聚合规则未文档化**（p3 §9-1：该序列
 * 非严格 30d-ATM 锁定口径）。它若哪天悄悄改了规则，**这条自算对表是唯一能发现的信号** ——
 * 数据本就要落，无额外 vendor 调用，成本近零。
 *
 * 🚨 **判定结果只进采集侧告警面，MUST NOT 进 API 响应、MUST NOT 进 UI**（FR-034/FR-035）：
 * 界面显示的 IVP 恒为 `overview` 直读值（**显示口径单源**）。自算值只用于发现口径漂移；
 * 让它顺着 DTO 漏进 UI，就等于同一个读数有了两个来源。
 * 🚨 IV 标注一律写「**富途标的聚合 IV**」，禁写「IV30d」（FR-035）。
 *
 * ## 「不可算」是显式态，不是 0 也不是空值（FR-014 全片纪律）
 *
 * 窗口不足 252 交易日 / 当日无直读 IV ⇒ {@link IvPercentileResult} 的 `computable: false`。
 * 落 0 会让「历史太短」长得像「IV 处于一年最低」——**恰好方向相反的误读**。
 * 对表侧同理：窗口不足 **跳过对表且不告警**（缺窗口不是口径漂移）。
 *
 * ## 为什么分位值走 Prisma.Decimal 而不是 number
 *
 * 三档判定卡在**恰好 2pp / 恰好 5pp** 上，而浮点减法会让 `40.3 - 38.3 = 1.9999999999999964`
 * ——边界值随输入随机落到相邻档。Decimal 十进制精确减法让边界归属唯一（且 DB 侧
 * `iv_percentile` 本就是 `Decimal(8,4)`，直传零转换、零精度损失，与「禁 Float」一致）。
 *
 * 单位：`pp` = percentage point（分位值域 0–100，差值单位与之相同）。
 */
import { Prisma } from '../generated/prisma/client.js';

/**
 * IVP 自算的最小窗口（交易日）。
 *
 * 252 = 美股一年的交易日数，也是「IV 分位」这个读数的行业口径基数（过去一年）。
 * 样本不足此数 ⇒ 不可算（见上文，禁回 0）。
 */
export const IVP_MIN_WINDOW_TRADING_DAYS = 252;

/**
 * 双算差 WARN 阈值（pp）。差 ≤ 此值 = 静默（量化噪声带）。
 *
 * 取 p3b §6.3 已给的实测基线，不另拍脑袋。
 */
export const IVP_DIVERGENCE_WARN_PP = new Prisma.Decimal(2);

/** 双算差硬门阈值（pp）。差 > 此值 = 口径疑似漂移，进硬告警。同取 p3b §6.3 基线。 */
export const IVP_DIVERGENCE_HARD_PP = new Prisma.Decimal(5);

/**
 * `his_volatility` 单次请求的跨度上限（自然日，**含首尾**）。
 *
 * vendor 官方限制是「单次跨度 ≤364 天」，但没说 364 算的是含首尾天数还是端点日期差。
 * 这里取**更严的那种读法**（含首尾计数 ≤364 ⇒ 端点差 ≤363）：多切一页的成本是一次请求，
 * 猜宽了则整轮回填被 vendor 4xx 打断（`us_equity_bar` 08-01 那次的形状）。
 */
export const HIS_VOLATILITY_MAX_SPAN_DAYS = 364;

/** 不可算的两种成因 —— 调用方据此区分「历史不够」与「今天没值」，二者告警策略不同。 */
export type IvPercentileUncomputableReason = 'insufficient_window' | 'missing_current';

export interface IvPercentileComputed {
  computable: true;
  /** 0–100，Decimal 精确值（是否四舍五入到列精度由落库侧决定）。 */
  percentilePct: Prisma.Decimal;
  /** 参与计算的有效样本数（null / 非有限值已剔除）。 */
  sampleSize: number;
}

export interface IvPercentileUncomputable {
  computable: false;
  /** 🚨 恒 null —— **不是 0**（0 会被读成「一年最低」）。 */
  percentilePct: null;
  reason: IvPercentileUncomputableReason;
  sampleSize: number;
}

export type IvPercentileResult = IvPercentileComputed | IvPercentileUncomputable;

/** 三档 + 跳过档。`skipped` 不是第四档严重度，是「本次不成立对表」。 */
export type IvpDivergenceLevel = 'skipped' | 'ok' | 'warn' | 'hard';

export interface IvpDivergenceVerdict {
  level: IvpDivergenceLevel;
  /** |直读 − 自算|，单位 pp；`skipped` 时为 null（没有可比差值，不拿 0 冒充）。 */
  diffPp: Prisma.Decimal | null;
  /** 人可读依据，进告警面供运维定位。 */
  reason: string;
}

/** 回填窗口，闭区间 `[start, end]`，两端均为 `YYYY-MM-DD`。 */
export interface BackfillWindow {
  start: string;
  end: string;
}

/** 回填区间不合法（日期格式/日历不存在/跨度上限非正）—— 算错区间比少拉几天危险得多，故抛。 */
export class InvalidBackfillRangeError extends Error {
  constructor(message: string) {
    super(`[underlying-iv] ${message}`);
    this.name = 'InvalidBackfillRangeError';
  }
}

const HUNDRED = new Prisma.Decimal(100);
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * IV 分位自算：过去窗口里**严格低于**当前值的样本占比 × 100。
 *
 * 口径 = 业内通行的 IV percentile（「过去一年中 IV 低于当前值的天数占比」）：并列样本不计入，
 * 故当前值等于窗口最小值时是 0、高于全部历史时是 100。连续量（IV 存 `Decimal(12,8)`）上并列
 * 几乎不出现，取哪种并列处置对结果无实质影响 —— 而对表容忍带本就是 2pp。
 *
 * 复杂度 **O(n)**（单遍计数）。⚠️ tasks.md 预估的「O(n log n) 排序主导」是按「先排序再二分找
 * 秩」写的；求**给定值的秩**无需排序，计数法结果等价且更省 —— 此处记录该偏离，免得下次
 * 有人「补」一个排序回来。
 *
 * @param history 历史 IV 序列（顺序无关）；`null` / 非有限值视为该日无数据，剔除后再判窗口。
 * @param current 当日直读 IV；缺失 ⇒ `missing_current`（优先于窗口判定：连被比较的值都没有）。
 */
export function computeIvPercentile(
  history: readonly (Prisma.Decimal | null)[],
  current: Prisma.Decimal | null,
): IvPercentileResult {
  const sample = history.filter((v): v is Prisma.Decimal => v !== null && v.isFinite());

  if (current === null || !current.isFinite()) {
    return {
      computable: false,
      percentilePct: null,
      reason: 'missing_current',
      sampleSize: sample.length,
    };
  }
  if (sample.length < IVP_MIN_WINDOW_TRADING_DAYS) {
    return {
      computable: false,
      percentilePct: null,
      reason: 'insufficient_window',
      sampleSize: sample.length,
    };
  }

  let below = 0;
  for (const v of sample) if (v.lessThan(current)) below++;

  return {
    computable: true,
    percentilePct: new Prisma.Decimal(below).mul(HUNDRED).div(sample.length),
    sampleSize: sample.length,
  };
}

/**
 * 双算差三档判定（FR-034）。
 *
 * | 差值 `d`（pp）        | 档     | 处置                     |
 * | --------------------- | ------ | ------------------------ |
 * | 自算不可算 / 无直读值 | `skipped` | 不对表、**不告警**    |
 * | `d ≤ 2`               | `ok`   | 静默（量化噪声带）       |
 * | `2 < d ≤ 5`           | `warn` | 进 WARN 复核名单         |
 * | `d > 5`               | `hard` | 硬门告警（疑似口径漂移） |
 *
 * **两个边界各只属一档**：恰好 2pp 归 `ok`、恰好 5pp 归 `warn` —— 两个 `≤` 顺序判定，
 * 结构上不可能两档同时亮（配合 Decimal 精确减法，边界不随浮点误差漂移）。
 *
 * 入参是 {@link IvPercentileResult} 而不是裸数值：让「不可算 ⇒ 跳过」由类型结构保证，
 * 调用方没有机会拿 0 当自算值传进来。复杂度 O(1)。
 */
export function classifyIvpDivergence(
  vendorPercentilePct: Prisma.Decimal | null,
  self: IvPercentileResult,
): IvpDivergenceVerdict {
  if (!self.computable) {
    return {
      level: 'skipped',
      diffPp: null,
      // 缺窗口不是口径漂移 —— 告警面不该被上线头一年的新标的刷屏。
      reason: `自算不可算 (${self.reason}, 有效样本 ${self.sampleSize}/${IVP_MIN_WINDOW_TRADING_DAYS}) ⇒ 跳过对表`,
    };
  }
  if (vendorPercentilePct === null || !vendorPercentilePct.isFinite()) {
    return { level: 'skipped', diffPp: null, reason: 'vendor 直读分位缺失, 无可比对象 ⇒ 跳过对表' };
  }

  const diff = vendorPercentilePct.minus(self.percentilePct).abs();
  const detail = `直读 ${vendorPercentilePct.toFixed(4)}pp vs 自算 ${self.percentilePct.toFixed(4)}pp, 差 ${diff.toFixed(4)}pp`;

  if (diff.lessThanOrEqualTo(IVP_DIVERGENCE_WARN_PP)) {
    return { level: 'ok', diffPp: diff, reason: `${detail} ≤ ${IVP_DIVERGENCE_WARN_PP}pp` };
  }
  if (diff.lessThanOrEqualTo(IVP_DIVERGENCE_HARD_PP)) {
    return { level: 'warn', diffPp: diff, reason: `${detail}, 进 WARN 复核名单` };
  }
  return {
    level: 'hard',
    diffPp: diff,
    reason: `${detail} > ${IVP_DIVERGENCE_HARD_PP}pp, 疑似 vendor 聚合口径漂移`,
  };
}

/** `YYYY-MM-DD` 校验 + 日历有效性（02/30 这类会被 Date 滚成下月，回读不等即非法）。 */
function assertIsoDate(label: string, raw: string): void {
  const m = ISO_DATE_RE.exec(raw);
  if (m === null) {
    throw new InvalidBackfillRangeError(`${label} 不是 YYYY-MM-DD: "${raw}"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new InvalidBackfillRangeError(`${label} 是不存在的日期: "${raw}"`);
  }
}

/** `YYYY-MM-DD` 加 n 天（UTC 定点，绕开本地时区/夏令时；字典序即时序，可直接比较）。 */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * 回填总区间 → 逐段 ≤ {@link HIS_VOLATILITY_MAX_SPAN_DAYS} 天的窗口序列（FR-024）。
 *
 * **首尾相接、不重不漏**：下一窗起点 = 上一窗终点 **+1 天**（闭区间语义下这是唯一不重不漏的
 * 接法 —— 用 `+0` 会让边界那天被拉两次，用 `+2` 会漏一天，而两者都不会报错、只会在库里变成
 * 重复行或永久空洞）。末窗被 `end` 截断，绝不越界。
 *
 * `start > end`（日常增量算出空区间）→ 返回 `[]`，不是错误；日期非法 / `maxSpanDays ≤ 0`
 * → 抛 {@link InvalidBackfillRangeError}（后者还会死循环）。
 *
 * 首次上线**拉满 vendor 上限约 3 年**（FR-024）—— 理由是不可逆性：`his_volatility` 的 3 年是
 * **滑动窗**，今天不拉，明年再想要中间那段就永久没有了。
 *
 * 复杂度 O(k)，k = 产出窗口数 = ⌈总天数 / maxSpanDays⌉。
 */
export function splitBackfillWindows(
  start: string,
  end: string,
  maxSpanDays: number = HIS_VOLATILITY_MAX_SPAN_DAYS,
): BackfillWindow[] {
  assertIsoDate('start', start);
  assertIsoDate('end', end);
  if (!Number.isInteger(maxSpanDays) || maxSpanDays <= 0) {
    throw new InvalidBackfillRangeError(`maxSpanDays 必须是正整数, 实得 ${maxSpanDays}`);
  }
  if (start > end) return [];

  const windows: BackfillWindow[] = [];
  let cursor = start;
  while (cursor <= end) {
    const full = addDays(cursor, maxSpanDays - 1); // 含首尾计 maxSpanDays 天。
    const winEnd = full < end ? full : end;
    windows.push({ start: cursor, end: winEnd });
    cursor = addDays(winEnd, 1);
  }
  return windows;
}
