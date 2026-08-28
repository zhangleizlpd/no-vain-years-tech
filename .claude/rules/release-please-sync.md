---
paths:
  - 'release-please-config.*.json'
  - '.release-please-manifest.*.json'
  - '.github/workflows/release-please.yml'
  - 'apps/*/CHANGELOG.md'
---

# release-please 同步纪律（path-triggered，触及发版配置 / manifest / CHANGELOG 自动加载）

- **manifest 是版本号唯一来源**：`apps/*/package.json` / `app.json` 的 `version` 由 release-please 同步，不手改；manifest 起步值不能 `0.0.0`。
- **Release PR 永远手动 merge**（label `autorelease: pending: <component>`，两线互斥，AI 不接 auto-merge）。
- **双线各自独立**：改一线的 config / manifest 不动另一线；`release-as` 用完必删；`changelog-sections` 不吃默认（`refactor` 必须可见）。
- `CHANGELOG.md` 是 release-please 产物，不手编（手改会在下次 release 被覆盖或冲突）。

canonical：[`docs/conventions/versioning.md`](../../docs/conventions/versioning.md)（bump 规则 / 可见性 / 发版链 / 上架路线）+ ADR-0042。
