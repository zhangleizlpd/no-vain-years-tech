/**
 * **per-market 连续竞价时段表**（060 T001, FR-010 / FR-011 / FR-022, plan §D6）。纯函数、
 * 无 I/O、无 DI（ADR-0043 §4）。
 *
 * 本文件是盘中时段的**唯一**落点。此前它只以 `cn` 一条登记内联在
 * `alert/intraday-eval.processor.ts` 里，而 `trading-day-gate.ts` 的 `MARKET_CLOSE_MINUTES`
 * 注释明写「盘中时段还要午休段，那是另一件事，归各消费方」—— 060 出现第二个消费方（锚首建
 * 冷启动），散在两处必漂，故下沉合并到这里。
 *
 * 落点判据是 eslint 实测出来的、不是偏好：`eslint.config.mjs` 的 `from: { type: 'alert' }`
 * disallow 列了 `marketdata` 但**没列 `marketdata-rules`**（ADR-0053 放行的那条编译期边），
 * 而 `marketdata-rules` 元素的 pattern 是 `src/marketdata/*.rules.ts`（`mode: 'full'`）
 * ⇒ 文件名落在这个形状上，alert 才 import 得到，合并零配置改动。
 * ⚠️ 反向不成立：`from: { type: 'optionsdesk' }` 的 disallow **含** `marketdata-rules`
 * ⇒ 将来若想把盘中判断挪进 optionsdesk 会直接撞墙。
 */
import type { SessionKindStatus } from './trading-day.rules.js';

/**
 * market → 定盘中时段所用时区 (IANA) + 连续竞价时段 (当地当日分钟数, 闭区间)。
 *
 * `halfDaySegments` = 该市场**半日市**当天的时段 (063 Phase 2); 缺席 = 该市场没有半日市形态
 * (cn: A 股除夕直接休市, 不半开) ⇒ 即便日历说 `half` 也回落常规时段, **不编一个出来**。
 */
const MARKET_SESSION: Record<
  string,
  {
    timeZone: string;
    segments: readonly [number, number][];
    halfDaySegments?: readonly [number, number][];
  }
> = {
  // 上午 [09:30,11:30] + 下午 [13:00,15:00] (收盘集合竞价归 15:00)。
  cn: {
    timeZone: 'Asia/Shanghai',
    segments: [
      [9 * 60 + 30, 11 * 60 + 30],
      [13 * 60, 15 * 60],
    ],
  },
  // 单段 [09:30,16:00] ET —— **真的无午休** (与 hk 的「有午休但蓄意不建模」不是一回事)。
  // 盘后延长时段 (16:00–20:00 ET) 蓄意**不登记**: 期权在那一段基本无成交, 既有常规快照轮
  // (北京 06:30 = ET 17:30/18:30) 正是落在其中并把 `last` 当收盘态用, 本片沿用同一口径。
  us: {
    timeZone: 'America/New_York',
    segments: [[9 * 60 + 30, 16 * 60]],
    // 🚨 **13:15 = 期权收盘, 不是股票的 13:00** (063 Phase 2)。两个都真: NYSE 半日市股票
    // 13:00 ET 收、期权 13:15 ET 收。取**较晚**那个, 判据是偏差方向:
    // · 取 13:15 → 13:00–13:15 之间股票 EOD 晚采 15 分钟。无害 (夜间 cron 本就在几小时后)。
    // · 取 13:00 → 期权仍在交易时判「已收盘」⇒ **写半根**。正是本片要消灭的那类。
    // 而本表唯一的生产消费方 (锚首建冷启动) 服务的恰恰是**期权**采集能力。
    // 精确区分股票/期权收盘要 MIC (ISO 10383) 粒度, plan 已明确不做。
    halfDaySegments: [[9 * 60 + 30, 13 * 60 + 15]],
  },
  // 单段 [09:30,16:00] HKT —— **午休 (12:00–13:00) 蓄意不建模**, 合并进一段 (2026-08-18
  // user 定案, 趁 hk 期权尚未开通落地)。登记 hk 本身是为 FR-024 的「市场能力显式登记」留结构
  // 位 —— hk 期权采集仍**未开通** (`COLD_START_CAPABILITY` 里 hk 是空表项)。
  //
  // 🚨🚨 **这个简化只对「补数闸」成立, 对「预警」不成立 —— 两种语义在这里分岔, 别混。**
  //
  // · 补数闸 ({@link isSessionUnderway}) 问的是「**这一场收了没有**」。单段化后午休仍算场内
  //   ⇒ 冷启动在午休照样 `intraday_skipped`、不写快照 ⇒ FR-011 原样成立, 取值**逐点不变**。
  //
  // · 预警问的是**另一件事**:「**此刻能不能成交**」。午休不能成交 ⇒ 盘中告警在午休 MUST NOT
  //   触发。而单段化让 {@link isWithinTradingSession} 对 hk 午休从 `false` 翻成 `true`
  //   —— **对预警而言那是错的答案**。
  //
  // ⇒ 🚨 **将来给 hk 接盘中告警时, MUST NOT 直接拿本表的 hk 单段去判。** 两条路二选一:
  //   ① **首选**: 把 hk 恢复成 [09:30,12:00] + [13:00,16:00] 两段。对补数闸**零影响** ——
  //      `isSessionUnderway` 取的是 min(开盘)/max(收盘), 两段与单段同为 09:30/16:00 ——
  //      而预警同时拿回正确答案。换言之这条退路是免费的。
  //   ② 或给预警侧单独登记一份带午休的 hk 时段, 别让两个消费场景共用同一行。
  //
  // 今天之所以可以先合: `isWithinTradingSession` 唯一的生产调用方是
  // `alert/intraday-eval.processor.ts`, 参数写死 `INTRADAY_MARKET = 'cn'` ⇒ hk 够不到它。
  hk: {
    timeZone: 'Asia/Hong_Kong',
    segments: [[9 * 60 + 30, 16 * 60]],
    // 半日市 = **只开上午** (12:00 HKT 收, 无下午段) —— 与上面「午休蓄意不建模」正交:
    // 那条合并的是 12:00–13:00 这个**休息**段, 而半日市当天 12:00 之后根本没有下午场。
    halfDaySegments: [[9 * 60 + 30, 12 * 60]],
  },
};

function unregisteredMarketError(market: string): Error {
  return new Error(
    `[market-session] 市场 "${market}" 未登记盘中时段 —— ` +
      `加市场须在 MARKET_SESSION 显式登记其时区与时段 (禁默认套用别的市场的时窗)`,
  );
}

/**
 * 该市场的盘中时段**登记了没有** —— 唯一一个「未登记也不抛」的入口 (060 T005)。
 *
 * {@link marketNow} 与 {@link isSessionUnderway} 对未登记市场一律抛, 那是对的: 它们的返回值
 * 会被当成判据用, 静默套用别的市场的时段正是要根除的失败形态。但 FR-022 要求未登记市场
 * **显式跳过并留下可判读记录**, 调用方得先问一句「登记了吗」才能落那条记录 —— 拿上面两个
 * 函数的异常当控制流是把 fail-closed 的守卫改造成分支, 那条守卫就不再守任何东西了。
 */
export function isSessionRegistered(market: string): boolean {
  return MARKET_SESSION[market] !== undefined;
}

/**
 * 某市场当地的日期串 + 当日分钟数。
 *
 * 🚨 **走 Intl 而非手工时区偏移** —— 原实现是 `now + 8h` 再取 UTC 字段, 对 `Asia/Shanghai`
 * (恒 UTC+8 无 DST) 答案正确, 但那份正确性只是巧合: 换任何有 DST 的市场 (`America/New_York`)
 * 都会静默错一小时, 而且错在**边界那一小时**上 —— 开盘/收盘各差一格, 不报错。本片登记 us
 * 之后这条从「将来的隐患」变成**当下的判据**。
 * 未登记市场直接抛: 静默套用别的市场的时段, 正是这条要根除的失败形态。
 */
export function marketNow(market: string, now: Date): { dateOnly: string; minutesOfDay: number } {
  const session = MARKET_SESSION[market];
  if (session === undefined) {
    throw unregisteredMarketError(market);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: session.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    dateOnly: `${pick('year')}-${pick('month')}-${pick('day')}`,
    minutesOfDay: Number(pick('hour')) * 60 + Number(pick('minute')),
  };
}

/**
 * 该市场**连续竞价**时段判定 (闭区间; 午休落在两段之间 ⇒ false)。复杂度 O(段数)。
 * 语义 =「**此刻能不能成交**」⇒ 预警 / 盘中触发这类判据用它。
 *
 * 🚨 但它的答案取决于该市场**登记了几段**: hk 已合并成单段 (2026-08-18) ⇒ 它对 hk 午休答
 * `true`, 而午休不能成交 ⇒ **对预警是错的答案**。接 hk 盘中告警前, 必须先按 `MARKET_SESSION`
 * 里 hk 登记处注释给的两条路之一处理, MUST NOT 直接拿它去判。
 *
 * ⚠️ 未登记市场返 `false` 而不抛 —— 这是自 alert 原样搬来的既有语义, 刻意保留 (alert 的调用
 * 点先过 `marketNow` 才到这里, 抛在那一步)。**新调用方别依赖这个 false**: 想要 fail-closed
 * 的判据用 {@link isSessionUnderway}。
 */
export function isWithinTradingSession(market: string, minutesOfDay: number): boolean {
  const session = MARKET_SESSION[market];
  if (session === undefined) return false;
  return session.segments.some(([from, to]) => minutesOfDay >= from && minutesOfDay <= to);
}

/**
 * 该市场当日的这一场**是否进行中** —— 自首段开盘至末段收盘, **含**中间的休息段（午休）。
 * 复杂度 O(段数)。
 *
 * 🚨 **它与 {@link isWithinTradingSession} 的差别只有午休那一段, 而那正是 FR-011 的落点。**
 * 期权快照是「按交易日归属、供应方只给当下一份」的数据, 它的闸要问的是「**这一场收了没有**」
 * 而不是「此刻在不在连续竞价」。午休时后者返 `false` —— 拿它当闸就会放行, 于是把午休时刻的
 * 盘口贴上「上一场收盘」的标签写进库（`sessionWatermark` 在未过收盘时给出的目标日是
 * **上一个交易日**）。那种错行**不报错**、按唯一键占位、当晚正确的行反被挡掉 ⇒ 永久缺口。
 *
 * 📌 两谓词的分道如今**只剩 `cn`**: us 真的无午休, hk 已于 2026-08-18 合并成单段 (理由与
 * 「接 hk 预警时必须改回去」的硬约束见上面 hk 登记处的注释) ⇒ 它俩在这两个市场上逐分钟等价
 * （单测里有一条逐分钟断言钉住这件事）。而 cn 不在 `COLD_START_CAPABILITY` 里 ⇒ 这个差异当前
 * **无生产落点**; 留着本谓词是为了「哪天给一个有午休的市场开通期权采集」时闸仍站在收紧那侧,
 * 而不是指望那天有人临时想起来该用哪一个。
 *
 * ⚠️ 未登记市场**抛**（与 `isWithinTradingSession` 相反）: 返 `false` 的方向是「没在进行中」
 * ⇒ 放行写快照, 那是 fail-open。本谓词的每一个 `false` 都意味着「可以写」, 故未知即抛。
 */
export function isSessionUnderway(
  market: string,
  minutesOfDay: number,
  kind: SessionKindStatus,
): boolean {
  const session = MARKET_SESSION[market];
  if (session === undefined) {
    throw unregisteredMarketError(market);
  }
  // 🚨 `kind` **必填**不可省 (063 Phase 2): 做成可选默认 `whole` 的话, 漏传的调用点会在半日
  // 市当天静默拿到「还在场内」⇒ 落终态不重试的 `intraday_skipped` ⇒ 那一场的快照**永久缺失**。
  // 让 TS 把每个调用点逼出来显式声明它知不知道 kind, 与 `daysToExpiry` 拒绝可选交易所入参同源。
  //
  // `unknown` → 回落常规时段 = 本列上线前的逐点行为 (fail-open, 少采一场下轮补上);
  // 该市场没登记 `halfDaySegments` (cn) 同样回落 —— **不为一个没有半日市的市场编一个出来**。
  const segments =
    kind === 'half' ? (session.halfDaySegments ?? session.segments) : session.segments;
  // 取 min(开盘) / max(收盘) 而非 segments[0] / at(-1) —— 不把「登记时必须按时序排」这条
  // 隐式不变式压在加市场的人身上（排错了不会红, 只会让午休那段悄悄漏出闸）。
  const open = Math.min(...segments.map(([from]) => from));
  const close = Math.max(...segments.map(([, to]) => to));
  return minutesOfDay >= open && minutesOfDay <= close;
}
