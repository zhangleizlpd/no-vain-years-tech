import type { TradingCalendarPort } from './trading-calendar.port.js';

/**
 * 交易日 gate (016 T004, FR-S02): 夜间管线**最外层短路**。今日非交易日 → 返 false,
 * 调用方据此整管线 skip (SyncRun status=skipped, 零 vendor 调用 — 节假日/周末盲跑纯浪费配额)。
 *
 * 纯委托 `TRADING_CALENDAR_PORT` (不自维护节假日表); `date` 由调用方按市场时区算 (见
 * `shanghaiToday`)。无副作用 → vitest 纯单测可喂 stub calendar。
 *
 * 🚨 **三态 → 布尔的映射是 `!== 'non-trading'`, 不是 `=== 'trading'`** (062 T006, Impl
 * Guardrail 1): gate 的语义是「**确认**今天不是交易日才关」——「日历还没填到这儿」(`unknown`)
 * 必须走**放行**侧, 与 062 之前 `DbTradingCalendarAdapter` 对未 populate 的日历 fail-open 返
 * `true` 逐点相同 (零行为变更)。写成 `=== 'trading'` 会让上线首刻 (覆盖声明表刚建、尚未灌值
 * ⇒ 全 `unknown`) 整条夜间管线恒 skip, 而**没有任何测试会红**。
 */
export async function isTradingDayGateOpen(
  calendar: TradingCalendarPort,
  market: string,
  date: string,
): Promise<boolean> {
  return (await calendar.classify(market, date)) !== 'non-trading';
}

/**
 * 今日 (Asia/Shanghai) 的 `YYYY-MM-DD`。A 股以北京时区定交易日;服务器时区无关。
 * `en-CA` locale 直出 ISO `YYYY-MM-DD` 格式 (避免手拼月日零填充)。
 */
export function shanghaiToday(now: Date): string {
  return dateInTimeZone(now, 'Asia/Shanghai');
}

/** 任意 IANA 时区下 `now` 的 `YYYY-MM-DD` (DST 由 Intl 处理, 无需手工偏移)。 */
function dateInTimeZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * 任意 IANA 时区下 `now` 的日期 + 当日分钟数 (DST 同样由 Intl 处理)。
 * `hourCycle:'h23'` 而非 `hour12:false` —— 后者在部分实现下把午夜给成 `24`。
 */
function timeInTimeZone(now: Date, timeZone: string): { date: string; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    minutesOfDay: Number(pick('hour')) * 60 + Number(pick('minute')),
  };
}

/**
 * market → 该市场**定交易日所用的时区** (IANA)。
 *
 * 🚨 这不是"服务器在哪"或"用户在哪", 是**交易所在哪** —— 业内通行口径:
 * QuantConnect 的证券数据按 exchange time zone 打戳、日线按其在**本所**收盘的时刻定日;
 * TradingHours「date parameters are always converted into the timezone of the specified market」。
 * 我们此前全局用 `shanghaiToday` 相当于把"跑批的墙上时钟"当业务日期 —— 对 cn/hk 恰好相等
 * 所以一直没暴露, 对 us 直接塌 (见 {@link marketDateFor} 的失败形态表)。
 */
const MARKET_TIME_ZONE: Record<string, string> = {
  cn: 'Asia/Shanghai',
  hk: 'Asia/Hong_Kong', // 与 Asia/Shanghai 同为 UTC+8 且均无 DST → 与 cn 同日, 行为零变化
  us: 'America/New_York',
};

/** `marketScope` 为空 (meta 维度如 universe/profile) 时的兜底 —— 保持既有宿主口径。 */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/**
 * 维度的**业务日期** (`asOf`): 按其 `marketScope` 所属市场的时区求"今天"。
 *
 * 🚨 **为什么不能全局用一个 `shanghaiToday`** —— us 的收盘 (16:00 ET) 落在北京**次日凌晨**,
 * 故 us 维度只能排在北京清晨, 而那一刻 `shanghaiToday` 已经翻到下一天:
 *
 * | 北京时刻 | 刚收盘的 US session | 全局 shanghaiToday | 后果 |
 * | --- | --- | --- | --- |
 * | 周二 06:00 | 周一 ET | 周二 | 拿到周一的 bar 却标成周二 → **日期错位一天**, 且 targetDate 幂等判据随之失效 |
 * | **周六 06:00** | **周五 ET** | 周六 | 交易日闸判"周六非 us 交易日"→ 短路 → 🚨 **周五的 bar 永远采不到** |
 * | 周一 06:00 | (无) | 周一 | 白跑 —— 美股周一尚未开盘 |
 *
 * 换算到 `America/New_York` 后三行全部自洽, 且 **DST 无需特判** (Intl 处理): 北京 06:00 在
 * 夏令 = 前一日 18:00 EDT、冬令 = 前一日 17:00 EST, 两者都在 16:00 收盘之后。
 *
 * ⚠️ **scope 内各市场必须落在同一业务日** —— 否则没有单一"今天"可言, 直接抛。这同时把
 * p3b §3.3 那条"别往 cn/hk 维度里掺 us"的散文约定变成机器强制 (混进去还会踩另一个坑: tick
 * payload 无 `markets` 字段 ⇒ 工作集恒为全 scope, 只有 us 开市的日子会对全部 cn+hk 标的发请求)。
 *
 * 🚨 **判据是"算出来的日期相同", 不是"时区字符串相同"**: `cn`(Asia/Shanghai) 与
 * `hk`(Asia/Hong_Kong) 是两个不同的 IANA 名字但恒为 UTC+8 且均无 DST —— 现役 `eod_bar`
 * 维度的 scope 就是 `{cn,hk}`, 按字符串比会在生产直接抛。比日期才是真正要守的不变量。
 *
 * 复杂度 O(scope 长度)。
 */
export function marketDateFor(marketScope: string[], now: Date): string {
  const byMarket = marketScope.map(
    (m) => [m, dateInTimeZone(now, MARKET_TIME_ZONE[m] ?? DEFAULT_TIME_ZONE)] as const,
  );
  const distinct = new Set(byMarket.map(([, date]) => date));
  if (distinct.size > 1) {
    throw new Error(
      `[trading-day] marketScope 跨时区无单一业务日期: ` +
        `${byMarket.map(([m, d]) => `${m}=${d}`).join(' / ')}; ` +
        `拆成各自的维度 (混 scope 还会让工作集恒为全 scope)`,
    );
  }
  return byMarket.length > 0 ? byMarket[0][1] : dateInTimeZone(now, DEFAULT_TIME_ZONE);
}

/**
 * market → 该市场**常规交易时段收盘时刻** (当地时区的当日分钟数)。
 *
 * 只用于「哪一个 session 已经收了」这一个判断, **不是**盘中时段表 —— 盘中时段还要午休段,
 * 那是另一件事, **唯一落点是 `market-session.rules.ts`** (060 T001 下沉合并; 在那之前它只以
 * `cn` 一条内联在 `alert/intraday-eval.processor.ts` 里, 本注释原先写的是「归各消费方」)。
 * ⇒ 要判盘中去那儿, **别在这里长出第三份时段表**。
 */
const MARKET_CLOSE_MINUTES: Record<string, number> = {
  cn: 15 * 60,
  hk: 16 * 60,
  us: 16 * 60,
};

/** 未登记市场的兜底: 与 {@link DEFAULT_TIME_ZONE} 配套, 取较晚的 16:00 (偏保守 → 少判陈旧)。 */
const DEFAULT_CLOSE_MINUTES = 16 * 60;

/**
 * **已收盘 session 的日期上界** (`YYYY-MM-DD`, 市场当地日历日): 当地时间已过收盘 ⇒ 今天,
 * 否则 ⇒ 昨天。调用方拿它去 `trading_day` 取 `≤ cutoff` 的**最大交易日** = 「最近一个已收盘
 * 交易日」(本函数自己不碰日历, 保持纯函数可测)。
 *
 * 🚨 **为什么必须带收盘时刻, 不能只用「严格早于当地今天」**: 那样定义的话, 北京周四上午
 * (= ET 周三 21:00, 周三早已收盘) 算出的上界是**周二** —— 昨夜同步失败、数据还停在周二时
 * 会被判成「正常」, 而那恰恰是 FR-020 要抓的「停在上一交易日」。带收盘时刻后上界是周三,
 * 缺周三的数据立刻显陈旧。
 *
 * ⚠️ 代价: 从收盘到夜间管线落库之间 (us 约北京 04:00–06:00) 会短暂判陈旧。那是**事实**
 * (最新一场确实还没入库), 且落在境内用户的睡眠时段, 不做特判。
 *
 * 复杂度 O(1)。
 */
export function lastClosedSessionCutoff(market: string, now: Date): string {
  const { date, minutesOfDay } = timeInTimeZone(now, MARKET_TIME_ZONE[market] ?? DEFAULT_TIME_ZONE);
  if (minutesOfDay >= (MARKET_CLOSE_MINUTES[market] ?? DEFAULT_CLOSE_MINUTES)) return date;
  return previousCalendarDay(date);
}

/**
 * `sessionDate` 那一场**收盘了吗** —— 「此刻能不能以收盘口径 (`source='eod'`) 往这一天落库」。
 *
 * 算式就是 {@link lastClosedSessionCutoff} 的一次比较 (`YYYY-MM-DD` 字典序 = 时序)。单独起名
 * 是因为**它是一条前置条件而不是一个日期**: 调用点要问的是「现在能写这一天吗」, 不是「最近收了
 * 哪一天」。同一个算式、两种语义, 混用会让调用点读起来像在取日期。
 *
 * 🚨 **为什么需要它 (2026-08-17 prod 实撞)**: 采集维度的业务日走 {@link marketDateFor} ——
 * 市场时区的**日历日**, 里面不含「这一场收没收」。三条定时入口 (夜间轮 06:30 / 当日重试 08:00 /
 * 盘前兜底 18:00, 均 Asia/Shanghai) 的正确性**全寄存在 cron 时刻里, 代码从未断言过**; 而 CLI
 * (`marketdata-trigger` / `marketdata-backfill`) 是第四个入口, 时刻由敲命令的人决定。开盘前跑
 * `option_daily_snapshot` ⇒ 行盖当日日戳、装的却是上一场的价; 又因该表落库是
 * `createMany(skipDuplicates)` (键 `(contract_id, session_date, source)`) ⇒ **当晚真收盘那轮
 * 被静默挡掉**, 而完整性探针只核逐合约覆盖率 (行在 = 覆盖满) **照样绿**。
 * ⇒ 把那条隐式前提变成一句显式断言。
 *
 * 🚫 **MUST NOT 拿它当「是不是交易日」用** —— 它只回答「过没过收盘时刻」: 周六 ET 18:30 判周六
 * 同样返 `true`, 而周六根本没有 session。交易日判定归 `trading_day` / {@link isTradingDayGateOpen},
 * 两件事分开。本函数也**刻意不碰日历** —— 那张表停摆过 (044), 让它参与判断等于把「日历坏了」
 * 升级成「连补采都做不了」。
 *
 * 复杂度 O(1)。
 */
export function isSessionClosed(market: string, sessionDate: string, now: Date): boolean {
  return sessionDate <= lastClosedSessionCutoff(market, now);
}

/** `YYYY-MM-DD` 减一个**日历日** (纯字符串日期运算, 与任何时区无关)。 */
function previousCalendarDay(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// 剩余期限 (DTE) —— 047 T006a
// ─────────────────────────────────────────────────────────────────────────────

/** 一个日历日的毫秒数。**只在 UTC 午夜之间做减法**时成立 (UTC 无 DST), 故下方一律先换算到 UTC。 */
const MS_PER_CALENDAR_DAY = 86_400_000;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 期权到期日所属市场 —— 本片全为美股期权 (047 T003 三个维度 `market_scope={us}`)。
 *
 * 🚫 **MUST NOT 做成带默认值的可选入参**: `marketDateFor([])` 会静默落回宿主口径
 * (`Asia/Shanghai`), 而"悄悄用了宿主日期"正是本函数存在的理由。将来真接入他所期权时,
 * 加一个**必填**参数, 让每个调用点显式声明是哪个交易所。
 */
const OPTION_EXCHANGE_SCOPE = ['us'];

export interface DaysToExpiryInput {
  /**
   * 合约到期日。接受 Prisma `@db.Date` 读出的 `Date` (恒为 UTC 午夜) 或 `YYYY-MM-DD` 字符串。
   * 传带时间的绝对时刻会**抛** —— 见 {@link daysToExpiry} 的第 3 条纪律。
   */
  expiry: Date | string;
  /**
   * **请求时刻** (绝对时刻, 通常就是 `new Date()`)。
   *
   * 🚨 蓄意收的是 instant 而**不是**一个算好的 `today` 字符串: 后者等于把"跟谁的今天"这个
   * 判断推回给调用方, 于是每个调用点各自发挥 —— 正是本函数要消灭的形态。
   */
  now: Date;
}

/**
 * 请求时的**剩余日历天数 (DTE)**。canonical 口径见
 * `docs/conventions/cross-timezone-date-semantics.md` §3 (「今天」归属表) + §4 (剩余期限)。
 *
 * 三条纪律, 每条都对应一种**不会报错、只让数字悄悄差一天**的塌法:
 *
 * 1. **基准 = 交易所的今天** (`marketDateFor(['us'], now)`), 不是宿主本地日期。北京上午
 *    = ET 前一日晚 ⇒ 取宿主日期会让 DTE **恒偏 1 天**, 而 DTE 是两个意图 Tab 的带判据
 *    (建仓腿 `DTE ≤ 14` / 收租腿 `DTE ∈ [150,365]`) 与 FR-048 的豁免线 (`DTE ≤ 2`),
 *    偏一天 = 边界腿静默进出带。
 * 2. **整数日历日, 含周末与节假日**; 到期日当天 = 0, 已过期为负 (🚫 不 clamp 到 0 —— 0 已被
 *    "当天到期"占用)。🚫 **禁用绝对时刻差**: 会得小数, 让 `≤ N 天` 这类带判据在一天之内抖,
 *    且跨 DST 的窗口不是 24h 的整数倍 (73 小时的窗会算成 3.04 天)。
 * 3. **到期日只接受"日期"**, 不接受带时间的绝对时刻 —— canonical §3 那个"同一个函数身兼两职"
 *    的陷阱 (拿 `@db.Date` 归一化是对的, 拿 `new Date()` 求今天是错的) 在此处被签名挡住。
 *
 * 🚨 **允许并要求一处口径错配 —— 这是有意为之, 不是 bug, 🚫 不要"修"它**: 同屏的价格来自
 * **上一场 session** 的 EOD 快照, 而 DTE 从**当前** ET 日期起算, 两者不同基准。决策是前瞻的
 * ("我今天挂这张单还要扛多少天风险"), 改成按快照日起算会**系统性多算一天**。代价是同屏必须有
 * 显式 `asOf` 让人看得见价格的时点 (FR-041 / 快照行另有独立的 `oi_as_of`)。
 *
 * 复杂度 O(1)。
 */
export function daysToExpiry({ expiry, now }: DaysToExpiryInput): number {
  const today = marketDateFor(OPTION_EXCHANGE_SCOPE, now);
  return utcEpochDay(expiryDateOnly(expiry)) - utcEpochDay(today);
}

/** `@db.Date` 的 Date (UTC 午夜) → `YYYY-MM-DD`; 带时间的绝对时刻直接拒。 */
function expiryDateOnly(expiry: Date | string): string {
  if (typeof expiry === 'string') {
    return expiry;
  }
  // NaN (Invalid Date) 与任何非 UTC 午夜时刻都落这里。
  if (expiry.getTime() % MS_PER_CALENDAR_DAY !== 0) {
    throw new Error(
      `[trading-day] 到期日必须是**日期** (\`YYYY-MM-DD\` 或 \`@db.Date\` 读出的 UTC 午夜 Date), ` +
        `实得带时间的绝对时刻 ${expiry.toISOString?.() ?? String(expiry)}; ` +
        `拿绝对时刻当到期日会把"谁的日期"这个判断推给宿主时区`,
    );
  }
  return expiry.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → 自 epoch 起的整数日序 (UTC 午夜锚点, 故减法恒为整数日, DST 不参与)。 */
function utcEpochDay(dateOnly: string): number {
  const parts = DATE_ONLY_PATTERN.exec(dateOnly);
  const ms = parts
    ? Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : Number.NaN;
  // 🚨 回写比对: `Date.UTC` 把溢出日**静默滚进下个月** (2026-02-30 → 2026-03-02), 不回比就是
  // 一个不报错的两天误差。
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== dateOnly) {
    throw new Error(`[trading-day] 不是合法的 YYYY-MM-DD 日期: ${JSON.stringify(dateOnly)}`);
  }
  return ms / MS_PER_CALENDAR_DAY;
}
