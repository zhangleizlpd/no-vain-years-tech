# no-vain-years-mono Constitution

> 「不负光阴」mono-repo PoC 项目级原则。每个业务模块、每个 use case、每个 PR review 必参考。基于 [Plan 1](../../docs/private/plans/2026-05/05-18-plan1-backend-stack-poc.md) PoC 范围（W1-W5）锁定，Plan 2 / Plan 3 阶段视需要 amend。

## Core Principles

### I. Spec-Driven Development（NON-NEGOTIABLE）

每个业务 use case 严格走 SDD 流程：`/speckit-constitution`（项目级一次性）→ `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-analyze` → `/speckit-implement`。**前端 UI feature 在 `clarify` 与 `plan` 之间强制插一步 Mockup**（产出 `design/` HTML preview baseline，per [sdd.md 前端 UI 工作流（mockup-first）](../../docs/conventions/sdd.md)）；后端 use case（无 UI）无此步。详见 [`docs/conventions/sdd.md`](../../docs/conventions/sdd.md)。

**禁跳步**：clarify → plan / plan → tasks / analyze → implement 之间是人工审批卡点，不可绕；**前端 UI feature 还含 `clarify → Mockup → plan` 卡点——跳过 Mockup 直接 plan = 违规**。直接跳到 implement 等于绕过 spec 一致性保障。

### II. Test-First TDD（NON-NEGOTIABLE）

`/speckit-implement` 每 task 走红→绿→typecheck/lint→tasks.md `[X]`→stage→commit 6 步闭环。**测试必须先写**，看到 RED 才写实现；GREEN 后才 commit。

**禁反模式**：写完 impl 再补测试 / 测试通过但未真正断言关键路径 / mock 过深以致 spec drift。

### III. Atomic Task = 30min-2h + 独立 Commit

`/speckit-tasks` 拆 task 时每条应是 **30min-2h 可独立 commit 的工作单元**。每个 task 完成同 commit stage 业务代码 + 测试 + tasks.md `[X]` 翻转。

**禁反模式**：tasks 拆得过细（每个 method 一个 task） / 多 task 合一 commit / 写完 impl 喊 /commit 事后再开 PR 改 tasks.md。

**Clear 检查点批次**：`/speckit-implement` 每 **2-3 个强关联 task（硬上限 5）** 为一个 clear 检查点批次，批次后停顿提醒切 `/clear` 防 context 膨胀。**批次 ≠ commit 合并**（每 task 仍各自 atomic commit），详见 [`.claude/rules/implement-task-closure.md`](../../.claude/rules/implement-task-closure.md)。

### IV. Module Boundary 显式 + ESLint 强制（扁平 + 贫血 + 护城河）

跨 bounded context（`auth` / `account` / `security`）通信走 Module 显式 `exports` + DI，**单向** `auth → account → security`（反向禁），由 `eslint-plugin-boundaries` 在 **module 级**拦截（hexagonal 层强制已退役，per ADR-0032）。模块**内部扁平**：文件平铺于 module 根，无 `domain` / `application` / `infrastructure` / `web` 层子目录（per ADR-0043 § 1）。

**现行边界规则**（ESLint boundaries + Nx depConstraints 在 CI 拦截）：

1. 跨 module 单向 `auth → account → security`；`security`（平台基座）不依赖任何业务 ctx
2. **数据护城河**：某 ctx 不碰他 ctx 的 Prisma 表（禁 `tx.<otherTable>.*` / `prisma.<otherTable>.*` 出现在非 owner ctx）；跨 ctx 读/写经对方的 use case（R2，必要时拆**两段式委托** `Inspect*UseCase` 只读 + `Commit*UseCase` 写，per ADR-0043 § 3a / § 5）
3. **无 repository port**：use case 直注 `PrismaService` 读写自己 ctx 的表；数据 = 贫血 Prisma row（`@map` camelCase）+ `*.rules.ts` 纯函数不变量；禁充血 Domain Class / Entity Mapper / 输入校验 VO class（零-class，per ADR-0043 § 2 / § 4）
4. shared 层（`packages/`）不依赖 business module（`apps/`）

详见 ADR-0032（bounded context 拆分 + hexagonal 退役）+ ADR-0043（扁平 / 贫血 / 护城河 / 零-class 正向范式）。**ADR-0020（原 hexagonal 四层 + repository 边界）已 Superseded by 0032 + 0043。**

### V. 类型同步链 Nx-driven（不引入跨仓 hook）

`apps/server` `@nestjs/swagger` 装饰器 → `nx run server:export-openapi` 产 `apps/server/openapi.json` → `packages/api-client` 跑 `openapi-typescript` 生成 TS client → `apps/mobile` 消费。`nx affected` 自动传导，**不引入 cross-cwd hook**（改由 Nx target dependency chain 覆盖）。

**PR 边界**：一个 feature = 一个分支 = 一个 PR。纯 server / 纯 mobile 改动固然单 PR；**跨端 feature（server use case + mobile UI 消费）也走单 PR** —— server impl + IT + api-client regen + mobile 消费 + 两层验证**全部同 PR 原子 merge**。

- monorepo 单 PR 内 regen 的 client 就在同一棵树，mobile 直接 import → **原子 merge 零类型 drift 窗口**（无需「PR1 先 merge」序）。
- **代价（已接受，2026-06-13 决策）**：cross-end feature 出 prod bug 整体 revert，不保留 server 独立回滚。
- **跨端 feature 的 mobile 侧两层验证（正交，各抓各的 bug，全落本 PR）**：
  - ① **hermetic UI e2e**（Playwright Expo Web，mock 后端）—— 验交互 / 点通（乐观更新 / 行内错误 / 手势 / a11y）。
  - ② **契约冒烟 contract smoke**（node 层，无浏览器）—— 用生成的 `@nvy/api-client` 打 testcontainers 真 server，验**契约对齐**（URL/method/序列化/响应解封/错误码）+ **基建**（真 token / 真落库 / 真状态机）。这是 hermetic mock（mock 即假设契约）与 server IT（不经生成客户端）**都覆盖不到的缝**。每 feature 一条 happy-path，加进 `apps/mobile/e2e/contract-smoke/` 共享套件（`nx run mobile:contract-smoke`，nightly 软信号 + 本地 mobile 收尾门）。

> ⚠️ 旧措辞「PR2 Playwright 真后端冒烟」混淆了上述 ① ②（hermetic UI ≠ 真后端）—— 自本版起拆为两层。历史 spec/plan/commit 中的「真后端冒烟」字样为冻结记录，不回改。

> ⚠️ 旧「跨端两段式（PR1 server / PR2 mobile）」自 v1.3.0（2026-06-13）退役为单 PR；历史 spec/plan/commit 中的 PR1/PR2 拆分字样为冻结记录，不回改。

## Tech Stack Constraints

PoC 阶段（W1-W5）锁定栈：

| 层 | 选型 | Plan 1 § |
|---|---|---|
| Runtime | Node 22 LTS | § F |
| Package manager | pnpm 10.33.2 | § F |
| Monorepo | Nx 21+ | § F |
| 后端框架 | NestJS 11 + Fastify adapter | § F |
| 后端 ORM | Prisma 6+ | § F + ADR-0019 |
| 后端 build | `@nx/js:swc` 转译（不 bundle） | § F + W2.0 amend |
| 前端框架 | Expo（Plan 2 物理迁入） | § F |
| Test runner | Vitest 2（前后端一致） | § F |
| Lint / Format | ESLint 9 flat config + Prettier 3 | § F |
| Pre-commit | lefthook（W3+ 装） | § F |
| CI | GitHub Actions + Nx affected | § F |
| 容器 base | `node:22-alpine`（production） | § F |
| OpenAPI | code-first `@nestjs/swagger` | § F |
| 跨语言 contract | OpenAPI（Protobuf 未来评估） | § F |

## Quality Gates

每个 PR 必须满足：

1. **Required status checks**（mono main-protection ruleset）：
   - Gitleaks（密钥扫描）
   - Actionlint（workflow YAML）
   - PR title（conventional commits）
   - Build (nx build server)（SWC 转译产 dist/main.js）
2. **Conventional Commits**：PR title + body + 每个 commit message 符合 `<type>(<scope>): <subject>` 格式（type ∈ `feat / fix / docs / chore / refactor / style / test / perf / build / ci`）；body 每行 ≤ 150 字符
3. **Squash merge only**：保持 main 线性历史；feature 分支 merge 后自动删除
4. **AI agent default auto-merge**：除明示例外（user 要 review / draft / 不可逆操作 / release-please），AI 创建 PR 后接 `gh pr merge --auto --squash --delete-branch`

详见 [`docs/conventions/git-workflow.md`](../../docs/conventions/git-workflow.md)。

## Governance

本 Constitution **supersede** `CLAUDE.md` / `docs/conventions/*` 中冲突部分。

**Amendments**：

- 任何 amend 走独立 PR（`docs/constitution-amend-<topic>`）
- PR 描述必须 cite：当时背景 / 为何需 amend / 影响哪些已有约定
- 每 amend bump version（SemVer：原则增减→MAJOR，section 重写→MINOR，文字调整→PATCH）
- Last Amended date 同步更新

**AI agent compliance**：

- 每 PR review 必引用本 Constitution 检查 5 原则 + Tech Stack 锁定 + Quality Gates
- `/speckit-analyze` 把 spec / plan / tasks 对照 Constitution 扫一致性
- Constitution 与 `docs/conventions/sdd.md` 冲突时以 Constitution 为准（sdd.md 是 SDD 流程细节，Constitution 是 PoC 项目级原则）

**Version**: 1.4.0 | **Ratified**: 2026-05-17 | **Last Amended**: 2026-06-21

> v1.4.0（2026-06-21）：§ I 明确**前端 UI feature 在 clarify 与 plan 之间强制插 Mockup 步**（mockup-first，产 `design/` baseline），并把「跳过 Mockup 直接 plan」列入禁跳步。此前 Principle I 仅列 6 步、无 mockup，mockup-first 只活在 sdd.md UI 子节 → 权威流程与 UI 工作流不一致（032-ideation 实战据此误跳 mockup 直接 plan，暴露该 gap）。后端 use case（无 UI）无此步。
>
> v1.3.0（2026-06-13）：§ V PR 边界从「跨端两段式（PR1 server 先 merge / PR2 mobile）」改为「跨端 feature 单 PR 原子 merge」—— 单 PR 内 regen client 同树、mobile 直接 import，零 drift 窗口，「先 merge」序失效故移除；代价为 feature 整体 revert（已接受）。两层验证（hermetic e2e + 契约冒烟）内容不变，措辞从「PR2 的」解耦为「mobile 侧的」。配套 `/sdd-auto-impl` 自动驱动器（单 feature = 单分支 = 单 PR）。
>
> v1.2.1（2026-06-02）：§ V 把 PR2 验证拆为正交两层 —— ① hermetic UI e2e（点通）+ ② 契约冒烟 contract smoke（node 层生成客户端打真 server，验契约对齐+真落库，补 hermetic mock 与 server IT 都覆盖不到的缝）；纠正旧「PR2 真后端冒烟」对 hermetic UI 的误指。源自 012-broker-account-binding 实践。
>
> v1.2.0（2026-06-02）：§ V 重写 PR 边界 —— 跨端 feature（server use case + mobile UI 消费）默认两段式（PR1 server+api-client regen 先 merge / PR2 mobile 消费已落地 client），约束 regen 随 PR1 ship 消解类型同步链 drift（沿 005/011 实践）；§ III 增「Clear 检查点批次」（每 2-3 强关联 task 停顿提醒 /clear，批次≠commit）。源自 011-stock-market-access 实践。
>
> v1.1.0（2026-05-24）：§ IV Module Boundary 重写对齐 ADR-0043 扁平+贫血+护城河+零-class 范式（R-1~R-VO 实装后）—— 删退役的 hexagonal 四层 ArchUnit 规则，改单向 module 边界 + 数据护城河 + 无 repository；ADR-0020 标 Superseded。
