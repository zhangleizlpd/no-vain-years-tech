---
adr_id: ADR-0039
status: Accepted
applies_to: [mono-wide]
sunset_trigger: |
  - 引入 SLO 框架 (Linkerd / Istio SLO / Datadog SLO) — perf budget 走外部工具
  - 引入 APM (Datadog / New Relic) — perf IT 走真生产 trace 而非合成
  - 业务 < 10 endpoint (overhead > benefit)
---

# ADR-0039: Performance and Latency Governance — spec frontmatter SSOT + lefthook ≤ 30s + nightly perf IT

- Status: Accepted
- Deciders: project owner
- Tags: backend / mobile / performance / governance / cross-cutting

## Context

Plan 1 W3 实装 FR-S06 (single-endpoint enumeration defense IT) 时实证:

- 性能预算无 SSOT — `FR-S06` 写 P95 ≤ 50ms 在 spec.md 文字段,但 IT 测试硬编码 `EXPECTED_P95_MS = 50` 未关联
- lefthook 慢: 全包 typecheck 在 commit 时跑 ~50s,频繁触发反复破纪律(memory `feedback_avoid_slow_pre_commit_or_pre_push`)
- CI 长: 全包 build + test + lint + perf IT 串行 ~ 8min, 还在上升轨道
- perf IT 是否每 CI 跑 — 慢测试拖累 fast feedback

memory `feedback_env_gated_perf_it_pattern` 已确立 `RUN_PERF_IT + PERF_IT_REPS` env-gate pattern, 但缺统一 frontmatter SSOT 喂数据。

## Decision

### 1. spec frontmatter `perf_budgets:` SSOT

```yaml
---
perf_budgets:
  - endpoint: POST /api/v1/phone-sms-auth
    p95_ms: 200
    p99_ms: 500
    timing_defense:
      diff_p95_ms: 50 # 反枚举不同路径 P95 wall-clock 差 ≤ 50ms
  - endpoint: GET /api/v1/accounts/me
    p95_ms: 50
    p99_ms: 100
---
```

- 每 endpoint 显式 p95/p99 (毫秒)
- timing-defense 类(反枚举)显式 `diff_p95_ms`
- spec.md frontmatter 是单一来源,plan.md 不重复写

### 2. plan.md derived (禁手 edit)

`scripts/checks/plan-compiler.ts` (PR-6 ship; 原 `scripts/orchestrator/`,2026-06-13 随 B 退役迁出，perf-budget 治理保留): spec frontmatter → plan.md `## Performance Budget` 段自动生成 + commented `<!-- auto-generated from spec.md frontmatter; do not edit -->`.

### 3. vitest setup 注入 EXPECTED_P95_MS env

`scripts/inject-perf-env.ts` 或 vitest `globalSetup`:启动时读 staged spec 的 `perf_budgets`,export 到 `process.env.EXPECTED_P95_MS_<ENDPOINT_SLUG>` → perf IT 用 `parseFloat(process.env.EXPECTED_P95_MS_PHONE_SMS_AUTH)`,不硬编码。

### 4. lefthook ≤ 30s 硬上限

`pre-commit` total wall-clock ≤ 30s.分而治之:

- `lefthook.yml` `parallel: true`
- 单 hook 慢操作 (typecheck / prisma generate) 用 `glob:` 限定 staged 文件,nx affected 跑增量
- `--skip-nx-cache` 仅在 staged 含新文件时强制(per memory `feedback_nx_cache_false_green_on_new_files`)

### 5. CI fast ≤ 10min

主分支 PR check 跑:typecheck / lint / unit test / build — 全用 nx affected.
慢 e2e + perf IT 分流到 `nightly-perf.yml` workflow,跑 main 分支每晚 1 次.

### 6. nightly perf IT 软预警

`.github/workflows/nightly-perf.yml`:

- 触发: `cron: '0 19 * * *'` (UTC 19:00 = 北京 3:00)
- job: `RUN_PERF_IT=1 PERF_IT_REPS=300 pnpm nx run server:test:perf`
- 结果超 P95 阈值 → 软通知 (PR comment / Slack 接入 Plan 3) 不阻塞 CI
- 不调 spec frontmatter — 数据驱动 issue 改 spec / 改实现

## Consequences

- PR-1 amend spec-template.md 加 `perf_budgets` 字段 + spec.zod 校验 (可选字段,有则结构校验)
- PR-6 ship 完整: spec → plan derived script + vitest setup inject + nightly-perf workflow
- 现有 spec 001 `FR-S06` 50ms 阈值:PR-1 C5 spec frontmatter backfill 时迁入 `perf_budgets:`

## Trade-offs

- nightly perf IT 不阻塞 = 不能保证 PR 引入回归 — 接受 (perf IT 慢,blocking 会拖累节奏);PR 引入退化由 nightly 24h 内捕
- spec frontmatter 持续累积可能臃肿 — schema 限定字段集 + lint enforced

## References

- memory `feedback_env_gated_perf_it_pattern`
- memory `feedback_avoid_slow_pre_commit_or_pre_push`
- memory `feedback_nx_cache_false_green_on_new_files`
- [ADR-0023](0023-sms-code-storage-hmac.md) (FR-S06 实证起源)
