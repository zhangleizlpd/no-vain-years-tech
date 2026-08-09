// 012 券商账户绑定中文文案单源。非 i18n —— 与 market-copy / 既有 settings COPY 体例一致
// （Plan 4 引 i18next 再抽）。券商显示名来自 client broker-catalog（V1 硬编码字典），
// 本文件只放 UI chrome 文案 + 错误提示（行内重复 / 删除失败 toast / 加载失败）。
export const BROKER_COPY = {
  // 页 A 列表（FR-M01/M02）。
  list: {
    title: '股票账户',
    create: '新建',
    defaultTag: '系统默认',
    defaultSubtitle: '本账号 · 未归类持仓的默认归属',
    boundTag: '已绑定',
    delete: '删除',
    deleteConfirm: '确认删除该券商账户？',
    empty: '暂无绑定券商账户',
  },
  // 页 B 绑定表单（FR-M04）。
  bind: {
    title: '绑定券商',
    selectBroker: '选择券商',
    selectBrokerPlaceholder: '请选择券商',
    clientNoLabel: '客户号',
    clientNoPlaceholder: '请输入客户号',
    submit: '绑定',
  },
  // 页 C 券商选择弹层（FR-M05）。
  picker: {
    title: '选择券商',
    searchPlaceholder: '搜索券商名称 / 简拼',
    empty: '未找到匹配的券商',
  },
  // 首屏 GET 失败 fallback（FR-M / Mobile Edge）。
  load: {
    error: '加载失败，请重试',
    retry: '重试',
  },
  // 错误分流文案（FR-M08）：行内重复（409）/ 表单校验（400）/ 删除失败 toast / 通用网络错。
  error: {
    duplicate: '该券商账户已绑定，请勿重复添加',
    validation: '客户号有误，请检查后重试',
    deleteFailed: '删除失败，请重试',
    network: '网络异常，请重试',
  },
} as const;
