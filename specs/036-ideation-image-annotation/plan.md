---
feature_id: 036-ideation-image-annotation
spec_ref: ./spec.md
status: drafted
created_at: 2026-06-25
updated_at: 2026-06-25
adr_refs: ['0045', '0058', '0061', '0035', '0043', '0032']
context7_verified: []
---

# Implementation Plan: ideation 图片标注 + 多模态结合（B2-3）

> **HOW 权威基线** = [B2-3 plan (velvety-pike)](../../docs/private/plans/2026-06/06-25-ideation-b2-3-image-annotation.md)（D1-D3 决策 + server/mobile 架构 + 复用锚点 + verification + 已核实 9 facts）。本 plan.md 把该基线**形式化**进 spec-kit 模板（Constitution Check + 4 Phase-0 gate + 依赖防火墙 + Architecture Notes），**不重新选型**。plan 起草时已 grep 实证全部 9 个 load-bearing 锚点（见 Phase 0 / research.md）。

## Summary *(mandatory)*

把 033 留下的图片「即将开放」stub（`ClarifyChatScreen.tsx:209` `imageSendComingSoon` toast）接成真功能：图片直传 OSS → 在图上打点编号标注（pin + 每点文字/语音注记）→ 「图 + 编号 pin」Set-of-Mark 展平烧录 + 同编号合成文字 → 带图轮路由 MiniMax-M3 视觉对焦，作为一条 ideation 对话轮入既有澄清闭环。技术路径：server 抽 `integrations/oss/` 平台层 + 首建 `IdeaAttachment` 表 + `Msg.content` 扩多模态（向后兼容）+ 带图轮强制 `model:'minimax'`；mobile 复用 profile-image OSS 直传 4 步流 + 035 ASR + 033 暂存缩略，新增图片查看器/标注画布两屏 + 唯一新依赖 `react-native-view-shot` 做 SoM 烧录。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| **`react-native-view-shot`** (mobile, **唯一新依赖**) | SoM 烧录：`captureRef` 把「RN 图 + SVG pin overlay」混合视图展平为单图发给视觉模型（D2） | Expo 官方文档收录 `sdk/captureRef`（[docs.expo.dev/versions/latest/sdk/captureRef](https://docs.expo.dev/versions/latest/sdk/captureRef/)）；upstream v5.x New Arch/Fabric iOS+Android+Web 全支持、活跃维护（[github.com/gre/react-native-view-shot](https://github.com/gre/react-native-view-shot)）。已 grep 实证当前未装。**否决 `@shopify/react-native-skia`**：混合视图截图 Android 已知 bug（[issue #1633](https://github.com/Shopify/react-native-skia/issues/1633)）+ 引擎过重。详见 research.md。 |
| 手势栈（gesture-handler / reanimated / react-native-svg） | 标注画布缩放/平移 + pin overlay | **零新增** — 已装（gesture-handler 2.28 / reanimated 4.1 / svg 15.12，grep package.json 实证）。 |
| `expo-image-manipulator` | 上传前压缩(≤10MB/webp) + pin 周边裁切小图块预览 | **零新增** — 033 已装并用。 |
| ASR（nitro-sound / `transcribeRecording`） | pin 注记语音转写 | **零新增** — 035 已落地复用。 |
| OSS 直传（无新 SDK，PostObject V4 自签 + fetch 直传） | 图片 client 直传 | **零新增** — 复用 `profile-image/use-profile-image-upload.ts` + server `account/oss-policy.ts`（搬到 integrations/oss/）。 |

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking table below.

逐原则核对：

1. **§I SDD（含 mockup-first）**：specify ✓ → clarify ✓（5 问已编码）→ **Mockup ✓**（`design/036-image-annotation.dc.html` 9 帧，`/mockup-gen 036` 已生成）→ 本 plan。未跳步。
2. **§II Test-First TDD**：tasks 阶段每实现 task 绑测试，红→绿→commit。server lifecycle 组件遵守下方 3 条 Testing Invariants（无 lifecycle mock / 强制 integration / state_branches 穷举）。
3. **§III Atomic Task**：tasks 拆 30min-2h 单元；D1 已认本 PR 较大 → 按 task 粒度逐 commit + 每 2-3 task /clear 检查点。
4. **§IV Module Boundary（扁平+贫血+护城河）**：`IdeaAttachment` = 贫血 Prisma row（`annotationsJson` 贫血 Json 列，无 mapper / 无 Domain Class）；ideation UC 直注 `PrismaService`。**D3 触及 `account/` 是平台层抽取**（`buildPostObjectCredential` 上移 `integrations/oss/`，account 改为消费、对外契约零变），**非跨 ctx 碰他表** → 不破护城河（见 Complexity Tracking）。`integrations/` 是平台基座（ADR-0058），account + ideation 同源消费合规。
5. **§V 类型同步链 + 单 PR**：跨端 feature 走**单 PR**（server impl + 真后端 IT + `@nvy/api-client` regen + mobile 消费 + 两层验证原子 merge）。mobile 两层：① Playwright Expo Web hermetic e2e ② contract-smoke node 层打 testcontainers 真 server。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: real-boot smoke（Testcontainers PG+Redis + `IDEATION_FAKE_LLM` / fake-oss）覆盖每个新 EP（上传凭证签发 / 带图 turn 多模态路由）——tasks 阶段落 IT。
- [x] **Mobile / Web**: P1 golden-path（缩略图→查看器→编辑→落 pin→注记→发送）走 Playwright Expo Web hermetic e2e（图片选取/展平/ASR 经 seam，OSS+turn 经 `route.fulfill` 镜像契约）。原生烧录/上传/手势真机手动验证（web_compat: untested，spec 已声明）。
- [x] **Evidence**: 验证策略见 spec § 跨端 feature + velvety-pike § Verification；smoke commit 待 implement 阶段产出。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

引入 1 个新第三方包 `react-native-view-shot`：

| # | Question | Answer |
|---|---|---|
| Q1 | Long-term maintenance signals? | upstream `gre/react-native-view-shot` 活跃（v5.x，2026 仍发版）；Expo 官方 SDK 文档收录（`captureRef`）= 一等公民维护信号 |
| Q2 | Could an already-installed tool cover this equivalently? | 否。结构化坐标路径可零依赖但 SoM 要求**编号烧录进图片像素**（D2 业内事实标准）；svg/skia 均不解「混合 RN 视图展平」；view-shot 是 Expo 推荐的 captureRef 路径 |
| Q3 | Compatibility（NestJS/Prisma/Expo/pnpm/Nx）? | mobile-only，Expo SDK 收录、New Arch(Fabric) iOS+Android+Web 支持（Web 兼容是 Playwright e2e 关键）；与「RN Image + SVG pin overlay」混合视图直接契合 |
| Q4 | LLM training-data 覆盖? | 是。`react-native-view-shot` / `captureRef` API 面成熟稳定、训练数据广覆盖，低幻觉风险 |
| Q5 | Decoupling cost? | 低。仅 SoM 烧录一处调用点（`captureRef(ref)`）；替换为坐标-only 路径或他库 < 0.5 周 |
| Q6 | Risk surface（license/CN/supply-chain/CVE）? | MIT；纯 client 原生模块无 CN 网络面；无已知 CVE。否决 skia（混合截图 Android bug #1633 + 引擎过重） |

**Evidence**: research.md（Decision/Rationale/Alternatives）+ velvety-pike D2。impl 期引库时 PR 列本对比（stop-signal #2「引库前联网评估」已满足）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

本 feature 为 **mono-native**（ideation 模块 TS-first，无 Java/Spring 迁入血统）：

- [x] No stale Java class names — N/A（mono-native）
- [x] No stale Maven coords — N/A
- [x] No stale ADR ids — 引用 ADR 全为 mono id（0045/0058/0061/0035/0043/0032），已 `ls docs/adr/` 实证存在
- [x] No stale file paths — 全部 `apps/server/src/` / `apps/mobile/src/` nx 布局，已 grep 实证
- [x] No stale API paths — NestJS `@nestjs/swagger` code-first，新 EP `POST /ideation/sessions/{id}/attachments/credential`（命名 tasks 期定稿）
- [x] **Evidence**: plan 起草 grep 批次（react-native-view-shot 未装 / profile-image hook 存在 / minimax provider 存在 / IdeaAttachment 缺 / integrations/oss 缺 / clarify-turn.usecase.ts:482 model:'pro' / ClarifyChatScreen.tsx:209 imageSendComingSoon / llm-provider.port.ts:42 content:string）全部命中。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0045（对象存储上传） | 签名工具是否硬绑 avatar\|background target 枚举 | mitigated | D3 抽 `integrations/oss/` 时参数化 key-prefix + size 上限，去硬绑枚举；account 对外契约零变 |
| ADR-0058（server integrations 层） | oss 是否纳入 integrations 平台层（原仅 llm/asr/codeindex） | accepted-as-is | D3 把 oss 凭证签发作为 generic vendor I/O port 纳入 `integrations/oss/`，与既有同范式，无需新 ADR |
| ADR-0061（ideation 语音 ASR） | 音频是否落库 | accepted-as-is | 不变：语音注记仅转写，音频瞬态不持久化（spec Assumptions 重申） |
| ADR-0035（数据层治理 expand） | 新表 migration 走 expand | mitigated | `IdeaAttachment` 首建走 expand（纯增表，无破坏既有列） |

`rg` 验证：`rg -l "ADR-00(45\|58\|61\|35)" docs/adr/` 命中对应文件；无其他 ADR Open Question 被本 feature 触发。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支（12 条：附件上传 / 标注生命周期 / 多模态发送 / 各降级链路），**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏权限拒绝 / OSS 非 2xx / 凭证签发失败 / 视觉模型失败 / 取消零副作用 / 流式互斥 / 他人 session 404 等非 happy-path。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> - **Flat Module**: ALL files live flatly in `apps/server/src/ideation/` 与 `apps/server/src/integrations/oss/`. NEVER generate `domain/` / `application/` / `infrastructure/` / `web/` subdirectories.
> - **Anemic Data & Zero-Class**: `IdeaAttachment` = raw Prisma row（snake_case 由 schema.prisma `@map`）；`annotationsJson` 为贫血 Json 列。NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: ideation UC 直注 `PrismaService` 读写自己 ctx 的表。业务不变量放 `*.rules.ts` 纯函数（如 SoM 合成文字「编号↔注记 1:1」校验）。
> - **The Moat**: NEVER write `tx.<otherTable>.*`. `integrations/oss/` 是平台基座（非业务 ctx），account + ideation 同源消费合规；ideation 不碰 account 表。

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：带图 turn 落库（IdeaAttachment insert + IdeaTurn 引用）与既有 turn 状态写**同 tx**；外部 I/O（OSS 直传由 client 做、不在 server tx 内；视觉模型调用 split-tx，禁 tx 内持锁等 HTTP）。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：带图操作沿用既有 session 归属 + 反枚举——他人 sessionId 的上传凭证/带图 turn → **字节级一致 404**（FR-013）；上传凭证 scope 受限（key 前缀 `ideation/<accountId>/` + content-type 白名单 + size 上限 + 短时效），server 不代理图片字节（per ADR-0045）；失败分支不暴露 vendor 细节 / 不泄漏凭证（FR-011）。
- **前端（mobile）**：标注画布手势走 reanimated + gesture-handler（零新依赖）；pin 锚**图片内容坐标**（缩放/平移后稳定，FR-003 / Edge Case）；SoM 烧录用 `react-native-view-shot` `captureRef`（唯一新依赖）；语音注记复用 035 `transcribeRecording` + `insert-at-cursor`（插入光标/追加末尾，不覆盖）；OSS 直传复用 `profile-image/use-profile-image-upload.ts` `executeUpload`+`mapUploadError`。→ `../../docs/conventions/mobile-impl-playbook.md`

### 本 feature 设计意图（数据模型 + API surface 散文，非镜像表）

**Server（落 `apps/server/src/ideation/` + 新 `apps/server/src/integrations/oss/`）**：

1. **D3 抽 `integrations/oss/` 平台层（前置基建，安全搬移）**：把 `buildPostObjectCredential` + `oss-policy` 签名逻辑从 `account/oss-policy.ts` 上移到 `integrations/oss/`（generic vendor I/O port，与 llm/asr/codeindex 同位，ADR-0058）；**参数化** key-prefix + size 上限（去掉硬绑 `avatar|background` target 枚举）。account 既有 `IssueUploadCredentialUseCase` 改为消费平台层、**对外 EP 契约零变**（profile 上传零回归）。⚠️ 触及 `account/` 但是平台抽取非 account 行为变更 → PR 明确标注（stop-signal #4）。
2. **`IdeaAttachment` 表 + migration（ADR-0035 expand 首建附件表）**：字段 `id / sessionId / accountId / ossKey / kind('image') / annotationsJson?（各编号 pin 的图片内容坐标 + 注记文字，贫血 Json）/ createdAt`，`@@schema("ideation")`。**只存烧录图 ossKey + 元数据，不存原图**（clarify 决策）。与 session/turn 逻辑关联，归属随 session accountId（无声明 FK，沿 ideation 体例）。
3. **ideation 图片上传凭证 UC + 新 EP**：消费 `integrations/oss/` 签 PostObject V4，key 前缀 `ideation/<accountId>/`，content-type 白名单 jpeg/png/webp + size ≤10MB（对齐 M3）。EP `POST /ideation/sessions/{id}/attachments/credential`（命名 tasks/contract 定稿，`@nestjs/swagger` 装饰器 code-first）。他人 session → 404。
4. **`Msg` 多模态（向后兼容铁律）**：`content` 由 `string`（`llm-provider.port.ts:42` SoT）扩为 `string | MsgPart[]`，`MsgPart = {type:'text',text} | {type:'image_url',image_url:{url}}`；`toApiMessages`（`llm-stream.rules.ts`）透传数组形态（OpenAI vision content parts）。**纯文本路径行为零回归**（不传数组 = 旧 string 形状，SC-005）。
5. **视觉路由（send-once）**：带图 clarify 轮强制 `model:'minimax'`（M3 视觉，facts #1/#3；`clarify-turn.usecase.ts:482` 当前 `model:'pro'`）；纯文本仍 `'pro'`（DeepSeek，视觉 API 未开放 fact #2）。`RoutingLlmProvider` 不改（已支持 minimax 委托）。**图只随它那一轮注入 image_url（FR-015 send-once）**，后续纯文本轮组上下文 MUST NOT 重注历史图。⚠️ M3 adaptive 思考 + 视觉的实测延迟/稳定性 impl 期 PoC 验。
6. **clarify-turn 接 image**：turn request 加可选 `attachmentKeys[]` + `annotationText`（SoM 编号合成文字）；UC 落 user turn（引用 IdeaAttachment）+ 组多模态 Msg（OSS public URL → `image_url` part，编号标注文字 → `text` part）→ 路由 M3。

**Mobile（落 `apps/mobile/src/ideation/` + `apps/mobile/app/(app)/(tabs)/ideation/`）**：

1. **图片上传接线**：发送时上传——复用 `profile-image/use-profile-image-upload.ts` `executeUpload`（签名→PostObject 直传→拿 ossKey）+ `mapUploadError`，签名 EP 换 ideation 的；压缩走 `expo-image-manipulator`（≤10MB/webp）。**删 `imageSendComingSoon` 占位**（`ClarifyChatScreen.tsx:209` + `ideation-copy.ts:76`）。
2. **图片查看器屏**（mockup 帧②）：Expo Router stack，全屏暗底 + **仅居中「编辑/标注」**（去保存/分享）；`ThumbChip` 点击导航此屏。
3. **标注画布屏**（mockup 帧③-⑥）：手势缩放/平移（零新依赖）、点击落递增编号 pin（SVG overlay，软上限 9）、单点文字/语音注记（注记框接麦克风→复用 035）、pin 周边裁切预览（`expo-image-manipulator` crop，纯 UI 非模型 payload）。
4. **SoM 烧录**（D2）：标注完成 → `react-native-view-shot` `captureRef` 把「图 + 编号 pin」展平为单图 → 上传烧录图；合成 `annotationText` 同编号（`1：… 2：…`）。**发送时仅纳入有注记的 pin**（空 pin 既不烧录也不计入，FR-006 严格 1:1）。
5. **对话渲染**：`TurnRow`（`ClarifyChatScreen.tsx`）渲染 user turn 图片缩略（`ossThumbUrl` 即时派生，复用 `profile-image/oss-image.ts`）；助手按既有澄清流程回复。

**验证（端到端，per velvety-pike § Verification + Constitution §V）**：server IT（Testcontainers + fake-llm/fake-oss：凭证 scope / 带图 turn 落库 / 多模态 Msg 断言 content 为数组+image_url）· contract-smoke（打真 server，本地显式 `MARKETDATA_PROVIDER=mock`：签名→直传→confirm→带图 turn 契约对齐）· mobile Playwright Web hermetic e2e（缩略图→查看器→编辑→落 pin→注记 mock ASR→发送 mock 上传+SSE）· dogfood（真截图 → M3 真视觉返回对焦 brief）。烧录/坐标真机视觉验证留设备手动。

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| D3 平台层抽取触及 `account/`（改 `account/oss-policy.ts` + `issue-upload-credential.usecase.ts`） | 签名工具是 generic vendor I/O，account + ideation 都要用；放 `integrations/oss/`（ADR-0058 平台基座）是正确归属，避免 ideation 跨 ctx 碰 account 表（那才真破护城河 §IV.2） | 「ideation 复制一份签名逻辑」= 重复 PostObject V4 签名 + 双份漂移源；「ideation 直 DI account UC」= 跨业务 ctx 耦合签发凭证语义、非编排无 R2 理由。平台抽取是唯一不破护城河又不重复的路径；account 对外契约零变（re-export 保调用零改）。 |
