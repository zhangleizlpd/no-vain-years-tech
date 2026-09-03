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
 * ## 「样本」= 真实有值的观测，**不是行数**（FR-019a，066 T08 补）
 *
 * 判「够不够 252」数的是 {@link isRealIvObservation} 为真的那些观测，空值观测累积再多也不进
 * 分子。这条在美股上一直无从触发（无期权的标的其概览**整行缺席**），但**港股上是常态**：港股
 * 绝大多数标的没有挂牌期权，它们的概览会返 200 + 各数值字段字面量 `'N/A'`，经采集侧规范化
 * 落 `null` —— 也就是说库里会**有行**、只是行里没有观测。若按行数判，这类空行凑够 252 就
 * 会被判「样本充足」，产出一个毫无意义却看起来可算的分位，**且不报错**。
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
 * 日更增量回看窗（自然日，#211 修 FR-023 的「增量」半边）。
 *
 * 单位是**自然日**而非交易日：它是喂给 `his_volatility` 区间接口的 `from`，那个接口按日历
 * 日收区间、按交易日返行。窗内含多少交易日无所谓 —— 多取几天的代价是零（同在 vendor 单次
 * 上限 {@link HIS_VOLATILITY_MAX_SPAN_DAYS} 内 ⇒ 恒为**一页**，与取 1 天同样一次调用）。
 *
 * 🚨 **为什么是滚动窗而不是「只补当日」**：`skipDuplicates` + 回看窗 ⇒ 任一晚失败（vendor
 * 抖动 / 部署撞链 / 进程被替换），下一晚**自动补回**，无需人介入。而「只补当日」漏一晚就是
 * 一个永久空洞，只能靠人工回填发现并修复 —— **那正是 #211 的成因形状**：`underlying_iv_history`
 * 此前只有 backfill 一条写入路径，静默停更 23 天而无人知晓。自愈是本常量存在的全部理由。
 *
 * 取 30 而非 7：成本完全相同（都是一页），但能扛住的故障窗口从「一个周末」变成「一个月」。
 */
export const IV_HISTORY_INCREMENT_LOOKBACK_DAYS = 30;

/**
 * 双算差 WARN 阈值（pp）。差 ≤ 此值 = 静默（量化噪声带）。
 *
 * 取 p3b §6.3 已给的实测基线，不另拍脑袋。
 *
 * 📌 2026-08-27 prod 横截面复核（12 只标的、窗口滞后 0 天那日）：残差**全部是 1/252 =
 * 0.3968pp 的整数倍**（1×~4×），只有 4 只完全吻合。⇒ 残差成因是「窗口内容差几个样本」而
 * **不是口径不同**，这条 2pp 噪声带的标定依然成立。🚫 别期待差值归零后再收紧阈值。
 *
 * 📌 **同日 vendor 官方给出了那「几个样本」的来源**（py-futu-api#257）：他们的分母取**实际有效
 * 天数**（不含空值日），而历史序列已把空值日**前向填充**过 ⇒ 我们数 252、他们数 252−空值日，
 * 差的正是整数个样本。⇒ 上面这条经验标定与官方口径**互相印证**，但也说明差值**没有上界**
 * （某只票空值日一多就能差很远）——所以 5pp 那档在同一天被降级，见
 * {@link IVP_DIVERGENCE_NOTABLE_PP}。
 */
export const IVP_DIVERGENCE_WARN_PP = new Prisma.Decimal(2);

/**
 * 双算差**显著档**阈值（pp）。同取 p3b §6.3 基线。
 *
 * 🚨 **它曾经是硬门，2026-08-27 降级了 —— 别改回去**（py-futu-api#257 官方答复）。原文案是
 * 「差 > 5pp = 口径疑似漂移 ⇒ 硬告警 ⇒ 需人工核口径」，那个**推断现在已知是错的**：差值有三个
 * 已确认的结构性来源，客户端一个都消不掉。见 {@link classifyIvpDivergence} 的表。
 * 留着它只是让「差得离谱」与「差一点点」在日志里仍可分辨，**不再断言任何关于 vendor 的结论**。
 */
export const IVP_DIVERGENCE_NOTABLE_PP = new Prisma.Decimal(5);

/**
 * 「恰合」的判据（pp）。差 ≤ 此值即算两侧算出同一个数。
 *
 * 不写「差恰为 0」：自算走 `below / sampleSize * 100` 的 Decimal 除法，除不尽时留尾数；
 * 直读值也已按列精度四舍五入。两侧都对时差值是 **1e-4 量级**，不是严格 0。
 */
export const IVP_EXACT_MATCH_PP = new Prisma.Decimal(0.001);

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
  /** 参与计算的**真实观测**数（空值观测已剔除，见 {@link isRealIvObservation}）。 */
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
export type IvpDivergenceLevel = 'skipped' | 'ok' | 'warn' | 'notable';

export interface IvpDivergenceVerdict {
  level: IvpDivergenceLevel;
  /** |直读 − 自算|，单位 pp；`skipped` 时为 null（没有可比差值，不拿 0 冒充）。 */
  diffPp: Prisma.Decimal | null;
  /** 人可读依据，进告警面供运维定位。 */
  reason: string;
}

/**
 * 「恰合数为 0」这条判据成立所需的**最小可算样本数**。
 *
 * 🚨 **它不是保守裕度，是判据的前提**：那条判据的逻辑是「窗口内没有空值日的票**必然**恰合，
 * 所以一只都不合 ⇒ 是我们这侧算错了」。样本太小时前提不成立 —— 抽到的那几只**本来就可能
 * 全都有空值日**，此时「恰合数为 0」是正常态，不是塌陷。
 *
 * 取 10：2026-08-26 实测 110 只可算标的中 65 只恰合（59%）。若每只独立地有 ~41% 概率带空值日，
 * 10 只全带的概率约 `0.41^10 ≈ 1e-4` ⇒ 假阳性可忽略，而 #211 那种**全域**塌陷照样命中。
 * 🚫 别为了「让小样本也能判」把它调小 —— 那恰好是把前提拆掉。
 */
export const IVP_SYSTEMIC_BREAK_MIN_SAMPLE = 10;

/** 一轮对表的批级汇总（逐票判据退场后，采集侧唯一的输出面）。 */
export interface IvpBatchSummary {
  /** 成立对表的标的数（`skipped` 不计 —— 不成立对表 ≠ 对不上）。 */
  computable: number;
  /** 其中两侧算出同一个数的（差 ≤ {@link IVP_EXACT_MATCH_PP}）。 */
  exact: number;
  /** 最大偏移（pp）；零可算标的时为 `null`（不拿 0 冒充「完全吻合」）。 */
  maxOffsetPp: Prisma.Decimal | null;
  /** 最大偏移折成**样本数**（四舍五入）——它才是「窗口内空值日数」的直读量。 */
  maxOffsetSamples: number;
  /** 🚨 唯一的自动判据，见函数注释。 */
  systemicBreak: boolean;
}

/**
 * 批级汇总 + **唯一一条**系统性判据。
 *
 * ## 🚨 逐票判据为什么退场（py-futu-api#257 / #218 / #209）
 *
 * vendor 已书面确认：`get_option_underlying_his_volatility` 的序列对 IV 为空的日期**前向填充**
 * 且**客户端无法仅凭返回序列区分真实日与被填充日**；而 `iv_percentile` 的分母取**实际有效
 * 天数**（不含空值日），更新频率还是**盘中分钟级**。⇒ 逐票偏移 = 该票窗口内的空值日数，
 * **客户端消不掉**。2026-08-26 实测 110 只可算标的里 24 只落在原 WARN 带 —— 全是这种。
 *
 * 🚫 **MUST NOT 靠调阈值解决**：偏移没有上界（某只票空值日一多就能差很远），放宽到今天的
 * 经验上界（10 样本 ≈ 3.97pp）明天就会被一只空值日更多的票越过。而天天响的告警等于没有告警
 * （#209 正文：「天天判红会让人学会无视这份报告 —— 那等于闸失效」）。
 *
 * ## 那还剩什么值得自动判
 *
 * **恰合数为 0**。填充机制下，**窗口内没有空值日的那批票必然恰合**（2026-08-26 实测 65/110
 * 恰合）；连它们都不合了，就不是 vendor 侧的填充，而是**我们这侧**算错了。#211（历史序列
 * 停更 23 天）正是这个形状：全域偏移变大、恰合归零 —— 它能被这一条抓到，而那 24 条噪声
 * 不会触发它。
 *
 * 🚨 可算样本不足 {@link IVP_SYSTEMIC_BREAK_MIN_SAMPLE} 时**一律不判塌陷**：上线首日 / 全部
 * 窗口不足时可算集本就很小，而判据的前提（样本里存在无空值日的票）此时不成立 —— 详见该常量。
 *
 * 📌 **恢复逐票判据的条件**：vendor 提供空值标记（如逐行 `iv_filled`）或未填充口径 —— 官方
 * 已主动表示可另行对齐。拿到之前，把逐票阈值接回告警面都是在制造无解的人工任务。
 *
 * 复杂度 O(n)，n = 本轮标的数。
 */
export function summarizeIvpDivergences(
  verdicts: readonly IvpDivergenceVerdict[],
): IvpBatchSummary {
  let computable = 0;
  let exact = 0;
  let maxOffsetPp: Prisma.Decimal | null = null;

  for (const v of verdicts) {
    if (v.diffPp === null) continue; // skipped：不成立对表
    computable++;
    if (v.diffPp.lessThanOrEqualTo(IVP_EXACT_MATCH_PP)) exact++;
    if (maxOffsetPp === null || v.diffPp.greaterThan(maxOffsetPp)) maxOffsetPp = v.diffPp;
  }

  // 1 样本 = 100 / 252 pp。折样本数是为了让这个数**可直接读成「空值日数」**。
  const perSample = HUNDRED.div(IVP_MIN_WINDOW_TRADING_DAYS);
  return {
    computable,
    exact,
    maxOffsetPp,
    maxOffsetSamples: maxOffsetPp === null ? 0 : Math.round(maxOffsetPp.div(perSample).toNumber()),
    systemicBreak: computable >= IVP_SYSTEMIC_BREAK_MIN_SAMPLE && exact === 0,
  };
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

/**
 * 一个「真实有值的观测」（FR-019a）—— 分位样本的**唯一**入选判据。
 *
 * 具名而不内联，是因为它是那条判据本身：`null` 在这条链路上不表示 0、也不表示「那天没开市」，
 * 而是「那天这只票根本没有 IV 这个读数」（无挂牌期权标的的常态形态）。把它并回
 * `filter(v => v !== null)` 会让「样本 ≠ 行数」这件事重新变成一句注释。
 */
function isRealIvObservation(v: Prisma.Decimal | null): v is Prisma.Decimal {
  return v !== null && v.isFinite();
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
 * @param history 历史 IV 序列（顺序无关）；空值观测（{@link isRealIvObservation} 为假）视为该日
 *                无读数，**先剔除再判窗口** —— 判据是观测数不是行数（FR-019a）。
 * @param current 当日直读 IV；缺失 ⇒ `missing_current`（优先于窗口判定：连被比较的值都没有）。
 */
export function computeIvPercentile(
  history: readonly (Prisma.Decimal | null)[],
  current: Prisma.Decimal | null,
): IvPercentileResult {
  const sample = history.filter(isRealIvObservation);

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
 * | 差值 `d`（pp）        | 档        | 处置                                   |
 * | --------------------- | --------- | -------------------------------------- |
 * | 自算不可算 / 无直读值 | `skipped` | 不对表、**不告警**                     |
 * | `d ≤ 2`               | `ok`      | 静默（量化噪声带）                     |
 * | `2 < d ≤ 5`           | `warn`    | 进 WARN 复核名单                       |
 * | `d > 5`               | `notable` | 同样只进 WARN，**不喊人工介入**（见下） |
 *
 * ## 🚨 本对表**不再是 vendor 口径的判据**（py-futu-api#257，2026-08-27 官方答复）
 *
 * 差值有三个已确认的结构性来源，**客户端一个都消不掉**：
 *
 * | 来源 | 官方原文要点 |
 * | --- | --- |
 * | **历史序列被前向填充** | `get_option_underlying_his_volatility` 对 iv 为空的日期「取**最近一个有效 iv** 填充后返回」，且**客户端无法仅凭返回序列区分真实日与被填充日** |
 * | **分母口径不同** | vendor 取**实际有效天数**（不含空值日），我们取固定 252 |
 * | **取数时点不同** | 该字段**盘中分钟级更新**，我们拿日线收盘序列比 |
 *
 * 🚨 第一条是 {@link isRealIvObservation} 那道闸的**第二次落空**：它按「空值观测剔出样本」写，
 * 而序列里根本没有空值——同 ADR-0067 里 `numToString` 「在这个 vendor 上恒不触发」的形状，
 * 只是这次的带内哨兵不是 `0` 而是**前一个有效值**，连异常都不像。
 *
 * ⇒ 本函数现在只剩**一个**有效用途：盯**我们自己**这侧的回归（#211 那种把当日行算进窗口的错）。
 * 对 vendor 侧不构成任何判据，故最高档也只 WARN。
 *
 * 📌 **恢复硬门的条件**（别凭感觉改回去）：vendor 提供空值标记（如逐行 `iv_filled`）或未填充口径
 * ——官方已主动表示可另行对齐。拿到之前，把任何一档接回 ERROR 都是在制造无解的人工任务。
 * 🚫 已否决的替代：「连续相同 IV 值 = 填充日」这个启发式会把**真实平盘日**一并误判，
 * 属于用一个静默错误换另一个。
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
  if (diff.lessThanOrEqualTo(IVP_DIVERGENCE_NOTABLE_PP)) {
    return { level: 'warn', diffPp: diff, reason: `${detail}, 进 WARN 复核名单` };
  }
  return {
    level: 'notable',
    diffPp: diff,
    // 🚫 MUST NOT 写回「疑似 vendor 聚合口径漂移」—— 那个推断已被官方答复证否 (见函数注释)。
    reason:
      `${detail} > ${IVP_DIVERGENCE_NOTABLE_PP}pp。**不据此判 vendor 口径漂移**: 已知成因 = ` +
      `his_volatility 序列对空值日前向填充(不可分辨) + vendor 分母取实际有效天数 + 盘中分钟级更新`,
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
 * 首次上线**拉满 vendor 可回看的全部历史**（FR-024，维度行 `history_depth = 1095`）。
 *
 * EVIDENCE: 那个底是**固定数据纪元**, 不是 3 年滑动窗 —— 相隔 24 天的两次实取里底几乎没动:
 * 2026-07-29 `US.PEP` 776 行回到 **2023-06-26**; 2026-08-22 港股逐窗二分触底 **2023-06-27**
 * (`2022-08-25..2023-08-23` 只 41 行且首行即 2023-06-27, 再前一窗 0 行 —— 065 探针)。真是滑动
 * 窗的话 2026-08-22 那天的底应在 2023-08-22, 比实测晚近两个月; 且两个市场的底只差一天 ⇒ 是
 * vendor 级纪元, 不是各票各自的浅历史。富途官方文档对**回看深度**与保留策略只字未提 (只写了
 * 单次跨度 ≤364 天,
 * https://openapi.futunn.com/futu-api-doc/quote/get-option-underlying-his-volatility.html,
 * 2026-09-03 复核) ⇒ 深度这一维只有实测、没有规格。
 *
 * 🚨 **原注释「那 3 年是滑动窗, 今天不拉明年那段就永久没了」已被上述实测证伪, 本次删除。**
 * 拉满仍然正确, 但理由降级为「拉满无害且一次性成本可忽略 (12 只 × 4 页 ≈ 48 次)」—— 紧迫性
 * 论证不再成立。`specs/066-hk-option-cold-start/spec.md:299` 早已按此订正, 当时订正没走到代码
 * 注释, 本次补齐。
 *
 * ASSUMED: 「纪元固定」本身仍是**从两次观测推出来的**, 没有 vendor 规格背书。它若哪天真变回
 * 滑动窗, 紧迫性回来而**不会有任何断言变红** —— 唯一盯它的是
 * `test/integration/marketdata.futu-shim.vendor.spec.ts` 的深度边界断言, 而那套件恒 skip。
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
