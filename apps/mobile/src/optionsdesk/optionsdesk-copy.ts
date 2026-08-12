// 045 期权台文案单源（mockup 帧 ①~⑩ 逐字）。T024 在此追加雷达五态文案。
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
    /** 计数条 —— 分母恒取逻辑集合长度，**不是渲染窗口大小**（SC-012）。 */
    rowTotal: (total: number) => `共 ${total} 行`,
    /**
     * state_branch：从无快照 —— **非空页非错误页**（FR-014），且 MUST **说明何时会有**。
     * 🚨 后半句不是客套：新建锚当天进来的人看到「未就绪」会以为坏了；给出「下一次美股收盘后
     *    的采集轮次」才把它从故障读成事实。措辞与采集节律（EOD 轮次）一致，别写成「稍后重试」。
     */
    chainNotReady:
      '期权链数据未就绪 —— 该标的尚未被快照覆盖。采集在每个美股交易日收盘后跑一轮，下一轮覆盖到它就能读。',
    readFailed: '选约表读取失败',
    retry: '重试',
    /** 零适格腿：Tab 可进入、面板**不隐藏不置灰**（FR-021）。 */
    empty: '该 Tab 暂无适格腿 —— 面板照常可读',
    /** DTE 两段式提示（mockup 帧 ①~④ 页脚，逐字）。 */
    dteTip: 'DTE 两段式 · ① 先让到期日盖过已知利空出清点（财报后）② 再在其后留方向性缓冲。',
    dteTipAnnualNote: '折年仅作周化行参照，不跨 DTE 追年化最大化。',
    /** 🚨 FR-011 常驻页脚 —— 这九个字是 T035 e2e 的断言锚，别改。 */
    disclaimer: '触发 ≠ 开仓 —— 人工终决',

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
      cost: '成本vsW',
      delta: 'Δ',
      sigma: 'σ距',
      oi: 'OI',
      vol: 'Vol',
      turnover: '成交额',
      activity: '活跃',
      mark: '标注',
      action: '动作',
    },
    /** 列头副标。`rate` 的那条随口径换（见下方三条），Δ 这条恒在。 */
    columnSubDelta: '带判据',
    /**
     * 费率列头 —— **列头即口径本身**（051 FR-017a：不在其上再套「费率」这层通用标题）。
     * 🚨 取值域与服务端 `basisByTab` 一一对应，映射单点在 `leg-picker.rules.ts`；
     *    客户端 MUST NOT 自带一份「Tab → 口径」的第二实现（FR-017）。
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
    /** 腿族口径徽标（全腿 Tab 每行标，FR-019）。 */
    basisWeekly: '周',
    basisAnnualized: '年',
    /** 数值缺失的统一占位 —— 与「建仓腿按设计无财报标」共用同一个字形（FR-006 收敛后只剩一义）。 */
    noValue: '—',

    // ── 三 Tab + 意图条 + 水位 chip（047 T033；mockup 帧 ①~③ 逐字）──────────
    /**
     * 三个 Tab（FR-002）。🚨 **三个恒可进入、恒不置灰** —— 空 Tab 是空态不是禁用态（FR-020），
     * 未选水位也不锁任何一个（FR-017）。
     */
    tabs: {
      all: '全腿',
      build: '建仓腿·周化',
      rent: '收租腿·年化',
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
     * 🚨 未选水位时收租腿 Tab 的**就地注明**（047 plan D-SOT-4）：Δ 档取三档并集而非静默取一档。
     *
     * ⚠️ **050 起本行已不成立, 但蓄意留到 P2（051）再改** —— server 的 `RENT_DEPTH_UNION_BAND`
     * 已随召回换代整条删除（Δ 退出召回判据，FR-009），未选水位时收租 Tab 展示的是**该 DTE 段的
     * 全部召回腿**、与 Δ 无关，只是**零推荐标**。本片是纯 server 片（零 mobile 行为改动），
     * 改文案属显示口径跟进 ⇒ 归 051。留着的是一句**过时但不误导操作**的注解（它描述的范围比
     * 实际更窄，不会让人少看到腿）。
     */
    rentDepthUnionNote: '水位未选 → 展示全部 Δ 档（0.05–0.40Δ）',

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
    /** 建仓腿整列无财报标是**设计**不是缺数据（与「无日期」两回事）。 */
    legendBuildNoEarnings: '建仓腿按设计无财报标 —— 建仓意图本就想接货。',

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
} as const;
