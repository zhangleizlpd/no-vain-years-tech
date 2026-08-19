/**
 * **纯时钟层** —— 「此刻在交易所当地是几号」与「哪一场已经收了」的**唯一**落点
 * (063 Phase 1, ADR-0066)。纯函数、无 I/O、无 DI (ADR-0043 §4)、**不碰交易日历**。
 *
 * ## 四条时间轴 (ADR-0066)，本文件只管其中一条半
 *
 * | 轴 | 问的问题 | 载体 |
 * | --- | --- | --- |
 * | **event time** | 这条数据描述的是哪一场交易 | `session_date` / `trade_date` (`@db.Date`) ← **本文件** |
 * | **ingestion time** | 我们什么时候拿到它 | `quote_as_of` / `intraday_at` (`timestamptz`) |
 * | **processing time** | 跑批的墙钟 | `sync_run.started_at` / `sync_dimension.last_watermark` |
 * | **vintage** | 这个值是第几版 | (尚未建轴) |
 *
 * 🚨 **`sessionWatermark` 与 `sync_dimension.last_watermark` 是两条不同的轴, 名字撞了**:
 * 前者是 **event-time 水位**(「事件时间已推进到哪一场」, 业内 watermark 的原义); 后者是
 * **processing-time 水位**(「上一轮跑到几点」, 除权命中检查的窗口起点)。读代码时别混。
 *
 * ## 🚨 本文件刻意**不查日历**
 *
 * `trading_day` 那张表停摆过 (044)。让它参与「这一场收没收」的判断, 等于把「日历坏了」升级成
 * 「连补采都做不了」。⇒ 本层只用**时钟**给出一个**永远保守**的答案:
 * 真收盘早于登记值时 (半日市) 水位回退一天 —— **少采一场, 绝不写半根**。
 * 需要「最近一个已收盘**交易日**」时, 拿本层的水位去 `trading_day` 取 `≤ 水位` 的最大交易日
 * (见 `TradingCalendarPort.lastClosedSession`), 日历不可用则**回落到本层结果**。
 */

/**
 * market → 该市场**定业务日期所用的时区** (IANA)。
 *
 * 🚨 这不是「服务器在哪」或「用户在哪」, 是**交易所在哪** —— 业内通行口径: 证券数据按
 * exchange time zone 打戳、日线按其在**本所**收盘的时刻定日 (QuantConnect / TradingHours;
 * FIX 的 `TradeDate` / `ClearingBusinessDate` 同源)。此前全局用 `shanghaiToday` 相当于把
 * 「跑批的墙上时钟」当业务日期 —— 对 cn/hk 恰好相等所以一直没暴露, 对 us 直接塌
 * (失败形态表见 {@link exchangeCalendarDate})。
 *
 * 🚨 **必须是 IANA 名, 不能是固定偏移**: 偏移是快照, IANA 名是规则 (含 DST 与历史/未来变更)。
 * 只有 `us` 有 DST; cn/hk 恒 UTC+8 ⇒ 两者**恒同日**, 而「恰好相等」不是「可以推导」。
 */
const EXCHANGE_TIME_ZONE: Record<string, string> = {
  cn: 'Asia/Shanghai',
  hk: 'Asia/Hong_Kong',
  us: 'America/New_York',
};

/** `marketScope` 为空 (meta 维度如 universe/profile) 或市场未登记时的兜底 —— 保持既有宿主口径。 */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/**
 * market → 该市场**常规交易时段收盘时刻** (当地时区的当日分钟数)。
 *
 * 只用于「哪一个 session 已经收了」这一个判断, **不是**盘中时段表 —— 盘中时段还要午休段,
 * 那是另一件事, **唯一落点是 `market-session.rules.ts`**。⇒ 要判盘中去那儿,
 * **别在这里长出第三份时段表**。
 *
 * ⚠️ **半日市尚未建模** (063 Phase 2 的工作): NYSE 感恩节次日 / 平安夜 13:00 ET 收
 * (期权 13:15)、HKEX 平安夜 12:00 HKT 收。取常规收盘值的偏差方向是**安全**的 ——
 * 真收了而这里说没收 ⇒ 水位回退一天 ⇒ 少采一场, 下一轮补上; 反向 (说收了其实没收) 不存在,
 * 因为没有任何市场的实际收盘晚于登记值 (us 盘后延长时段 16:00–20:00 ET 刻意不登记,
 * 且那一段不产生日 K)。
 */
const REGULAR_CLOSE_MINUTES: Record<string, number> = {
  cn: 15 * 60,
  hk: 16 * 60,
  us: 16 * 60,
};

/** 未登记市场的兜底: 与 {@link DEFAULT_TIME_ZONE} 配套, 取较晚的 16:00 (偏保守 → 少判陈旧)。 */
const DEFAULT_CLOSE_MINUTES = 16 * 60;

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

/** `YYYY-MM-DD` 减一个**日历日** (纯字符串日期运算, 与任何时区无关)。 */
function previousCalendarDay(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 交易所当地的**日历日** (`YYYY-MM-DD`)。
 *
 * 🚨 **它不回答「这一场收了没有」** —— 那是 {@link sessionWatermark}。拿本函数当采集业务日
 * 用, 就是 #103 的病灶: 盘中触发 ⇒ 拿到一根**尚未收盘**的日 K (富途会返「进行中」的 K 线,
 * 理杏仁返空数组 —— 所以同一个错只在 us 显形), 落库即半根, 且写路径 `skipDuplicates`
 * 让它**永久驻留**。
 *
 * 合法用途只有两类: ① 交易日闸「今天开不开市」(省配额, 与写哪一天正交);
 * ② 前瞻派生量的基准 (DTE —— 「我今天挂这张单还要扛多少天」, 见 `daysToExpiry`)。
 *
 * 🚨 **为什么不能全局用一个 `userToday`** —— us 的收盘 (16:00 ET) 落在北京**次日凌晨**,
 * 故 us 维度只能排在北京清晨, 而那一刻宿主日期已经翻到下一天:
 *
 * | 北京时刻 | 刚收盘的 US session | 全局宿主日 | 后果 |
 * | --- | --- | --- | --- |
 * | 周二 06:00 | 周一 ET | 周二 | 拿到周一的 bar 却标成周二 → **日期错位一天**, 幂等判据随之失效 |
 * | **周六 06:00** | **周五 ET** | 周六 | 交易日闸判「周六非 us 交易日」→ 短路 → 🚨 **周五的 bar 永远采不到** |
 * | 周一 06:00 | (无) | 周一 | 白跑 —— 美股周一尚未开盘 |
 *
 * 换算到 `America/New_York` 后三行全部自洽, 且 **DST 无需特判** (Intl 处理): 北京 06:00 在
 * 夏令 = 前一日 18:00 EDT、冬令 = 前一日 17:00 EST, 两者都在 16:00 收盘之后。
 *
 * 复杂度 O(1)。
 */
export function exchangeCalendarDate(market: string, now: Date): string {
  return dateInTimeZone(now, EXCHANGE_TIME_ZONE[market] ?? DEFAULT_TIME_ZONE);
}

/**
 * 一个 `marketScope` 的**共同**日历日。
 *
 * ⚠️ **scope 内各市场必须落在同一业务日** —— 否则没有单一「今天」可言, 直接抛。这同时把
 * 「别往 cn/hk 维度里掺 us」那条散文约定变成机器强制 (混进去还会踩另一个坑: tick payload
 * 无 `markets` 字段 ⇒ 工作集恒为全 scope, 只有 us 开市的日子会对全部 cn+hk 标的发请求)。
 *
 * 🚨 **判据是「算出来的日期相同」, 不是「时区字符串相同」**: `cn`(Asia/Shanghai) 与
 * `hk`(Asia/Hong_Kong) 是两个不同的 IANA 名字但恒为 UTC+8 且均无 DST —— 现役 `eod_bar`
 * 维度的 scope 就是 `{cn,hk}`, 按字符串比会在生产直接抛。比日期才是真正要守的不变量。
 *
 * 复杂度 O(scope 长度)。
 */
export function exchangeCalendarDateForScope(marketScope: readonly string[], now: Date): string {
  const byMarket = marketScope.map((m) => [m, exchangeCalendarDate(m, now)] as const);
  const distinct = new Set(byMarket.map(([, date]) => date));
  if (distinct.size > 1) {
    throw new Error(
      `[session-clock] marketScope 跨时区无单一业务日期: ` +
        `${byMarket.map(([m, d]) => `${m}=${d}`).join(' / ')}; ` +
        `拆成各自的维度 (混 scope 还会让工作集恒为全 scope)`,
    );
  }
  return byMarket.length > 0 ? byMarket[0][1] : dateInTimeZone(now, DEFAULT_TIME_ZONE);
}

/**
 * **event-time 水位**: 该市场**已收盘 session 的日期上界** (`YYYY-MM-DD`, 交易所当地日历日)。
 * 当地时间已过常规收盘 ⇒ 今天, 否则 ⇒ 昨天。
 *
 * 业内把这个概念叫 **watermark**(「事件时间已推进到 t」)。本函数是**纯时钟**的那一半:
 * 它给出的可能是个非交易日 (周六 ET 18:00 → 周六)。要「最近一个已收盘**交易日**」, 拿它去
 * `trading_day` 取 `≤ 上界` 的最大交易日 (`TradingCalendarPort.lastClosedSession`)。
 *
 * 🚨 **为什么必须带收盘时刻, 不能只用「严格早于当地今天」**: 那样定义的话, 北京周四上午
 * (= ET 周三 21:00, 周三早已收盘) 算出的上界是**周二** —— 昨夜同步失败、数据还停在周二时
 * 会被判成「正常」, 而那恰恰是「停在上一交易日」要抓的。带收盘时刻后上界是周三,
 * 缺周三的数据立刻显陈旧。
 *
 * ⚠️ 代价: 从收盘到夜间管线落库之间 (us 约北京 04:00–06:00) 会短暂判陈旧。那是**事实**
 * (最新一场确实还没入库), 且落在境内用户的睡眠时段, 不做特判。
 *
 * 复杂度 O(1)。
 */
export function sessionWatermark(market: string, now: Date): string {
  const { date, minutesOfDay } = timeInTimeZone(
    now,
    EXCHANGE_TIME_ZONE[market] ?? DEFAULT_TIME_ZONE,
  );
  if (minutesOfDay >= (REGULAR_CLOSE_MINUTES[market] ?? DEFAULT_CLOSE_MINUTES)) return date;
  return previousCalendarDay(date);
}

/**
 * 一个 `marketScope` 的水位, 取 scope 内**最早**的那个 (= 最严)。
 *
 * 🚨 **极性与 {@link exchangeCalendarDateForScope} 刻意相反 —— 跨时区 scope 不抛**:
 * 「同一业务日」是日历日口径的**前提**(否则没有单一「今天」可言); 而水位问的是「哪一场收了」,
 * 多市场取最严**恒有意义**。现役 `eod_bar` 的 `{cn,hk}` 在北京 15:30 就会分岔 (cn 已收、
 * hk 未收), 取 min ⇒ 落到 hk 的前一日, 宁可少采一场也不写半根。判据与
 * `manual-sync-session-guard` 的「多市场取最严」同源。
 *
 * 复杂度 O(scope 长度)。
 */
export function sessionWatermarkForScope(marketScope: readonly string[], now: Date): string {
  if (marketScope.length === 0) return sessionWatermark('', now);
  // `YYYY-MM-DD` 字典序 = 时序 ⇒ 直接取字符串最小值, 无需转 Date。
  return marketScope.map((m) => sessionWatermark(m, now)).reduce((a, b) => (a <= b ? a : b));
}

/**
 * `sessionDate` 那一场**收盘了吗** —— 「此刻能不能以收盘口径 (`source='eod'`) 往这一天落库」。
 *
 * 算式就是 {@link sessionWatermark} 的一次比较 (`YYYY-MM-DD` 字典序 = 时序)。单独起名
 * 是因为**它是一条前置条件而不是一个日期**: 调用点要问的是「现在能写这一天吗」, 不是「最近收了
 * 哪一天」。同一个算式、两种语义, 混用会让调用点读起来像在取日期。
 *
 * 🚨 **为什么需要它 (2026-08-17 prod 实撞)**: 开盘前跑 `option_daily_snapshot` ⇒ 行盖当日日戳、
 * 装的却是上一场的价; 又因该表落库是 `createMany(skipDuplicates)` (键
 * `(contract_id, session_date, source)`) ⇒ **当晚真收盘那轮被静默挡掉**, 而完整性探针只核逐
 * 合约覆盖率 (行在 = 覆盖满) **照样绿**。
 *
 * 🚫 **MUST NOT 拿它当「是不是交易日」用** —— 它只回答「过没过收盘时刻」: 周六 ET 18:30 判周六
 * 同样返 `true`, 而周六根本没有 session。交易日判定归 `trading_day` / `isTradingDayGateOpen`,
 * 两件事分开。
 *
 * 复杂度 O(1)。
 */
export function isSessionComplete(market: string, sessionDate: string, now: Date): boolean {
  return sessionDate <= sessionWatermark(market, now);
}

/**
 * **用户所在地**的今天 (`YYYY-MM-DD`)。
 *
 * 🚨 只用于**人工节奏** (复审到期 / 待办逾期 / 提醒排期) —— 「你什么时候坐下来做这件事」,
 * 与市场无关。🚫 **MUST NOT 当业务日期用**: 那正是两条 CLI 的 `asOf` 兜底踩过的坑
 * (对 us 维度错位一天且每周固定丢周五)。
 *
 * 当前用户群全在境内 ⇒ 值域固定 `Asia/Shanghai`。将来真要按账号时区走时, 改这一处
 * (加必填的 tz 入参), 而不是让每个调用点各自 `new Date()`。
 */
export function userToday(now: Date): string {
  return dateInTimeZone(now, DEFAULT_TIME_ZONE);
}
