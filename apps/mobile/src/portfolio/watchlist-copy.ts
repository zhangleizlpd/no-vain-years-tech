// 自选列表中文文案（013）。错误 toast 文案先在 T014 hooks 落地；屏内标题 / 空态 / 长按菜单 /
// 分组管理 / 添加入口文案由 T015-T018 扩展。非 i18n —— 与 market-copy 同体例（Plan 4 引 i18next）。

export const WATCHLIST_COPY = {
  errorToast: {
    /** 系统组「自选 / 持仓」改名或删除被拒（SYSTEM_GROUP_PROTECTED 422）。 */
    systemProtected: '系统分组不可重命名或删除',
    /** 持仓组为派生只读视图，写入被拒（HOLDINGS_GROUP_READONLY 422）。 */
    holdingsReadonly: '持仓分组为自动派生,不可手动增删或调整',
    /** 目标分组不存在 / 已被删（GROUP_NOT_FOUND 404）。 */
    groupNotFound: '分组不存在或已被删除',
    /** 自选项不存在 / 已被删（WATCHLIST_ITEM_NOT_FOUND 404）。 */
    itemNotFound: '标的不存在或已被移除',
    /** 限流（RATE_LIMIT_EXCEEDED / 429）。 */
    rateLimit: '操作过于频繁,请稍后再试',
    /** 网络 / 5xx 兜底。 */
    network: '操作失败,请检查网络后重试',
  },
  /** 屏1 主列表（T015）。 */
  main: {
    title: '自选',
    load: { error: '自选加载失败', retry: '重试' },
    columns: { name: '名称', last: '最新', pct: '涨幅', change: '涨跌' },
    pinnedBadge: '顶',
    add: '添加自选',
    emptyHoldings: {
      title: '持仓数据待导入',
      // 025 点亮：持仓组 = holding 表派生（导入后份额 > 0 且可识别的标的自动出现）。
      sub: '在持仓页点「＋」导入，或用本机同步工具；份额 > 0 的标的将自动出现在此组',
    },
    emptyGroup: {
      title: '这个分组还没有标的',
      sub: '点右上角 + 添加，或长按其他标的移动到这里',
    },
  },
  /** 屏2 长按菜单（T016）。6 项 + 颜色 / 归属子面板。 */
  menu: {
    delete: '删除',
    pin: '固顶',
    unpin: '取消固顶',
    moveFront: '移到最前',
    moveBack: '移到最后',
    colorGroup: '分组·颜色',
    note: '笔记',
    /** 笔记为外部特性，V1 仅留入口（spec Out of Scope）。 */
    noteComingSoon: '笔记功能即将推出',
    sectionGroup: '归属分组',
    sectionColor: '颜色标记',
    clearColor: '清除颜色',
  },
  /** 屏3 分组管理（T017）。 */
  groups: {
    title: '全部分组',
    create: '新建分组',
    namePlaceholder: '输入分组名称',
    confirm: '完成',
    rename: '重命名',
    deleteGroup: '删除分组',
    systemBadge: '系统',
    hidden: '已隐藏',
    countSuffix: '个标的',
    showLabel: '显示分组',
    hideLabel: '隐藏分组',
    dragHandle: '拖拽排序',
    moreActions: '更多操作',
    footnote: '系统组「自选 / 持仓」仅可隐藏与拖拽排序，不可删除或重命名。拖动右侧手柄调整顺序。',
  },
  /** 添加自选入口（T018）。 */
  add: {
    title: '添加自选',
    searchPlaceholder: '输入代码或名称，如 600519 / 茅台',
    emptyHint: '输入代码 / 名称开始搜索',
    noResult: '未找到匹配标的',
    addTo: '加入',
    submit: '加入自选',
  },
} as const;
