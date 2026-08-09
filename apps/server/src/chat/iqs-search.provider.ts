import { Logger } from '@nestjs/common';
import type { IqsConfig } from '../config/iqs.config.js';
import type { SearchProvider, SearchResult, SearchOptions } from './search-provider.port.js';

/**
 * IqsSearchProvider (030 T002, plan D2) — 阿里云 IQS GenericSearch HTTP adapter。
 *
 * 主路:Node 22 内建 `fetch` **GET** `<baseUrl>/search/genericSearch?query=<q>`,header
 * `X-API-Key: <env>`。**零新 npm dep**。归一化 `pageItems[]` → `SearchResult[]`
 * (`link→url` / `publishTime→publishedAt` / `markdownText??mainText→content`)。
 *
 * ⚠️ D2 实测定稿 (2026-06-18, T003 RUN_IQS_IT 真连通): GenericSearch 标准接口是
 * **GET + query 参数** (非 POST+JSON;POST 返 404)。GET 默认即返 markdownText/mainText/
 * publishTime/snippet,无需额外 returnMarkdownText 参数。HTTP 主路可用 → 不切 SDK 回退。
 *
 * 超时:per-search 硬超时 8s (plan D2;perf p95≤2500ms 留余量) → throw,由 send-message
 * loop 降级 (FR-009)。abort:调用方 `opts.signal` 与 8s timeout 合并 (`AbortSignal.any`),
 * 任一触发即中断在途 HTTP (FR-011 停止生成)。
 *
 * 测试缝:构造器可注入 `fetchFn` (默认全局 `fetch`),IT/单测注入 stub 验归一化/超时/错误,
 * 无需 mock 全局 (DI 层仍走真容器, per plan「NO LIFECYCLE MOCKING」—— 此处是 adapter
 * 内部 I/O 缝,非 DI port mock)。
 */

/** per-search 硬超时 (ms);超时 throw → loop 降级。 */
export const IQS_SEARCH_TIMEOUT_MS = 8000;

/** 注入式 fetch 形状 (全局 `fetch` 的最小子集,便于测试 stub)。GET 无 body。 */
export type FetchFn = (
  input: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** IQS GenericSearch 响应单条 (grounding:pageItems[])。字段可缺,归一化兜底。 */
interface IqsPageItem {
  title?: string;
  link?: string;
  snippet?: string;
  publishTime?: number | string;
  markdownText?: string;
  mainText?: string;
}

/**
 * 归一化 IQS 响应 → SearchResult[] (纯函数,可单测)。
 * - `link→url`:无 link 的条目丢弃 (url 是来源/去重主键,缺则无意义)。
 * - `publishTime→publishedAt`:数字直取,字符串 `Date.parse` 兜底,非法/缺省则不带。
 * - `content = markdownText ?? mainText`(喂模型正文,可能长)。
 */
export function normalizeIqsResponse(json: unknown): SearchResult[] {
  const items = (json as { pageItems?: unknown })?.pageItems;
  if (!Array.isArray(items)) return [];
  const out: SearchResult[] = [];
  for (const raw of items as IqsPageItem[]) {
    const url = raw?.link;
    if (typeof url !== 'string' || url.length === 0) continue;
    const publishedAt = toEpochMs(raw.publishTime);
    out.push({
      title: raw.title ?? url,
      url,
      snippet: raw.snippet ?? '',
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...((raw.markdownText ?? raw.mainText) ? { content: raw.markdownText ?? raw.mainText } : {}),
    });
  }
  return out;
}

/** publishTime → epoch ms;数字直取,可解析字符串 Date.parse,否则 undefined。 */
function toEpochMs(v: number | string | undefined): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

export class IqsSearchProvider implements SearchProvider {
  // 付费外部调用,info 级记 query+命中数 (同 AliyunSmsGateway 范式) 便于追成本/延迟/命中率;
  // 检索动静本不写服务端日志 (只走 SSE tool_* 帧 + message.metadata),此 logger 是唯一服务端观测点。
  private readonly logger = new Logger(IqsSearchProvider.name);

  constructor(
    private readonly config: IqsConfig,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
    // 硬超时 ms;默认 8s (生产)。构造器缝便于单测注小值验超时映射,无需真等 8s。
    private readonly timeoutMs: number = IQS_SEARCH_TIMEOUT_MS,
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    if (this.config.kind !== 'aliyun') {
      // mock 配置下被实际调用 = 误配 (未设 IQS_PROVIDER=aliyun 且未走 CHAT_FAKE_SEARCH)。
      throw new Error(
        'IQS not configured: set IQS_PROVIDER=aliyun + IQS_API_KEY, or CHAT_FAKE_SEARCH=1 for tests',
      );
    }
    // 调用方 signal + 硬超时合并:任一触发即 abort 在途 fetch。
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([opts.signal, timeout]);

    // GET + query 参数 (D2 实测;query 经 URLSearchParams 转义, 防中文/特殊字符破坏 URL)。
    const url = `${this.config.baseUrl}/search/genericSearch?${new URLSearchParams({ query }).toString()}`;
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: { 'X-API-Key': this.config.apiKey },
        signal,
      });
    } catch (err) {
      // 超时触发的 AbortError 归一为可读超时错误 (调用方 signal 触发则透传中断语义)。
      if (timeout.aborted && !opts.signal.aborted) {
        throw new Error(`IQS search timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    }
    if (!res.ok) {
      throw new Error(`IQS search failed: HTTP ${res.status}`);
    }
    const results = normalizeIqsResponse(await res.json());
    // 控 context 预算:IQS 默认返 ~10-18 条, 按 maxResults 截取 (loop 传 top-K=5)。
    const out =
      opts.maxResults && opts.maxResults > 0 ? results.slice(0, opts.maxResults) : results;
    this.logger.log(`IQS search "${query}" → ${out.length} result(s)`);
    return out;
  }
}
