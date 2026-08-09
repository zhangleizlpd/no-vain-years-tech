# Plan: 000-autoimpl-selftest（🧪 自测 fixture）

> 🧪 THROWAWAY。仅供 `/sdd-auto-impl --dry-run`。**单 PR**（per Constitution §V v1.3.0 单 PR 模型——本 fixture 也不拆 PR 策略段）。

## 技术上下文

- **dry-run 闭环覆盖**：子 agent 写 `sandbox/<file>.ts` → 跑 `node -e` 断言（**不走 nx vitest**，sandbox 不在 project graph）→ **dry-run 不真 git commit**，改为在结果契约里报 `commit_sha: "DRY-RUN"` + would-be subject。
- **路径**：一切落 `specs/000-autoimpl-selftest/sandbox/`（fixture-local `.gitignore` 丢弃）。
- **零依赖 / 零真实模块 / 零网络**。

## 锚点（子 agent brief「相关现有代码」用）

- T002 必读 T001 产出 `sandbox/echo.ts`（验干净上下文 handoff）。
- T003 必读 `spec.md` FR-003 + SC-003（会发现精度未定 → 应 blocked）。

**Plan Version**: 1.0.0 | **Created**: 2026-06-13
