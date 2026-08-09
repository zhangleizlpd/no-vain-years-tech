/**
 * 公司画像端口 (016 T010, FR-S06 profile 富化步骤)。
 *
 * 职责单一: 把一批 A 股 stockCode 解析成理杏仁公司类型 (`fs_type`) 并**回写缓存**到
 * `Instrument.lixingerCompanyType`。fundamental 步骤按 fsType 路由到不同端点 (银行/保险/
 * 券商/非金融…), 故须先有 fsType; 但 fsType 极少变 → 独立**低频**维度预热缓存, 避免
 * 每夜全量 fundamental 都重解析 (FR-S06「低频/变更才跑」)。
 *
 * live 实现 = `LixingerCompanyProfileAdapter` (复用 015 `lixinger-adapter.base.ts` 已有的
 * `/cn/company` 解析 + 缓存回写路径); mock = 无外呼 no-op (mock fundamental 不依赖 fsType)。
 */
export const COMPANY_PROFILE_PORT = Symbol('COMPANY_PROFILE_PORT');

export interface CompanyProfilePort {
  /**
   * 批量解析 stockCode → fsType, **副作用**回写 `Instrument.lixingerCompanyType` 缓存。
   * 已缓存的 code 命中即零外呼。返已解析的 `code → fsType` (调用方一般只关心副作用)。
   *
   * 038 T009: `market` 段参数化 (cn/hk) —— 按 market 路由 `/{market}/company` + market-specific
   * fsType 值域 (hk 含房托 `reit`)。调用方按 market 分组后逐组传入。
   */
  resolveCompanyTypes(market: string, codes: string[]): Promise<Map<string, string>>;
}
