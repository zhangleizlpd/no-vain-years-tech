/**
 * SearchProvider port (030 T001, plan D1) — chat ctx 联网检索后端的 vendor I/O 抽象。
 *
 * 与 `llm-provider.port.ts` 同款:external vendor I/O 是 ADR-0043 允许的 port/adapter
 * 场景 (sms / push gateway 同款,非自有表 repository)。provider-agnostic:阿里云 IQS 仅是
 * `SearchProvider` 的一个实现 (`iqs-search.provider.ts`);二期换 Bocha/Tavily 仅加新实现,
 * 不动 send-message ReAct loop 编排 (plan D4)。
 *
 * 实现:
 * - IqsSearchProvider   — 生产默认绑定 (阿里云 IQS GenericSearch HTTP API, key 仅 server env)。
 * - FakeSearchProvider  — IT 确定性替身 (scripted results + 可注入 error/timeout/空结果, 尊重 signal)。
 *
 * 测试用真 DI 容器 override 此 token 注入 FakeSearchProvider, 不 jest.mock
 * (per plan Architecture Notes「NO LIFECYCLE MOCKING」)。
 */

/** DI token — send-message UC 注入 `SearchProvider` 接口而非具体类 (便于 IT override)。 */
export const SEARCH_PROVIDER = Symbol('SEARCH_PROVIDER');

/**
 * 单条检索结果 (provider 归一化后的中性形状,plan D1)。
 * - `title` / `url` / `snippet` 为来源列表展示 + 引用必需。
 * - `publishedAt` (epoch ms, 可选):IQS `publishTime` 归一,用于时效判断/展示。
 * - `content` (可选):IQS `markdownText??mainText` 归一,喂回模型作答的正文,可能较长。
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: number;
  content?: string;
}

/**
 * search 调用选项 — `signal` 透传上游 provider 的 HTTP `fetch`, abort 时取消在途检索
 * (停止生成语义, FR-011);`maxResults` 控喂回模型的 top-K 条数 (默认 5, 控 context 预算)。
 */
export interface SearchOptions {
  signal: AbortSignal;
  /** 返回结果上限 (top-K), 控 context 预算;provider 未约束则由调用方 topK 截取。 */
  maxResults?: number;
}

export interface SearchProvider {
  /**
   * 联网检索:对 `query` 调外部搜索后端,归一化为 `SearchResult[]` (oldest-first 即原始排序)。
   * `opts.signal` abort → 中断上游 HTTP;超时/error → throw (由 loop 降级处理, FR-009)。
   * 零结果返空数组 (非 error, 模型据空结果作答, 不标 degraded)。
   */
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}
