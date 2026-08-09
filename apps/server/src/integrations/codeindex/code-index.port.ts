/**
 * CodeIndexProvider port (034 T001, plan §Architecture Notes #1) — code-index
 * 检索服务 (services/code-index, S2 #550/#552) 的 vendor I/O 抽象。
 *
 * external vendor I/O 是 ADR-0043 允许的 port/adapter 场景 (sms / push / llm 同款,
 * 非自有表 repository)，归 integrations 平台层 (ADR-0058 第二位租户，紧随 llm)。
 * provider-agnostic: HttpCodeIndexProvider 是生产绑定 (Node 内置 fetch 打 HTTP)，
 * FakeCodeIndexProvider 是 IT 确定性替身。ideation UC 注入 `CODE_INDEX` 端口即可，
 * 二期换实现不动调用方。
 *
 * **DTO 贫血、ideation/integrations 侧自有** (per ADR-0043): 形状对齐 services/code-index
 * 的 `SearchHit` (query.ts:5) 与 `RepoMeta` (meta.ts:4)，但**不 import** 那侧的类型
 * (integrations 不依赖 services/code-index 源码，仅经 HTTP 契约耦合)。
 *
 * 测试用真 DI 容器 override 此 token 注入 FakeCodeIndexProvider，不 jest.mock
 * (per plan Architecture Notes「NO LIFECYCLE MOCKING」)。
 */

/**
 * 单条命中代码块 — 形状对齐 code-index `SearchHit` (services/code-index/src/query.ts:5)。
 * `symbol` nullable (chunk 可能无显式符号名，如整文件块)。`score` = 1 - cosine 距离 (越大越近)。
 */
export interface CodeChunk {
  relPath: string;
  kind: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

/**
 * repo catalog 单项 — 形状对齐 code-index `RepoMeta` (services/code-index/src/meta.ts:4)。
 * `status`: 'ready' (可检索) | 'indexing' (重建中，前端置灰)。
 */
export interface RepoCatalogEntry {
  repo: string;
  lastSha: string;
  /** ISO-8601 字符串 (HTTP JSON 传输形态；fake 亦用串保持端口契约纯串)。 */
  indexedAt: string;
  chunkCount: number;
  status: 'ready' | 'indexing';
}

/** DI token — ideation UC 注入 `CodeIndexProvider` 接口而非具体类 (便于 IT override)。 */
export const CODE_INDEX = Symbol('CODE_INDEX');

export interface CodeIndexProvider {
  /**
   * 在 `repo` 命名空间内向量检索 `query`，返回 top-k 命中代码块 (provider 内部决定 topK 默认)。
   * `signal` abort → 中断上游 HTTP。非 2xx / 网络错 / 超时 → **throw** (上游 UC catch 降级)。
   */
  search(repo: string, query: string, signal?: AbortSignal): Promise<CodeChunk[]>;
  /**
   * 拉全量已索引 repo 目录 (供 mobile 选库)。非 2xx / 网络错 / 超时 → **throw**
   * (上游 catalog UC catch → 映射可重试错误态)。
   */
  listRepos(signal?: AbortSignal): Promise<RepoCatalogEntry[]>;
}
