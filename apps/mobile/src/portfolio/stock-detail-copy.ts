// 股票详情中文文案常量（014 mobile）。随各 task 增量补齐（T006 起：nav 标题 + us gate 占位）。

export const STOCK_DETAIL_COPY = {
  /** 动态路由 Stack 标题（screen 自带 nav 时不显，硬刷新兜底用）。 */
  navTitle: '详情',
  /** us 市场 gate 占位（D9：016 marketScope=['cn'] 未同步 us → 零数据）。 */
  usGate: {
    title: '美股即将上线',
    sub: '美股行情数据正在接入中，敬请期待。',
    back: '返回',
  },
  /** 固定 3-Tab（富途式，默认图表）。 */
  tabs: {
    chart: '图表',
    analysis: '分析',
    company: '公司',
  },
  nav: {
    back: '返回',
  },
  /** 详情加载/错误态。 */
  load: {
    error: '行情数据加载失败',
    retry: '重试',
  },
  /** 分析 Tab（T014 US7）：研报容器 V1 占位，指向独立研报 PRD（OQ2/FR-M09）。 */
  analysis: {
    title: '研报功能即将上线',
    sub: '完整研报阅读能力将在独立版本中提供',
  },
  /** 公司 Tab（T011）：5 分区卡（估值/分位/财务/身份/公司行动）+ 分位条 + 空态。 */
  company: {
    cards: {
      valuation: '估值',
      percentile: '估值分位 · 理杏仁',
      financials: '财务衍生',
      identity: '静态身份',
      actions: '公司行动',
    },
    valuation: {
      peTtm: 'PE (TTM)',
      peStatic: 'PE (静)',
      peDynamic: 'PE (动)',
      pb: 'PB',
      ps: 'PS',
      dividendYield: '股息率',
      marketCap: '总市值',
      circMarketCap: '流通市值',
    },
    percentile: {
      peY5: 'PE 历史百分位 (5年)',
      peY3: 'PE 历史百分位 (3年)',
      pbY5: 'PB 历史百分位 (5年)',
      pbY3: 'PB 历史百分位 (3年)',
      low: '低估',
      high: '高估',
    },
    financials: { roe: 'ROE', grossMargin: '毛利率', eps: 'EPS (TTM)', bps: 'BPS' },
    identity: {
      name: '名称',
      code: '代码',
      market: '市场',
      type: '证券类型',
      currency: '币种',
      range52w: '52周高/低',
    },
    actions: {
      empty: '暂无分红 / 拆股记录',
      types: { dividend: '分红', split: '拆股', allotment: '配股' },
    },
  },
  /** 图表 Tab K 线（T010）：周期/复权切换 + OHLC legend + 空态。 */
  chart: {
    periods: { day: '日K', week: '周K', month: '月K', quarter: '季K', year: '年K' },
    adjusts: { none: '不复权', forward: '前复权', backward: '后复权' },
    legend: { open: '开', high: '高', low: '低', close: '收', change: '涨跌' },
    volume: '成交量',
    empty: '暂无 K 线数据',
    error: 'K 线加载失败',
    retry: '重试',
  },
  /** 报价 header（图表 Tab 首屏，EOD 字段网格 + 数据新鲜度 + 阶段二预留，D10/FR-M02）。 */
  quote: {
    fields: {
      prevClose: '昨收',
      peTtm: '市盈率TTM',
      pb: '市净率PB',
      dividendYield: '股息率',
      marketCap: '总市值',
      circMarketCap: '流通市值',
    },
    /** 阶段二盘中字段预留区（dashed 占位，不重排，FR-M02）。 */
    phase2Hint: '盘中行情（最高/最低/今开/量比等）即将上线',
  },
  /** 固定底栏（同花顺式 4 项，T012）：预警 / 笔记（disabled）/ 加·删自选（窄义）/ 编辑分组。 */
  bottomBar: {
    alert: '预警',
    note: '笔记',
    /** 未在系统「自选」组 → 「自选」（加）；已在 → 「已自选」（删），D1 对称翻。 */
    addWatch: '自选',
    inWatch: '已自选',
    editGroups: '编辑分组',
    /** disabled 项（预警/笔记）tap 轻提示后缀（OQ1/FR-M09）。 */
    comingSoonSuffix: '功能即将上线',
  },
  /** 编辑分组 sheet + 新建分组弹框（T013，同花顺式 multi-select，全复用 013 端点）。 */
  editGroups: {
    title: '编辑分组',
    close: '关闭',
    newGroup: '新建分组',
    done: '完成',
    /** 账号无非持仓组（极端，系统组首写才物化）。 */
    empty: '暂无可选分组，点「新建分组」创建',
    /** 居中新建分组弹框（复用 013 createGroup，无颜色/无快速建组/无分享，D11）。 */
    create: {
      title: '新建分组',
      sub: '为该股新建一个自选分组',
      placeholder: '分组名称',
      cancel: '取消',
      confirm: '确定',
    },
  },
} as const;
