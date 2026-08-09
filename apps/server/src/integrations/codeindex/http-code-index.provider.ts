import { Injectable, Logger } from '@nestjs/common';
import type { CodeIndexConfig } from '../../config/index.js';
import type { CodeChunk, CodeIndexProvider, RepoCatalogEntry } from './code-index.port.js';

/**
 * HttpCodeIndexProvider (034 T001) — 生产默认 `CodeIndexProvider` 实现，Node 22 内置全局
 * `fetch` (undici) 打 services/code-index 的 HTTP 契约 (server.ts:43,46)，**零新 npm 依赖**。
 *
 * 契约对齐 (services/code-index/src/server.ts):
 * - `POST /search` body `{repo, query, topK?}` → 200 `{results: SearchHit[]}` → 解包 `.results`。
 * - `GET  /repos`  → 200 `{repos: RepoMeta[]}`   → 解包 `.repos`。
 * - 每路要 `Authorization: Bearer <serviceToken>` (auth.ts isAuthorized)；非 2xx (401/400/5xx)
 *   或网络错或超时 → **throw** (上游 UC catch 降级，FR-008)。
 *
 * **token 安全 (plan §Impl Guardrails)**: token 经 env 注入、仅拼进 `Authorization` 头，
 * **绝不入日志、绝不回前端**。分级日志 (warn 非 2xx / error 网络错) 只记 status + 端点路径，
 * 不记 header / token / 响应体。
 *
 * **超时**: 用 `AbortSignal.timeout()` (Node 内置) 与上游传入 signal 经 `AbortSignal.any()`
 * 合并 — 任一触发即中断 fetch (止付 / 断连语义)。AbortError → throw (视作不可达，降级)。
 */

/** 默认请求超时 (ms) — code-index 含 bge-m3 embed，留足冷启动窗 (S1 spike 实测 embed 数百 ms)。 */
const DEFAULT_TIMEOUT_MS = 15_000;
/** /search 默认 topK (与 services/code-index DEFAULT_TOPK 对齐语义；端口不暴露给调用方调参)。 */
const DEFAULT_TOP_K = 8;

@Injectable()
export class HttpCodeIndexProvider implements CodeIndexProvider {
  private readonly logger = new Logger(HttpCodeIndexProvider.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;

  constructor(config: Extract<CodeIndexConfig, { kind: 'http' }>) {
    // 去尾斜杠，避免 baseUrl 末尾 `/` 与 path 头 `/` 拼出 `//search`。
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.serviceToken = config.serviceToken;
  }

  async search(repo: string, query: string, signal?: AbortSignal): Promise<CodeChunk[]> {
    const body = await this.request<{ results?: CodeChunk[] }>(
      '/search',
      {
        method: 'POST',
        body: JSON.stringify({ repo, query, topK: DEFAULT_TOP_K }),
      },
      signal,
    );
    return body.results ?? [];
  }

  async listRepos(signal?: AbortSignal): Promise<RepoCatalogEntry[]> {
    const body = await this.request<{ repos?: RepoCatalogEntry[] }>(
      '/repos',
      { method: 'GET' },
      signal,
    );
    return body.repos ?? [];
  }

  /**
   * 共享 HTTP 执行：拼 URL + Bearer 头 + 超时合并 signal + 非 2xx/网络错 throw + 解析 JSON。
   * 复杂度 O(1) (单次 fetch)；token 仅入 header，错误日志只记 status + path (不记 token/body)。
   */
  private async request<T>(
    path: string,
    init: { method: string; body?: string },
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    // 上游 signal (停止/断连) 与本地超时任一触发即 abort；signal 缺省时仅用超时。
    const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.serviceToken}`,
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: merged,
      });
    } catch (err: unknown) {
      // 网络错 / AbortError (超时或上游 abort) — 不记 token，仅端点 + 错误名。
      const name = err instanceof Error ? err.name : 'UnknownError';
      this.logger.error(`code-index ${init.method} ${path} failed: ${name}`);
      throw err;
    }

    if (!res.ok) {
      // 非 2xx：401 (token 错) / 400 (参数错) / 5xx (服务内部) 分级，只记 status，不记 body/token。
      const level = res.status >= 500 ? 'error' : 'warn';
      this.logger[level](`code-index ${init.method} ${path} → HTTP ${res.status}`);
      throw new Error(`code-index ${init.method} ${path} returned HTTP ${res.status}`);
    }

    return (await res.json()) as T;
  }
}
