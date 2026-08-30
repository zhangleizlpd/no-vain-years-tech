// 045 期权台文案单源（mockup 帧 ①~⑩ 逐字）。T024 在此追加雷达五态文案。
import type { MarchAuditEvidenceResponse, OptionsdeskControllerRadarMarket } from '@nvy/api-client';

export const OPTIONSDESK_COPY = {
  /** 雷达屏题头（= 期权台 tab 落地屏）。 */
  radarTitle: '击球区雷达',
  /** 雷达题头 ⚙ —— 真入口，进锚管理二级页。 */
  anchorsEntry: '锚管理',

  /**
   * 击球区雷达（T024，mockup 帧 ①~④）。
   *
   * 🚨 **三个空态文案不在这里** —— server 随 `emptyState` 一起下发 `emptyStateMessage`
   *    （零锚 / 筛选无结果 / 全体不动区，三态判定与措辞同源，FR-015 + FR-034 明令不复用）。
   *    前端**只渲染拿到的那一条**，不再自己拼一套。这里只放前端独有的壳文案。
   */
  radar: {
    /**
     * 题头 🌡 的 a11y 名。046 T023 起是**真入口**（直达 P7）——「即将可用」占位串随之删除
     * （045 FR-019 那条已被 046 FR-021 取代；留着就是页内还能搜到该字样的唯一来源）。
     */
    thermometer: '温度计',
    sortLabel: '按距 W 升序',
    /** SC-002：下拉增量加载，**全程无页码控件**。 */
    loadMore: '下拉加载更多',
    loadingMore: '加载中…',
    noMore: '已到底',
    loadFailed: '雷达加载失败，请下拉重试',

    // ── 新鲜度条（FR-016：数值必带 asOf + 新鲜度档，禁静默当实时） ──────────
    /** 「数据截至 X · 收盘」正文复用 `~/format/as-of`，此处只补档位后缀 / 无数据态。 */
    freshUnavailable: '行情不可用 —— 这批锚尚未被采集覆盖',
    freshStaleSuffix: ' · 非当日',

    // ── 行（每行恰好 5 字段，plan D13） ─────────────────────────────────
    spotPrefix: 'S ',
    distancePrefix: '距 W ',
    /** FR-017：单票行情缺失 = 显式不可用，禁 0 值 / 禁隐藏行 / 禁整页失败。 */
    quoteUnavailable: '行情不可用',
    noValue: '—',

    // ── 徽标（FR-014 顺序纪律：L 层 → 区间 / 锚逾期 → 复核锚 / 提醒类） ────
    badgeOverdue: '锚逾期',
    badgeReviewFlag: '复核锚',
    zoneLabels: {
      deep_buy: '深买区',
      buy: '买区',
      thin: '薄带',
      expensive: '偏贵',
      overvalued: '高估',
    },

    // ── 筛选 chips（**多选**；锚管理那处才是单选） ────────────────────────
    filterPendingReview: '待复审',
    filterBelowW: '跌破 W',
    clearFilter: '清除筛选',

    /** 零锚空态的行动入口（文案本体来自 server 的 emptyStateMessage）。 */
    goCreateAnchor: '去建锚',

    /**
     * 市场页签标签（065 FR-001）。用**双字**，两格等分下双字最稳（三字会在窄机上换行）。
     *
     * 🚨 键的值域是 `OptionsdeskControllerRadarMarket`（= server `IMPORTABLE_MARKETS` 经
     *    `@IsIn` → openapi → orval），`satisfies Record<...>` 让**加了受支持市场却不补文案
     *    即 tsc 红** —— 与服务端 `RADAR_EMPTY_STATE_MESSAGES` 同一手法。
     * 🚫 **MUST NOT 用 `marketBadgeLabel`** —— 它签名 `(code, market = 'cn')` 是 **code 优先**
     *    的**标的**徽标（传空 code + `'cn'` 得「深A」），不是市场名。
     */
    marketTabs: {
      us: '美股',
      hk: '港股',
    } satisfies Record<OptionsdeskControllerRadarMarket, string>,
  },

  /**
   * 标的详情屏 · 上半（046 T021，mockup `046-underlying-detail.dc.html` 帧 ①~⑥）。
   *
   * 🚨 **FR-035 口径单源**：IV 一律标「**富途标的聚合 IV**」，**禁写「IV30d」**或任何暗示
   *    30 天 / ATM 锁定的措辞（p3 §9-1：富途未文档化其 tenor / moneyness 聚合规则）。
   *    机械防线在 `underlying-detail.rules.spec.ts`（深走本子树断言零命中）。
   * 🚨 **Guardrail 8**：降级状态字（「分位不可算」/「暂无数据」/「行情读取失败」）在屏内
   *    **禁用最淡档** `text-ink-subtle`（白底实测 2.85:1，不达 WCAG AA）—— 用 `text-ink-muted`
   *    或 `text-ink`。FR-014/FR-017 要的是**显式**呈现不可用，渲染成最不显眼的字自相矛盾。
   */
  underlyingDetail: {
    title: '标的详情',

    // ── 块 ① 锚卡（FR-002 / FR-004 / FR-005，只读呈现无编辑入口） ──────────
    anchorCard: {
      willingBuyAnchor: '愿买价锚',
      asofPrefix: '锚 asof ',
      fieldV: 'V 愿买价',
      fieldW: 'W = 0.8V',
      fieldConfidence: 'confidence',
      fieldLLevel: 'L 层',
      fieldMethod: 'method',
      fieldAsof: 'asof',
      fieldPositionCap: '单票上限',
      fieldPositionLevel: '仓位水位',
      fieldNextReview: '下次复审',
      /**
       * 🚨 plan D9 ①：仓位水位的输入（持仓规模）属 M3/M4，本片**无数据通路** ⇒ 恒此串。
       * **禁显 0 / 0% / 空仓** —— 「不知道」与「知道是零」是两件事，混了会读成「我没仓位」。
       */
      positionLevelPending: '未知 · 待接入',
      confidenceSuffix: ' / 10',
      overdueSuffix: ' · 已逾期',
      overdueDays: (days: number) => `复审逾期 ${days} 天`,
      /** FR-004：人工态措辞与 045 锚表单同语义（**临时**，下次上游刷新回落）。 */
      manualBadge: '人工调整',
      manualLLevelHint: (derived: string) =>
        `L 层：人工调整 · 下次上游刷新将回落（映射档 ${derived}）`,
      manualPositionCapHint: (derived: string) =>
        `单票上限：人工调整 · 下次上游刷新将回落（L 档 ${derived}）`,
      loadFailed: '锚卡读取失败',
      noValue: '—',
    },

    // ── 块 ② 个股温度计区块（FR-012 / FR-013 / FR-014 / FR-035 / FR-036） ──
    ivBlock: {
      /** 🚨 FR-035 的落字处。 */
      title: '波动位置 · 富途标的聚合 IV',
      /** FR-012：通往 P7 全景（T023 接真路由）。 */
      panorama: '全景 ›',
      ivpUnit: '% IVP',
      aggregateIvPrefix: '聚合 IV ',
      /** FR-014 三态**各自成句、禁合并** —— 「不可算」是窗口不足，「暂无」是还没采到。 */
      percentileUnavailable: '分位不可算',
      missing: '暂无数据',
      /** `read_failed` = 跨 ctx 读故障，与「暂无数据」蓄意分开（server 侧也分开了）。 */
      readFailed: '波动读数暂不可用',
      /** FR-036 提醒状态三档（阈值 25 / 70 / 90；本片只呈现档位，无发送链路）。 */
      alertNotCrossed: '未越阈值档',
      alertCrossedHigh: '已越高档',
      alertCrossedExtreme: '已越极高档',
      noValue: '—',
    },

    // ── 块 ③ 区间时序（FR-006 ~ FR-010） ──────────────────────────────────
    series: {
      title: '区间时序',
      /** 粒度串（窗口→粒度映射本身在 `window-granularity.rules.ts`）。 */
      periodDay: '日 K',
      periodWeek: '周 K',
      periodMonth: '月 K',
      periodQuarter: '季 K',
      periodYear: '年 K',
      window1Y: '近 1 年',
      window3Y: '近 3 年',
      window5Y: '近 5 年',
      window10Y: '近 10 年',
      /** FR-008 边界：序列短于窗口 ⇒ 标明实际起点，**禁拉伸补空 / 禁静默截断**。 */
      actualStart: (date: string) => `实际自 ${date} 起`,
      /** state_branch #10：序列为空 ⇒ 空态，四区间带仍单独呈现（边界只依赖锚）。 */
      empty: '该标的暂无日线序列 —— 四区间带仍按锚呈现',
      /** state_branch #15：价格序列失败**不整页失败**，只降级折线区。 */
      loadFailed: '行情读取失败',
      retry: '重试',
      anchorStillOk: (asof: string) => `锚 asof ${asof} 正常`,
      /** FR-007：前复权口径，与雷达未复权 last_close 的口径差同屏可解释。 */
      adjustNote: '前复权口径 · 与雷达 spot（未复权）口径不同',
    },

    // ── 新鲜度（FR-020：两侧各带各的 asOf，分别标注） ──────────────────────
    freshness: {
      staleSuffix: ' · 非当日',
      unavailable: '无数据时点',
    },

    // ── 无锚（FR-011：显式提示 + 建锚入口，禁空白页 / 禁报错页） ────────────
    noAnchor: {
      text: '该标的尚未建锚',
      cta: '去建锚',
    },
  },

  /**
   * 选约区块 · 详情屏下半（047 T031，mockup `047-leg-picker.dc.html` 帧 ①~④）。
   *
   * 🚨 **FR-011 的「常驻」= 区块页脚不可折叠、不随状态消失**，不是屏幕常驻 ——
   *    与 046 把 FR-019 免责渲在滚动容器**之外**那个范式**不同**（mockup 帧 ①–④ 的页脚
   *    就在表格下方，随表一起滚）。别照抄 046 那条。
   * 🚨 **`chainNotReady` 与 `readFailed` 蓄意分开**：前者是「采集还没轮到」这一事实、
   *    要说明何时会有；后者是跨 ctx 读故障。合并成一句「加载失败」= 把事实说成故障。
   */
  legPicker: {
    /**
     * 区块级 asOf 无值时的显式标注（正文走 `~/format/as-of` 的「数据截至 X · 收盘」）。
     * 🚨 **OI 列有它自己的 `oiAsOf`，与区块级 asOf 故意不是同一天**（FR-013）—— 由 T032 落列。
     */
    asOfUnavailable: '无数据时点',
    /**
     * 陈旧档的后缀（T027a）。🚨 **档位由 server 的 `asOfFreshnessTier` 下发** —— 客户端拿
     * 设备本地日期自判，对美股恒为真（境内本地日历领先市场一天），那一档随之失去信息量。
     */
    asOfStaleSuffix: ' · 非当日',
    /**
     * 区块头计数 —— 未覆盖检索条件时的单数形态。
     *
     * 🚨 **053 起它报的是「符合条件的总数」（`matchedCount`）而不是渲染出来的行数**
     *    （FR-016）：表达层截断之后两者不再相等，而「已显示前 D 条」由**非常驻区**的截断计数
     *    承担 ⇒ 区块头再报 D 就是同一个数一屏两处（`SC-005` 明禁）。
     * 📌 未覆盖时 `memberCount === matchedCount`，此时 MUST NOT 并列显示两个相等的数（FR-009）。
     */
    rowTotal: (total: number) => `共 ${total} 行`,
    /**
     * 区块头计数 —— **有覆盖生效**时的双数形态（plan D-API-1 计数三处分工）。
     * 🚨 「全量」= 无覆盖口径下的候选数（`memberCount`），不是链上的全部腿：没有它，用户在表上
     *    看不到「我筛掉了多少」的基准，而抽屉徽标只答「改了几个维度」不答「少看到多少条腿」。
     */
    rowTotalNarrowed: (matched: number, member: number) => `筛后 ${matched} · 全量 ${member}`,
    /**
     * state_branch：从无快照 —— **非空页非错误页**（FR-014），且 MUST **说明何时会有**。
     * 🚨 后半句不是客套：新建锚当天进来的人看到「未就绪」会以为坏了；说出「已经在补、不用你做
     *    什么」才把它从故障读成事实。别写成「稍后重试」——那是把事实又变回故障。
     *
     * 🚨 **别把「等下一次收盘采集」写回来**（2026-08-22 订正，issue #139）。原文案是
     *    「采集在每个美股交易日收盘后跑一轮，下一轮覆盖到它就能读」，两处都已不成立：
     *    ① 新建锚由 060 冷启动**当场触发**补数，不等收盘轮；
     *    ② #124 之后，盘中补完读到的是**实时独载基线**（`source='realtime'`），
     *       `option_daily_snapshot` 可以自始至终 0 行 —— 它从没被快照「覆盖」过。
     *    真机实测（`us:ADBE`，建锚 → 冷启动 → 189 行 realtime）逐条对上这两点。
     *
     * 🚨 **刻意不写等待时长。** 实测过一次 81 分钟，但那 96% 是队列排队（冷启动 job 与夜间全
     *    市场批共用一条 `concurrency=1` 的队列），而 #139 正在讨论改出队顺序 ⇒ 任何写死的时长
     *    都会在那之后变成第二次 drift。说机制不说秒表。
     */
    chainNotReady:
      '期权链数据未就绪 —— 该标的的链正在补。新建的锚会自动触发一次补数，无需操作；补完这张表就有内容。',
    readFailed: '选约表读取失败',
    retry: '重试',
    /**
     * 053 FR-020：三个视角是三次独立请求，可能跨过业务日切换点 —— 自动重取一次之后仍不一致时
     * **显式说出来**。🚫 MUST NOT 静默把来自不同业务日的读数并排呈现（每个数字都对，只是不属于
     * 同一天），也 MUST NOT 继续无限重取（闩已置，处置权交回用户）。
     */
    asOfMismatch: '三个视角的数据时点不一致 —— 自动重取后仍未对齐，表里可能混着不同交易日的读数。',
    asOfMismatchCta: '重新取三个视角',
    /** 零适格腿：Tab 可进入、面板**不隐藏不置灰**（FR-021）。 */
    empty: '该 Tab 暂无适格腿 —— 面板照常可读',
    /** DTE 两段式提示（mockup 帧 ①~④ 页脚，逐字）。 */
    dteTip: 'DTE 两段式 · ① 先让到期日盖过已知利空出清点（财报后）② 再在其后留方向性缓冲。',
    dteTipAnnualNote: '折年仅作周化行参照，不跨 DTE 追年化最大化。',
    /** 🚨 FR-011 常驻页脚 —— 这九个字是 T035 e2e 的断言锚，别改。 */
    disclaimer: '触发 ≠ 开仓 —— 人工终决',

    // ── 两个门槛计数（051 FR-006/007/007a，mockup 帧 ①③④⑤⑥ 逐字）──────────
    /**
     * 🚨 两条计数的**语义不对称**（FR-007）：权利金挡下的腿整条移出响应 ⇒ 三个视角都没有；
     *    流动性挡下的腿只是不进意图视角 ⇒ 全腿视角仍在。MUST NOT 用同一个暗示「滤掉」的词。
     * 📌 后缀与数分开：计数为 0 时**只报数不带解释后缀**（「移出 0 条 · 三个视角都看不到」自相矛盾）。
     */
    gatePremiumFloor: (n: number) => `权利金门槛移出 ${n} 条`,
    gatePremiumFloorNote: ' · 三个视角都看不到',
    gateLiquidity: (n: number) => `流动性门槛排除 ${n} 条`,
    /** 在意图视角说：那些腿去全腿视角还能看到（本条带入口）。 */
    gateLiquidityNoteIntent: ' · 仍在全腿视角',
    /** 在全腿视角说：它们**就在本视角内** ⇒ 改口且不给入口（去全腿视角的入口在这里是死链）。 */
    gateLiquidityNoteAll: ' · 仅全腿视角可见',

    // ── 表达层截断计数 · 第 3 条（053 FR-016/FR-017/FR-018，plan D-UI-1）──────────
    /**
     * 🚨 **只带新信息**：报「已显示多少」与「还剩多少没显示」，🚫 MUST NOT 复述「符合条件 N 条」
     *    —— 那个数已由 sticky 区块头承担（{@link rowTotal}），同屏出现两次会被读成两个不同的量
     *    （`SC-005` 是它的可验证形态）。
     * 🚨 **措辞与上面两条门槛计数 MUST 不混用同一个词**（FR-018）：门槛说「移出 / 排除」（被条件
     *    挡下），这一条说「未显示」（腿合格，只是排在阈值之后）—— 两件事，用户该做的处置也不同。
     */
    truncated: (shown: number, hidden: number) => `已显示前 ${shown} 条 · 其余 ${hidden} 条未显示`,
    /**
     * 收窄指引（FR-017）—— 🚨 **不给它等于告诉用户「还有 N 条，但你够不到」**：分页、「加载更多」
     * 与被截断腿的下钻在本片都不存在（FR-019），收窄检索条件是唯一的手段。
     * 📌 吃 `entry` 而不内嵌「检索条件」四个字 —— 抽屉入口的措辞只有 {@link criteria}.entry 一个落字处。
     */
    truncatedGuide: (entry: string) => ` · 收窄「${entry}」可让其余的腿进来`,

    // ── 候选上限 K 的异常位（053 FR-019c，Guardrail 6/14）────────────────────────
    /**
     * 🚨 **与截断计数不同款是硬要求**：`K` 是给下游限流的**保险丝**（触及即系统异常，处置是**调
     *    容量**），`N` 是用户可见条数（触及是正常呈现约定，处置是**调展示**）。同款呈现会让
     *    「该调容量」被读成「该调展示」。
     * 🚨 **必须说明「上面的数可能不完整」**：`K` 触及会让 `matchedCount` **静默失真** —— 它算在
     *    已被 `K` 砍过的集合上，于是「其余 N−D 条」少报，而条数与数值全都正常、**不会红**。
     */
    candidateCap: (n: number) =>
      `候选上限已触及 —— 召回阶段先切掉了 ${n} 条，上面的条数可能少报。这是系统容量的保险丝，不是你的检索条件切的。`,

    // ── 意图视角空态两分支（051 FR-009，mockup 帧 ③④ 逐字）────────────────
    /**
     * 🚨 两分支**一眼可分**是硬要求：用户据此该做的事完全不同 —— ③ 是「去看被挡下的那些」，
     *    ④ 是「换一只票」。分支判据是**该视角自己的**排除数（契约的 `excludedFromIntentTabs`
     *    —— 053 起一次请求只判定一个视角，它就是本视角的数）。
     */
    emptyIntentTitle: { build: '建仓视角暂无候选', rent: '收租视角暂无候选' },
    emptyBlockedByGate: (n: number) =>
      `这只票有 ${n} 条腿在该视角的期限段内合格，但报价太宽，被流动性门槛挡在意图视角之外。`,
    emptyBlockedCta: (n: number) => `去全腿视角看这 ${n} 条`,
    /**
     * 🚨 **不写死期限段的天数**：`BUILD_RECALL_DTE` / `RENT_RECALL_DTE` 是服务端的可调策略参数
     *    且不在契约里下发 —— 抄进文案就多一处漏改点，而漏改是静默的（数字照显、句子照通顺）。
     *    这是 FR-019「说明文案 MUST 与当前服务端判据一致」在本条上的落法：宁可粗一档也别失真。
     * 📌 两支判据本就不同：建仓 = 期限段 ∧ 有效成本门槛；收租 = 只有期限段。
     */
    emptyNoneReason: {
      build: '这只票没有一条腿同时满足建仓视角的期限段与有效成本门槛。',
      rent: '这只票没有一条腿落在收租视角的期限段内。',
    },
    emptyNoneTail: '换一只票，或改看另一个视角。',

    // ── 12 列表头（047 T032；mockup 帧 ①~④ 逐字）────────────────────────
    /**
     * 🚨 列头**穷举**用 `Record<LegColumnKey, string>` 而非 `Partial<Record>` ——
     *    漏一列即编译红。列宽 / 列序的单源在 `leg-row.rules.ts`。
     */
    columns: {
      strike: '行权价/到期',
      bid: 'bid/ask',
      /**
       * 🚨 **常态下渲不到屏幕上**（051 FR-017a）——费率列头直接是服务端下发的口径本身
       * （「周化」/「年化」，见 {@link rateBasisWeekly}）。这一条只作口径未知 / 契约未到手
       * 时的**降级标题**（FR-018），单点在 `leg-picker.rules.ts` 的 `RATE_HEADER_UNKNOWN`。
       */
      rate: '费率',
      /**
       * 053 新增两列（FR-032）。措辞取**短形**：50 / 48px 的列宽下，「单笔权利金」「相对价差」
       * 五字 / 三字在 10px 表头里都装不下 —— 完整口径由 spec 与页脚承担，列头只求认得出。
       */
      premium: '权利金',
      spread: '价差',
      cost: '成本vsW',
      delta: 'Δ',
      oi: 'OI',
      vol: 'Vol',
      activity: '活跃',
      mark: '标注',
      action: '动作',
    },
    /** 列头副标。`rate` 的那条随口径换（见下方三条），Δ 这条恒在。 */
    columnSubDelta: '带判据',
    /**
     * 费率列头 —— **列头即口径本身**（051 FR-017a：不在其上再套「费率」这层通用标题）。
     * 🚨 取值域与服务端下发的 `basis`（**本次视角**那一份口径）一一对应，映射单点在
     *    `leg-picker.rules.ts`；客户端 MUST NOT 自带一份「视角 → 口径」的第二实现（FR-017）。
     */
    rateBasisWeekly: '周化',
    rateBasisWeeklySub: '折年参照',
    rateBasisAnnualized: '年化',
    /**
     * 🚨 OI 列的**独立归属日**（FR-013 / Guardrail 6）—— 美股期权 OI 盘前更新，收盘后采的
     * 快照其 OI 归属 T−1 日 ⇒ 它与区块级 `asOf` **不是同一天**，MUST 挂在 OI 列头上。
     */
    oiAsOfSub: (monthDay: string) => `截至 ${monthDay}`,
    /** 周化行的折年副标 —— 折年是**参照**，不作排序键（页脚有完整说明）。 */
    rateAnnualizedRef: (annualized: string) => `年 ${annualized}`,
    /**
     * 钉住列的两个标（051 FR-011a / FR-014 / FR-014b）。
     *
     * 🚨 推荐标取「贴合」不取「推荐」—— 服务端的判定**完全不看视角成员**，故存在「带标却进不了
     *    任何意图视角」的腿（050 实测约占期限段合格腿五分之一）。措辞是**唯一**的消歧手段：
     *    它说的是「这条腿的 Δ 落在你当前意图的带内」，MUST NOT 读作「建议买入 / 该选它」。
     * 🚨 两个都是**认得出来的汉字**，不是几何符号 —— 纯符号连「这是什么」都要查图例
     *    （mockup 阶段实证：月度链标初版画成空心方块，spec 作者本人评审时仍需发问）。
     */
    fitBadge: '贴合',
    monthlyBadge: '月',
    /** 数值缺失的统一占位 —— 与「建仓意图下无财报标」共用同一个字形（FR-006 收敛后只剩一义）。 */
    noValue: '—',

    // ── 064 区块级档位条 + 行级档位标（FR-009/FR-010/FR-013/FR-014；映射在 leg-tier-bar.rules）──
    /**
     * 🚨 三个档位名**互不重叠且都认得出**：「实时」是此刻的盘口 ·「收盘档」是库内那一天的收盘
     *    盘口 ·「未就绪」是这一批连时点都没有。🚫 MUST NOT 把后两者合并成「不可用」——
     *    收盘档是**正常可读**的数（境内白天的常态），未就绪才是「这一步压根没算」。
     */
    tierLive: '实时',
    tierEod: '收盘档',
    tierNotReady: '未就绪',
    /**
     * 🚨 收盘档的原因**必须是原因**（FR-011），🚫 不许写成「加载失败」那种零信息文案。
     * 🚨 **064 T007a 起措辞是单义的**：契约下发了 `realtimeDegrade`，「正常休市」与「本该给
     *    实时却没给成」当场分得开 ⇒ 本条只服务前者。原先那句「或实时源暂不可用」的两可措辞
     *    是当时契约分不出两者的让步，留着等于**每天都在暗示可能出事了** —— 而真出事那天
     *    （见 {@link tierDegradeSourceDown}）它说的话与今天一模一样。
     * 📌 **长度是这一族的硬约束**（本条与下面四条降级原因、未就绪原因共用同一个插槽）：
     *    档位条是 `● 收盘档 08-18 · <原因> · 刷新` 一整行，插槽宽度约 20 个汉字，超了就
     *    折成第二行把条目撑高。⇒ 写原因时**先删掉与档位名 / 时点重复的那半句**（「屏上是
     *    收盘盘口」之类，档位名已经说过），剩下的才是这一句独有的信息。
     */
    tierEodReason: '美股非常规交易时段',
    // ── 064 T008a 链级降级的四条原因（值域同契约 `realtimeDegrade`；映射在 leg-tier-bar.rules）──
    /**
     * 🚨 **四条各说各的处置**，🚫 MUST NOT 收敛成一句通用降级文案 —— 前两条用户**自己能动手**
     *    （收窄条件 / 下拉重试），后两条只能等；一句话包圆等于把「你现在能做什么」抹掉。
     */
    tierDegradeOverCap: '合约过多超出单批上限，可收窄条件重试',
    tierDegradeBasisStale: '标的盘中价未更新，定不出取价范围',
    /**
     * 🚨 **本片最要紧的那一句**：美股正在开着、我们却拿不到此刻的盘口 —— 屏上那张表看起来
     *    完全正常，而它是**上一交易日**的。064 立项的病根就是这一格没人说出来。
     */
    tierDegradeSourceDown: '🚨 盘中取不到实时源，勿据此下单',
    tierDegradeGateUnknown: '判不出是否交易时段，下拉可重试',
    /** 逐行降级的**去处**（FR-009）：说出条数，人才知道要去行内找那枚「收」标。 */
    tierPartialMiss: (n: number) => `${n} 条未取到实时 · 见行内「收」标`,
    /** 🚨 未就绪不给任何看似正常的时点 —— 「这一步没算出来」与「算出来是旧的」是两件事。 */
    tierNotReadyReason: '这一批没有可用的报价时点，下拉可重试',
    /** 行级档位标（复用钉住列既有的 badge 载体，🚫 不新建组件、不新开一列）。 */
    eodBadge: '收',
    /** 068 带外横档（bandStatus='out'）—— 同批实时 Δ 未落意图带，保留供比价。 */
    bandOutBadge: '带外',
    /**
     * 🚨 成交量列的两档口径（FR-013）—— 盘中的累计量天然小于全天量，两档共用一句表头文案会
     * 把活跃的腿看成冷门腿，**而两个数都显示得出来**。
     */
    volSubRealtime: '至此刻',
    volSubEod: '当日',
    // ── 064 等待与刷新（FR-022, mockup 帧 ⑥⑦）────────────────────────────────
    /**
     * 🚨 首屏等待态的名字是**「正在取此刻报价」不是「加载中」** —— 它要说清楚在等什么，
     *    否则「多等 0.4 秒」在用户那里只是一次没来由的卡顿。
     */
    tierBusyFirstLoad: '正在取此刻报价',
    /** 🚨 首屏**不先出收盘档**是本条要解释的那件事（FR-022），文案直接把它说出来。 */
    tierBusyFirstLoadNote: '等这一批到齐再整体渲染 —— 屏上不会先出现一份昨收的表',
    tierBusyRefreshing: '刷新中',
    /** 刷新期间标在时点前面：屏上这批**还是上一批**，不遮罩不置灰，到齐后整体替换。 */
    tierBusyKeptNote: '屏上这批仍是',
    /** 档位条右端的刷新入口。🚫 无自动轮询（spec Assumption）⇒ 推进时点只有这一个手动入口。 */
    refreshCta: '刷新',

    // ── 064 成员变化提示（FR-021 / SC-009, mockup 帧 ⑧）────────────────────────
    /**
     * 🚨 **「本轮」这两个字是判据的一部分**：说的是**相邻两次取数之间**的进出，不是「今天以来」
     *    也不是「相对某个基准」。差集只在客户端算（服务端不持有你上一轮看到了什么）。
     */
    membershipLead: '本轮',
    membershipEntered: (n: number) => `${n} 条新进`,
    /**
     * 🚨 措辞是**「已不满足」不是「被移除」** —— 判据没变，是数变了。「移除」会被读成系统把腿
     *    删了、可以去别处找回来；而这条腿是**此刻确实不再过判据**，正是用户不该照旧下单的那条。
     */
    membershipLeft: (n: number) => `${n} 条已不满足`,
    membershipDismiss: '关闭本轮变化提示',
    /**
     * 🚨 实时档下区块头那一行的前缀（064）：它报的是**库内快照的归属交易日**（OI 与未被覆盖的
     * 列仍出自它），而本批报价来自此刻 ⇒ 再说「数据截至 X · 收盘」就是屏幕上的一句假话，
     * 且它与档位条上的时刻**同屏对冲**。收盘档下措辞一字不变（仍走 `~/format/as-of`）。
     */
    snapshotPrefix: '快照 ',

    // ── 三 Tab + 意图条 + 水位 chip（047 T033；mockup 帧 ①~③ 逐字）──────────
    /**
     * 三个 Tab（FR-002）。🚨 **三个恒可进入、恒不置灰** —— 空 Tab 是空态不是禁用态（FR-020），
     * 未选水位也不锁任何一个（FR-017）。
     *
     * 🚨 **措辞是「视角」不是「腿」**（051 FR-019）：P1 起 Tab 是看同一批数据的三种眼光，
     *    不再是腿的分类 ——「建仓腿」这个词已不指任何东西（同批退役的还有口径徽标，FR-019a）。
     *    与本屏其余 051 文案逐字同词（`emptyIntentTitle` / `gateLiquidityNoteAll` 皆称「视角」）。
     * 🚨 **MUST NOT 把口径（周化 / 年化）写回标签**：那是客户端的第二份「视角 → 口径」映射，
     *    正是 FR-017 禁的那件事；口径的唯一落字处是费率列头本身（FR-017a，取自服务端下发）。
     */
    tabs: {
      all: '全腿视角',
      build: '建仓视角',
      rent: '收租视角',
    },
    /** 意图矩阵四输出（FR-016）。`pending` 是**常驻分支**，不是 loading。 */
    intents: {
      build_position: '建仓',
      rent: '收租',
      no_new_position: '不开新仓',
      pending: '待定',
    },
    intentPrefix: '意图 ',
    /** 意图 chip 下的判定依据小字 —— 三个输入原样摊开（`L2 · 买区 · 水位 ≥2/3`）。 */
    intentBasis: (lLevel: string, zone: string, bucket: string) =>
      `${lLevel} · ${zone} · 水位 ${bucket}`,

    /** 水位三选一（FR-017）。值域与写端点逐字一致，**无「清空」动作**。 */
    bucketTitle: '仓位水位',
    buckets: {
      lt_one_third: '<1/3',
      one_to_two_thirds: '1/3–2/3',
      gte_two_thirds: '≥2/3',
    },
    /** 未选 —— 🚫 MUST NOT 显 0、MUST NOT 按最保守档静默假设。 */
    bucketUnselected: '未选',
    /**
     * 🚨 「人工输入」角标（FR-017）—— 直接读契约的 `positionBucketSource`，**不靠前端记忆推**。
     * M3 真实水位接入后同一字段会混进非 manual 来源，届时这个标自然只挂在人填的那些值上。
     */
    bucketManual: '人工输入',
    bucketSetAtPrefix: '选于 ',
    bucketSaving: '保存中…',
    bucketSaveFailed: '水位保存失败，请重试',
    /** 🚫 未选水位时的显式提示（FR-017 逐字）—— 提示在，三 Tab 照常全部可进入。 */
    bucketUnsetHint: '选一次水位档以定位意图',
    /**
     * 收租意图下打开建仓视角时的就地说明（051 FR-012）。
     * 🚨 口径是「这些标按当前的收租意图打」，**不是**「这个视角没有推荐」—— 后者会让人以为
     *    标丢了，而实际上推荐标随**标的级意图**判、不随视角变（FR-011）。
     */
    marksFollowIntentNote: (intent: string, badge: string) =>
      `本表的「${badge}」标按标的级意图（${intent}）打，不随视角变 —— 不是「建仓视角没有推荐」。`,
    /**
     * 未选水位时收租视角的**就地注明**（051 FR-020 订正 —— 050 已在此登记并推迟到本片）。
     *
     * 🚨 **原文案「水位未选 → 展示全部 Δ 档（0.05–0.40Δ）」描述的是 047 的召回行为**：server 的
     *    `RENT_DEPTH_UNION_BAND` 随召回换代整条删除，Δ 退出召回判据 ⇒ 选不选水位，收租视角的
     *    **成员集合一条不变**，差别只在于全表零推荐标。旧文案把范围说得比实际窄（读起来像
     *    「选了水位就只剩一档」），而它**不会红**：数字照显、句子照通顺。
     * 📌 吃 `badge` 而不内嵌「贴合」二字 —— 与 {@link marksFollowIntentNote} 同一范式，
     *    标的措辞只有 {@link fitBadge} 一个落字处。
     */
    rentDepthUnionNote: (badge: string) =>
      `水位未选 → 收租视角的腿与选了水位时完全相同，差别只在于全表零「${badge}」标。`,

    // ── 档位 / 动作 / 财报 chip / 数据缺口（047 T034；mockup 段 3 配色 + FR 定案文案）──
    /**
     * 🚨 **动作四态梯度**（FR-010 08-04 定案）：挂 OCO（好/可接受**合并**，靠着色区分）→
     *    暂不挂（薄，「暂」承时间性）→ 死档剔除（永久性）→ 无法判档（greeks 缺 / 无 bid）。
     * 🚫 **四者全是建议语义** —— 动作列是**中性 tag 不是按钮**（FR-011/FR-012），
     *    刻意不做按钮观感，页脚那句「触发 ≠ 开仓」是它们的统一注脚。
     */
    actionPlaceOco: '挂 OCO',
    actionHold: '暂不挂',
    actionDead: '死档剔除',
    actionUnjudgeable: '无法判档',
    /** 🚨 薄档行同屏带出的 `ask` 口径费率（D-SOT-2）—— 人据此自行套用 SoT 的尴尬区二分。 */
    rateAskRef: (ask: string) => `ask ${ask}`,

    /**
     * 财报 chip **五形态**（T026 实装的值域）+ 建仓腿的 `null`。
     * 🚨 `no_cross`（已确认不跨）/ `no_date`（不知道）/ `null`（建仓腿按设计无标）**三者
     *    MUST NOT 合并** —— 把「不知道」渲成「已确认不跨」正是 FR-026 / FR-034 明禁的那一步。
     *    形态上也分得开：`no_cross` 无 chip 纯文字 · `no_date` 虚线 chip · `null` 占位符。
     */
    earningsCovered: '覆盖 ✓',
    /** N 的语义是**还差几天**凑够缓冲（不是「已缓冲几天」）。 */
    earningsBufferShort: (days: number) => `缓冲不足 +${days}d`,
    /** 契约给了 buffer_short 却没给 N —— 退无 N 的说法，MUST NOT 渲 `+nulld`。 */
    earningsBufferShortUnknown: '缓冲不足',
    earningsCrosses: '跨财报 ⚠',
    earningsNoCross: '不跨',
    earningsNoDate: '无日期',

    /**
     * 四档图例（页脚）。
     * ⚠️ **边界值的真源在 server `leg-tier.rules.ts` 的 `TIER_FLOORS_BY_BASIS`**（FR-022 单点
     *    可改）—— 跨 bounded context 拿不到那个常量，故这里是**手抄的镜像**：调档位参数时
     *    MUST 回改这四行。这是本片已知的一处 drift 风险，蓄意接受（唯一的替代是把六个数字塞进
     *    响应体，为一行图例扩契约不划算）。
     */
    tierLabels: {
      good: '好',
      acceptable: '可接受',
      thin: '薄',
      dead: '死档',
    },
    tierBounds: {
      good: '年 ≥15% / 周 ≥2%',
      acceptable: '年 10–15% / 周 1–2%',
      thin: '年 5–10% / 周 0.6–1%',
      dead: '年 <5% / 周 <0.6%',
    },
    legendTitle: '档位（bid 口径 · 分母 = 准备金 K−P）',
    /** FR-007 的「数据不全」在面板级说清楚 —— 行内三处处置（占位 / 不着色 / 无法判档）的注脚。 */
    legendUnjudgeable:
      '「无法判档」= 该腿 greeks 不全（缺 Δ）。费率算得出来但会骗人 —— 不判档不着色。',
    /**
     * 整表无财报标是**设计**不是缺数据（与「无日期」两回事）。
     *
     * 🚨 **判据挂在标的级意图上，不是挂在某一类腿上**（051 FR-019 订正）：server 的
     *    `earningsLegFamilyFor(intent, dte)` 只在 `intent === 'build_position'` 时返建仓域
     *    ⇒ 无标 ⟺ **标的级意图为建仓**，三个视角一起无。原文案「建仓腿按设计无财报标」既用了
     *    已退役的腿族措辞，又在「收租意图 × 建仓视角」下**当场为假**——那些行确实带财报标，
     *    而本行渲在四态三视角恒在的页脚里（`LegBlockFooter`，无条件分支）。
     */
    legendBuildNoEarnings: '标的级意图为建仓时整表无财报标 —— 建仓本就想接货。',

    /**
     * 🚨 FR-021 不动区：警示注**置顶**，且腿数据**照常全量展示**（全量可见原则）。
     * 🚫 MUST NOT 借机隐藏 / 折叠 / 置灰表格 —— 「不开新仓」是结论不是屏蔽理由。
     */
    noNewPositionWarning: '不开新仓 —— 该标的落在不动区或 L4。以下腿数据照常全量呈现，仅供查看。',
    /**
     * 快照来源标（契约 `source`）。🚨 只在**非 eod** 时出 —— 「一直靠兜底续命」要看得见。
     * 📌 它**不是**新鲜度判据：「asOf 是不是当期」要查交易日历，本片契约未下发该档，
     *    故客户端**不自造陈旧判定**（拿设备本地日期比美股 EOD 永远显「已过时」）——
     *    改为把 asOf 恒常醒目呈现（SC-003：零处「不知道这是哪天的数」）。
     */
    sourceBackfillPrefix: '来源 ',

    // ── 检索条件抽屉（052 T012，mockup `052-criteria-sheet.dc.html` 帧 A1~A6 逐字）─────
    /**
     * 🚨 **控件标签与 12 列表头逐字同词**（`OI` / `Vol`）—— 同屏可直接对照。
     *    🚫 MUST NOT 用「持仓」称合约未平仓量：本 App 里「持仓」已被 `portfolio` 占用
     *    （持仓屏 / 持仓导入 / 持仓规模），而选约屏自己的水位 chip 就在讲持仓规模。
     * 🚨 **活性是一个维度、两个值**（`OI ≥ x` **或** `Vol ≥ y`）—— 中缝画「或」，与区间的
     *    `–` 蓄意不同形：前者择一、后者取交。判据本身 MUST 常驻，MUST NOT 塞进 ⓘ。
     */
    criteria: {
      /** Tab 行右端入口（34px）—— 徽标数的是**已覆盖维度数**，不是排除条数。 */
      entry: '检索条件',
      entryBadge: (n: number) => `已改 ${n} 项`,
      sheetTitle: (perspectiveLabel: string) => `检索条件 · ${perspectiveLabel}`,
      subDefault: '当前为系统默认值',
      subDirty: (n: number) => `已改 ${n} 项 · 未提交`,
      subApplied: (n: number) => `已改 ${n} 项`,
      /** 行标签。`≥` / `≤` 直接写进标签 —— 方向感是判据的一部分，别只靠输入框位置暗示。 */
      labelStrike: '行权价',
      labelDte: '期限天',
      labelPremium: '权利金 ≥',
      labelOi: 'OI ≥',
      labelVol: 'Vol ≥',
      labelSpread: '价差 ≤',
      /** 「不限」= 空框 + 占位符。🚫 MUST NOT 写 0 或 ∞（两者都是**值**，不是「没有边界」）。 */
      unbounded: '不限',
      rangeDash: '–',
      percentSuffix: '%',
      /**
       * 活跃度分组块的标签（056 `FR-034`）。
       *
       * 🚨 **零新词**：这一维在计数行里**已经有名字** —— {@link countLabels}.`livenessMin` =
       *    「活跃度下限」，用户在「活跃度下限之外还有 N 条」里见过它。本条是**沿用**那个叫法。
       * 🚫 MUST NOT 引入「活性」（会成为同一维度的**第三个**叫法：代码 `livenessMin` /
       *    文案「活跃度」/ 新词「活性」）或「流动性」（会与计数行的「活跃度」在屏上并存）。
       * ⚠️ **绊线已复核**（`FR-034` 要求）：选约表另有一列叫「活跃」（{@link columns}.`activity`，
       *    标注枚举，同源不同物）。两者**不会并排被读成一件事** —— 抽屉是 Modal，打开时整张表
       *    在遮罩之下；且一个是分组块标签、一个是 12 列表头里的列名，位置与措辞都可分。
       */
      livenessGroupLabel: '活跃度',
      /**
       * 分组块内的匹配规则说明（056 `FR-030` / `FR-032`）——**只读一行字，不是选择器**。
       *
       * 🚨 存在理由：主流期权筛选器（Barchart / moomoo / IB / MarketChameleon）一律把 OI 与
       *    成交量做成两条独立 **AND** 项，用户带来的预期与本仓判据**相反**；夹在两框之间的
       *    一个「或」字会被当排版噪声略过，而读错的后果**屏幕上不会红**（筛出来的腿比预期多）。
       * 🚫 MUST NOT 做成可切换的 AND/OR，也 MUST NOT 画成禁用态的 segmented ——
       *    禁用态说的是「暂时不能改」，这里是「压根没有这个旋钮」（`FR-032`）。
       */
      livenessRule: '满足任一',
      /**
       * 🚨 ⓘ 只放**口径说明**（nice-to-know），判据本身 MUST 常驻 —— tooltip 易被忽略
       *    （NN/G），把判据放进去等于没写。移动端是 **tap 触发**的 popup tip（无 hover），
       *    热区 44×44。
       */
      infoIcon: 'ⓘ',
      premiumTipLabel: '权利金口径',
      premiumTip:
        '门槛判的是 bid（挂出去即可成交的那一边），不是 mid 或 ask。腿没有 bid ⇒ 判不通过——「不知道」与「知道且很低」处置同归。',
      /**
       * 建仓视角行权价行的口径提示（056 `FR-016`）。形态沿用上面那个 ⓘ，🚫 MUST NOT 新造一种。
       *
       * 🚨 **存在理由**：`K − bid < spot` 这道有效成本硬门槛**无控件、不可调，且不进边际计数**
       *    （服务端 `soleFailure === null` 那一支明写「硬门槛不过 ⇒ 不进任何一维的计数」）
       *    —— 用户在建仓设了行权价却看到腿更少时，少掉的那部分可能是硬门槛切的，而屏上不解释。
       * 🚫 **不写死判据里的数**：口径由服务端持有，抄进文案就多一处静默漏改点（同
       *    {@link emptyNoneReason} 那条不写死期限段天数的理由）。
       */
      strikeTipLabel: '行权价口径',
      strikeTip:
        '建仓视角另有一道有效成本硬门槛在生效（它挡掉深度实值），不可调、也不在这里 —— 这里设的行权价是在它之外再收一刀。被硬门槛挡下的腿不进任何一维的计数，所以腿变少时未必都是你切的。',
      /** 「搜」与「复位」**并存**（不是互斥槽位）：前者显式提交，后者清回系统默认值。 */
      submit: '搜',
      reset: '复位',
      close: '关闭抽屉',
      /**
       * 收窄维度的计数行（FR-030 措辞）。🚫 MUST NOT 说「被系统滤掉」——
       * 这一刀是用户自己切的，系统默认值下的排除**不出计数**（默认值就摆在控件里）。
       */
      countLine: (label: string, n: number) => `${label}之外还有 ${n} 条`,
      countGoNote: ' · 去改',
      countLabels: {
        strikeMax: '行权价上界',
        strikeMin: '行权价下界',
        dteBand: '期限段',
        premiumMin: '权利金下限',
        livenessMin: '活跃度下限',
        relativeSpreadMax: '价差上界',
      },
      /**
       * 空态第三支（spec Edge Case「条件收紧到候选为空」）—— 与「本来就没有」**一眼可分**：
       * 这一支是用户自己切没的，故给的入口是**复位**而不是「去别的视角看」。
       */
      emptyTitle: '当前检索条件下没有候选',
      emptyText: '是你收窄的这几条把它们切没了 —— 这只票本身有腿。',
      emptyResetCta: '复位到系统默认值',
    },
  },

  /**
   * 波动温度计屏 · P7（046 T022，mockup `046-thermometer.dc.html` 帧 ⑦~⑩）。
   *
   * 🚨 **不出 regime 读数**（FR-015 📌，2026-08-03 拍板）—— vault 未给 N/X 的机械判据，且
   *    把它定性为「温度计的极致读数 + 人判 + 无 gate」。**mockup 帧⑦ 画了它，别照抄回来**；
   *    server DTO 里也没有该字段。机械防线在 `thermometer.rules.spec.ts`（本子树深走零命中）。
   * 🚨 **FR-019 免责常驻**：{@link disclaimer} 渲在 ScrollView **之外** —— 非折叠、非 tooltip，
   *    任何滚动位置 / 任何数据态都在。它唯一的机械载体是 T024 e2e。
   * 🚨 **Guardrail 8**：降级状态字（「显示不可用」/「不可用」）禁用最淡档 `text-ink-subtle`
   *    （白底实测 2.85:1）—— FR-017 要的是**显式**呈现不可用。
   */
  thermometer: {
    title: '波动温度计',
    /** 🚨 FR-019 的落字处 ——「不构成开仓理由」是 T024 的断言锚，别改这七个字。 */
    disclaimer: '温度计全程展示供参考判断 —— 不构成开仓理由',
    loadFailed: '温度计加载失败',
    retry: '重试',

    // ── VIX 半圆表盘（三段 = **波动读数不是涨跌**，禁复用涨跌色） ─────────────
    gauge: {
      title: 'VIX 波动率指数',
      /** FR-017 的字面要求 —— 两个成因各自成句，但都含这四个字。 */
      unavailable: '显示不可用',
      missing: '显示不可用 · 暂无数据',
      /** `read_failed` = 跨 ctx 读故障，与「暂无数据」蓄意分开（server 侧也分开了）。 */
      readFailed: '显示不可用 · 读取失败',
      tierCalm: '平静',
      tierElevated: '抬升',
      tierHigh: '高波',
      /** 图例：阈值与 `thermometer.rules.ts` 的 `VIX_CALM_MAX` / `VIX_ELEVATED_MAX` 同源。 */
      legendCalm: '平静 <20',
      legendElevated: '抬升 20–30',
      legendHigh: '高波 >30',
    },

    // ── 旁列：VVIX + 比值（各带自己的时点标注，FR-020） ───────────────────────
    vvix: {
      title: 'VVIX',
    },
    ratio: {
      title: 'VVIX / VIX',
      /** FR-015：正常带是**读法**不是判据 —— 本片只呈现这行参考，不据此下结论。 */
      normalBand: '正常带 4–6',
      basisPrefix: '共同基准 ',
      /** FR-016：两侧不是同一交易日 ⇒ **不计算**并显式标注。 */
      basisMismatch: '基准不一致 · 不计算',
      /** 任一侧无数据 ⇒ 显式不可用（🚨 MUST NOT 拿单侧推算）。 */
      missing: '不可用 · 缺一侧数据',
      readFailed: '不可用 · 读取失败',
    },

    // ── 锚定标的 IVP 列表（FR-018） ──────────────────────────────────────────
    list: {
      /** 🚨 FR-035 的落字处（禁写 IV30d）。 */
      title: '锚定标的 IVP · 富途标的聚合 IV',
      /** state_branch #22：零锚 ⇒ 列表空态，**表盘照常渲染**（指数维度不挂锚闸）。 */
      empty: '还没有锚 —— IVP 列表为空。指数表盘不依赖锚，照常呈现。',
      goAnchors: '去锚管理',
      /** Edge Case：`excluded` 照常列出并标记（045 语义：锚 = 采集意愿、excluded = 交易意愿）。 */
      excluded: '已排除',
      excludeReasonPrefix: '排除原因：',
    },
  },

  /**
   * 标的链分析报表屏（055，mockup `055-chain-report-states.dc.html`）。
   *
   * 🚨 **三个时点各自成句、🚫 禁合并成一个「数据截至」**（FR-033）—— 报价与持仓量常态下
   *    就不是同一天（美股期权 OI 盘前更新），合成一句会让「活跃度是哪天的」永远说不清。
   *    机械防线在 `chain-report-copy.spec.ts`：三条标注恒为三条、标签互异。
   */
  chainReport: {
    /** 题头 = `<code> · 链分析`（`titleSuffix` 是那半截固定的）。 */
    titleSuffix: ' · 链分析',

    // ── 详情屏入口行（FR-035–FR-037；mockup `055-chain-report-panels.dc.html` 帧 ⑧） ──
    /**
     * 🚨 **FR-037：措辞 MUST NOT 与温度计入口重复** —— 046 已把「全景 ›」给了
     * `ivBlock.panorama`；两个入口文案相同、目的地不同是本片明禁的形态。
     * 机械防线在 `chain-report-entry.rules.spec.ts`（不含「全景」+ 两串互异）。
     */
    entryTitle: '链分析 · 机会分布',
    entrySubtitle: '按价外深度 × 到期日看整条链',
    /**
     * 🚨 **FR-039a：两个时点都要说出来**。报表与选约是两个屏、两次取数，中间可能跨换日或
     * 换批报价 ⇒ 条数不符时那**不是缺陷**（数据真的变了），但一个字都不说它就变成了缺陷。
     */
    drilldownAsOfMismatch: (report: string, leg: string) =>
      `报表读的是 ${report} 的数据，这张表是 ${leg} 的 —— 条数与报表不符是数据真的变了`,
    ivpLabel: '本链 IV 分位',
    ivpUnit: '/ 100 · 近一年',
    /** 三个时点的标签（FR-033）。⚠️ 顺序即语义：交易所今天 → 报价 → 持仓量。 */
    stampMarketDate: '交易日',
    stampQuote: '报价',
    stampOpenInterest: '持仓量',
    /** 报价那条恒带「收盘」后缀 —— 本片只有 EOD 快照一种来源。 */
    quoteClosedSuffix: ' 收盘',
    // ── IV 期限结构曲线（FR-020 / FR-021） ────────────────────────
    curveTitle: '隐含波动率 · 期限结构',
    /** 🚨 `FR-021` 的可见交代 —— 横轴是**列序**不是时间轴，读图的人有权知道。 */
    curveAxisNote: '列序等距 · 非时间轴',

    // ── 网格列头与范围框（FR-009 / FR-009a） ──────────────────────
    /** 月度到期链标（判据在 server，与选约表同一处）。 */
    monthlyChip: '月',
    /** 🚨 列级淡出的**主信号**（Guardrail 7）—— 灰底只是辅，🚫 别只留灰底。 */
    outOfBandChip: '段外',
    /**
     * 两条召回段图例。🚫 **蓄意不写 DTE 天数** —— 那两个区间是 server 的召回常量
     *（`leg-recall.rules.ts`），抄到客户端就是第二份阈值；哪几列归哪一段，范围框本身已经说了。
     */
    bandKeyBuild: '建仓段',
    bandKeyRent: '收租段',
    /** Edge Case：锚 `excluded` ⇒ 报表照常渲染、页头带标记（用户是主动进来的）。 */
    excludedNotice: '该标的已排除出雷达 —— 报表照常，仅供查看',
    retry: '重试',

    /**
     * 五种降级态的说明（055 T017，mockup `055-chain-report-panels.dc.html` 帧 ⑦）。
     *
     * 🚨 **三句两两不同、🚫 不合并成一句「暂不可用」** —— 未就绪（等就有）/ 无现价（行轴无从
     *    定义）/ 读失败（可重试）对用户是三件完全不同的事，合并之后每一种的处置都说不清。
     * 📌 「全被门槛挡下」那句压在**网格下方**（网格照画），与上面三句不是一个槽位。
     */
    degraded: {
      chainNotReady: {
        title: '链数据未就绪',
        text: '该标的还没有任何期权链快照 —— 与「有链但全被门槛挡下」是两回事。',
      },
      noSpot: {
        title: '标的现价暂不可用',
        text: '价外幅度以现价为分母，现价缺失时行轴无从定义。',
      },
      readFailed: {
        title: '链数据读取失败',
        text: '稍后重试，或返回详情页。页头的 IV 分位不受本次失败影响。',
      },
      allGated: {
        title: '这条链上没有过门槛的腿',
        text: '链上有合约，但没有一条落到图上 —— 各自挡在哪一步见下方三行。',
      },
    },
    /** 缺失一律「—」，🚫 不裸 0（同 046 `ivBlock.noValue`）。 */
    noValue: '—',

    // ── 四种格值（FR-010；`Record` 而非 `Partial<Record>`，漏一个编译红） ──────
    metricTabs: {
      buildQuality: '建仓',
      rentAnnualized: '收租',
      allAnnualized: '全腿',
      activity: '活跃度',
    },
    /**
     * 每种格值的读法一行（mockup `.best`）。🚨 **活跃度那条的时点跟 `oiAsOf`**（FR-014）——
     * 与报价常态不同日，用区块级 asOf 会把「没人碰过」说成今天的事。
     */
    metricCaptions: {
      buildQuality: '有效成本相对愿买价 W 的位置，越低越好',
      rentAnnualized: '年化费率 —— 每格取该位置最好的一条',
      allAnnualized: '带 † 的行不参与色阶 —— 权利金里那一段是内在价值，不是租金',
      activity: '持仓量 + 当日成交（张）',
    },
    /** 活跃度时点：与报价同日只说一句，不同日两个时点都说出来（`state_branch` 19）。 */
    asOfPrefix: ' · 截至 ',
    quoteDiffDay: (quote: string) => `，与报价的 ${quote} 不同日`,

    // ── 十字线读数面板（FR-027 / FR-028 / FR-029 / SC-004） ───────────────────
    readoutDteSuffix: ' 天',
    readoutMonthly: '月度',
    readoutStrikePrefix: 'K ',
    readoutLegCount: '格内腿数',
    readoutIv: '本列 IV',
    /** 读数标签随格值变 —— 成色 / 年化 / 活跃度不是一个东西，共用一套标签会读串。 */
    readoutMetricLabels: {
      buildQuality: { best: '最优成色', runnerUp: '次优成色' },
      rentAnnualized: { best: '最优年化', runnerUp: '次优年化' },
      allAnnualized: { best: '最优年化', runnerUp: '次优年化' },
      activity: { best: '最活跃', runnerUp: '次活跃' },
    },
    /** 🚨 `FR-028`：次优为空**显式呈「无」**，🚫 MUST NOT 复述最优值充数。 */
    readoutNoneSingle: '无（仅 1 条）',
    readoutNone: '无',
    /** 🚨 `FR-029`：空格三种成因**各自成句**，🚫 不停留在上一格的读数。 */
    readoutReasonVoid: '该位置链上无合约',
    readoutReasonBlocked: '有腿，但被门槛挡下',
    readoutReasonOutOfBand: '本列不在当前格值的召回段内',
    readoutTip: '竖线同时落在网格这一列与曲线这一点上 · 松手退出',

    // ── 页脚三个互斥计数（FR-034；🚫 MUST NOT 合并成一个总数） ────────────────
    gatePremium: '权利金门槛移出',
    gateRowFloor: '深实值行下界外',
    gateLiveness: '无任何活动',
    /** 每条**各带自己的分母** —— 分母不同是这三条不能相加成一个数的原因。 */
    gateDenominatorTotal: '全量',
    gateDenominatorSkeleton: '骨架',
    gateDenominatorWithinRows: '行内',
    gateUnit: '条',
    /** `SC-006` 的求和恒等式；🚨 对不上账时**整行不显示**，🚫 不说一句错话。 */
    gateHint: (valued: number, total: number) =>
      `三者互斥，与图上 ${valued} 条相加 = 全链 ${total} 条`,
  },

  /** 锚管理列表屏（T022，mockup 帧 ⑤）。 */
  anchorList: {
    title: '锚管理',
    create: '新建锚',
    /** 筛选 chips —— 锚管理这处是**单选**（雷达那处才是多选）。 */
    filterAll: '全部',
    filterPendingReview: '待复审',
    filterExcluded: '已排除',
    /** 逾期红标（FR-004：拒绝交易语义，但行不隐藏、字段照常可读）。 */
    overdue: '复审逾期',
    overdueDays: (days: number) => `复审逾期 ${days} 天`,
    /** FR-005 + Guardrail 12：excluded 在锚列表**必须可见**并带 reason（与雷达默认排除相反）。 */
    excluded: '已排除',
    excludeReasonPrefix: '排除原因：',
    vLabel: 'V',
    wLabel: 'W=0.8V',
    confidenceLabel: 'confidence',
    nextReviewLabel: '下次复审',
    noValue: '—',
    emptyAll: '还没有锚。先建一个锚 —— 雷达与采集工作集都从这里长出来。',
    emptyFiltered: '当前筛选无结果',
    clearFilter: '清除筛选',
    loadFailed: '锚列表加载失败，请下拉重试',
  },

  /** 锚表单屏（T022，mockup 帧 ⑥⑦⑧）。 */
  anchorForm: {
    createTitle: '新建锚',
    save: '保存',
    saving: '保存中…',
    delete: '删除锚',
    deleteConfirmTitle: '删除这条锚？',
    deleteConfirmMessage:
      '删除后该标的不再进雷达，采集工作集下一轮移出；已落库的行情历史与变更痕迹保留。',
    cancel: '取消',
    confirmDelete: '删除',

    // ── 段 ① 选择标的（FR-002 / EC-2） ─────────────────────────────────
    sectionTicker: '① 选择标的',
    tickerSearchLabel: '标的代码 / 名称',
    tickerSearchPlaceholder: '输入代码或名称搜索',
    tickerSearchHint: '来自标的库 · 只能选',
    /**
     * 非受支持市场的搜索结果（065 FR-017 / SC-006）：**可见但不可选 + 一句原因**。
     * 🚫 **MUST NOT 静默过滤掉** —— 搜「茅台」返回空白会让人以为搜索坏了。
     */
    tickerMarketUnsupported: '暂不支持该市场',
    /** EC-2：搜不到即不能建锚，**不提供任何绕过**（FR-002 硬约束）。 */
    tickerNoMatch: '标的库中无此代码 —— 无法建锚',
    tickerNoBypass: '无「仍然保存」绕过路径',
    tickerChange: '更换',
    tickerEmptyHint: '输入代码或名称开始搜索',

    // ── 段 ② 估值输入 ────────────────────────────────────────────────
    sectionValuation: '估值输入',
    vLabel: 'V（愿买价基准）',
    vPlaceholder: '如 170.00',
    confidenceLabel: 'confidence（10 分制）',
    confidencePlaceholder: '0 – 10',
    /** `confidence_source = model` ⇒ 只读、**无编辑入口**（不是 disabled 输入框）。 */
    confidenceReadonly: '来源 model · 只读',
    confidenceEditable: '来源 manual · 可改',
    confidenceModelNote:
      '模型已覆盖本票，confidence 只读。对模型评分有异议时人工位在 L 层，不回头改 confidence。',
    methodLabel: 'method',
    methodPlaceholder: '如 DCF · 估值报告 #24',
    asofLabel: 'asof',
    asofPlaceholder: 'YYYY-MM-DD',

    // ── 段 ③ 派生 · 人工调整位（FR-032 四条） ─────────────────────────
    sectionDerived: '派生 · 人工调整位',
    wLabel: 'W = 0.8V',
    zoneLabel: '四区间',
    lLevelLabel: 'L 层',
    positionCapLabel: '单票上限',
    willingSellLabel: '愿卖锚',
    willingSellLongHold: '长持',
    willingSellRent: '收租',
    /** 单票上限 L4 = null（策略 SoT 未定义 L4 上限）→ 展示「—」，**不自造值**。 */
    noValue: '—',
    /** FR-032 ②：措辞须表达**临时**语义（与 2026-08-01 前的「永久覆盖」区分）。 */
    manualBadge: '人工调整 · 将回落',
    manualHintPrefix: '下次上游刷新将回落为',
    manualUndo: '撤销',
    manualSet: '人工调整',
    manualConfirm: '确定',
    manualCancel: '取消',
    manualPlaceholder: '输入人工值',
    followsUpstream: (upstream: string) => `跟随 ${upstream} 派生`,
    derivedVLabel: '模型值',
    derivedLLevelLabel: '映射档',
    derivedPositionCapLabel: '按生效 L 层派生的',

    // ── 段 ④ 复审 ───────────────────────────────────────────────────
    sectionReview: '复审',
    nextReviewLabel: '下次复审',
    doReview: '做一次复审',
    reviewNote: '跌破 W 触发的「复核锚」也由这个动作解除 —— 无第二个确认状态（FR-013）。',
    overdueAgainstAsof: '建锚即逾期（next_review 早于 asof）',

    // ── 段 ⑤ 排除 ───────────────────────────────────────────────────
    sectionExclude: '交易意愿排除',
    excludedLabel: '排除出雷达',
    excludeReasonLabel: '排除原因',
    excludeReasonPlaceholder: '如：并购整合期，现金流口径不可比',
    excludeNote: '排除 = 交易意愿；采集照常（要停采只能删锚，FR-028）。',

    // ── 段 ⑥ 变更痕迹（plan D15：M1 放表单内） ────────────────────────
    sectionHistory: '变更痕迹',
    /**
     * M1 server 只 ship 了 PIT 还原端点（`GET /anchors/:id/at`），**没有痕迹列表读端** ——
     * 痕迹逐条落库（T008）但无从分页读出。故 M1 表单内是显式「即将可用」而非伪造行。
     * 展示位已按 plan D15 落在表单内，将来加读端只换本段内容、不动结构。
     */
    historyComingSoon: '变更痕迹已逐条落库；列表读端即将可用。',

    // ── 错误映射 ───────────────────────────────────────────────────
    /** EC-7：server 409 的既有锚 id 嵌在 message 串里（ProblemDetail 只透传白名单）⇒ 前端按 ticker 定位。 */
    duplicateAnchor: '该票已有锚，去编辑',
    goEditExisting: '去编辑既有锚',
    invalidInput: '输入不合法，请检查后重试',
    rateLimit: '请求过于频繁，请稍后再试',
    network: '网络异常，请检查网络后重试',
    unknown: '保存失败，请稍后再试',
    loadFailed: '锚加载失败',
  },

  /**
   * 069 清链与行军选档（FR-014/FR-015/FR-016，mockup 帧①③④⑤）。
   *
   * 🚨 **文案单点在此，server 只下发结构化数值**（plan Guardrail 6）：13 类原因的格式化函数
   * 吃契约证据袋、吐一行文本 —— 措辞演进零契约变更。语气纪律（FR-016）：中性、禁感叹号、
   * 两个空态是**诚实空态不是错误** —— 禁错误红语气词（「失败」「异常」保留给真故障）。
   */
  march: {
    /** 收租行推荐章（FR-016）—— 单字，载体同「贴合」标。 */
    recommendBadge: '荐',
    /** 三类劣档灰显微标（凹 #2 / 陈 #3 / 并 #4，只标不删）。 */
    inferiorMarks: {
      concave: '凹',
      stale: '陈',
      merged: '并',
    },
    /** 三态判决（FR-009）。 */
    verdicts: {
      recommended: '推荐档',
      no_qualified: '无合格档',
      untradable: '整梯无可成交',
    },
    /** 两类诚实空态的预期管理文案（FR-016，中性灰非错误）。 */
    emptyNoQualified: '这一梯的前向费率未达到再投资线，暂无值得锁的期限',
    emptyUntradable: '这一梯当前没有可成交的档位，成因见逐档说明',
    /** 弹层遮罩的 a11y 名（点击关闭）。 */
    closeA11y: '关闭期限判决',
    /** 收租行入口的 a11y 提示（plan D5）。 */
    rowA11yHint: '轻点查看该行权价的期限判决',
    /** 弹层题头（T009 消费）。 */
    sheetTitle: (strike: string) => `${strike} 的期限判决`,
    /** 净链小结（「段内/净链/剔/并/标」五计数 → 一行）。 */
    chainSummary: (s: {
      ladderCount: number;
      netChainCount: number;
      removedCount: number;
      mergedCount: number;
      markedCount: number;
    }) =>
      `段内 ${s.ladderCount} 档 · 净链 ${s.netChainCount} · 剔 ${s.removedCount} · 并 ${s.mergedCount} · 标 ${s.markedCount}`,
    /** φ 只读读数行（T009 消费；入参 = 契约证据里的年化小数比例串，无证据时不渲）。 */
    phiReadout: (phi: string) => `再投资线 φ ${marchPct(phi)}`,
    /**
     * 13 类原因文案（FR-015 表逐条）：契约证据 → 「fwd 6.0% < φ 15%」式一行。
     * 🚨 键集 = `LegMarchAuditResponseCategory` 全集（Record 穷举 —— 契约加类不加文案 = 编译红）。
     * 证据缺失一律「—」占位（「不知道」不伪造数字，046 纪律）。
     */
    reasons: {
      crossed_quote: (e: MarchAuditEvidenceResponse) =>
        `报价交叉 买 ${marchPrice(e.bid)} ≥ 卖 ${marchPrice(e.ask)}`,
      concave_dominated: (e: MarchAuditEvidenceResponse) =>
        `凹陷支配 进档 ${marchPct(e.fwd)} < 出档 ${marchPct(e.fwdOut)}`,
      absolute_dominated: (e: MarchAuditEvidenceResponse) =>
        `疑似陈旧报价 权利金 ${marchPrice(e.premium)} ≤ 更短档 ${marchPrice(e.premiumShorter)}`,
      collinear_merged: (e: MarchAuditEvidenceResponse) =>
        `与相邻档共线并段 垂距 ${marchTicks(e.chordDistanceTicks)} < 1 tick`,
      fwd_below_phi: (e: MarchAuditEvidenceResponse) =>
        `远期费率 ${marchPct(e.fwd)} < φ ${marchPct(e.phi)}`,
      decay_rebound_above_beta: (e: MarchAuditEvidenceResponse) =>
        `衰减回升 ${marchDaily(e.decay)} > 前段上限 ${marchDaily(e.decayCap)}`,
      decay_above_gamma_cap: (e: MarchAuditEvidenceResponse) =>
        `衰减超绝对帽 ${marchDaily(e.decay)} > γ ${marchDaily(e.decayCap)}`,
      tier_floor_failed: (e: MarchAuditEvidenceResponse) =>
        `年化 ${marchPct(e.annualized)} < 档界 ${marchPct(e.tierFloor)}`,
      qualified_not_stop: (e: MarchAuditEvidenceResponse) =>
        e.recommendedDteDays === null
          ? '合格，被更长档胜出'
          : `合格，推荐档 ${e.recommendedDteDays}d 更长`,
      stop_oi_below_min: (e: MarchAuditEvidenceResponse) =>
        `持仓 ${marchCount(e.oi)} < 下限 ${marchCount(e.oiMin)}，沿净链回退`,
      ladder_oi_all_below_min: (e: MarchAuditEvidenceResponse) =>
        `持仓 ${marchCount(e.oi)} < 下限 ${marchCount(e.oiMin)}，全梯无过闸`,
      band_out: (e: MarchAuditEvidenceResponse) =>
        `预测带外 |Δ| ${marchPlain(e.absDelta)}，保留供比价`,
      quote_missing: (e: MarchAuditEvidenceResponse) =>
        e.bid === null ? '缺买价，费率不可算' : '缺相邻基准，远期费率不可算',
    },
  },
} as const;

// ═══════════════ 069 march 证据格式化（仅本段消费；缺值一律「—」） ═══════════════

const MARCH_NO_VALUE = '—';

function marchFinite(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** 年化小数比例 → 1 位百分数（`0.060000` → `6.0%`）。 */
function marchPct(raw: string | null): string {
  const n = marchFinite(raw);
  return n === null ? MARCH_NO_VALUE : `${(n * 100).toFixed(1)}%`;
}

/** 每日衰减（年化费率/日，量级 ~1e-4）→ 2 位百分数每日（`0.000900` → `0.09%/日`）。 */
function marchDaily(raw: string | null): string {
  const n = marchFinite(raw);
  return n === null ? MARCH_NO_VALUE : `${(n * 100).toFixed(2)}%/日`;
}

/** 价格 → 尾零收干净（`0.5200` → `0.52`）。 */
function marchPrice(raw: string | null): string {
  const n = marchFinite(raw);
  return n === null ? MARCH_NO_VALUE : `${Number(n.toFixed(4))}`;
}

/** 垂距（tick 单位）→ 2 位 + 单位。 */
function marchTicks(raw: string | null): string {
  const n = marchFinite(raw);
  return n === null ? MARCH_NO_VALUE : `${n.toFixed(2)} tick`;
}

/** 整数计数（OI 等）。 */
function marchCount(value: number | null): string {
  return value === null ? MARCH_NO_VALUE : value.toLocaleString('en-US');
}

/** 已定标小数原样收尾零（|Δ| 等）。 */
function marchPlain(raw: string | null): string {
  const n = marchFinite(raw);
  return n === null ? MARCH_NO_VALUE : `${Number(n.toFixed(4))}`;
}
