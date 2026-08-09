# Research — 037 ideation mockup 交付链路 + App 渲染

> Phase 0 研究收敛。NEEDS CLARIFICATION 已在 `/speckit-clarify`（spec § Clarifications 3 问）+ spec Assumptions 解决；本文件收敛**真正的技术选型决策**（与 035/036 research.md 同体例）。HOW 基线 = [Phase D 设计 §A/§E](../../docs/private/plans/2026-06/06-27-ideation-mockup-phase-d-delivery-seam.md)。Q2（凭证鉴权）+ R3（渲染库）经**联网核业界**后定。

## R1 — 凭证端点鉴权 + scope 派生：worker-token + server 派生（轻量 B，vs 委托 token）

- **Decision**: mockup 上传凭证 + 写记录端点 = **worker-token 鉴权**；scope（accountId + sessionId）由 **server 据 channel 所认领的 `agentQueueEvent` 派生**，channel 不得自报。凭证 PostObject scope 锁 `ideation-mockup/{accountId}/{sessionId}/`。
- **Rationale**（联网核，2026-06-27）：对齐**业界对「队列 worker 替某资源传产物到对象存储」的主流答案**——
  - **AWS Deadline Cloud**（渲染农场 = 队列 + 远程 worker + 每任务产物落 S3，1:1 对照）：worker **不持用户 token**，两层身份 fleet role（worker 自证）+ queue role（worker assume、scope 据 job 派生、prefix 锁 S3、短时效 + 自动刷新、confused-deputy 防护）。([Deadline Cloud service roles](https://docs.aws.amazon.com/deadline-cloud/latest/userguide/security-iam-service-roles.html))
  - **AWS presigned 最佳实践**：后端签发、凭证继承签发者授权、session policy 收 prefix、PostObject policy 自带过期窗（独立于账户 token TTL）。([presigned 最佳实践](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/overview.html))
  - **RFC 8693**：复用 account access token 作「委托」实为 **impersonation**（无 `act` claim、不可审计）；worker workload-identity 优于 opaque 冒充。([RFC 8693](https://datatracker.ietf.org/doc/html/rfc8693))
  - **credential vending/broker**（Iceberg/Lake Formation/Unity Catalog/[broker 论文](https://arxiv.org/html/2504.14761v1)）：worker 自证 → broker 据请求资源派生最小权限短时凭证。
  - 净：worker-token 派生模型**免委托 token TTL race、伪造面最紧、confused-deputy 最稳**；Deadline Cloud 的 fleet/queue 双 role 分层正是「worker-token（agent-bridge 传输）+ 资源 scoped 凭证（ideation）」。
- **Alternatives considered**:
  - ❌ **委托 token / ideation ctx（mirror AttachmentCredentialController）**：ctx 最纯 + 最大复用，但委托 token 是 impersonation（可审计差）、需调 TTL 放宽写授权、与业界主流不符。
  - ❌ **channel 自报 account/session**：越权面，被否决。
- **轻量化（senior 测）**：不引通用 `bizType→policy` registry / STS role-vending / `act`-claim delegation 链（单 consumer YAGNI）——只一个 worker-token 端点 + 据 event 派生。

## R2 — 落库形态：新 `IdeationMockup` 表（ideation ctx，vs 扩 agent-queue result）

- **Decision**: 新 `IdeationMockup` 领域表（`ideation` schema）；worker-token 写记录端点（校 objectKey prefix 归属）；postResult 留 agent-queue 终态（解耦）；**OSS callback 硬化 DEFER**。
- **Rationale**: 领域记录归 ideation ctx，app 走读端点 `GET /ideation/sessions/{id}/mockups`；扩 `agent_queue_event.result`(Json) = 拿瞬态队列表当领域库 + 跨 ctx + 无 app 读路。prefix scope 锁死下，channel 谎报 key 仅致渲染 404（低害，非安全）→ OSS callback（需 server 公网可达 + 验签）过重，先不上；要兜可 server 写时 OSS HEAD 校存在（tasks 期可选）。
- **Alternatives considered**: ① 扩 agent-queue result —— ctx 漏 + 瞬态表当领域库；② OSS upload callback 权威落库 —— v1 过重，scope 锁 + 低害下不必要。

## R3 — 渲染库：`react-native-webview` + 静态硬化（vs @expo/dom-webview / expo-web-browser / 自绘）

- **Decision**: `react-native-webview`（唯一新依赖）`source={{uri}}` 内嵌渲染交付的 mockup；**静态硬化** `javaScriptEnabled={false}`（静态设计稿不需 JS）+ `originWhitelist` 锁备案展示域 + `onShouldStartLoadWithRequest` 拦外链 + CSP + 不在 webview 处理敏感数据。Web e2e 下退化 `<iframe sandbox>` + meta-CSP。
- **Rationale**（联网核，2026-06-27）：Expo 官方 SDK 文档收录 + `expo install react-native-webview`（~13.13.x）一等支持、活跃维护（[Expo webview doc](https://docs.expo.dev/versions/latest/sdk/webview/)）；不可信 HTML 渲染业界硬化法（关 JS / 独立 origin 加载 / CSP frame 白名单 / 不在 webview 放敏感数据）正是本场景所需（[Zellic WebView 安全](https://www.zellic.io/blog/webview-security/)）——mockup 是**静态**设计稿 → 关 JS 后攻击面骤降，配独立备案域 origin 隔离，干净落 spec FR-005 / SC-004。
- **Alternatives considered**:
  - ❌ `@expo/dom-webview`（SDK56 DOM 组件默认）—— 为「跑 RN-authored React DOM 组件」用途，非渲染任意 URL/HTML，错用途。
  - ❌ `expo-web-browser`（已装）—— 开 SFSafariViewController / Custom Tabs **modal 浏览器 chrome**，非内嵌 viewer 内联渲染。
  - ❌ in-app sanitize-then-render（`react-native-html-webview` 类）—— 净化大段自包含设计稿易破样式；**origin 隔离（备案域）+ 关 JS** 是更干净的隔离边界，不依赖 sanitizer 正确性。
- **impl 期动作**: 引库 task 触发「新依赖」stop-signal，PR body 列本对比 + 硬化配置（stop-signal #2 已满足）。

## R4 — 产物形态：单自包含对象 + channel 后处理内联（vs 多对象 / author 侧内联）

- **Decision**: mockup 多状态屏拼**单自包含 HTML**（内联 CSS）→ 1 OSS 对象；内联由 **channel `turn.ts`（node）后处理**做（`<link>`→`<style>`，纯机械、不喂 LLM）。`screens[]` 逐屏标签作记录 metadata。
- **Rationale**（设计 doc §E Q4/Q5）：私有桶相对 `_ds/css` 路径 403（PoC-3 §234）→ 必自包含；node 确定性内联避免 LLM drift / token 浪费（senior 测）；单对象 = app 一个隔离 iframe 渲完、最简。**注**：此项落 **channel（agent-platform 仓，仓外）**，本 feature 仅消费其产物 objectKey。
- **Alternatives considered**: ① 多对象 —— app 要拉 manifest 渲 gallery、对象多；② author（claude -p）侧内联 —— LLM 干机械活、drift 风险。

## R5 — 多版 / 元数据 / 新鲜度：append-only + 逐屏标签 + fetch-on-open（clarify 编码）

- **Decision**: 多版 = **append-only 保留全部**（新交付不覆盖，多行；最新 = max createdAt，version 序 app 按 rank 派生不落列）；记录元数据 = **逐屏标签清单**（per-screen labels，无文档内锚点）；新鲜度 = **fetch-on-open**（无 session 内实时刷新）。
- **Rationale**（spec § Clarifications Q1/Q2/Q3）：append-only 支撑 US2 迭代对比 + 数据干净；逐屏标签让 app 展示「含哪些状态屏」而不增 author 锚点契约；fetch-on-open 最简（headless 交付耗分钟、用户不盯着等），实时推送 v1 over-engineering。
- **Alternatives considered**: 覆盖式只留最新（丢迭代对比，US2 降级）；仅 count 元数据（无屏级信息）；session 内自动刷新（增轮询/推送，v1 over）。

## R6 — 跨 ctx 归属派生：只读 claimed event + 注释化（Q7-B，vs 直 DI / 共享服务）

- **Decision**: ideation mockup 凭证 / 写记录 UC **只读** `agentQueueEvent`（agent-bridge 表）派生 (accountId, sessionId)，`// CROSS-CONTEXT-READ` 注释化（catalog Q7-B 临时路径），**永不跨 ctx 写**。
- **Rationale**: scope 源头 = 那条 claimed event，数据在 agent-bridge；只读 + 注释化是既不破护城河（无跨 ctx 写）又不让 agent-bridge 长 ideation-mockup 业务知识的路径。单消费者 → 直读最省；第二消费者出现 → 升级抽 agent-bridge 共享只读服务（catalog Q7-B → 共享读服务）。
- **Alternatives considered**: ① 凭证端点放 agent-bridge —— 破其 biz-agnostic；② ideation DI agent-bridge use case —— 非编排跨业务 ctx 耦合；③ 现引共享只读服务 —— 单 consumer YAGNI。
