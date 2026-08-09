# AI Agent Friction Catalog v1

> Symptoms / 实证场景 / 缓解策略,sourced from A-002 ship retro + Plan 1 W2-W5 实证。每条 entry 对应 spec frontmatter `agent_friction_observed=true` 时 `agent_friction_notes` 可引用的 catalog ID。

## How this catalog is used

- **spec frontmatter**: 业务 spec ship 后 retro，若 LLM 协作中撞到本 catalog 已记的模式 → spec.md frontmatter `agent_friction_observed: true` + `agent_friction_notes: "<catalog-id>: <一句话现象>; <catalog-id>: ..."`。schema (per `mono-orchestrator-ready`，真相源 `.specify/schemas/mono-orchestrator-ready/spec.zod.ts`) 强制 notes ≥ 10 字符。
- **新模式触发**: 撞到本 catalog 未记的新摩擦模式 → 加 entry 到本文件 v(N+1) 段 + spec 引用。
- **ADR 联动**: 每个 entry 关联 1+ ADR (有则缓解措施已立; 无则为 backlog candidate)。

---

## v1 — 6 patterns (post-A-002 retro)

### F-001 · TS-Bundler-Mismatch

**症状**: `tsconfig` 用 `moduleResolution: nodenext` (Node.js ESM hard rule) 反前端 bundler 生态 (Vite / Metro / Webpack) 期望 — `.js` 后缀强加在 `.ts` source 编辑期 IDE 红线;Metro 解析失败 `.js → .ts` 找不到。

**实证**:

- PR #65 `@hey-api/openapi-ts` 输出 `import './schemas.js'` → Metro 解不开 (Issue #68)
- PR #67 `packages/auth/src/*` 显式 `.js` 后缀被 sweep 删

**LLM 摩擦**: agent 默认按 Node.js ESM 规则 (训练数据 dominant) 加 `.js` 后缀, IDE auto-import 配 nodenext 时也加,前端 PR 反复修。

**缓解 ADR**: [ADR-0029](../adr/0029-ts-module-resolution-policy.md) (base = `bundler`, apps/server override = `nodenext`)

---

### F-002 · Typecheck-Boot-Gap

**症状**: `nx run-many --target=typecheck --all` 通过不等于 runtime boot OK — e.g. `AppModule` init 触发 `PrismaService.$connect()` + `ioredis` 连接,CI 无外部依赖即挂 EPIPE / connection refused。

**实证**:

- memory `feedback_nest_app_module_full_boot_needs_external_deps` — vitest 测 NestJS swagger metadata 用 controllers-only test module,禁 full AppModule boot
- W1.4 W3 阶段反复撞: typecheck green → CI run test fail (PG/Redis 未起)

**LLM 摩擦**: agent 默认相信 typecheck pass = correctness pass,跳过 boot smoke; CI fail 才发现 boot 路径需要 testcontainers。

**缓解**:

- unit test 用 controllers-only test module (per memory)
- e2e 走 Testcontainers (per [ADR-0019](../adr/0019-orm-prisma.md) IT 章节)

---

### F-003 · Pnpm-Strict-vs-Expo-Hoist

**症状**: pnpm 默认 `shamefully-hoist=false` (社区"正确"做法) 与 Expo SDK + RN Metro 期望 `node_modules/` flat 对抗 — peer dep 解析失败,`expo-modules-autolinking` 扫不到顶层 packages。

**实证**:

- A-002 ship 中 PR #66 (publicHoistPattern 半解) + PR #67 (`shamefully-hoist=true` 全解)
- 11+ Expo peer dep 雪崩补到 root package.json

**LLM 摩擦**: agent 默认遵循 pnpm best practice strict mode,撞 Metro 报错时反复加 publicHoistPattern,最终才接受 `shamefully-hoist`。

**缓解 ADR**: [ADR-0028](../adr/0028-monorepo-pnpm-policy.md) (`shamefully-hoist=true` + 文档化 sunset trigger)

---

### F-004 · Interactive-CLI-Block

**症状**: LLM agent 撞到 interactive prompt CLI (e.g. `expo prebuild`, `prisma init`, `gh auth login`) → 30-60s 等待 → timeout / cancel,卡 task 进度。

**实证**:

- memory `feedback_orchestrator_llm_cwd_must_match_target_paths` (5 类 LLM-subprocess 盲区之一)
- W1.4 实证 `prisma migrate dev` 一次性 prompt 命名输入 — wrapper 半自动化已 ship 进 [ADR-0035](../adr/0035-data-layer-governance.md)

**LLM 摩擦**: agent 看不到 prompt 提示,bash subprocess 默认非交互;脚本作者得显式 `--name <verb>_<obj>` flag pass-through 才能让 LLM 调用。

**缓解**:

- CLI wrapper 强制 `--name` / `--non-interactive` flag (per ADR-0035 prisma-migrate wrapper)
- 凡 LLM 触发的 CLI step 必须 flag 化所有 prompt 输入

---

### F-005 · Untyped-Error-Code-Hallucination

**症状**: 后端业务错误返回 `code` 字段 (e.g. `AUTH_LOCKED`),OpenAPI 未声明各 endpoint 的 code union → 前端 LLM agent switch 时编造不存在的 code (e.g. `AUTH_BANNED` / `USER_FROZEN`),compile pass 但 runtime 永不命中。

**实证**:

- A-002 ship 前 mobile 端 ProblemDetail 消费 fallback chain 缺失,各处手写 `if (err.message === '...')` 反模式
- memory `feedback_smoke_test_catches_spec_drift` (错误处理代码必须列所有 wrapper 类型)

**LLM 摩擦**: agent 看 ProblemDetail.code 字段 string 类型 → 编造业务合理的 code 字符串 (训练数据风格),无 schema enforce。

**缓解 ADR**: [ADR-0038](../adr/0038-error-handling-ux-contract.md) (OpenAPI `allOf` per-endpoint code union + Orval codegen 产 typed enum)

---

### F-006 · Indirect-Spec-Module-Mapping

**症状**: spec `modules:` 字段值 (业务概念 e.g. `auth` / `account`) 与代码物理路径 (`apps/server/src/<module>/`) 应严格 1:1,但实际:

- `auth` module 既含 JWT (security 关注点) 又含 account profile (account 关注点) → LLM 加 `changePhone` use case 时错向放 `auth/`
- ADR `applies_to` 字段缺失 / 误读 (e.g. ADR-0018 SWC 被误读为 mono-wide,实际 backend-only)

**实证**:

- A-002 ship retro 发现 `src/auth/domain/Account.ts`（旧分层；ADR-0043 已退 domain/ 扁平化）实体名与 module 不符
- ADR-0018 SWC 段落被 mobile-task LLM 加载浪费 token

**LLM 摩擦**: agent 拉相关 ADR / spec 上下文时按"看起来相关"判断,无 programmatic filter,易引入噪声或漏关键约束。

**缓解 ADR**:

- [ADR-0024](../adr/0024-spec-feature-first-layout.md) (spec frontmatter `modules:` SSOT + 反查)
- [ADR-0031](../adr/0031-adr-governance.md) (ADR `applies_to` + programmatic filter)
- [ADR-0032](../adr/0032-backend-bounded-context.md) (物理拆 security / account / auth 3 context)

---

## Backlog (未 v1 收纳)

候选模式 (撞 ≥ 2 次后晋升 v2):

- **Cache-Hit-False-Green**: nx cache 假绿 (per memory `feedback_nx_cache_false_green_on_new_files`) — 单次实证后已加 `--skip-nx-cache` 纪律,等再撞触发 entry。
- **Lockfile-Bypass-Phantom-Dep**: `shamefully-hoist=true` 副作用 (per F-003 sunset) — 子包 require 未 declare dep 不失败,etu 后由 eslint-plugin-import enforce。
- **CLAUDECODE-Env-Gate-Bypass**: subprocess 内未设 `CLAUDECODE=1` 时 hook 不触 (per memory orchestrator 5 盲区) — 待 orchestrator 独立 PoC 推进。
