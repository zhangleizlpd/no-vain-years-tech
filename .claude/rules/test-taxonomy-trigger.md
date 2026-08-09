---
paths:
  - 'apps/server/src/**/*.spec.ts'
  - 'apps/server/test/**'
  - 'apps/mobile/src/**/*.spec.ts'
  - 'apps/mobile/src/**/*.spec.tsx'
  - 'apps/mobile/e2e/**'
  - 'scripts/checks/**/*.spec.ts'
---

# 测试分类学（path-triggered，新增 / 改动任何测试文件时自动加载）

写测试前先定 **size**（跑起来要什么资源）—— 这是**机器强制**的轴，判据 = **文件名后缀**：

| size       | 后缀               | 默认执行路径允许什么                                                 | 落哪                                 |
| ---------- | ------------------ | -------------------------------------------------------------------- | ------------------------------------ |
| **Small**  | `*.spec.ts`        | **单进程内**。禁容器、禁真网络、禁磁盘 I/O、禁 sleep                 | server `unit` project；`mobile:test` |
| **Medium** | `*.it.spec.ts`     | 可起进程、可 localhost 网络。**容器 / 本机 server / 浏览器都在这档** | server `it` project；`mobile:e2e` 等 |
| **Large**  | `*.vendor.spec.ts` | **真外网 / 真凭证**，必须 `RUN_<VENDOR>_IT` 门控、默认 skip          | server `it` project，默认全 skip     |

**判据是「默认执行路径」所需的最大资源**——`describe.skipIf(!RUN_XXX_IT)` 门控掉的块不计入。故 Medium 文件里挂一个真 vendor 块，文件**仍是** `*.it.spec.ts`；只有整个文件都被门控才叫 `*.vendor.spec.ts`。

## 新写一个测试的决定顺序

1. **默认写 Small**（`*.spec.ts` + 与源码 colocate）。需要容器 / 浏览器 / 本机 server 才往下。
2. **先试 test double** 换掉那个依赖。换得掉就换（配比锚 ~80% narrow / ~15% integration / ~5% e2e）。
3. **换不掉 → `*.it.spec.ts`**，文件头写一行「为什么必须要真 X」。**PG 绝不自己起容器**，从 `test/_support/isolated-db.ts` 三入口取：
   - 只要 PG → `setupIsolatedDb()`
   - PG + Redis → `setupIsolatedStores()`
   - 自己要跑 `migrate deploy` 并验证其产物 → `setupEmptyDb()`
   - **只要 Redis、不要 PG → 自起 `RedisContainer`**（三入口都会白克隆一个用不上的 PG 库）
4. **要打真 vendor** → 包进 `describe.skipIf(!RUN_<VENDOR>_IT)`，并把 env 名登记进 `scripts/checks/check-env-sync.ts` 的 `ALLOWLIST`。
   ⚠️ 这些 env **无任何 workflow 设置 = 恒 skip**。「测试全绿」对它们覆盖的契约**不构成证据**。
5. **位置**：Narrow colocate / Broad 进 `test/` —— 惯例而非硬约束，存量例外都是蓄意的，别当缺口补。

## 机器会拦你的七条

`scripts/checks/check-test-size.ts`（PR 门 `gate-checks` job，全扫）：

1. `apps/server/src` 下非 `.it.` / `.vendor.` 的 spec 禁 import `@testcontainers/*` 或共享 PG helper
2. 任何 spec 读真 vendor `RUN_*_IT` env 就必须有 `skipIf` 门控
3. `*.vendor.spec.ts` 每个顶层 `describe` 都必须被 vendor 门控
4. `apps/mobile/src` 下的 spec 禁 Playwright import
5. `apps/server/test/` 下只许 `*.it.spec.ts` / `*.vendor.spec.ts`
6. `apps/mobile/e2e/` 下禁 `.it.` / `.vendor.` 后缀（该目录单一档 Medium，目录即坐标）
7. `scripts/checks/` 下禁 size 后缀、禁容器 / 共享 PG / Playwright import

> **没被机器拦 ≠ 合规。** 上面「决定顺序」的第 3 步存储选型、文件头理由、配比取舍都**不在守卫覆盖内**，是 review 与自觉的事。

## 单源真理

- 分类学完整版（两个轴为什么正交、命名决策记录、存量 grandfather 规则、规范自身怎么验）→ [`docs/conventions/testing.md`](../../docs/conventions/testing.md)
- 各类测试跑在哪个环境、吃什么 env、隔离到什么级别、常驻陷阱 → [`docs/conventions/test-environment-matrix.md`](../../docs/conventions/test-environment-matrix.md)
- 照抄结构的测试样板 → [`docs/conventions/golden-sample-registry.md`](../../docs/conventions/golden-sample-registry.md)
- 本地怎么跑、哪些失败是环境骗你的 → [`docs/conventions/local-verification.md`](../../docs/conventions/local-verification.md)
