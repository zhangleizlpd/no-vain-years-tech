import type { CodeChunk, CodeIndexProvider, RepoCatalogEntry } from './code-index.port.js';

/**
 * FakeCodeIndexProvider (034 T001, plan Gate 0.1) — IT/契约冒烟确定性替身。
 *
 * 真 code-index 检索非确定 (向量召回 / 时延 / 命中随机)，IT 注入本替身得可复现的命中序列 +
 * 可注入「不可达」态，精确驱动 state_branches (命中 / 0 命中 / 服务不可达降级 / catalog 空/错)。
 * 通过 DI override `CODE_INDEX` token 注入 (不 jest.mock，per plan「NO LIFECYCLE MOCKING」)。
 *
 * 编排 (确定性命中脚本):
 * - `hitsByRepo`   — 按 repo 命名空间映射命中 (命名空间隔离测：repoA→hitsA, repoB→hitsB)。
 * - `repos`        — listRepos 返回的 catalog (空数组测空态)。
 * - `unreachable`  — true → search/listRepos 都 throw (模拟服务不可达，驱动 FR-008 降级)。
 *
 * search 默认：repo 在 `hitsByRepo` 有键 → 返其命中；无键 → `[]` (0 命中，与不可达严格分流 FR-009)。
 */
export interface FakeCodeIndexConfig {
  /** 按 repo 命名空间的确定性命中脚本 (未列 repo → 返 [] = 0 命中)。 */
  hitsByRepo?: Record<string, CodeChunk[]>;
  /** listRepos 返回的 catalog (默认空数组)。 */
  repos?: RepoCatalogEntry[];
  /** true → search/listRepos throw `FAKE_CODE_INDEX_UNREACHABLE` (驱动降级 / catalog 错误态)。 */
  unreachable?: boolean;
}

export class FakeCodeIndexProvider implements CodeIndexProvider {
  constructor(private readonly config: FakeCodeIndexConfig = {}) {}

  async search(repo: string, _query: string, signal?: AbortSignal): Promise<CodeChunk[]> {
    this.throwIfAborted(signal);
    if (this.config.unreachable) {
      throw new Error('FAKE_CODE_INDEX_UNREACHABLE: injected service-unreachable');
    }
    // 命名空间隔离：按 repo 取命中；未配置该 repo → 0 命中 (端口正常返空集，非不可达)。
    return this.config.hitsByRepo?.[repo] ?? [];
  }

  async listRepos(signal?: AbortSignal): Promise<RepoCatalogEntry[]> {
    this.throwIfAborted(signal);
    if (this.config.unreachable) {
      throw new Error('FAKE_CODE_INDEX_UNREACHABLE: injected service-unreachable');
    }
    return this.config.repos ?? [];
  }

  /** 尊重 abort (停止/断连)：已 abort 即 throw，模拟真 provider 中断。 */
  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error('FAKE_CODE_INDEX_ABORTED: signal already aborted');
    }
  }
}
