---
adr_id: ADR-0040
status: Accepted
applies_to: [mono-wide]
sunset_trigger: |
  - Nx EOL / Anthropic Agent SDK 换框架 — Nx affected 不再可用
  - 测试基建被某新框架（如 Playwright Component Testing 一站式覆盖
    server + mobile + visual diff）成熟替代
  - e2e gate 误伤率 > 5% 持续 1 月 — gating 反噬开发体验
---

# ADR-0040: Multi-layer Test Gate Strategy — 机制 / 策略 / 门禁 三段渐进

- Status: Accepted (2026-05-22, PR-T3 ship)
- Deciders: project owner
- Tags: testing / ci / nx / spec-kit / governance / cross-cutting

## Context

PR #79 (PR-5 tail) retro 显示 PR #65 / PR-5a/5b/5c 共 8 处 cascade bug 中 6 处源自「merged 但从未真实端到端跑过」反模式。`gh pr merge --auto` + 单元/lint/typecheck CI 全 GREEN ≠ runtime 正确。深层根因：「成功完成」标准漏了 runtime 这一层。

并行 Explore 审计揭示当前 Nx 策略结构性缺失：mobile e2e target 存在但 CI 不调；server `test` 混 unit + integration；无 `--skip-nx-cache` 纪律；orchestrator 无 project.json 不在 nx affected 图；prisma schema 改动不会撕全盘 cache。

详见主 plan: [`docs/private/plans/2026-05/05-22-test-infra-master.md`](../private/plans/2026-05/05-22-test-infra-master.md)

## Decision

用 **3 阶段渐进结构** 修复：

| 阶段        | 心法                                | 性质 | 出错代价        |
| ----------- | ----------------------------------- | ---- | --------------- |
| **L1 机制** | 先把验证脚本写出来、本地裸跑得通    | 能力 | 单纯不可用      |
| **L2 策略** | 再用 Nx 包装托管 + 自动触发         | 调度 | 可用但人工触发  |
| **L3 门禁** | 最后 GitHub ruleset / lefthook 强制 | 强制 | 反噬：误拦好 PR |

设计纪律：**L1 不通不写 L2；L2 不稳不上 L3**。

### 接口契约（master 锁定，sub-plan 不得违反）

- **P1 → P2**：P1 产出 `scripts/ci/server-boot-smoke.ts` standalone tsx + spec-kit templates/schemas 升级；P2 把脚本 wrap 成 `nx run server:runtime-smoke` target，不改脚本内部
- **P2 → P3**：P2 产出 nx affected 跨包链路 + nx.json cache 失效树 + ESLint scope 边界；P3 ci.yml 调 `nx affected --target=runtime-smoke`，不重写脚本
- **P1 ↔ P3**：P1 引入 `state_branches` 字段 + `🚨 Testing Invariants` 段；P3 lefthook anti-mock 正则配套拦 `new MyGuard()` 类违反

## 5 钢钉

1. **Server runtime smoke**（PR-T1 起）— Testcontainers + 真 NestFactory boot + 真 HTTP fetch + 3 断言（no 500 / RFC 9457 shape / traceId 串联）；脚本 `scripts/ci/server-boot-smoke.ts`
2. **spec `state_branches` 字段**（PR-T1 起 optional / P3 转 required）— 强制 spec 阶段穷举状态分支，喂下游 `/speckit-tasks` 生成 exhaustive integration test 任务
3. **plan-template `🚨 Testing Invariants` 3 禁令**（PR-T1 起）— NO LIFECYCLE MOCKING / MANDATORY INTEGRATION / EXHAUSTIVE BRANCHING；orchestrator 注入 LLM prompt 时硬性约束
4. **nx affected 跨包传导**（PR-T2）— server endpoint 改 → api-client regen → mobile e2e 自动触发；prisma schema 改 → 全盘 cache 失效；ESLint scope 边界 enforce
5. **PR validation 门禁**（PR-T3）— `.github/workflows/pr-validation.yml` 跑 `nx affected ... runtime-smoke` + PR template checkbox 扫描 Action；branch ruleset required checks 加上述 jobs；lefthook anti-mock 正则拦 commit-msg 层

## Rollout 路径

3 个 PR 严格串行：

```text
PR-T1 (机制层 — docs/private/plans/2026-05/05-22-test-infra-p1-runtime-smoke.md)
  ├─ scripts/ci/server-boot-smoke.ts standalone tsx
  ├─ spec-kit preset 0.2.1 → 0.2.2 (3 模板插桩 + state_branches 字段)
  └─ 本 ADR stub Proposed
       ↓ merged
PR-T2 (策略层 — docs/private/plans/2026-05/05-22-test-infra-p2-nx-tracks.md)
  ├─ nx run server:runtime-smoke + mobile:runtime-smoke target
  ├─ nx.json cache 失效树 (prisma schema → sharedGlobals)
  └─ ESLint scope:* 边界电网
       ↓ merged
PR-T3 (门禁层 — docs/private/plans/2026-05/05-22-test-infra-p3-ci-gates.md)
  ├─ .github/workflows/pr-validation.yml + nightly-sweep.yml
  ├─ PR template + unchecked-blocker Action
  ├─ lefthook anti-mock 正则
  ├─ branch ruleset required checks 更新
  └─ 本 ADR amend → Accepted（含三阶段实际 ship 证据）
```

## Sandbox E2E 终局验收

3 PR 全 merge 后，模拟 Agent ship 一个最小 feature 验证体系拦截能力 — 详见主 plan「Sandbox E2E 终局验收」段。通过门槛：4 类逆向测试 ≥ 3 类被对应 gate 拦截。

## 三阶段 ship 证据

| 阶段    | PR            | 实际 ship 内容                                                                                                                                                                                                                     |
| ------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 机制 | #80           | `scripts/ci/server-boot-smoke.ts` standalone tsx + spec-kit preset 0.2.2 (state_branches optional / Testing Invariants 3 禁令 / T003 模板) + 本 ADR stub Proposed                                                                  |
| L2 策略 | #81           | `nx.json` namedInputs.sharedGlobals 4 核弹 + targetDefaults strict DAG + 5 projects scope tag + api-client implicitDeps + mobile static-export runtime-smoke (5/5 Playwright in 3.6s) + ESLint default-deny boundary               |
| L3 门禁 | PR-T3 (本 PR) | `.github/pull_request_template.md` 3 checkbox + `lefthook.yml` no-bad-mocks 正则拦 + `.github/workflows/{pr-validation,nightly-sweep}.yml` + spec.zod state_branches required (0.3.0) + spec 001/002 backfill + ruleset gh api PUT |

## 已关闭的 Open Questions（PR-T2/PR-T3 决策）

- **mobile `runtime-smoke` static export vs dev server** → static export 胜（PR #81 实证 3.6s vs ~60s dev server）；保留 `mobile:e2e` 走 dev server 作本地 DevX
- **GH Actions PR body parser** → official `actions/github-script@v7` + 严格段落抽取 regex `### 🚨 部署与存活前置确认[\s\S]*?(?=\n###?\s|$)`
- **lefthook anti-mock 正则精度** → user blueprint `new [A-Za-z0-9_]+\(` 收紧为 `new[[:space:]]+[A-Za-z_][A-Za-z0-9_]*(Guard|Interceptor|Filter|Pipe|Repository)[[:space:]]*\(` + `createTestingModule[[:space:]]*\(` 严格函数调用形态 + POSIX 字符类（macOS BSD grep 兼容）；grep 现有 specs 仅命中 3 个 known violations，不误伤其他

## Sandbox E2E 终局验收（PR-T3 ship 后）

详见主 plan「Sandbox E2E 终局验收」段。通过门槛：4 类逆向测试 ≥ 3 类被对应 gate 拦截。

## References

- 主 plan：[`docs/private/plans/2026-05/05-22-test-infra-master.md`](../private/plans/2026-05/05-22-test-infra-master.md)
- PR #79 retro：see 主 plan § Context
- spec-kit preset：`.specify/presets/mono-orchestrator-ready/preset.yml`（版本以该文件 `version:` 字段为准）
