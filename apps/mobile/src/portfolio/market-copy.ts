// 证券市场设置页中文文案单源（011 portfolio）。非 i18n —— 与既有 settings COPY
// 体例一致（Plan 4 引 i18next 再抽）。市场显示名 / ISO 码来自 server 响应（FR-M06，
// 不在客户端硬编码字典），本文件只放 UI chrome 文案 + 错误 toast。
export const MARKET_COPY = {
  title: '证券市场',
  groups: {
    core: '核心',
    overseas: '海外',
  },
  comingSoon: '即将支持',
  // min-1 客户端预判拦截轻提示（FR-M05 / SC-M03）。
  minOneHint: '至少保留一个激活市场',
  // settings/index.tsx 投资设置 Card 入口（D5）。
  entry: {
    card: '投资',
    stockMarket: '证券市场',
    broker: '券商账户',
  },
  // 首屏 GET 失败 fallback（FR-M / Mobile Edge：不渲染错误默认态）。
  load: {
    error: '加载失败，请重试',
    retry: '重试',
  },
  // 切换失败 errorToast（FR-M07）：min-1（422 兜底）与通用错误文案区分。
  errorToast: {
    minOne: '至少保留一个激活市场',
    rateLimit: '请求过于频繁，请稍后再试',
    network: '网络异常，请重试',
  },
} as const;
