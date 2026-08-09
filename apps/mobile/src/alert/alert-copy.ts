import type { AlertConditionItemType, MessageConditionItem, MessageItem } from '@nvy/api-client';

// 021 alert 中文文案常量（mockup AlertScreens/AlertKit 定稿文案单源）。
// 体例对齐 013 watchlist-copy / 014 stock-detail-copy：feature 内集中、组件按段取用。
//
// 023 PR-3 T014：扩 32 词表 meta 镜像（server alert-condition-meta.ts 同 shape，跨 app
// 不直接 import per ADR）+ 4 分类分组 + 无参语义副标题 + 卡片摘要(C)/消息正文(D) 渲染。
// 阈值数字口径对齐 021：恒 2dp，元/倍 空格分隔、% 紧贴（SC-005 既有 4 type 零变化）。

// ============================ 023 词表 meta（mobile 镜像） ============================

/** 4 分类（mockup rail 顺序：价格跟踪 / 估值 / 成交量 / 技术指标）。 */
export const ALERT_CATEGORIES = ['price', 'valuation', 'volume', 'technical'] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/** 参数/阈值形态族（驱动条件库渲染 + 参数 sheet 变体分发，mockup B1-B6e）。 */
export type AlertConditionKind =
  | 'threshold'
  | 'ma'
  | 'window'
  | 'daysPct'
  | 'pctile'
  | 'rsi'
  | 'none';

/** threshold 值域族（server isThresholdInRange 同口径）。 */
export type ThresholdFamily = 'price' | 'percent' | 'positive' | 'pctile' | 'rsi';

/** 均线周期白名单（FR-S02）。 */
export const MA_PERIODS = [5, 10, 20, 60, 120, 250] as const;
/** 新高新低窗口白名单（FR-S02）。 */
export const WINDOW_DAYS = [60, 120, 250] as const;
/** 累计涨跌幅天数白名单（FR-S02）。 */
export const PERIOD_DAYS = [3, 5, 10] as const;
/** 估值分位回看年限白名单（FR-S01）。 */
export const PCTL_YEARS = [3, 5] as const;
/** 无参条件 param sentinel（plan D3，与 server NO_PARAM_SENTINEL 同值）。 */
export const NO_PARAM = 0;

export interface AlertConditionMeta {
  type: AlertConditionItemType;
  category: AlertCategory;
  kind: AlertConditionKind;
  /** 条件库列表显示名（mockup AddCondKit 定稿）。 */
  name: string;
  /** 无参条件行副标题（触发语义说明，mockup A2）；带参类型无。 */
  sub?: string;
  /** 空数组 = 无参（param 必为 sentinel 0）；非空 = param 必在表内。 */
  paramWhitelist: readonly number[];
  /** null = 禁带 threshold（none/ma/window kind）。 */
  thresholdFamily: ThresholdFamily | null;
  /** 阈值单位（sheet 后缀 + 摘要单位）；无阈值/无单位 = null。 */
  unit: string | null;
  /** 仅 rsi kind：新建 sheet 预填默认（FR-S04 70/30）。 */
  defaultThreshold?: number;
}

function meta(
  type: AlertConditionItemType,
  category: AlertCategory,
  kind: AlertConditionKind,
  name: string,
  opts: {
    sub?: string;
    paramWhitelist?: readonly number[];
    thresholdFamily?: ThresholdFamily | null;
    unit?: string | null;
    defaultThreshold?: number;
  } = {},
): AlertConditionMeta {
  return {
    type,
    category,
    kind,
    name,
    sub: opts.sub,
    paramWhitelist: opts.paramWhitelist ?? [],
    thresholdFamily: opts.thresholdFamily ?? null,
    unit: opts.unit ?? null,
    defaultThreshold: opts.defaultThreshold,
  };
}

/**
 * 34 词表 meta（server alert-condition-meta.ts 镜像；分类内顺序 = mockup rail/列表序）。
 * 021 既有 4 type 居首形态不变（FR-S09）。计数 = 34（023 的 32 + 024 盘中 5min 涨/跌超 2）。
 */
export const ALERT_CONDITION_META: Record<AlertConditionItemType, AlertConditionMeta> = {
  // ── 价格跟踪（12）
  PRICE_RISE_TO: meta('PRICE_RISE_TO', 'price', 'threshold', '股价涨到', {
    thresholdFamily: 'price',
    unit: '元',
  }),
  PRICE_FALL_TO: meta('PRICE_FALL_TO', 'price', 'threshold', '股价跌到', {
    thresholdFamily: 'price',
    unit: '元',
  }),
  DAILY_GAIN_OVER: meta('DAILY_GAIN_OVER', 'price', 'threshold', '日涨幅超', {
    thresholdFamily: 'percent',
    unit: '%',
  }),
  DAILY_LOSS_OVER: meta('DAILY_LOSS_OVER', 'price', 'threshold', '日跌幅超', {
    thresholdFamily: 'percent',
    unit: '%',
  }),
  MA_CROSS_UP: meta('MA_CROSS_UP', 'price', 'ma', '股价上穿均线', {
    sub: '收盘价上穿所选均线时提醒（盘后判定）',
    paramWhitelist: MA_PERIODS,
  }),
  MA_CROSS_DOWN: meta('MA_CROSS_DOWN', 'price', 'ma', '股价跌破均线', {
    sub: '收盘价跌破所选均线时提醒（盘后判定）',
    paramWhitelist: MA_PERIODS,
  }),
  NEW_HIGH: meta('NEW_HIGH', 'price', 'window', '创N日新高', { paramWhitelist: WINDOW_DAYS }),
  NEW_LOW: meta('NEW_LOW', 'price', 'window', '创N日新低', { paramWhitelist: WINDOW_DAYS }),
  PERIOD_GAIN_OVER: meta('PERIOD_GAIN_OVER', 'price', 'daysPct', 'N日涨幅超', {
    paramWhitelist: PERIOD_DAYS,
    thresholdFamily: 'percent',
    unit: '%',
  }),
  PERIOD_LOSS_OVER: meta('PERIOD_LOSS_OVER', 'price', 'daysPct', 'N日跌幅超', {
    paramWhitelist: PERIOD_DAYS,
    thresholdFamily: 'percent',
    unit: '%',
  }),
  // 024 盘中 5min 差分（无参 / percent (0,100]）
  PRICE_RISE_5MIN_OVER: meta('PRICE_RISE_5MIN_OVER', 'price', 'threshold', '5分钟涨超', {
    thresholdFamily: 'percent',
    unit: '%',
  }),
  PRICE_FALL_5MIN_OVER: meta('PRICE_FALL_5MIN_OVER', 'price', 'threshold', '5分钟跌超', {
    thresholdFamily: 'percent',
    unit: '%',
  }),
  // ── 估值（10）
  PE_ABOVE: meta('PE_ABOVE', 'valuation', 'threshold', 'PE 高于', {
    thresholdFamily: 'positive',
    unit: '倍',
  }),
  PE_BELOW: meta('PE_BELOW', 'valuation', 'threshold', 'PE 低于', {
    thresholdFamily: 'positive',
    unit: '倍',
  }),
  PB_ABOVE: meta('PB_ABOVE', 'valuation', 'threshold', 'PB 高于', {
    thresholdFamily: 'positive',
    unit: '倍',
  }),
  PB_BELOW: meta('PB_BELOW', 'valuation', 'threshold', 'PB 低于', {
    thresholdFamily: 'positive',
    unit: '倍',
  }),
  DIVIDEND_YIELD_ABOVE: meta('DIVIDEND_YIELD_ABOVE', 'valuation', 'threshold', '股息率高于', {
    thresholdFamily: 'percent',
    unit: '%',
  }),
  DIVIDEND_YIELD_BELOW: meta('DIVIDEND_YIELD_BELOW', 'valuation', 'threshold', '股息率低于', {
    thresholdFamily: 'percent',
    unit: '%',
  }),
  PE_PCTL_ABOVE: meta('PE_PCTL_ABOVE', 'valuation', 'pctile', 'PE 分位高于', {
    paramWhitelist: PCTL_YEARS,
    thresholdFamily: 'pctile',
    unit: '%',
  }),
  PE_PCTL_BELOW: meta('PE_PCTL_BELOW', 'valuation', 'pctile', 'PE 分位低于', {
    paramWhitelist: PCTL_YEARS,
    thresholdFamily: 'pctile',
    unit: '%',
  }),
  PB_PCTL_ABOVE: meta('PB_PCTL_ABOVE', 'valuation', 'pctile', 'PB 分位高于', {
    paramWhitelist: PCTL_YEARS,
    thresholdFamily: 'pctile',
    unit: '%',
  }),
  PB_PCTL_BELOW: meta('PB_PCTL_BELOW', 'valuation', 'pctile', 'PB 分位低于', {
    paramWhitelist: PCTL_YEARS,
    thresholdFamily: 'pctile',
    unit: '%',
  }),
  // ── 成交量（2）
  TURNOVER_RATE_OVER: meta('TURNOVER_RATE_OVER', 'volume', 'threshold', '换手率超', {
    thresholdFamily: 'positive',
    unit: '%',
  }),
  VOLUME_RATIO_OVER: meta('VOLUME_RATIO_OVER', 'volume', 'threshold', '量比超', {
    thresholdFamily: 'positive',
    unit: '倍',
  }),
  // ── 技术指标（10）
  MACD_GOLDEN_CROSS: meta('MACD_GOLDEN_CROSS', 'technical', 'none', 'MACD 金叉', {
    sub: 'DIF 上穿 DEA',
  }),
  MACD_DEATH_CROSS: meta('MACD_DEATH_CROSS', 'technical', 'none', 'MACD 死叉', {
    sub: 'DIF 下穿 DEA',
  }),
  KDJ_GOLDEN_CROSS: meta('KDJ_GOLDEN_CROSS', 'technical', 'none', 'KDJ 金叉', { sub: 'K 上穿 D' }),
  KDJ_DEATH_CROSS: meta('KDJ_DEATH_CROSS', 'technical', 'none', 'KDJ 死叉', { sub: 'K 下穿 D' }),
  KDJ_OVERBOUGHT: meta('KDJ_OVERBOUGHT', 'technical', 'none', 'KDJ 超买', { sub: 'J > 100' }),
  // spec FR-S04 为准（J < 10），非 mockup 笔误 J < 0。
  KDJ_OVERSOLD: meta('KDJ_OVERSOLD', 'technical', 'none', 'KDJ 超卖', { sub: 'J < 10' }),
  RSI_OVERBOUGHT: meta('RSI_OVERBOUGHT', 'technical', 'rsi', 'RSI 超买', {
    thresholdFamily: 'rsi',
    defaultThreshold: 70,
  }),
  RSI_OVERSOLD: meta('RSI_OVERSOLD', 'technical', 'rsi', 'RSI 超卖', {
    thresholdFamily: 'rsi',
    defaultThreshold: 30,
  }),
  BOLL_BREAK_UPPER: meta('BOLL_BREAK_UPPER', 'technical', 'none', 'BOLL 突破上轨', {
    sub: '收盘价上穿布林上轨',
  }),
  BOLL_BREAK_LOWER: meta('BOLL_BREAK_LOWER', 'technical', 'none', 'BOLL 跌破下轨', {
    sub: '收盘价下穿布林下轨',
  }),
};

/** 词表全序（分类内顺序保持，条件库列表 + 测试枚举共用）。 */
export const ALERT_CONDITION_TYPES = Object.keys(
  ALERT_CONDITION_META,
) as readonly AlertConditionItemType[];

/** 分类 → 该类条件 type 序（条件库 rail 切换右列表）。 */
export function conditionsByCategory(category: AlertCategory): AlertConditionItemType[] {
  return ALERT_CONDITION_TYPES.filter((t) => ALERT_CONDITION_META[t].category === category);
}

/** meta 查表（词表外 type → undefined，调用方兜底）。 */
export function metaOf(type: string): AlertConditionMeta | undefined {
  return ALERT_CONDITION_META[type as AlertConditionItemType];
}

/** threshold 值域谓词（per family；NaN/Infinity 一律拒。server isThresholdInRange 同口径）。O(1)。 */
export function isThresholdInRange(family: ThresholdFamily, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  switch (family) {
    case 'price':
    case 'positive':
      return value > 0;
    case 'percent':
      return value > 0 && value <= 100;
    case 'pctile':
      return value >= 0 && value <= 100;
    case 'rsi':
      return value > 0 && value < 100;
  }
}

export const ALERT_COPY = {
  /** 提醒频率三档（sheet 全称 + 卡片信息行短称；默认 DAILY）。 */
  frequency: {
    ONCE_DELETE: {
      title: '仅提醒1次（提醒后删除预警）',
      sub: '仅第1次达到预警条件时提醒',
      short: '仅1次·删除',
    },
    ONCE_DISABLE: {
      title: '仅提醒1次（提醒后关闭预警）',
      sub: '仅第1次达到预警条件时提醒',
      short: '仅1次·关闭',
    },
    DAILY: {
      title: '每日1次',
      sub: '每个交易日第1次达到预警条件时提醒',
      short: '每日1次',
    },
  },
  /** 行情条 5 字段 label（屏 1 / 屏 5 组头同源口径）。 */
  quoteStrip: {
    last: '最新价',
    change: '涨跌额',
    changePct: '涨跌幅',
    limitUp: '涨停',
    limitDown: '跌停',
  },
  /** 预警卡片。 */
  card: {
    noNote: '未备注',
    editA11y: '编辑预警',
    toggleA11y: '启停预警',
    selectA11y: '选择预警',
  },
  /** 列表通用。 */
  list: {
    end: '已经到底了',
    emptyAlerts: '暂无预警，点击下方「添加预警」',
    emptyMessages: '暂无提醒消息',
    loadError: '加载失败',
    retry: '重试',
  },
  /** 屏 1 个股预警列表（+ 1b 多选态；底栏文案屏 5 共用）。 */
  listScreen: {
    title: '预警',
    allAlerts: '全部预警',
    done: '完成',
    selectDelete: '选择删除',
    addAlert: '添加预警',
    selectAll: '全选',
    delete: '删除',
  },
  /** 屏 5 全部预警（多选删/底栏文案复用 listScreen）。 */
  allAlerts: {
    title: '全部预警',
    marketTab: 'A股',
    newAlert: '新建预警',
    empty: '暂无预警，点击下方「新建预警」',
  },
  /** 屏 4 预警对象选择（批量灰字提示复用 editScreen.batchHint）。 */
  targetSelect: {
    title: '预警对象选择-A股',
    tabWatch: '自选',
    tabSearch: '搜索',
    selectA11y: '选择标的',
    goAdd: '去添加',
    searchPlaceholder: '搜索股票',
    emptyHint: '输入股票代码或名称搜索',
    noResult: '未找到相关股票',
    emptyWatchlist: '自选列表为空，去「搜索」添加',
    clear: '清空',
    add: '添加',
  },
  /** 屏 2 编辑/新建预警。 */
  editScreen: {
    titleEdit: '编辑预警',
    titleNew: '添加预警',
    done: '完成',
    sectionTitle: '预警条件',
    metBefore: '同时满足 ',
    metAfter: ' 项条件后预警',
    addCondition: '添加附加条件',
    removeCondition: '删除',
    push: '推送方式',
    pushValue: 'App推送',
    frequency: '提醒频率',
    note: '备注',
    notePlaceholder: '例如：达到预期价格，考虑加仓',
    deleteAlert: '删除预警',
    /** 批量新建提示（FR-M09 灰字，屏 4 同源）。 */
    batchHint: '将为选中的每只股票分别创建预警',
  },
  /** 屏 3 添加条件（023：4 分类 rail，FR-M01）。 */
  addCondition: {
    title: '添加条件',
    searchPlaceholder: '搜条件',
    add: '添加',
    added: '已添加',
    emptySearch: '未找到相关条件',
    /** 4 分类 rail 标签（ALERT_CATEGORIES 同序）。 */
    categories: {
      price: '价格跟踪',
      valuation: '估值',
      volume: '成交量',
      technical: '技术指标',
    },
  },
  /** sheets（7a 提醒频率 / 7b 数值输入 + 023 参数变体族）。 */
  sheet: {
    frequencyTitle: '提醒频率',
    done: '完成',
    confirm: '选好了',
    /** 自绘键盘「确定」键文案（026 US1 值类 / 组合类提交，区别纯周期类「选好了」）。 */
    keypadConfirm: '确定',
    close: '关闭',
    /** 参数 sheet 通用（B1-B6e）。 */
    valuePlaceholder: '输入数值',
    /** 非到价阈值类（百分比/倍/分位）空态占位（026 FR-015）。 */
    numberPlaceholder: '0.00',
    /** 多选 chip 组提示（026 US2，FR-006）。 */
    multiSelectHint: '可多选',
    /** RSI 出域错误态（B6e，FR-M02）。 */
    rsiRangeError: '请输入 0-100 之间的数值',
  },
  /** 屏 6 消息通知（正文格式化文案见 formatMessageBody）。 */
  messages: {
    title: '消息通知',
    tabRemind: '提醒',
    tabTodo: '待办',
    cardTitle: '预警触发',
    bodyInfix: ' 触发预警：',
    actualLow: '今日最低',
    actualHigh: '今日最高',
    actualToday: '今日',
    actualCurrent: '当前',
    actualClose: '今日收盘',
    actualTurnover: '今日换手率',
    actualVolumeRatio: '今日量比',
    valuationDate: '估值日',
    // 024 FR-007 盘中实时口径标注（区别 EOD 收盘价）：到价类标「盘中价 X 元」、5min 差分类标「盘中 ±X%」。
    actualIntraday: '盘中价',
    actualIntradayPct: '盘中',
  },
  /** 操作失败 toast 分流（013 watchlist errorToast 体例）。 */
  errorToast: {
    validation: '预警校验未通过，请检查条件与备注',
    notFound: '预警不存在或已删除',
    rateLimit: '操作太频繁，请稍后再试',
    network: '网络异常，请稍后再试',
  },
} as const;

/** Decimal string → 2dp；非法串原样回显兜底。 */
function fmt2(s: string): string {
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? s : n.toFixed(2);
}

/** 带符号 pct（正值补 +，色盲友好 014 口径）；非法串原样。 */
function signedPct(s: string): string {
  const n = Number.parseFloat(s);
  return Number.isNaN(n) ? s : `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

/** YYYY-MM-DD → MM/DD（估值日标注）；非法串原样回显。 */
function monthDay(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[2]}/${m[3]}` : s;
}

/** 条件名 fallback：词表内出中文名，词表外原样回显 type（服务端演进防御）。 */
export function conditionName(t: string): string {
  return metaOf(t)?.name ?? t;
}

/** 条件单位 fallback：词表外/无单位空串。 */
export function conditionUnit(t: string): string {
  return metaOf(t)?.unit ?? '';
}

/**
 * 参数 sheet 数值输入框空态参考占位（026 FR-014/015）：
 * - 到价类（股价涨到/跌到）：行情就位 →「最新价 <last>」给设值锚点；未就位（last='--'）→ 退回
 *   通用「输入数值」，**不显 '--' 误导值**。
 * - 其余阈值类（百分比/倍/分位/RSI）：「0.00」占位，不强加行情参考。
 * `lastPriceText` 由调用方 `formatPrice(quote)` 给出（未就位为 '--'）—— 复用 015 行情格式化口径、
 * 保持本函数纯（不引 api-client，vitest 可直测）。
 */
export function referencePlaceholder(type: string, lastPriceText: string): string {
  const sheet = ALERT_COPY.sheet;
  if (type === 'PRICE_RISE_TO' || type === 'PRICE_FALL_TO') {
    return lastPriceText === '--'
      ? sheet.valuePlaceholder
      : `${ALERT_COPY.quoteStrip.last} ${lastPriceText}`;
  }
  return sheet.numberPlaceholder;
}

/** 多选剩余名额提示（026 FR-008，N=可再选数）。 */
export function formatRemainingQuota(n: number): string {
  return `最多再选 ${n} 项`;
}

/**
 * 条件摘要行（mockup 卡片 C / 屏 1 体例）：按 kind 模板渲染含参描述。
 * threshold 恒 2dp（元/倍 空格、% 紧贴，021 口径 SC-005）；param 整数原样。
 * 词表外 type → 原样回显兜底（不炸）。
 */
export function formatConditionLine(c: {
  type: string;
  param?: number;
  threshold: string | null;
}): string {
  const m = metaOf(c.type);
  const value = c.threshold == null ? '' : fmt2(c.threshold);
  if (m === undefined) {
    return value === '' ? c.type : `${c.type} ${value}`;
  }
  const name = m.name;
  const param = c.param ?? NO_PARAM;
  switch (m.kind) {
    case 'threshold':
      return m.unit === '%' ? `${name} ${value}%` : `${name} ${value} ${m.unit}`;
    case 'ma':
      return `${c.type === 'MA_CROSS_UP' ? '股价上穿' : '股价跌破'} MA${param}`;
    case 'window':
      return `创${param}日新${c.type === 'NEW_HIGH' ? '高' : '低'}`;
    case 'daysPct':
      return `${param}日${c.type === 'PERIOD_GAIN_OVER' ? '涨' : '跌'}幅超 ${value}%`;
    case 'pctile':
      return `${name} ${value}%（${param}年）`;
    case 'rsi':
      return `${name}(${value})`;
    case 'none':
      return name;
  }
}

/**
 * 编辑屏条件行可点「值」chip 文案（值-only，区别于 formatConditionLine 整句）：
 * 阈值类保留 021 输入原串口径（"13元" / "7%"，**非** 2dp——编辑回显用户输入原值，SC-005）；
 * 带参类显参（"MA20" / "250日" / "5日 10%" / "30%·5年"）；无参类空串（无可编辑值，调用方不渲染 chip）。
 * 词表外 type → 原串兜底。
 */
export function conditionValueLabel(c: {
  type: string;
  param?: number;
  threshold: string | null;
}): string {
  const m = metaOf(c.type);
  if (m === undefined) return c.threshold ?? '';
  const param = c.param ?? NO_PARAM;
  const thr = c.threshold ?? '';
  switch (m.kind) {
    case 'threshold':
      return m.unit === '%' ? `${thr}%` : `${thr}${m.unit ?? ''}`;
    case 'rsi':
      return thr;
    case 'ma':
      return `MA${param}`;
    case 'window':
      return `${param}日`;
    case 'daysPct':
      return `${param}日 ${thr}%`;
    case 'pctile':
      return `${thr}%·${param}年`;
    case 'none':
      return '';
  }
}

/**
 * 命中条件 + 实际值（屏 6 正文片段，mockup 卡片 D）：
 * 估值类（带 dataDate）统一「当前 X，估值日 MM/DD」；其余按 type 语义标注实际值。
 * 旧消息/词表外 type 缺键 → 原样回显兜底（021 path 不炸，plan D7）。
 */
function formatTriggeredCondition(c: MessageConditionItem): string {
  const M = ALERT_COPY.messages;
  const m = metaOf(c.type);
  const actual = fmt2(c.actual);
  if (m === undefined) {
    const value = c.threshold == null ? '' : ` ${fmt2(c.threshold)}`;
    return `${c.type}${value}（${M.actualToday} ${actual}）`;
  }
  const line = formatConditionLine({ type: c.type, param: c.param, threshold: c.threshold });
  // 024 FR-007：盘中触发标实时口径，区别 EOD 收盘价。到价类 → 实时价（元）；5min 差分类 → 实时
  // 涨跌幅（带符号 %）。旧消息缺 priceContext / 显式 eod → 落下方 EOD 路径兜底（向后兼容，plan D7）。
  if (c.priceContext === 'intraday') {
    return m.thresholdFamily === 'percent'
      ? `${line}（${M.actualIntradayPct} ${signedPct(c.actual)}%）`
      : `${line}（${M.actualIntraday} ${actual} 元）`;
  }
  // 估值类：dataDate 仅估值条件携带（FR-S01），统一口径。
  if (c.dataDate != null) {
    return `${line}（${M.actualCurrent} ${actual}，${M.valuationDate} ${monthDay(c.dataDate)}）`;
  }
  switch (c.type) {
    case 'PRICE_FALL_TO':
    case 'NEW_LOW':
      return `${line}（${M.actualLow} ${actual} 元）`;
    case 'PRICE_RISE_TO':
    case 'NEW_HIGH':
      return `${line}（${M.actualHigh} ${actual} 元）`;
    case 'DAILY_GAIN_OVER':
    case 'DAILY_LOSS_OVER':
      return `${line}（${M.actualToday} ${signedPct(c.actual)}%）`;
    case 'PERIOD_GAIN_OVER':
    case 'PERIOD_LOSS_OVER':
      return `${line}（近${c.param ?? ''}日 ${signedPct(c.actual)}%）`;
    case 'MA_CROSS_UP':
    case 'MA_CROSS_DOWN':
    case 'BOLL_BREAK_UPPER':
    case 'BOLL_BREAK_LOWER':
      return `${line}（${M.actualClose} ${actual} 元）`;
    case 'TURNOVER_RATE_OVER':
      return `${line}（${M.actualTurnover} ${actual}%）`;
    case 'VOLUME_RATIO_OVER':
      return `${line}（${M.actualVolumeRatio} ${actual} 倍）`;
    default:
      // 技术指标状态/穿越（MACD/KDJ/RSI）：当前指标值。
      return `${line}（${M.actualCurrent} ${actual}）`;
  }
}

/**
 * 屏 6 消息正文（mockup 体例，文案不进契约 per plan）：
 * 「旭升集团(603305) 触发预警：股价跌到 13.00 元（今日最低 12.80 元）；日跌幅超 7.00%（今日 -7.43%）。」
 */
export function formatMessageBody(
  m: Pick<MessageItem, 'instrumentName' | 'code' | 'conditions'>,
): string {
  const parts = m.conditions.map(formatTriggeredCondition);
  return `${m.instrumentName}(${m.code})${ALERT_COPY.messages.bodyInfix}${parts.join('；')}。`;
}

/** 触发时间 → 「MM/DD HH:mm」（设备本地时区）；非法串空串兜底。 */
export function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
