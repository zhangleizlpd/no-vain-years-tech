---
feature_id: 027-ai-chat-streaming
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-14'
---

# Tasks: 027-ai-chat-streaming（AI 对话首页主干 + 单模型流式）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `027-ai-chat-streaming` | **设计源**: [master](../../docs/private/plans/2026-06/06-14-ai-chat-home-module-master.md) + [PoC findings](./poc-findings.md) + [mockup](./design/)

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；纯函数（`chat-context.rules` / `chat-title.rules` / SSE 帧解析）= vitest 无 DB；UC 读写 DB = **Testcontainers PG**（`nx test server <file>`，cwd=apps/server）；provider 真 DeepSeek 走 **env-gated IT**（`RUN_LLM_IT`，默认 skip，CI 不打外网）；mobile 纯逻辑 = vitest，UI·render·a11y = Playwright Expo Web e2e
- 无 task-meta JSON（**manual 模式**，per 004-026）
- 🚨 **027 = 仓内三首例**（plan D1/D3/D7）：① 第一个全新 bounded context `chat`（ADR-0032 7 问，**叶子 ctx 不 import 任何业务 ctx**）② 第一个 SSE 流式端点（Fastify `reply.hijack()` raw 写，PoC 定稿）③ 第一个 LLM provider 集成（`LlmProvider` port + DeepSeek，server 持 key）
- 🚨 **用户身份 = `accountId`**（`req.user.accountId` + `JwtAuthGuard` from `account/` = 平台 auth 基座复用，portfolio/alert 同款，**非业务跨 ctx 依赖**）；会话/消息按 accountId 归属，他人 conversationId → **404 字节级一致**（反枚举）
- 🚨 **SSE 端点不走 orval**（产 `text/event-stream` 非 JSON）：mobile 自写 expo/fetch 客户端消费；建会话/取消息端点走 orval typed hook。**中断检测用 `controller.signal.aborted`**（PoC gotcha：expo/fetch abort 抛 "Fetch request has been canceled" 不含 "Abort"）
- 🚨 **落库语义（Clarify）**：用户 msg 即时落；AI msg 仅流正常结束落（completed）/ 停止落（stopped）；**provider 失败不落 AI msg**（无 failed 占位）；流式期间不开 tx（外部 IO split-tx）
- **单 PR（per Constitution §V v1.3.0）**：`feat(chat)` —— server impl + 真 server IT + export-openapi + api-client regen + mobile 消费 + 两层验证全原子 merge。PR body flag「仓内首个 SSE 端点 + 首个 LLM 集成 + 首个新 ctx」+ 建议人工 review（D1/D3/D7）

## Path Conventions

- server：`apps/server/src/chat/`（**新建扁平 module**，无 domain/application/infrastructure 子目录）；schema `apps/server/prisma/schema.prisma` + 新 migration；IT `apps/server/test/integration/*.it.spec.ts`
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）
- mobile：`apps/mobile/src/chat/`（**新建 feature dir**）+ `apps/mobile/app/(app)/(tabs)/index.tsx`（替换占位）；`~/theme`/`~/ui` 零新库（mockup 0 新 token）
- e2e：`apps/mobile/e2e/`（mock SSE 端点 + 003 refresh per memory）；contract-smoke `apps/mobile/e2e/contract-smoke/chat-streaming.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait`（:5433/:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**
- 真 DeepSeek IT：env-gated `RUN_LLM_IT`，默认 skip（key 在 `apps/server/.env`，CI 不打外网）

---

## Phase 1: Server — chat 限界上下文 + 流式端点

**Goal**：新 `chat` 叶子 ctx 落地——建会话/取消息/SSE 流式发消息全链路，落库 + 停止/失败语义 + 多轮上下文窗口，spec 8 条 state_branches 全覆盖（FakeProvider 确定性 + 真 DeepSeek env-gated）。

- [X] T001 [Server] **Prisma `chat` schema + 两表 + migration**：`apps/server/prisma/schema.prisma` 的 `datasource db` `schemas` 列表加 `"chat"` + 新 `conversation` model（`id BigInt @id @default(autoincrement())` / `accountId BigInt @map("account_id")` 无 FK relation / `title String` / `model String` / `metadata Json?` 二期位 / `createdAt`/`updatedAt` / `@@index([accountId, updatedAt])` / `@@map("conversation")` / `@@schema("chat")`）+ `message` model（`id` / `conversationId BigInt @map("conversation_id")` 无 FK / `role String` / `content String @db.Text` / `status String` / `createdAt` / `@@index([conversationId, id])` / `@@map("message")` / `@@schema("chat")`）。**验**：`docker compose -f docker-compose.dev.yml up -d --wait` → `env -u OSS_* pnpm -C apps/server prisma migrate dev --name chat_init` 生成 migration + `prisma generate` 出 client 类型（migration 命名过 `migration-naming-check`）
- [X] T002 [P] [US2] [Server] **上下文窗口纯函数**：`apps/server/src/chat/chat-context.rules.ts` —— `buildContext(history, budget)` 从最新轮往回累加、字符启发式估 token、超 budget 丢最早轮（不做摘要，plan D4）+ vitest 红绿（空历史→空 / 单轮原样 / 超长截断保留最新 N 轮 / budget 边界）
- [X] T003 [P] [Server] **标题派生纯函数**：`apps/server/src/chat/chat-title.rules.ts` —— `deriveTitle(firstUserContent)` 截前 N 字 + 去换行/trim + 空兜底「新对话」（plan D5）+ vitest 红绿（正常截断 / 超长 / 含换行 / 空串兜底）
- [X] T004 [P] [Server] **SSE 帧序列化纯函数**：`apps/server/src/chat/sse.rules.ts` —— `toSseFrame(token)` / `SSE_DONE` 常量（`data: {json}\n\n` / `data: [DONE]\n\n`）+ vitest（token 转义 / DONE 哨兵 / 多字节中文）。复用于 controller，便于纯函数测试 SSE 编码
- [X] T005 [US1] [Server] **LlmProvider port + DeepSeek adapter + FakeProvider**：`apps/server/src/chat/llm-provider.port.ts`（`interface LlmProvider { stream(messages, opts: {signal}): AsyncIterable<string> }`）+ `deepseek.provider.ts`（`pnpm -C apps/server add openai`；`new OpenAI({baseURL:'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY})` → `chat.completions.create({model,messages,stream:true},{signal})` 出 `delta.content`）+ `fake-llm.provider.ts`（scripted token 迭代，供 IT 确定性 + 可注入 error/delay 模拟失败/超时）+ vitest（FakeProvider 吐 token 序列 / abort signal 中断迭代 / error 注入抛出）
- [X] T006 [US1] [Server] **建会话 + 取消息 UC + controller**：`create-conversation.usecase.ts`（建空会话，model 默认 `deepseek-chat`）+ `get-messages.usecase.ts`（按 `(conversationId,id)` 序取，scope accountId）+ `conversation.controller.ts`（`POST /chat/conversations` / `GET /chat/conversations/{id}/messages`，`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)`，他人 id → 404）+ 新建 `chat.module.ts` 注册 + `app.module.ts` import + **ESLint boundaries / Nx tag 注册 `chat` module**（business-naming 三处一致）+ Testcontainers 单测（建会话回显 / 取空会话→[] / 取本人消息按序 / 他人 conversationId→404 / 未认证→401）
- [X] T007 [US1] [US3] [Server] **流式发消息 UC + SSE controller**：`send-message.usecase.ts`（① scope 校验归属→他人 404 ② 落 user message 即时 ③ `buildContext`(T002) 组 messages ④ `LlmProvider.stream` 逐 token ⑤ 流结束落 AI msg `completed`；停止→落 `stopped` 半成品；失败→不落 + 发 error 帧）+ `chat-stream.controller.ts`（`POST /chat/conversations/{id}/messages`，`@Res() reply: FastifyReply` + `reply.hijack()` + SSE headers（`text/event-stream` / `no-cache,no-transform` / `X-Accel-Buffering:no`）+ `reply.raw.on('close')` → abort 上游 + 逐 token `reply.raw.write(toSseFrame)` + `[DONE]` + `end()`）+ 首条消息时 `deriveTitle`(T003) set title + Testcontainers 单测（**FakeProvider**：发消息→user+AI msg 落库 completed / 多轮带历史上下文 / 停止落 stopped 半成品 / 失败不落 AI msg 但 user msg 在 / 空输入拒）
- [X] T008 [US1] [US2] [US3] [Server-IT] **state_branches 全覆盖 IT**：`apps/server/test/integration/chat-streaming.it.spec.ts`（全 boot + FakeProvider 注入）覆盖 spec **8 条**（空态首发→建会话+落用户msg+流式+落AI msg / 已有对话追问→带历史多轮 / 空输入→拒 / provider 失败→半成品不落+用户msg在 / 停止→落 stopped / 断连→服务端完成则落 / 未认证→401 / 他人 conversationId→404 字节级一致）+ **env-gated 真 DeepSeek IT**（`RUN_LLM_IT`：真发一条→收到非空流式 token + 落库 completed，验 provider 接线 + TTFT 留观察，默认 skip）

## Phase 2: 契约同步（Nx-driven）

- [X] T009 [Contract] [Verify] **swagger + openapi + api-client regen**：`conversation.controller` / `chat-stream.controller` 加 `@nestjs/swagger` 装饰器（建会话/取消息 JSON DTO + SSE 端点标 `produces: text/event-stream` + response 描述 token 流+`[DONE]`，nullable string 字段显式 `type:'string'` per memory）→ `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen：建会话/取消息 typed hook；SSE 端点不依赖 hook）→ mobile typecheck 绿

## Phase 3: Mobile — 首页 chat 屏（翻 mockup baseline）

**Goal**：首页（第一个 tab）呈现 AI 对话，空态 Gemini 简约带昵称、对话流 Kimi 骨架打字机、停止/失败/重试，expo/fetch 流式增量（PoC 实证）。

- [X] T010 [US1] [Mobile] **SSE 帧解析纯函数 + expo/fetch 流式客户端**：`apps/mobile/src/chat/sse-parse.ts`（`parseSseChunk(buffer)` 切 `\n\n` 解 `data:` 帧、抽 token、识别 `[DONE]`，纯函数）+ vitest 红绿（单帧/多帧/跨 chunk 半帧缓冲/DONE/中文多字节）；`chat-stream-client.ts`（`fetch` from `expo/fetch`，`getReader()`+`TextDecoder`+`parseSseChunk`，`AbortController`，**中断判定 `signal.aborted`**，回调/async 迭代吐 token）
- [X] T011 [US1] [US2] [US3] [Mobile] **会话态机 hook**：`apps/mobile/src/chat/use-chat.ts`（态机 idle/streaming/done/error/stopped + 流式 token 累加 + 多轮消息态 + 停止(abort) + 重试 + 接 orval 建会话/取消息 hook + 本地存 last conversationId 冷启 reload，SC-002 + **streaming 态禁再次发送**（并发边界，spec Edge））+ vitest 纯逻辑（reducer/态转换：发送→streaming、token 累加、stop→stopped、error→error、retry→streaming、streaming 态拒发送）
- [X] T012 [US1] [Mobile] **首页 chat 屏（翻 mockup 5 状态）**：`apps/mobile/src/chat/` 屏组件（空态 Gemini 简约 + sparkle + 带昵称问候（`useMe()` 取昵称，未就位退通用，FR-001）/ 对话流 Kimi 气泡 + AI 头像 + 打字机 + 「内容由 AI 生成」标识 / 输入条「尽管问」+ 发送（空禁用）/ 消息操作条复制 / 错误态+重试 / 停止态「已停止」；顶栏 hamburger 占位 + 模型名只读 + 新会话）+ `chat-copy.ts`（问候/错误/标识文案）+ 复用 `~/theme`+`~/ui`（0 新 token）+ `app/(app)/(tabs)/index.tsx` 接入替换占位。**RN 布局**：流式区 `ScrollView` 自动跟随；避免无界高容器裸 `flex-1`（per mobile-impl-playbook）
- [X] T013 [US1] [US2] [US3] [Mobile-E2E] **hermetic UI e2e**：`apps/mobile/e2e/chat-streaming.spec.ts`（Playwright Expo Web，mock SSE 端点 + mock 建会话/取消息 + 003 refresh）验：空态带昵称 → 输入发送（空禁用）→ AI 渲染 → 多轮追问 → 停止冻结+「已停止」→ 失败错误态+重试 → 「内容由 AI 生成」标识在位 + 复制。注：playwright config `testMatch=*.spec.ts` → 文件名 `.spec.ts`（非 `.e2e.ts`，否则不被采集）；SSE mock 一次性全帧（`route.fulfill` 不支持逐帧增量），真增量由 server IT(T008) + PoC 兜底

## Phase 4: 契约冒烟 + 收尾

- [X] T014 [US1] [Contract-Smoke] **契约冒烟**：`apps/mobile/e2e/contract-smoke/chat-streaming.contract.ts`（node 层，生成的 `@nvy/api-client` 打 testcontainers 真 server，FakeProvider env 注入）：登录 → `POST /chat/conversations` 建会话 → 发消息（流式读到 token）→ `GET messages` 验真落库（user+AI msg、role/status/序）→ 契约对齐（URL/method/序列化/错误码）；落共享套件 `nx run mobile:contract-smoke`
- [X] T015 [Server] **新 ADR**：`docs/adr/0055-chat-ctx-sse-streaming-llm-provider.md`（记仓内三首例：① `chat` bounded context（ADR-0032 sunset 派生）② SSE 流式端点 Fastify `reply.hijack()` 范式 ③ `LlmProvider` port + server-proxy LLM key 策略——为 028/029/二期立锚）+ `docs/adr/README.md` index + frontmatter 过 `adr-frontmatter-check`/`adr-index-check`
- [X] T016 [Verify] **PR gate**：`pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main`（首跑 `--skip-nx-cache`）全绿 + moat/boundaries 0 violation（chat 叶子不跨 ctx，`JwtAuthGuard` 复用 OK）+ `[Contract-Smoke]` 绿 + spec `status: implementing→implemented` + tasks.md `[X]` 全同步 + PR body 三 checkbox 部署 gate

---

## Dependencies & 执行顺序

```text
T001(schema) ─┬─► T002/T003/T004 [P] 纯函数(无 DB)
              └─► T005(provider) ─► T006(会话 CRUD UC/controller + module 注册)
                                      └─► T007(SSE 发消息 UC/controller) ─► T008(state_branches IT)
T006/T007/T009(swagger) ─► T009(export-openapi + api-client regen)
T009 ─► T010(SSE 客户端) ─► T011(use-chat 态机) ─► T012(首页屏) ─► T013(Mobile-E2E)
T007 + T009 ─► T014(Contract-Smoke 真 server)
全部 ─► T015(ADR) ─► T016(PR gate)
```

- **MVP（US1 最小闭环）**：T001 → T005 → T006 → T007 → T009 → T010 → T011 → T012 —— 发起对话 + 流式回复 + 落库，单这条链已交付「问一句看流式回答」核心价值。
- **US2（多轮）**：T002（上下文窗口）+ T007（带历史）+ T011（多轮消息态）。
- **US3（停止/重试）**：T005（fake 可注 error）+ T007（停止/失败落库语义）+ T011（stop/retry 态）+ T013（交互验证）。
- **并行**：T002/T003/T004 三纯函数互不依赖可并行；mobile T010 解析纯函数与 server 段可并行起手（契约 T009 后接 client）。

## 验证矩阵映射（spec → task）

| spec | 覆盖 task |
|---|---|
| FR-001 空态带昵称 | T012 |
| FR-002 尽管问+发送禁用 | T012 |
| FR-003 流式增量 | T007 / T010 / T013 |
| FR-004 多轮 token 窗口 | T002 / T007 |
| FR-005/006 落库+归属 | T006 / T007 / T008 |
| FR-007 server 持 key | T005 |
| FR-008 停止保留 | T007 / T011 / T013 |
| FR-009 失败不落+重试 | T007 / T011 / T013 |
| FR-010 内容由 AI 生成 | T012 |
| FR-011 模型名只读+hamburger 占位 | T012 |
| FR-012 认证 | T006 / T008 |
| FR-013 标题派生 | T003 / T007 |
| SC-001 TTFT | T008（env-gated 真 DeepSeek 观察，PoC 已实测 518ms） |
| SC-002 重进仍在 | T006(get-messages) / T011(reload) / T014 |
| SC-007 越权 | T006 / T008 |
| state_branches ×8 | T008 |
