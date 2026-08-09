---
feature_id: 037-ideation-mockup-delivery
spec_ref: ./spec.md
status: implemented
created_at: 2026-06-27
updated_at: 2026-06-27
adr_refs: ['0045', '0058', '0032', '0043', '0038', '0035']
context7_verified: []
---

# Implementation Plan: ideation mockup 交付链路 + App 渲染（Phase D §A）

> **HOW 权威基线** = [Phase D 设计 §A 交付架构 + §E 4 开放问题终判](../../docs/private/plans/2026-06/06-27-ideation-mockup-phase-d-delivery-seam.md)（worker-token 凭证 / IdeationMockup 表 / channel 后处理内联 / 单自包含对象，**Q2 经联网核业界后定**）。本 plan.md 把基线**形式化**进 spec-kit 模板（Constitution Check + 4 Phase-0 gate + 依赖防火墙 + Architecture Notes），**不重新选型**。plan 起草已 grep 实证 load-bearing 锚点（`buildPostObjectCredential` 在 integrations/oss、agent-queue worker 鉴权 + claimed event 表、ideation schema、react-native-webview 未装）。

## Summary *(mandatory)*

把子plan3 已通的「headless 只产本地 preview」接成「云端交付 + App 渲染」。技术路径：**server**（落 `apps/server/src/ideation/`）首建 `IdeationMockup` 表（append-only 多版）+ 3 端点——① **worker-token** mockup 上传凭证端点（据 channel 所认领的 `agentQueueEvent` 派生 `accountId`+`sessionId` → 签 PostObject 凭证 scope 锁 `ideation-mockup/{accountId}/{sessionId}/` + content-type `text/html`，复用 `integrations/oss/buildPostObjectCredential` 并**参数化 content-type 白名单**）② **worker-token** 写记录端点（同款 event 派生 + 校 objectKey prefix 归属 → insert）③ **account-token** 读列表端点 `GET /ideation/sessions/{id}/mockups`（app 消费，反枚举）。**mobile**（落 `apps/mobile/src/ideation/`）新增 mockup-viewer 区：`react-native-webview`（**唯一新依赖**）静态隔离渲染（JS off + origin 锁 + 备案自定义域 + CSP）+ 多版切换 + 空/加载/错误态，fetch-on-open。**上传执行方 = channel（agent-platform 仓，仓外独立 PR）**，本 feature 只提供它消费的 server 契约。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| **`react-native-webview`**（mobile，**唯一新依赖**） | 在 viewer 屏**内嵌隔离渲染**交付的 mockup HTML（native `source={{uri}}`）；静态硬化 JS off + origin 锁 | Expo `expo install react-native-webview`（~13.13.x）一等支持、活跃维护（[Expo webview doc](https://docs.expo.dev/versions/latest/sdk/webview/)）。已 grep 实证当前未装。**否决 `@expo/dom-webview`**（SDK56 默认，但为「跑 RN-authored React DOM 组件」用途，非渲染任意 URL）；**否决 `expo-web-browser`**（已装，但开 modal 浏览器 chrome 非内嵌）。详见 research.md R3。 |
| 平台 OSS 签名器（`integrations/oss/buildPostObjectCredential`） | 签 PostObject scoped 凭证（字节不经 server） | **零新增** — 036 已抽到 `integrations/oss/`（ADR-0058 平台基座）。本 feature **参数化其 content-type 白名单**（现硬绑 `IMAGE_WHITELIST` → 加入参，mockup 传 `['text/html']`），镜像 036 参数化 key-prefix 的范式；account/ideation-image 仍传 image 白名单，对外零回归。 |
| agent-queue worker 鉴权 + claimed event 表 | worker-token 鉴权 + 据 event 派生 scope | **零新增** — 子plan3 已落 `WorkerAuthGuard` + `agent_queue_event`（含 `account_id`/`biz_type`/`biz_id`/`status`）。本 feature **跨 ctx 只读** claimed event 派生归属（`// CROSS-CONTEXT-READ` 注释化，见 Complexity Tracking）。 |
| 反枚举 / ProblemDetail / 贫血 row | 安全 + 错误契约 + 数据范式 | **零新增** — 沿 ideation 既有（036 FR-013 / ADR-0038 / ADR-0043）。 |

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles，跨 ctx 读在 Complexity Tracking justified。

逐原则核对：

1. **§I SDD（含 mockup-first）**：specify ✓ → clarify ✓（3 问已编码）→ **Mockup ✓**（`design/037-mockup-delivery.dc.html` 5 帧，`/mockup-gen 037` 已生成、push `nvy/ideation`）→ 本 plan。**未跳步**（此 feature 起手曾误跳 Mockup，已纠正补回）。
2. **§II Test-First TDD**：tasks 阶段每实现 task 绑测试，红→绿→commit。server lifecycle 组件遵守下方 3 条 Testing Invariants。
3. **§III Atomic Task**：tasks 拆 30min-2h 单元；按 task 粒度逐 commit + 每 2-3 task /clear 检查点。
4. **§IV Module Boundary（扁平+贫血+护城河）**：`IdeationMockup` = 贫血 Prisma row（`screens` 贫血 Json，无 mapper / 无 Domain Class）；ideation UC 直注 `PrismaService`。mockup 记录归 **ideation ctx**（ADR-0032）。**唯一跨 ctx = 只读** claimed `agentQueueEvent` 派生归属（Q7-B `// CROSS-CONTEXT-READ`，**永不跨 ctx 写**）→ 见 Complexity Tracking。`integrations/oss/` 是平台基座（ADR-0058）、合规消费。
5. **§V 类型同步链 + 单 PR**：跨端 feature 走**单 PR**（server impl + 真后端 IT + `@nvy/api-client` regen[3 新端点] + mobile 消费 + 两层验证原子 merge）。mobile 两层：① Playwright Expo Web hermetic e2e（mockup 产物经 `route.fulfill` 镜像）② contract-smoke node 层打 testcontainers 真 server。**channel（上传执行方）改动在 agent-platform 仓独立 PR**——本 PR 边界只到 server 契约 + mobile 消费。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（Testcontainers PG+Redis + fake-oss）覆盖每新 EP——worker-token 凭证签发（scope 派生 + content-type=text/html）/ worker-token 写记录（prefix 归属校验）/ account-token 读列表（反枚举）——tasks 阶段落 IT。
- [x] **Mobile / Web**: P1 golden-path（打开 session → 拉 mockup 列表 → 隔离渲染最新 → 多状态屏浏览 → 切历史版 / 空态 / 渲染降级）走 Playwright Expo Web hermetic e2e（mockup 产物 URL + 读列表经 `route.fulfill` 镜像契约）。native webview 真机隔离渲染（JS off + 自定义域）+ 备案域内联留真机手动验证（`web_compat: untested`，spec 已声明）。
- [x] **Evidence**: 验证策略见 spec § 跨端 feature；smoke commit 待 implement 阶段产出。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

引入 1 个新第三方包 `react-native-webview`：

| # | Question | Answer |
|---|---|---|
| Q1 | Long-term maintenance signals? | upstream `react-native-webview/react-native-webview` 活跃；**Expo 官方 SDK 文档收录 + `expo install` 推荐版**（~13.13.x）= 一等公民维护信号 |
| Q2 | Could an already-installed tool cover this equivalently? | 否。`expo-web-browser`（已装）开 modal 浏览器 chrome、非内嵌；DOM 渲染无既有件。webview 是 RN 内嵌 web 内容的事实标准 |
| Q3 | Compatibility（Expo/pnpm/Nx/New Arch）? | mobile-only；Expo SDK 收录、New Arch 支持；Expo Web 下 webview 退化为 `<iframe>`（Playwright e2e 关键，可注 `sandbox`/meta-CSP） |
| Q4 | LLM training-data 覆盖? | 是。`react-native-webview` API 面（`source`/`originWhitelist`/`javaScriptEnabled`/`onShouldStartLoadWithRequest`）成熟稳定、训练广覆盖，低幻觉 |
| Q5 | Decoupling cost? | 低。仅 viewer 屏一处渲染组件；替换为 `@expo/dom-webview` 或他法 < 0.5 周 |
| Q6 | Risk surface（license/CN/CVE/安全）? | MIT；纯 client 原生模块、无 CN 网络面。**不可信 HTML 风险经静态硬化收口**：`javaScriptEnabled={false}`（静态稿不需 JS）+ `originWhitelist` 锁备案域 + `onShouldStartLoadWithRequest` 拦外链 + CSP + 不在 webview 处理敏感数据（[Zellic WebView 安全](https://www.zellic.io/blog/webview-security/)）。snyk 历史 CVE 均远旧于 13.x。 |

**Evidence**: research.md R3（Decision/Rationale/Alternatives）。impl 期引库 task 触发「新依赖」stop-signal，PR body 列本对比（stop-signal #2「引库前联网评估」已满足）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

本 feature 为 **mono-native**（ideation 模块 TS-first，无 Java/Spring 迁入血统）：

- [x] No stale Java class names — N/A（mono-native）
- [x] No stale Maven coords — N/A
- [x] No stale ADR ids — 引用 ADR 全为 mono id（0045/0058/0032/0043/0038/0035），已 `ls docs/adr/` 实证存在
- [x] No stale file paths — 全部 `apps/server/src/ideation/` / `apps/mobile/src/ideation/` nx 布局；`integrations/oss/oss-policy.ts` + `agent-bridge/` + `prisma/schema.prisma` ideation schema 已 grep 实证
- [x] No stale API paths — NestJS `@nestjs/swagger` code-first，新 EP 命名 tasks/contract 定稿
- [x] **Evidence**: plan 起草 grep 批次（react-native-webview 未装 / `buildPostObjectCredential` 在 integrations/oss 硬绑 IMAGE_WHITELIST / `agent_queue_event` 含 account_id+biz_id+status / `claim-next` 据 row 派生 / ideation schema 存在 / 无 mockup 表）全部命中。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0045（对象存储上传） | 签名器是否支持非 image content-type | mitigated | 参数化 content-type 白名单（现硬绑 IMAGE_WHITELIST），mockup 传 `['text/html']`；image 调用方零变 |
| ADR-0058（integrations 平台层） | oss 签发是否可跨 feature 复用 | accepted-as-is | 复用既有 `integrations/oss/`，无新 ADR |
| ADR-0032（bounded context） | 跨 ctx 读 agent-bridge 事件归属 | mitigated | Q7-B `// CROSS-CONTEXT-READ` 只读派生（单受控点，永不跨 ctx 写）；第二消费者出现再抽 agent-bridge 共享读服务（见 Complexity Tracking） |
| ADR-0035（数据层 expand） | 新表 migration | mitigated | `IdeationMockup` 首建走 expand（纯增表，无破坏既有列） |
| ADR-0038（错误契约） | 失败降级 | accepted-as-is | 凭证签发 / 上传 / 渲染失败 → ProblemDetail，不泄漏 vendor（FR-008/009/011） |

`rg` 验证：`rg -l "ADR-00(45|58|32|43|38|35)" docs/adr/` 命中对应文件；无其他 ADR Open Question 被触发。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard`（含复用的 `WorkerAuthGuard` / `JwtAuthGuard`）/ `Interceptor` / `Filter` / `Pipe`，**绝对禁止** `new MyGuard()` / `jest.mock`。用 `Test.createTestingModule({ imports:[<TheModule>] }).compile()` 装微型 DI 容器在真 lifecycle 触发。
- **MANDATORY INTEGRATION**: 新 EP 必须 Testcontainers 真 server IT（PG+Redis + fake-oss）；`createTestingModule` 之外的"测试"视同未测。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches`（9 条：交付 / 渲染最新 / 空态 / 多版切换 / 凭证签发失败 / 直传失败 / 产物不可达降级 / 反枚举折叠 / 渲染隔离）**必须**各有对应 `it()` 块。100% 路径——不漏 worker-token 越权 scope / 他人 session 404 / 谎报 prefix 拒绝 / 渲染降级。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> - **Flat Module**: ALL files 平铺 `apps/server/src/ideation/`。NEVER 生成 `domain/` / `application/` / `infrastructure/` / `web/` 子目录。
> - **Anemic Data & Zero-Class**: `IdeationMockup` = raw Prisma row（snake_case 由 `@map`）；`screens` 为贫血 Json（逐屏标签字符串数组）。NEVER 生成 Domain Class / Entity Mapper。
> - **No Repositories**: ideation UC 直注 `PrismaService` 读写自己 ctx 表。业务不变量放 `*.rules.ts` 纯函数（如 objectKey prefix 归属校验、screens 标签规整）。
> - **The Moat**: NEVER `tx.<otherTable>.*` 写他 ctx 表。读 `agentQueueEvent`（agent-bridge 表）派生归属 = **唯一**跨 ctx，**只读** + `// CROSS-CONTEXT-READ` 注释（Q7-B）。`integrations/oss/` 是平台基座、合规消费。

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：写 mockup 记录 = 单 insert（append-only，无状态转换、无并发覆盖）；与 agent-queue `postResult` 终态**解耦**（记录写在 ideation，queue 终态在 agent-bridge，各自独立请求）。OSS 直传由 channel 做、**不在 server tx 内**。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：① **worker-token scope 派生**——凭证 / 写记录的 (accountId, sessionId) **永远** server 据 claimed event 派生，channel **不得自报**（防越权 + 混淆代理，spec FR-002 / Edge Case）；② **prefix 归属校验**——写记录时 objectKey MUST `startsWith` `ideation-mockup/{accountId}/{sessionId}/`，否则拒（防谎报他 session）；③ **反枚举**——读列表他人 / 不存在 session → 字节级一致 404（FR-007，沿 036 FR-013）；④ **渲染隔离**——不可信 mockup HTML 经 `javaScriptEnabled={false}` + `originWhitelist`(备案域) + `onShouldStartLoadWithRequest` 拦外链 + CSP，不在 webview 处理敏感数据（FR-005）；⑤ 失败不泄漏 vendor / 凭证（FR-008/011）。→ `../../docs/conventions/server-impl-playbook.md`
- **前端（mobile）**：viewer 区 fetch-on-open（无实时刷新，FR-011）；`react-native-webview` `source={{uri:<备案域 mockup URL>}}`（静态硬化见上）；多版切换 = 列表 chips（latest 默认，append-only 倒序）；空/加载/错误态沿既有 ideation 体例；OSS 默认端点强制下载 → **必经备案自定义展示域**内联（前置依赖，见 Complexity Tracking / spec Assumptions）。→ `../../docs/conventions/mobile-impl-playbook.md`

### 本 feature 设计意图（数据模型 + API surface 散文，非镜像表）

**Server（落 `apps/server/src/ideation/`）**：

1. **`IdeationMockup` 表 + migration（ADR-0035 expand 首建）**：字段 `id / sessionId / accountId / objectKey / screens(Json，逐屏标签字符串数组，无锚点) / note?(channel 哨兵 note，0新token 自检 / 降级说明) / createdAt`，`@@schema("ideation")`，`@@index([sessionId, createdAt])`（读列表倒序）+ `@@index([accountId])`。**append-only**（无 updatedAt、无覆盖；多版 = 多行，最新 = max createdAt；"v1/v2" 序号 app 按 createdAt rank 派生，不存 version 列——senior 测，可派生不落列）。归属随 session accountId（沿 ideation 体例，无声明 FK）。
2. **OSS 签名器参数化（integrations/oss，平台层安全改）**：`buildPostObjectCredential` 的 content-type 白名单从硬绑 `IMAGE_WHITELIST` 改为**入参**（默认仍 image，向后兼容）；mockup 凭证传 `['text/html']` + prefix `ideation-mockup/{accountId}/{sessionId}/` + size cap + 短 TTL。account / ideation-image 调用方零变。
3. **worker-token mockup 凭证 UC + EP**：EP（worker-token，`POST /ideation/mockups/credential`，body `{eventId}`，命名 tasks/contract 定稿）→ **`// CROSS-CONTEXT-READ`** 读 claimed `agentQueueEvent`(eventId) 得 `accountId`+`bizId`(=sessionId)，校 `bizType` + `status='claimed'` → 签 PostObject（content-type text/html，prefix 锁本 session）。事件不存在 / 非 claimed / bizType 不符 → 拒（不泄漏）。
4. **worker-token 写记录 UC + EP**：EP（worker-token，`POST /ideation/mockups`，body `{eventId, objectKey, screens[], note?}`）→ 同款 event 派生 (accountId, sessionId) → `*.rules.ts` 纯函数校 `objectKey` prefix 归属 → insert `IdeationMockup`。**幂等/并发**：append-only，重复回报落多行无害（channel 正常一次；如需去重可加 objectKey unique，tasks 期定）。
5. **account-token 读列表 UC + EP**：EP（`JwtAuthGuard`，`GET /ideation/sessions/{id}/mockups`）→ scope 校 session 归属 accountId（他人 / 不存在 → 404 字节级一致，沿 036）→ 返该 session mockup 列表（倒序，含 objectKey→备案域 URL 派生 + screens 标签 + createdAt + 派生 version 序）。app 据此列举 + 渲染。
6. **错误契约**：凭证签发失败（OSS 未配置 503 / 越权拒）、写记录 prefix 不符（拒）、读 404 → 统一 ProblemDetail（ADR-0038），不泄漏 vendor / 凭证（FR-008/011）。

**Mobile（落 `apps/mobile/src/ideation/` + `apps/mobile/app/(app)/(tabs)/ideation/`）**：

1. **mockup-viewer 区**（mockup 5 帧）：从 session 进入「设计稿」区；fetch-on-open 拉 `GET /ideation/sessions/{id}/mockups`（经 `@nvy/api-client`）。
2. **隔离渲染**：`react-native-webview` `source={{uri:<备案域 objectKey URL>}}` + `javaScriptEnabled={false}`（静态稿）+ `originWhitelist={['https://<备案域>']}` + `onShouldStartLoadWithRequest` 拦外链 + CSP（FR-005 / SC-004）。Web e2e 下退化 `<iframe sandbox>` + meta-CSP。
3. **多版切换**：列表 chips（latest 默认渲染，append-only 倒序；点历史 chip 切 uri 重渲）（US2 / FR-006）。屏标签行渲 `screens[]`（FR-010）。
4. **状态态**：空态（无 mockup 非错误，US1 AC3）/ 加载态（拉取/渲染中）/ 错误降级（`onError` → 一次性提示 + 重试，不阻断，FR-009 / US1 AC4）。
5. **契约消费**：3 端点经 `nx affected --target=generate` regen `@nvy/api-client`，mobile import 同 PR（零类型 drift）。

**验证（端到端，per Constitution §V）**：server IT（Testcontainers + fake-oss：凭证 scope 派生 + content-type text/html / 写记录 prefix 归属拒谎报 / 读列表反枚举 404 / append-only 多版倒序）· contract-smoke（打真 server：worker-token 签凭证 → 校 prefix → 写记录 → account-token 读列表对齐）· mobile Playwright Web hermetic e2e（打开 session → mock 读列表 → iframe 渲 fixture → 多状态屏 → 切版 → 空/降级）· native webview 隔离渲染 + 备案域内联留真机手动。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| 跨 ctx **只读** `agentQueueEvent`（agent-bridge 表）派生 (accountId, sessionId)（ideation mockup 凭证 / 写记录 UC，`// CROSS-CONTEXT-READ` Q7-B 注释化） | worker-token 凭证 scope 必须 server 据 channel 所认领的真实任务派生（防越权 / 混淆代理，Q2 终判 = worker-token 轻量 B）；归属源头 = 那条 claimed event，数据在 agent-bridge | 「channel 自报 accountId/sessionId」= 越权面，被 Q2 决策否决；「凭证端点放 agent-bridge」= agent-bridge 长出 ideation-mockup prefix + OSS signer 知识、破其 biz-agnostic；「ideation DI agent-bridge use case」= 非编排的跨业务 ctx 耦合（无 R2 理由）。**只读 + 注释化派生**是唯一既不破护城河（永不跨 ctx 写）又不让 agent-bridge 长业务知识的路径。第二跨 ctx-read 消费者出现 → 升级抽 agent-bridge 共享只读服务（catalog Q7-B → 共享读服务）。 |
| `react-native-webview` 新依赖 | native 内嵌隔离渲染不可信 mockup HTML 的事实标准；静态硬化收口风险 | `expo-web-browser`（已装）= modal 浏览器非内嵌；`@expo/dom-webview` = RN-authored DOM 用途非渲染任意 URL；自绘 HTML 渲染 = 重造轮子且失隔离。详见 research.md R3 + Gate 0.2。 |
