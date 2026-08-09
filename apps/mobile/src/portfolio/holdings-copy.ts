// 自有持仓中文文案（025）。持仓屏（US2）+ 标的交易历史屏（US3）+ 工具栏入口（T014）。
// 非 i18n —— 与 watchlist-copy 同体例（Plan 4 引 i18next）。

export const HOLDINGS_COPY = {
  /** 持仓屏（T012）。 */
  screen: {
    title: '持仓',
    load: { error: '持仓加载失败', retry: '重试' },
    summary: {
      totalValue: '总市值',
      totalPnl: '总累计盈亏',
      /** asOf 标注只出现在汇总条一处（mockup DO-NOT）。 */
      asOfPrefix: '快照截至',
    },
    tabs: { current: '当前持仓', closed: '已清仓' },
    empty: {
      /** App 内导入入口已上线（headerRight「+」/ 空态按钮）；本机同步工具仍可用。 */
      current: { title: '暂无持仓数据', sub: '点右上角「＋」导入，或用本机同步工具' },
      closed: { title: '暂无已清仓记录' },
    },
    /** 持仓导入（App 内入口，复用 server EP1 multipart 直传）。 */
    import: {
      action: '导入持仓',
      a11y: '导入持仓',
      resultTitle: '导入完成',
      errorTitle: '导入失败',
      dismiss: '完成',
      done: '已导入',
      skipped: '跳过',
      rowsUnit: '行',
      unit: { holdings: '持仓', closed: '已清仓', trades: '交易' },
      errors: {
        tooLarge: '文件过大，请确保不超过 2MB',
        invalid:
          '文件格式不正确，请上传同花顺导出的持仓 xlsx（含「持仓数据 / 已清仓 / 交易记录」三个表）',
        rateLimit: '操作过于频繁，请稍后再试',
        auth: '登录状态已失效，请重新登录',
        network: '网络异常，请重试',
        unknown: '导入失败，请稍后重试',
      },
    },
    /** 降级行角标（quotable=false，行情合成列显 `--`）。 */
    noQuote: '无行情',
    sub: {
      weight: '仓位',
      days: '持仓',
      daysUnit: '天',
      cumPnl: '累计盈亏',
      qtyUnit: '股',
      openToClose: '建仓 → 清仓',
      buyAvg: '买入均价',
      sellAvg: '卖出均价',
      vsIndex: '跑赢大盘',
      fee: '费用',
    },
  },
  /** 标的交易历史屏（T013）。 */
  trades: {
    load: { error: '交易记录加载失败', retry: '重试' },
    /** 非法 symbol 兜底（014 体例：占位 + 返回）。 */
    invalid: { title: '标的不存在或链接无效', back: '返回' },
    empty: { title: '该标的暂无交易记录' },
    end: '已经到底了',
    summary: { hold: '持有', cost: '成本', cumPnl: '累计盈亏' },
    /** 类别 badge 单字 + 事件名（买/卖描边圆 badge；息税中性灰不与买卖点混淆）。 */
    category: {
      buy: { badge: '买', label: '买入' },
      sell: { badge: '卖', label: '卖出' },
      xd: { badge: '息', label: '除权除息' },
      dividend_tax: { badge: '税', label: '股息个税征收' },
      repo_out: { badge: '出', label: '质押回购拆出' },
      repo_back: { badge: '回', label: '拆出质押购回' },
      cash: { badge: '资', label: '资金转入转出' },
      unknown: { badge: '他', label: '其他' },
    },
    feePrefix: '费用',
  },
  /** 自选主屏工具栏入口（T014）。 */
  toolbar: { holdings: '持仓' },
} as const;
