# Specification Analysis Report: 003-tokens

**Scope**: cross-artifact consistency across [`spec.md`](./spec.md) / [`plan.md`](./plan.md) / [`tasks.md`](./tasks.md) + `.specify/memory/constitution.md`
**Date**: 2026-05-25 | **Mode**: read-only（不改 spec/plan/tasks）

## Findings

| ID | Category | Severity | Location | Summary | Recommendation |
|----|----------|----------|----------|---------|----------------|
| C1 | Coverage | MEDIUM | spec FR-S10 / US2-AC4 / US5-AC4 | 「刷新/登出 MUST NOT 主动失效旧 access token，旧 access 至其 15min 过期前仍有效」无显式测试 task（无状态设计自然满足，但 spec 立为不变量） | 在 T013（rotate IT）+ T018（logout-all IT）各加 1 断言：操作后用旧 access token 调受保护端点仍 200（未到期）。无需新 task |
| C2 | Coverage | MEDIUM | spec SC-S02 | 「原文不落盘」要求「全代码路径 + 日志 grep 不出现 refresh token 原文」，但无显式验证 task | 折入 T026 verify：加一条 grep 静态检查（持久化/日志层无原文）；或在 T005 persist 单测断言入库值 = hash 非原文 |
| C3 | Coverage | LOW | spec FR-S03 | refresh token「256-bit 高熵生成」依赖既有 `JwtTokenService.generateRefreshToken()`，无新 task（有意复用） | 无需动作；T010 rotate 复用既有生成器即满足，建议 T010 单测断言新 refresh ≠ 旧、长度/字符集符合 base64url |
| I1 | Inconsistency | LOW | spec `status: draft` / plan `status: drafted` / tasks `status: ready` | 三件 frontmatter lifecycle 标签不同 | 设计如此（各文件生命周期独立）；T025 收尾统一 bump，无需现在改 |
| T1 | Terminology | LOW | 全三件 | 「refresh-token 记录 / record / `RefreshToken` model」混用 | 语义一致（同一表），不影响实现；保持 |
| D1 | Ambiguity | LOW | plan Client side | device id 生成/存储落点「倾向 `~/auth` 既有 store 旁」措辞略软 | T021 已钉到 `apps/mobile/src/auth/`；impl 起手确认即可，无歧义阻塞 |

> **0 CRITICAL / 0 HIGH**。无 Constitution MUST 冲突、无零覆盖核心需求、无 spec↔plan↔tasks 矛盾。

## Coverage Summary（21 FR + 14 SC）

| Requirement | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-S01 持久化 | ✅ | T005, T006, T007 | |
| FR-S02 device 来源/回退 | ✅ | T005, T006 | X-Device-Id 头 + 回退 |
| FR-S03 token 强度/仅哈希 | ✅* | T002, T010 | 256-bit 复用既有生成器（C3） |
| FR-S04 refresh 端点 | ✅ | T010, T011, T012 | |
| FR-S05 血缘继承 | ✅ | T010, T013 | |
| FR-S06 单次使用 | ✅ | T010, T013 | |
| FR-S07 轮换原子性 | ✅ | T010 | |
| FR-S08 并发乐观保护 | ✅ | T010, T015 | |
| FR-S09 refresh 反枚举 | ✅ | T011, T014 | |
| FR-S10 access 无状态 | ⚠️ | （无显式测试） | C1：建议折入 T013/T018 断言 |
| FR-S11 logout-all 端点 | ✅ | T016, T017, T018 | |
| FR-S12 logout-all 隔离 | ✅ | T016, T018 | |
| FR-S13 logout-all 鉴权 | ✅ | T017, T018 | |
| FR-S14 限流 | ✅ | T012, T017, T019 | |
| FR-S15 错误格式 | ✅ | T012, T014 | 复用既有 ProblemDetail filter |
| FR-S16 bounded context | ✅ | T011, T025, T026 | 跨 ctx 注释 + catalog + moat check |
| FR-C01 透明续期拦截 | ✅ | T022 | |
| FR-C02 single-flight | ✅ | T022 | |
| FR-C03 防循环 | ✅ | T022 | |
| FR-C04 device 标识 | ✅ | T021 | X-Device-Id 注入 |
| FR-C05 logout wrapper | ✅ | T023 | |
| SC-S01 持久化覆盖 | ✅ | T007 | |
| SC-S02 原文不落盘 | ⚠️ | （无显式验证） | C2：建议折入 T026/T005 |
| SC-S03~S09 | ✅ | T013/T013/T010/T015/T018/T019 | 轮换/单次/原子/并发/幂等/限流 |
| SC-S10 模块边界 | ✅ | T025, T026 | |
| SC-C01~C04 | ✅ | T022, T024 | 透明续期/single-flight/防循环/冒烟 |

**覆盖率**：FR 21/21 有 task（FR-S10 有 task 覆盖端点但缺专项断言）；SC 14/14（SC-S02 缺专项验证）。所有有 buildable 工作的 SC 均有 task。

## Constitution Alignment

| 原则 | 状态 |
|---|---|
| I. SDD（NON-NEGOTIABLE） | ✅ spec→clarify→plan→tasks→analyze（本）→implement 全程在轨 |
| II. Test-First TDD（NON-NEGOTIABLE） | ✅ 每 impl task 内联绑 RED unit 测试；6 个 [Server-IT] = 各 US Independent Test |
| III. Atomic 30min-2h + 独立 commit | ✅ 26 task 颗粒符合；Dependencies 段标明顺序 |
| IV. Module Boundary（扁平+贫血+护城河） | ✅ auth/security/account 边界 + 跨 ctx 注释（T011）+ moat check（T026） |
| V. 类型同步链 Nx-driven | ✅ T020 export-openapi → Orval regen → mobile 消费，同 PR |

**无违反**。

## Unmapped Tasks

无。26 个 task 全部映射到 FR/SC/US 或为必需基座（T001-T004 Setup/Foundational）、Contract（T020）、Polish（T025-T026）。

## Metrics

- Total Requirements：21 FR（16 FR-S + 5 FR-C）+ 14 SC（10 SC-S + 4 SC-C）
- Total Tasks：26（T001-T026）
- Coverage：FR 100% 有 task；2 项（FR-S10 / SC-S02）缺**专项断言/验证**（MEDIUM，可折入既有 task）
- Ambiguity Count：1（D1，LOW）
- Duplication Count：0
- Critical Issues：0 | High：0 | Medium：2 | Low：4

## Next Actions

- **0 CRITICAL / 0 HIGH → 可进 `/speckit-implement`**。
- 建议（非阻塞，impl 时顺手做）：
  1. C1 → T013 + T018 各加「旧 access token 操作后仍有效」断言。
  2. C2 → T026 加「日志/持久化无 refresh token 原文」grep；或 T005 单测断言入库 = hash。
  3. C3 → T010 单测断言新 refresh 与旧不同 + base64url 格式。
- 这 3 条是对**既有 task 内的断言增强**，不新增 task、不改 spec/plan 结构 → 可在 implement 阶段直接做，无需回 `/speckit-tasks`。
