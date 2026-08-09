---
adr_id: ADR-0057
status: Accepted
applies_to: [apps/server, apps/mobile]
sunset_trigger: |
  - ideation 产出从「喂 /speckit-specify 的 brief」扩张到「直接生成 spec.md / 多类产物」→ 重审与 spec-kit 的耦合边界 + 是否需内嵌模板知识
  - 出现第二个「AI 多轮对话产出结构化任务产物」业务域（非需求澄清）→ 重审 ideation 是否泛化为通用 AI-工作流 ctx
  - LLM provider 第 3 个消费 ctx（pkm）落地而 provider adapter 仍未抽出 chat/ → 强制抽到共享平台层（见 §2 Open）
  - 需把 PRD灵感 产出自动交接电脑端 / 归档 PKM（连接器能力）→ 触发 agent-platform 集成评估（本 ADR scope 外）
---

# ADR-0057: Ideation 第 8 Bounded Context — 移动端需求澄清助手（任务态）+ 叶子 ctx + LLM via 端口复用

- Status: Accepted (2026-06-21)
- Deciders: @zhangleizlpd
- Tags: server / bounded-context / ideation / llm
- Relates: [ADR-0032](0032-backend-bounded-context.md)（bounded context 拆分框架）/ [ADR-0043](0043-server-flat-module-paradigm.md)（扁平贫血范式 + §4 vendor port）/ [ADR-0052](0052-alert-bounded-context.md)（新 ctx 落独立 ADR 先例）/ [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)（chat SSE + `LlmProvider` port 起源）/ [ADR-0041](0041-server-common-directory-policy.md)（common-dir / platform infra 归属）/ [ADR-0045](0045-object-storage-image-upload.md)（OSS 直传）/ [ADR-0058](0058-server-integrations-layer.md)（LLM provider 落 integrations/ 层）；实施载体 = [PRD灵感 → SDD master](../private/plans/2026-06/06-21-prd-ideation-to-sdd-master.md)（子 plan B1/B2 → `specs/NNN-<slug>/`）

## Context

[PRD灵感 → SDD](../private/plans/2026-06/06-21-prd-ideation-to-sdd-master.md) = 移动端需求澄清助手：模糊初衷（截图/语音/文字）→ AI 多轮对焦 → 收敛 requirements brief → 交接 `/speckit-specify` 走 SDD。两个架构问题需定稿：

1. **归属**：需求澄清域落既有 7 ctx（security/account/auth/portfolio/marketdata/alert/chat）哪一个，还是新立 bounded context？
2. **LLM 复用**：多轮对话能力与 chat ctx 高度重叠（chat 已有 `LlmProvider` port + DeepSeek/MiniMax adapter），但 ESLint 边界禁止跨 ctx import——怎么复用而不破边界？

## Decision

### 1. 新立第 8 bounded context `ideation`（catalog Q4 命中）

[catalog](../conventions/server-bounded-context-catalog.md) 7Q 逐条：Q1 否（4 表全新无既有 owner）/ Q2 否（澄清会话·对话·收敛全在域内闭环，非跨 ctx 编排）/ Q3 否（业务领域非 platform infra）/ **Q4 是**——需求澄清助手是全新业务领域，7 现 ctx 都不沾；与 chat 形似但**生命周期与产物不同**（见 §3）。Q5/Q6/Q7 否（无跨 ctx 写、无同步编排、无 side-effect 通知、无跨 ctx 核心表只读）。

> 第 8 = 账号域 security/account/auth（计 3，共享 `account` schema）+ portfolio/marketdata/alert/chat（4）+ ideation（第 8）。

- 物理面：`apps/server/src/ideation/`（ADR-0043 扁平贫血）+ Prisma schema `ideation` 4 表（`idea_session` / `idea_turn` / `idea_attachment` / `requirements_draft`，moat owner=ideation）+ `apps/mobile/src/ideation/`（business-naming 三处同名）。
- 依赖面：**叶子 ctx**——单向 `ideation → account`（JwtAuthGuard/AccountId 鉴权 artefact 经 export 复用，**非业务调用**，同 alert 先例 ADR-0052 §1）+ `ideation → security`（platform infra）；无人依赖 ideation。ESLint boundaries + moat 探针双层强制。
- 外呼面（非跨 ctx 边）：LLM provider（§2）+ OSS 直传（§4）皆 **vendor I/O via port**（ADR-0043 §4），不计入 ctx 依赖。
- **注册四处由 B1 PR-1 实装**（同 ADR-0052「021 PR-1 实装注册面」节奏，本 ADR 仅决策不动代码）：`schema.prisma` schemas 加 `"ideation"` + 模型 `@@schema("ideation")`；ESLint boundaries + Nx tags；`scripts/checks/check-server-moat.ts` `MODEL_OWNERSHIP` 声明 owner=ideation（否则 `moat-unmapped` 硬拒）；`business-naming.md` 加 ideation 行。

### 2. LLM 多轮对话 = vendor I/O via `LlmProvider` port，**禁** import chat ctx

- chat 的 `llm-provider.port.ts` + `deepseek/minimax/llm-router/fake-llm` provider 目前物理在 `apps/server/src/chat/`。ideation **不能** `import` 它们（ESLint 跨 ctx 边界硬拒）。
- LLM 调用本质 = vendor I/O（openai SDK 打 DeepSeek/MiniMax），按 ADR-0043 §4 走 thin port + adapter，**不是**跨 ctx 业务 call，无 R2/R3 注释。
- 现已 **≥2 消费 ctx**（chat + ideation；pkm 后续为第 3）共用同一组 vendor adapter → 抽到新 **`integrations/` 平台层**（per [ADR-0058](0058-server-integrations-layer.md)：跨 ctx 共享外部 vendor I/O 适配器的家，**非** `security/`、**非** business ctx），chat + ideation 经 DI 绑同一 `LLM_PROVIDER` port；**禁** ideation 内重复粘贴 adapter、**禁** import chat。
- 对话流复用 chat SSE 范式（ADR-0055：`reply.hijack()` lazy-hijack + split-tx + abort）——范式复用 ≠ 代码 import，ideation 自写自己的 stream controller。

> LLM provider 从 `chat/` 迁到 `integrations/llm/`（ADR-0058 §2）在 **B1 PR-1** 落地；ideation 绑同一 port。

### 3. 任务态数据模型 + 产出 brief 喂 specify（与 chat 的本质区分）

ideation 与 chat 形似实异：chat = durable 对话历史（消费者是人，长期留存）；**ideation = 任务态短生命周期**（`idea_session.status` open → converged → handed-off，目标 = 对焦清楚 requirements，交接 SDD 即终结）。

- 4 表：`idea_session`（accountId/title/status）/ `idea_turn`（role/content）/ `idea_attachment`（OSS key + transcript）/ `requirements_draft`（收敛产出，结构化 markdown）。
- 产出 = **对焦后 feature 需求 brief（markdown）**，作 `/speckit-specify` 的自然语言输入；ideation **不碰 spec-kit 内部模板/frontmatter**（产物正名：终点是 `specs/NNN/spec.md`，不是 `requirements.md`）。
- `requirements_draft` 设计成可导出，预留**单向** seam：未来配置驱动归档进 PKM（本 ADR 不实现 PKM 侧，接口不堵死）。

### 4. 附件 = ADR-0045 直传；语音触发大附件 sunset

截图沿用 ADR-0045 presigned 直传。语音/大文件触发 ADR-0045 自身 sunset（multipart/断点续传 + 私有访问——现 `public-read` 不适合私人语音），在 B2 评审上传架构。

## Consequences

- B1 PR-1 实装本 ADR §1 全部注册面（schema/migration + boundaries + nx tags + moat + module 空壳）；后续 PR 实装会话/对话/收敛 + mobile。
- §2 抽取 LLM provider 到共享层是 B1 的**前置改造**（触碰 chat ctx），ADR-0055 届时补 amend 说明 provider 搬迁。
- ideation 叶子 ctx，无跨 ctx 写/读，moat 面最小（仅 vendor port + 鉴权 artefact 复用）。

## Trade-offs

- **新立 ctx vs 塞 chat**——接受多一个 context 的注册面，换 chat 不被需求澄清的异质职责（任务态生命周期 + spec 产物 + 多模态初衷）污染；chat 保持 durable 对话纯粹性。
- **LLM provider 抽共享层 vs 各 ctx 自持**——抽取触碰 chat ctx、增一次重构 PR，换零重复 adapter + 三 ctx（chat/ideation/pkm）单一 vendor 维护点；≥2 消费者已使抽取摊销成立。
- **产出 brief vs 直接生成 spec.md**——brief 喂 specify 让 ideation 职责最窄（不内嵌 spec-kit 模板知识、不随 spec-kit 版本漂移），代价是多一步人工粘贴；接受，自动交接属未来连接器 seam。

## Open Questions

- 共享 LLM provider 落点已定 = `apps/server/src/integrations/llm/`（[ADR-0058](0058-server-integrations-layer.md)）；chat 侧搬迁的 PR 序列 → B1 plan 细化。
- **ideation context 英文名** ——`ideation` 为暂名，B1 spec frontmatter `modules:` 终定（候选：ideation / intake / prd）。
- 多模态初衷的 ASR provider 选型 + RN 图片标注库选型 → B2 spec。

## References

- [PRD灵感 → SDD master](../private/plans/2026-06/06-21-prd-ideation-to-sdd-master.md)（子 plan B1/B2）
- [PKM「外脑」底座 PARKED](../private/plans/2026-06/06-21-pkm-waibrain-parked.md)（解耦的姊妹 initiative）
- [server-bounded-context-catalog](../conventions/server-bounded-context-catalog.md)（7Q 决策树）
- 新 ctx 落独立 ADR 先例：[ADR-0052](0052-alert-bounded-context.md)（alert 第 6 ctx）
