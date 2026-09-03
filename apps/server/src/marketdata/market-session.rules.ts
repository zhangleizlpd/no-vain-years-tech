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
  // 两段 [09:30,12:00] + [13:00,16:00] HKT —— **午休 (12:00–13:00) 显式建模** (071 FR-017,
  // 2026-08-31 由单段恢复; 沿革见下)。
  //
  // 🚨🚨 **本行服务两种语义, 它们对午休的答案相反 —— 加消费方之前先认清你问的是哪一个:**
  //
  // · 「**这一场收了没有**」({@link isSessionUnderway}, 补数闸)。它经 `spanOf` 取
  //   min(开盘)/max(收盘) ⇒ 两段与单段同为 09:30/16:00 ⇒ **取值逐点不变**: 午休仍算场内,
  //   冷启动在午休照样 `intraday_skipped`、不写快照。**FR-011 原样成立。**
  //
  // · 「**此刻能不能成交**」({@link isWithinTradingSession})。午休不能成交 ⇒ 两段化后它在
  //   午休返 `false` —— 这才是对的答案; 单段化时它返 `true`, 对这一类消费方是错的。
  //
  // ## 沿革: 当初为什么合, 现在为什么拆回来 (071 FR-018)
  //
  // 2026-08-18 合并成单段时给了三条支撑句, 到 2026-08-31 **只剩一条成立**:
  //   ① 「趁 hk 期权尚未开通落地」—— **已过期**: 066 已 ship 港股期权采集 (链发现 + 逐日快照
  //      + 标的 IV 三个维度在 prod 跑);
  //   ② 「hk 期权采集仍未开通 (`COLD_START_CAPABILITY` 里 hk 是空表项)」—— **现已为假**:
  //      `anchor-cold-start.rules.ts` 里 hk 是 `{ optionChain: true, optionSnapshot: true }`;
  //   ③ 「`isWithinTradingSession` 唯一生产调用方钉死 `cn`」—— **仍成立**
  //      (`alert/intraday-eval.processor.ts` 的 `INTRADAY_MARKET = 'cn'`)。
  // ⇒ 拆回来在今天**仍是零生产行为变化**, 但把 ③ 那个「唯一调用方」从一道运气变成一道余量。
  //
  // 🚨 **复审触发条件已扩宽** (071 FR-018)。原措辞是「将来给 hk 接盘中告警时」—— **太窄**,
  // 它把读端这类消费方漏在外面 (071 的港股实时选约表就是一个: 它要判「此刻能不能成交」,
  // 却既不是告警也不是补数)。现在的条件是: **任何需要判「此刻能不能成交」的港股消费方**
  // —— 接它之前回到本注释确认你拿的是哪个谓词。
  //
  // 📌 午休的**供应方字面量**已由 071 T001 实测坐实 (2026-08-31, 13 拍网格): 12:01–12:59
  //   逐拍 `REST`, 11:55 仍 `MORNING`、13:01 已 `AFTERNOON`, 与本行的 12:00 / 13:00 逐值一致。
  //   ⚠️ 但**实时档的闸读的是供应方状态、不读本表** (071 FR-019: 期权台 MUST NOT import 本
  //   文件, `eslint.config.mjs` 的 `from: optionsdesk` disallow 会直接撞墙; 就算能过也是第二份
  //   「能不能成交」判据)。⇒ 本行两段化对那条路径**零影响**, 它修的是本表自己的语义债。
  // ── 🚨 本行取值已按 HKEX 官方核实 (2026-08-23), 不是照搬正股口径的默认值 ──
  //
  // 核实对象 = **单只股票期权** (Stock Options), 逐项与本行吻合、无需修正:
  // · 早市 09:30–12:00 + 午市 13:00–16:00 ⇒ 整场跨度 09:30/16:00, 同 `segments`;
  // · 半日市 12:00 收 (只开上午), 同 `halfDaySegments`;
  // · **无** AHT / T+1 盘后段, **无**竞价段 ⇒ 本表不登记它们是对的;
  // · 被排除在「衍生品假日交易」(DHT, 2022-05-09 起) 之外, 属 Non-Holiday Trading Exchange
  //   Contracts ⇒ **期权交易日历 = 正股交易日历**, `todayIsTradingDay` 走现有 hk 日历即可。
  // 源: HKEX 的 Stock Options FAQ / Derivatives Market Trading Hours / After-Hours Trading /
  //     Trading Calendar and Holiday Schedule 四页互相印证。
  //
  // ⇒ 港股**不存在** us 那格的「股票 13:00 / 期权 13:15」分叉 (见上方 us 的 `halfDaySegments`
  //   注释)。那道题在这里问过了, 答案是「同开同收」—— 别再重查一遍。
  //
  // 🚨🚨 **以上仅对单只股票期权成立。要做指数期权 (HSI / HHI) 时三条全部翻转:**
  //   ① 有 AHT: 17:00 – 次日 03:00 ⇒ 本行的 16:00 收盘会在盘后段判「已收盘」而写脏快照;
  //   ② 在 DHT 名单内 ⇒ 公众假期照常交易, 而正股日历那天是 non-trading;
  //   ③ ⇒ 交易日历与正股**分叉**, 不能再共用 hk 这一份。
  //   届时 MUST 把 hk 拆成「股票期权 / 指数期权」两份登记, 别让两类产品共用本行 ——
  //   三个维度会同时错, 且与 us 那格同款: **静默写脏数据, 不报错**。
  hk: {
    timeZone: 'Asia/Hong_Kong',
    segments: [
      [9 * 60 + 30, 12 * 60],
      [13 * 60, 16 * 60],
    ],
    // 半日市 = **只开上午** (12:00 HKT 收, 无下午段) —— 与上面「午休蓄意不建模」正交:
    // 那条合并的是 12:00–13:00 这个**休息**段, 而半日市当天 12:00 之后根本没有下午场。
    halfDaySegments: [[9 * 60 + 30, 12 * 60]],
  },
};

/**
 * market → **该市场的未平仓合约数当天几点定稿**（当地当日分钟数）；`null` = 不在收盘当晚定稿
 * （沿用隔日口径）。066 T09 建表, `FR-016`。
 *
 * 🚨 **这是清算侧的事实, 与上面那张连续竞价时段表是两件事** —— 刻意分表, 别折进
 * {@link MARKET_SESSION}: 时段表答「什么时候在交易」, 本表答「什么时候能拿到定稿的 OI」,
 * 两者由不同机构按不同节奏决定, 合表会让下一个加市场的人以为填了时段就填全了。
 *
 * | 市场 | 值 | 依据 |
 * | --- | --- | --- |
 * | `us` | `null` | 清算所 T+1 才发布 ⇒ 收盘当晚抓到的 OI 属于**上一场** |
 * | `hk` | `21:30` | **2026-08-25 U2 实测** (见 `specs/066-hk-option-cold-start/spec.md` 的 Clarifications) |
 * | `cn` | `null` | 期权采集尚未开通; **保守取 null** —— 见下 |
 *
 * 📌 **`hk` 那条的实测形态**: 30 只合约 12 拍 360 行里 OI 只变动过一次, 落在 D 日
 * **16:30 之后、21:30 之前** (24/30 只变); 跨 22:00 日终那一拍 0/30, 次日盘前 0/30。
 * ⇒ 定稿早于日终, 而 `hk_option_daily_snapshot` 跑在 23:30, **落在定稿之后**。
 * 取窗口的**上界** 21:30 而非下界 16:30: 实测只能把定稿时刻夹在这两点之间, 取下界等于赌
 * 「一变完就到」, 而赌错的方向正是下面那条 fail-safe 要挡的那一侧。
 *
 * ## 🚨 登记的是**当地绝对时刻**, 不是「收盘后 N 分钟」
 *
 * 两条理由缺一不可:
 * ① 清算所的日终处理跑的是**墙钟排程**, 不跟着收盘走 —— 表达成收盘偏移量, 语义从一开始就错;
 * ② 偏移量会在**半日市**当天自动推出一个没人实测过的时刻 (hk 半日市 12:00 收, +5.5h = 17:30)。
 *    绝对时刻则天然与 `kind` 正交 —— 半日市当天 21:30 仍是 21:30。
 *
 * ## 🚨 定稿是**时刻**, 不是市场的静态属性 (#194 后续)
 *
 * 本表原为 `MARKET_OI_REFRESHED_AT_EOD: Record<string, boolean>`, 判据只问「这个市场当晚定稿
 * 吗」。那个形状对**夜间 cron** 成立 (hk 跑 23:30, 恒在定稿之后), 对**事件驱动**路径不成立:
 * 锚首建冷启动由用户行为触发, 落在 D 日 16:00–21:30 之间时, 端点返的仍是 **D−1 的 OI**, 而
 * 静态判据照样把它标成 D ⇒ 数字与标签**双错**, 且 `createMany(skipDuplicates)` 会让当晚 23:30
 * 那轮**正确的**写入被静默跳过 —— 那一场的 OI 从此拿不回来 (供应方不提供历史快照, 出处见
 * `option-snapshot.port.ts`)。
 * 066 spec 的实测结论只把推论走到了 cron 那条路; 本表补上第二条。
 *
 * 🚨 **`null` 是刻意的 fail-safe, 不是省事**: 猜「已定稿」而实际是 T+1 ⇒ 把上一场的 OI 标成
 * 当天的, 数字与标签**双错**且不报错; 猜「未定稿」而实际已定稿 ⇒ 只是标签保守偏早, 一条确定性
 * `UPDATE` 可订正 (与 `FR-016` 判不对称性的方向同源)。⇒ **没实测过的市场一律 `null`。**
 *
 * 🚫 **MUST NOT 拿它去改 `source`** (`eod` / `premarket_backfill`)。那个标签答的是「这批
 * 快照捕捉的是**哪一场**的收盘」, 与 OI 归属是正交的两件事 —— 混用会让「D 日盘后采的」被
 * 标成「次日盘前补的」, 而覆盖率与补采审计都读 `source`。
 *
 * ⚠️ **沿革留痕**: migration `20260825_1910_relabel_hk_option_oi_as_of` 的注释里那句「与
 * `market-session.rules.ts` 的 `MARKET_OI_REFRESHED_AT_EOD` 是同一个判断的两处表达」引用的是
 * **本表的旧名**。该 migration 已应用, 改它的注释会炸 Prisma checksum ⇒ 刻意不动; 从那句话
 * grep 过来的人落在这里。它说的那条纪律**依然成立**: 给别的市场填上非 `null` 时, MUST 同时
 * 补一条同形的清理 migration。
 *
 * 🚨 **本表的取值如今有第三处表达** (#262): `ops/jobs/marketdata-table-health.sql` 的判据 ⑫
 * 在 SQL 里复刻了 {@link oiRefreshedAtEod} 的三档判定 (`oi_zone` 那张 VALUES 表), 用来核对库里
 * 已经落下的 `oi_as_of` 标签。它**调不到本函数** —— 探针是纯 SELECT、跑在采集进程之外, 那正是
 * 它的存在理由 (FR-051)。⇒ **改本表 MUST 同步改那条判据**, 否则表现是「探针天天红而代码是对的」
 * 或反过来「探针绿而库里的标签已经漂了」, **两种都不报错**。
 */
const MARKET_OI_SETTLE_LOCAL_MINUTE: Record<string, number | null> = {
  cn: null,
  us: null,
  hk: 21 * 60 + 30,
};

/**
 * `sessionDate` 那一场的未平仓合约数, 在 `now` 这一刻**定稿了没有**。纯查表 + 一次时区折算,
 * 零 I/O。复杂度 O(1)。
 *
 * 三档判定, 顺序即优先级:
 * 1. 本表无值 (`null` / 未登记) ⇒ `false`, 沿用隔日口径;
 * 2. 该市场当地日期**已跨过** `sessionDate` ⇒ `true` —— 周末补采 (周六 10:00 补周五) 与
 *    #181 那种跨午夜的长链都落在这一档, 它们早已过了定稿时刻, 但当日分钟数**小于**定稿分钟,
 *    只比分钟数会把它们全判成「未定稿」;
 * 3. 同一天 ⇒ 比当日分钟数。
 *
 * 未登记市场返 `false` 而**不抛** —— 与 {@link marketNow} / {@link isSessionUnderway} 的
 * 「未登记即抛」**蓄意不同**: 那两个的返回值是判据, 静默套用别市场的时窗会写出错的行; 而本表
 * 的保守值 (`false` = 沿用隔日口径) 产出的偏差是**可订正的标签**, 不是脏数据。为一个 OI 标签
 * 把整轮采集炸掉, 方向反了 (同 `FR-016` 的不对称性)。⇒ 第 1 档的 `isSessionRegistered` 守卫
 * 不是冗余: 少了它, 「本表填了值但 {@link MARKET_SESSION} 没登记」这种配置错会从
 * {@link marketNow} 抛出去, 把上面那条不抛的契约破掉。
 */
export function oiRefreshedAtEod(market: string, sessionDate: string, now: Date): boolean {
  const settleMinute = MARKET_OI_SETTLE_LOCAL_MINUTE[market];
  if (settleMinute === undefined || settleMinute === null) return false;
  if (!isSessionRegistered(market)) return false;
  const { dateOnly, minutesOfDay } = marketNow(market, now);
  if (dateOnly !== sessionDate) return dateOnly > sessionDate;
  return minutesOfDay >= settleMinute;
}

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
 * 该市场**连续竞价**时段判定 (午休落在两段之间 ⇒ false)。复杂度 O(段数)。
 * 语义 =「**此刻能不能成交**」⇒ 预警 / 盘中触发这类判据用它。
 *
 * ## 🚨 区间约定 = **两端皆闭** `[from, to]`（业内的 `side="both"`），与
 * {@link isSessionUnderway} 的左闭右开**刻意不同**
 *
 * 不是疏漏, 是因为两者回答的是两个问题: 本谓词问「能不能成交」, 而**收盘集合竞价就在收盘
 * 那一刻成交**（cn 15:00 / hk 16:00 的收盘价正是它撮出来的）⇒ 端点必须算在内, 否则盘中预警
 * 会在最后一分钟静默失灵。而 {@link isSessionUnderway} 问「这一场收了没有」, 归属口径下收盘
 * 分钟属于**已收**（见那边的 `side` 论证）。
 *
 * 📌 业内把这个选择显式参数化（`exchange_calendars` 的 `side`）正是因为它有多个合理取值 ——
 * 同一份时段表, 不同消费方取不同侧是**正常的**, 不正常的是取了不同侧却没人写下来。
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
 * 该 `kind` 下生效的时段表。`unknown` / 该市场没登记 `halfDaySegments` (cn) 一律回落常规时段
 * —— **不为一个没有半日市的市场编一个出来**。
 *
 * 🚨 `kind` **必填**不可省 (063 Phase 2): 做成可选默认 `whole` 的话, 漏传的调用点会在半日市
 * 当天静默拿到「还在场内」⇒ 落终态不重试的 `intraday_skipped` ⇒ 那一场的快照**永久缺失**。
 * 让 TS 把每个调用点逼出来显式声明它知不知道 kind, 与 `daysToExpiry` 拒绝可选交易所入参同源。
 */
function segmentsFor(
  session: (typeof MARKET_SESSION)[string],
  kind: SessionKindStatus,
): readonly (readonly [number, number])[] {
  return kind === 'half' ? (session.halfDaySegments ?? session.segments) : session.segments;
}

/**
 * 取 min(开盘) / max(收盘) 而非 `segments[0]` / `at(-1)` —— 不把「登记时必须按时序排」这条
 * 隐式不变式压在加市场的人身上 (排错了不会红, 只会让午休那段悄悄漏出闸)。
 */
const spanOf = (
  segments: readonly (readonly [number, number])[],
): { open: number; close: number } => ({
  open: Math.min(...segments.map(([from]) => from)),
  close: Math.max(...segments.map(([, to]) => to)),
});

/**
 * 该市场该 `kind` 下的**收盘分钟**（当地当日分钟数）；未登记市场返 `undefined`。
 *
 * 🚨 **本函数存在的唯一理由是消灭第二份收盘时刻表**（#187 后续）。`session-clock.ts` 曾自持
 * 一份 `REGULAR_CLOSE_MINUTES` + `HALF_DAY_CLOSE_MINUTES`（cn 900 / hk 960 / us 960 +
 * hk-half 720 / us-half 795），与本表的 `max(to)` **逐点相同**，靠一句「改一处必改两处」的
 * 散文维系 —— 而 `check-time-semantics` 的 Rule A **同时豁免了这两个文件**，它们之间漂了
 * 门禁不会响。
 *
 * 漂了会怎样：假如有人把那边的 us 改成 16:15 而这边的 segments 没动 ⇒ 收盘后 15 分钟内
 * 「已收盘水位」说未收、「场内判定」说已收 ⇒ 写闸放行 + 归属指向上一场 ⇒ **把今天的盘口贴上
 * 昨天的标签写进库**。那正是 #181 的形状。现在它在类型层不可能发生。
 *
 * ⚠️ **未登记市场返 `undefined` 而不抛**，与 {@link isSessionUnderway} 的极性刻意不同:
 * 调用方 `session-clock.sessionWatermark` 对未登记市场有自己的 fail-open 兜底 (meta 维度的
 * 空 scope 依赖它), 在这里抛会把那条既有语义打断。
 *
 * 复杂度 O(段数)。
 */
export function sessionCloseMinutes(market: string, kind: SessionKindStatus): number | undefined {
  const session = MARKET_SESSION[market];
  if (session === undefined) return undefined;
  return spanOf(segmentsFor(session, kind)).close;
}

/**
 * 收盘后的**定稿缓冲**（分钟）—— 「这一场收了」到「它的收盘数据可以安全落库」之间的那段。
 *
 * ## 🚨 它此前是一个**伪装成区间端点的参数**
 *
 * {@link isSessionUnderway} 原本是闭区间 `[open, close]`，于是「收盘那一分钟不许写」这条行为
 * 是**闭区间的副作用**，而不是任何人做过的决定：它既没有名字、不能按市场调、也无法被证据替换。
 * 本常量把它拆出来命名，取值 **1 分钟 = 拆出来之前的等效值**，⇒ 行为逐点不变。
 *
 * ## 🚨 默认值 1 **不是研究结论**，是继承来的；`hk` 的 10 是
 *
 * 「vendor 会不会下发终局标记」已核实过一轮（2026-08-25），结论是**不会**，三层证据一致：
 * ① 实取 payload（`__fixtures__/hk-option-snapshot-00700-2026-08-23.json`，143 个字段）里与成熟度
 * 沾边的只有 `update_time` / `sec_status` / `suspension`，无 preliminary-final 之分；② 供应方
 * `get_market_snapshot` 官方文档同样无此字段；③ 066 U2 实测**已证伪**最像的那个候选 ——
 * `update_time` 在 16:30 与 21:30 两拍逐只完全相同，而 OI 在它不动的情况下变了（spec
 * `## Clarifications`）。⇒ tape trade qualifier 那条路在本供应方身上无处落地，**别再去找那个标记**。
 *
 * 但「没有真信号」不等于「1 是对的」。`hk` 的 10 来自**交易所公开规格**，不是墙钟猜测：
 * HKEX 收盘竞价（CAS）16:00 起，16:08–16:10 **随机**收市，撮合发生在随机收市之后，最终 IEP
 * 即当日收盘价 ⇒ **16:08 之前港股正股的官方收盘价根本不存在**。而本表的 `hk` 收盘登记在 16:00,
 * 取 buffer=1 时写闸 16:01 就放行 ⇒ 落库的 `underlying_spot` 是**竞价撮合前**的最后成交价,
 * 而它被 `option-anomaly.rules`（实值/虚值分类）、`option-snapshot-guard.rules`（硬门）、
 * `leg-retrieval.adapter`（选约表 spot）三处读。旁证在同一份 fixture 里: 标的行的 `update_time`
 * 是 `16:07:49`，不是 16:00。
 * 📌 半日市**同样成立**且同样是 10：CAS 整体平移到 12:00–12:10，而本函数按 market 取值、
 * 由调用方叠加在该 `kind` 的收盘分钟上 ⇒ 不必按 kind 再分叉。
 *
 * 🚫 **MUST NOT 把它调大来「稳一点」**：每多一分钟就是采集窗口少一分钟，而现役 cron 全部落在
 * 收盘后数小时 ⇒ 调大对正常路径零收益，只会让**事件驱动**路径（锚首建冷启动）更容易落
 * `intraday_skipped`（终态不重试）。要动它得先有那个市场的定稿证据 —— `hk` 那条给出的正是
 * 这种证据（交易所规格 + 实取旁证），`us` 至今**没有**（美股收盘竞价的官方价何时进到本供应方的
 * 快照里，没实测过）⇒ us 留在默认值上，别照着 hk 编一个。
 *
 * 🚨 **它管不了 OI** —— 那是清算侧的第二条时间线，由 {@link oiRefreshedAtEod} 单独回答。
 * 港股 OI 的定稿在 21:30（实测窗口上界），拿 buffer 去覆盖它意味着收盘后 5.5 小时不准写，
 * 那是拿「挡住写入」解决「标签说谎」，代价与病灶不匹配（2026-08-25 定案：允许冷启动立刻写一份
 * spot 偏早的行 —— `quote_as_of` 已如实记录采集时刻，偏差是**披露过的**；而 OI 标签没有任何
 * 列在披露它，故治标签、不挡写）。
 */
const DEFAULT_CLOSE_SETTLE_BUFFER_MINUTES = 1;

/** per-market 覆盖；缺项 ⇒ {@link DEFAULT_CLOSE_SETTLE_BUFFER_MINUTES}。依据见上方文档。 */
const CLOSE_SETTLE_BUFFER_MINUTES: Record<string, number> = {
  // HKEX CAS 16:08–16:10 随机收市，撮合在其后 ⇒ 官方收盘价最早 16:10 才存在。
  hk: 10,
  // 🚨 **Nasdaq NOCP 在收盘后 15 分钟才由 network processor 正式下发**为官方 Consolidated
  // Last Sale Price（Nasdaq《Opening and Closing Crosses》FAQ）。Closing Cross 本身 16:00 ET
  // 执行、价格即时打印，NYSE 侧同样是 16:00 单笔撮合带 sale condition 8「Closing Prints」即时
  // 上带 ⇒ **16:15 那一步改的是「官方性」不是价**，故 15 分钟是带余量的、不是卡在边界上。
  //
  // ⚠️ 这条与 `hk` 的 10 是**同一档证据**（都出自交易所公开规格），但 `hk` 另有一份 fixture
  // 旁证（标的行 `update_time` = 16:07:49），**`us` 没有** —— 它测的是「交易所何时下发」，
  // 不是「本供应方的快照何时反映」。那段残留缺口目前由「价在 16:00 就定了」这条性质兜着；
  // 真要收口得实取一轮 ET 16:01/16:05/16:15/16:30 的 `last_price` 做对照。
  us: 15,
};

/** 该市场的定稿缓冲分钟数。复杂度 O(1)。 */
export function closeSettleBufferMinutes(market: string): number {
  return CLOSE_SETTLE_BUFFER_MINUTES[market] ?? DEFAULT_CLOSE_SETTLE_BUFFER_MINUTES;
}

/**
 * 收盘后**盘口台阶**的上界（该市场当地绝对分钟）—— 过了它，做市商的报价档位已经掉到下一级
 * 台阶上，同一批腿的有买价比例阶跃式下滑。
 *
 * ## 🚨 它是**样本期结论**，不是物理常数
 *
 * 样本期 = **2026-08-31 一个交易日 × 3 个标的**（全链 3463 条腿，盘后 20 格）。实测盘口是
 * **阶梯式**撤走的、台阶内逐格数值完全相同；按仓内正规收租召回口径，收盘后 0–30 分钟有买价
 * 比例 **88.5%**，收盘后 45 分钟–2 小时掉到 **59.9%**。断点的确切分钟**落在采样盲区**
 * `(16:30, 16:45)`（网格 15 分钟看不见）⇒ 本表取的是**实测仍好的最后一格 16:30**。
 *
 * ## 🚨 取盲区的**下界**，与 {@link oiRefreshedAtEod} 那张表刻意相反
 *
 * 那张表取实测窗口的**上界**，因为它猜错的方向是「把上一场的 OI 标成当天的」= 数字与标签
 * 双错且不可回补；本表猜错的方向只是**告警早报**（假红，可判读）。反过来取 16:45 等于把一个
 * **实测已坏**的档位当成上界，而漏报的形态正是 FR-022 存在的理由 —— 数据照采、覆盖率照绿，
 * 只有带内腿有价率悄悄退回改动前，**没有任何东西会变红**。
 * ⇒ 两处共同的纪律不是「取上界」，而是「取值方向选**猜错也不产生静默错误**的那一侧」。
 *
 * ## 🚨 重标条件（写在明处，否则下一个人不知道它能不能动）
 *
 * ① 073 T012 的补样本（09-02 / 09-03 / **09-04 到期周**）把断点夹进更窄的区间 ⇒ 按新的
 *    「实测仍好的最后一格」重标；② 供应方 / 做市商的盘后撤单行为变化（换 vendor、HKEX 改
 *    规则）⇒ 整条曲线重测，别微调一个数。
 *
 * 🚫 **MUST NOT 因为「告警太吵」把它往后调** —— 吵是结论不是噪声。稳态抓价时刻落在
 * 16:28.6（16:20 触发 + 实测 519s / 28 锚），余量约 2 分钟；按每锚 18.5s 线性外推，
 * **约 35 个锚**就会开始报。那一刻该做的是拆批 / 链发现提前 / 降低发现频次（由人定，见
 * spec `## Clarifications`），不是改这个数。
 *
 * ## 🚨 `null` = 没实测过的市场不猜
 *
 * `us` / `cn` 至今零样本。借 `hk` 的值会让美股主轮（跑在 us 收盘后、折成当地分钟远晚于任何
 * 港股台阶）每晚产一条假红，而假红的代价是把真信号淹掉 —— 正是本条要避免的那件事。
 *
 * 📌 与 {@link closeSettleBufferMinutes} 是**同一个写入窗的两端**：那个是下界（早于它官方
 * 收盘价还不存在），本表是上界（晚于它盘口已经塌了）。港股的窗因此是 `[16:10, 16:30]`，
 * 主轮 16:20 落在正中 —— 两端都由证据钉着，中间没有余量可挥霍。
 */
const MARKET_QUOTE_LADDER_END_LOCAL_MINUTE: Record<string, number | null> = {
  cn: null,
  us: null,
  hk: 16 * 60 + 30,
};

/** 该市场盘口台阶的上界（当地分钟）；`null` = 未实测 ⇒ 不判。复杂度 O(1)。 */
export function quoteLadderEndMinute(market: string): number | null {
  return MARKET_QUOTE_LADDER_END_LOCAL_MINUTE[market] ?? null;
}

/**
 * 这一批快照的**抓价时刻**（落库的 `quote_as_of`，即端口 envelope 的 `as_of`）还在
 * `sessionDate` 那一场的盘口台阶内吗（073 T009，FR-022）。纯查表 + 一次时区折算，零 I/O。
 * 复杂度 O(1)。
 *
 * 三档判定，顺序即优先级（与 {@link oiRefreshedAtEod} 同构，**第 2 档方向相反**）：
 * 1. 本表无值（`null` / 未登记市场）⇒ `true`，该市场不判；
 * 2. 抓价时刻的当地日期**已跨过** `sessionDate` ⇒ `false`。被挤过午夜的长链正是最该报的
 *    一档，而只比当日分钟数会把它判成「台阶内」（01:30 < 16:30）。日期**早于** `sessionDate`
 *    ⇒ `true`：本条抓的唯一形态是「太晚」；
 * 3. 同一天 ⇒ 比当日分钟数，**两端皆闭**（`minutesOfDay` 是分钟标签，`990` 代表
 *    `[16:30:00, 16:31:00)`，而实测仍好的最后一格就是它）。
 *
 * 🚨 返回值只决定「要不要多打一条 ERROR」，**不决定任何一行怎么写** ⇒ 未登记市场返 `true`
 * 而不抛（同 {@link oiRefreshedAtEod} 的契约）：为一条告警把整轮采集炸掉，方向反了。
 */
export function quoteCapturedWithinLadder(
  market: string,
  sessionDate: string,
  capturedAt: Date,
): boolean {
  const ladderEnd = MARKET_QUOTE_LADDER_END_LOCAL_MINUTE[market];
  if (ladderEnd === undefined || ladderEnd === null) return true;
  if (!isSessionRegistered(market)) return true;
  const { dateOnly, minutesOfDay } = marketNow(market, capturedAt);
  if (dateOnly !== sessionDate) return dateOnly < sessionDate;
  return minutesOfDay <= ladderEnd;
}

/**
 * 该市场当日的这一场**是否进行中** —— 自首段开盘至末段收盘，**含**中间的休息段（午休）。
 * 复杂度 O(段数)。
 *
 * ## 🚨 区间约定 = **左闭右开** `[open, close)`（业内的 `side="left"`）
 *
 * `minutesOfDay` 是一个**分钟标签**，`960` 代表的是 `[16:00:00, 16:01:00)` 这 60 秒 —— 它落在
 * 收盘**之后**，故**不算**场内分钟。这与 `session-clock.sessionWatermark` 的 `>= close ⇒ 已收`
 * 是同一个约定的两种写法；两边取不同侧，就会在收盘那一分钟对同一个时刻给出相反的答案
 * （#187 实撞：归属判据说「已收」、本谓词说「场内」，合成为一轮无来由的 skip）。
 *
 * 📌 业内把这个选择**显式参数化**（`exchange_calendars` 的 `side`: left / right / both /
 * neither），且自 v4.0 起所有日历默认 `left`。本仓不做成参数（只有两个消费方），改为
 * **每个谓词在注释里声明自己用哪一侧**，并由单测钉住两侧一致（见 `market-session.rules.spec.ts`
 * 的「边界一致性」段）。
 *
 * 🚫 **别拿本谓词当写闸** —— 「场内吗」与「现在写安全吗」是两个问题，后者还要加定稿缓冲，
 * 走 {@link isCloseWriteBlocked}。
 *
 * 🚨 **它与 {@link isWithinTradingSession} 的差别只有午休那一段, 而那正是 FR-011 的落点。**
 * 期权快照是「按交易日归属、供应方只给当下一份」的数据, 它的闸要问的是「**这一场收了没有**」
 * 而不是「此刻在不在连续竞价」。午休时后者返 `false` —— 拿它当闸就会放行, 于是把午休时刻的
 * 盘口贴上「上一场收盘」的标签写进库（`sessionWatermark` 在未过收盘时给出的目标日是
 * **上一个交易日**）。那种错行**不报错**、按唯一键占位、当晚正确的行反被挡掉 ⇒ 永久缺口。
 *
 * 📌 两谓词的分道如今**只剩 `cn`**: us 真的无午休, hk 已于 2026-08-18 合并成单段 ⇒ 它俩在这两个
 * 市场上除收盘那一分钟外逐分钟等价。而 cn 不在 `COLD_START_CAPABILITY` 里 ⇒ 这个差异当前
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
  const { open, close } = spanOf(segmentsFor(session, kind));
  return minutesOfDay >= open && minutesOfDay < close;
}

/**
 * 收盘后仍在**定稿缓冲**窗内 —— `[close, close + buffer)`。复杂度 O(段数)。
 *
 * 与 {@link isSessionUnderway} 严格互补且相邻: 前者管 `[open, close)`, 本函数接着管
 * `[close, close + buffer)`, 两段之和就是 {@link isCloseWriteBlocked}。
 */
export function isWithinCloseSettleBuffer(
  market: string,
  minutesOfDay: number,
  kind: SessionKindStatus,
): boolean {
  const session = MARKET_SESSION[market];
  if (session === undefined) {
    throw unregisteredMarketError(market);
  }
  const { close } = spanOf(segmentsFor(session, kind));
  return minutesOfDay >= close && minutesOfDay < close + closeSettleBufferMinutes(market);
}

/**
 * 此刻**不可**以收盘口径往「今天这一场」落库 —— `[open, close + buffer)`。复杂度 O(段数)。
 *
 * = {@link isSessionUnderway}（场内，端点数据还没产生）∪ {@link isWithinCloseSettleBuffer}
 * （刚收，收盘价可能还没定稿）。**这才是采集路径该问的那个谓词**，不是前两者之一。
 *
 * 🚨 取 buffer=1 时本函数与 #194 改造前的 `isSessionUnderway`（闭区间 `[open, close]`）**逐点
 * 等价** —— 那次拆分改的是语义与可调性, 不是行为。**`hk` 自本次起不再落在这个等价上**
 * （buffer=10，依据见 {@link CLOSE_SETTLE_BUFFER_MINUTES}）：拆出来的可调性正是为了这一步，
 * 别把「与旧行为逐点等价」当成本函数的不变式去维护。
 */
export function isCloseWriteBlocked(
  market: string,
  minutesOfDay: number,
  kind: SessionKindStatus,
): boolean {
  return (
    isSessionUnderway(market, minutesOfDay, kind) ||
    isWithinCloseSettleBuffer(market, minutesOfDay, kind)
  );
}
