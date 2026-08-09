import { describe, it, expect } from 'vitest';
import { IqsSearchProvider } from '../../src/chat/iqs-search.provider.js';

// ── env-gated 真 IQS 连通冒烟 (RUN_IQS_IT) ──────────────────────────────────────
//
// 默认 skip (CI 不打外网 + 无 key)。本地显式跑 (真 key 见下) 真连阿里云 IQS GenericSearch
// 验 D2 HTTP 主路: 真 key 调 genericSearch → 返 pageItems[] 经 normalizeIqsResponse
// 可归一化为非空 SearchResult[]。
//
// 🚨 D2 硬前置 (plan): HTTP 主路若不通 (404/弃用/签名要求) → 切回退 SDK
// `@alicloud/iqs20241111`(复用已装 @alicloud/openapi-core AK/SK), 两路同归一化、不动 port。
// 实测结论 (HTTP 通 / 需切 SDK / 价格配额) 记录于本 task commit message。
//
// ⚠️ key 来源 = `process.env.IQS_API_KEY` (非读 .env 文件)。理由: vitest.config test.env
// **没有** IQS 占位 (mock 默认 boot 不需 key), 故 process.env 的真值不被覆盖 —— 与 RUN_LLM_IT
// 必须读文件绕 DEEPSEEK 占位 不同。真 key 存主 repo `apps/server/.env`(worktree `.envrc`
// `set -a; source` 之, runbook §worktree「Don't create local .env」), 运行时:
//   IQS_API_KEY="$(...主 .env 取值...)" RUN_IQS_IT=1 env -u OSS_* nx test server <file>
// (非交互 Bash 不挂 direnv, 故显式注入而非依赖 .envrc 自动 source)。
const RUN_IQS_IT = process.env.RUN_IQS_IT === '1' || process.env.RUN_IQS_IT === 'true';

describe.skipIf(!RUN_IQS_IT)('030 真 IQS 连通冒烟 (env-gated RUN_IQS_IT, 默认 skip)', () => {
  it('真 key 调 genericSearch → pageItems[] 可归一化为非空 SearchResult[]', async () => {
    const apiKey = process.env.IQS_API_KEY;
    if (!apiKey) {
      throw new Error(
        'RUN_IQS_IT set but IQS_API_KEY missing in process.env (注入主 repo .env 的真值)',
      );
    }
    const provider = new IqsSearchProvider({
      kind: 'aliyun',
      apiKey,
      baseUrl: process.env.IQS_BASE_URL ?? 'https://cloud-iqs.aliyuncs.com',
    });

    const controller = new AbortController();
    const results = await provider.search('上海今天天气', {
      signal: controller.signal,
      maxResults: 5,
    });

    // 真连通: 返回非空、字段归一 (url 必有, 来源/去重主键)。
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.url).toBe('string');
      expect(r.url.length).toBeGreaterThan(0);
    }
    // eslint-disable-next-line no-console
    console.log(`[RUN_IQS_IT] results=${results.length} firstUrl=${results[0]?.url}`);
  }, 20_000);
});
