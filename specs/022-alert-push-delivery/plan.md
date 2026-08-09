---
feature_id: 022-alert-push-delivery
spec_ref: ./spec.md
status: drafted
created_at: '2026-06-07'
updated_at: '2026-06-07'
adr_refs: ['0030', '0032', '0033', '0043', '0052']
context7_verified: ['expo-notifications']
---

# Implementation Plan: 022-alert-push-delivery（预警推送送达 — 极光推送 Android）

**Spec**: [`spec.md`](./spec.md) | **Branch**: `022-alert-push-delivery` | **前置**: [021-alert-management](../021-alert-management/plan.md)（AlertTrigger 事件源 + 消息中心兜底）+ PoC #364（jpush 集成 + 本地 config plugin）| **技术单源**: local-only experience `docs/experience/2026-06/06-07-jpush-android-poc.md`

> 手动模式（不用 orchestrator）→ 本 plan **无 `orchestrator_config` 块**（对齐 011-021）。
> **⚠ 头号架构事实**：**推送出口归 alert ctx 内收，不立 notification ctx**（D1，catalog Q4 复审：022 不新增消息源，ADR-0052 sunset trigger #1 未触发）。**触发→推送解耦 = alert 自有 `push_delivery` 表充当 transactional outbox**（D2，trigger tx 内 fan-out PENDING 行 + BullMQ 异步 dispatch），不走 security/outbox 通用事件表——与 spec 措辞「Outbox (ADR-0033, R3)」存在 pattern 同质 / 实现载体不同的偏离，**plan→tasks gate 请 review**。

## Summary _(mandatory)_

022 = 021 预警触发流水的推送出口三件套：**① mobile 推送正式化**（首启隐私政策弹窗 gate → JPush init → 自建 importance=MAX 通知渠道 → RegID 上报绑定/登出解绑/转绑）→ **② server 推送链路**（trigger tx 内按绑定 fan-out `push_delivery` PENDING 行 → BullMQ dispatch worker split-tx 调极光 REST API → 有限重试 + 留痕）→ **③ 华为厂商通道**（杀进程必达，外部门槛独立 PR-3 交付）。

- **server 段**：alert ctx 加 2 张新表（`push_binding` / `push_delivery`）+ 2 个端点（PUT/DELETE push-binding）+ jpush gateway（mock/jpush 双实现，镜像 sms.config.ts 体例）+ 推送文案纯函数 + evaluate UC trigger tx 内 fan-out + `push-dispatch` BullMQ job（复用 alert queue 连接）。**零新跨 ctx 边**（push 表自持，外呼极光是 external I/O 非跨 ctx）。
- **mobile 段**：`src/core/` 新增 consent store + 首启隐私弹窗（root layout AuthGate 外层；**web 不弹**）；`src/alert/` 新增 push 正式模块（channel 创建 / RegID 监听+轮询 / 绑定上报 / 登出解绑 / 点击进消息中心），`.native.ts` 平台分流（PoC 双文件先例）；`jpush-poc.*` 退役删除。
- **新外部依赖 = 1**：`expo-notifications`（仅用 `setNotificationChannelAsync` 创建 Android 高优渠道——jpush-react-native 无 NotificationChannel API，grep 实证）。新共享常量：`ALERT_PUSH_CHANNEL_ID` 落 `packages/types`（mobile 建渠道 + server payload 双端引用，FR-006 不可变契约）。

## API Contracts _(mandatory)_

EP 编号续 021（EP1-EP8 已 ship）：

| #    | Method | Path                                            | Auth   | Request                                          | Response                                                          | trace FR       |
| ---- | ------ | ----------------------------------------------- | ------ | ------------------------------------------------ | ------------------------------------------------------------------ | -------------- |
| EP9  | PUT    | `/api/v1/alert/push-binding`                    | bearer | `UpsertPushBindingRequest{ registrationId, platform }` | **200** `PushBindingResponse{ registrationId, platform, boundAt }` / 400 / 401 / 429 | FR-002, FR-001 |
| EP10 | DELETE | `/api/v1/alert/push-binding/{registrationId}`   | bearer | —                                                | **200** `{ deleted: number }`（0\|1，仅删本账号命中，幂等）/ 401 / 429 | FR-003         |

- **EP9 转绑语义（clarify Q1）**：`upsert where registrationId`——RegID 全局唯一，已被他账号绑定 → 整体改绑当前账号（旧绑定自动失效）；同账号重复上报 → 刷新 `updatedAt`。幂等，无 409 分支。
- **校验**：`registrationId` 非空 ≤64 字符；`platform` V1 仅 `'android'`。违规 → 400 ProblemDetail（ADR-0038）。
- 鉴权：`JwtAuthGuard` + ACTIVE → 401；EP10 scope `where accountId` 天然反枚举（删他人绑定 → deleted:0，无信息泄露）。限流：复用 021 named 桶 `alert-write-account 30/60s`。
- **perf SoT** = spec frontmatter `perf_budgets`（EP9 100/200；EP10 同档）。
- 推送外呼（极光 `/v3/push`，Basic auth `appKey:masterSecret`）不是本服务端点，不进 contracts；payload 形态见 § Architecture Notes。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| `expo-notifications`（mobile，runtime） | 仅用 `setNotificationChannelAsync(channelId, { importance: AndroidImportance.MAX })` 创建 Android 高优渠道（heads-up 横幅，FR-006）；不用其 push token / 远程推送面（无需 FCM 配置） | [Expo docs — setNotificationChannelAsync](https://docs.expo.dev/versions/latest/sdk/notifications/#setnotificationchannelasyncchannelid-channel)（context7 2026-06-07 verified）；排除项：`rg -i "importance\|notification_channel" node_modules/jpush-react-native/index.js` 0 命中（其 `setChannel` 是统计渠道非 NotificationChannel） |
| 其余 | None | N/A — jpush-react-native / jcore-react-native / semver / 本地 config plugin 均已随 #364 落地 |

## Constitution Check _(mandatory)_

通过，无违反。

| 原则                                               | 状态 | 备注                                                                                                                                                       |
| --------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. SDD（NON-NEGOTIABLE）                            | ✅   | spec ✅ → clarify ✅（2Q）→ plan（本）→ tasks → analyze → implement；UI 新节点仅 1 个全屏弹窗（系统级合规样式，无 mockup 必要——纯文本+双按钮，复用 `~/ui`） |
| II. Test-First TDD（NON-NEGOTIABLE）               | ✅   | 文案渲染/绑定校验/backoff 走纯函数 vitest 红绿；EP9/EP10/fan-out/dispatch Testcontainers IT（mock gateway）覆盖 state_branches；PR-3 厂商通道无代码面 → 真机 SC-002 验收替代 |
| III. Atomic 30min-2h + 独立 commit                 | ✅   | 三段式 PR（见 § Phase 2），tasks 按 30min-2h 拆                                                                                                              |
| IV. Module Boundary（扁平 + 贫血 + 护城河 + 单向） | ✅   | 2 新表自持 owner=alert（moat 注册）；**零新跨 ctx 边**（alert 仍叶子 ctx，021 两条 Q7-B 不变）；外呼极光走 gateway port = external I/O 非跨 ctx              |
| V. 类型同步链 Nx-driven                            | ✅   | PR-1 ship EP9/EP10 + api-client regen 先 merge；PR-2 mobile 消费已落地 typed client（PR-1 描述 cite §V 例外）                                               |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: PR-1 Testcontainers IT 覆盖 EP9（建绑/转绑/刷新）+ EP10（解绑/他人幂等 0）+ trigger fan-out + dispatch worker（mock gateway 注入成功/可重试失败/invalid 三态）至少各一次。
- [x] **Mobile / Web**: 推送为 native-only —— P1 golden path 走**华为真机 dev build 走查**（SC-001/003/004 手验脚本化于 quickstart 段）；web 路径（弹窗不弹 + push no-op）由 hermetic e2e 冒烟。
- [x] **Evidence**: PoC #364 已实证「init → RegID → REST 推 → 真机达」全链（`docs/experience/2026-06/06-07-jpush-android-poc.md`）；022 IT/真机走查随 PR 落。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

新引入 `expo-notifications`（Expo 第一方包）：

| # | Question | Answer |
|---|---|---|
| Q1 | 维护信号 | Expo 官方 SDK 包，随 SDK 54 版本锁定，活跃维护 |
| Q2 | 已装工具可覆盖？ | 否——jpush-react-native 无 NotificationChannel API（grep 实证）；config plugin 注入原生代码方案更脆（withMainApplication 改 Java，升级即碎） |
| Q3 | 栈兼容 | Expo 第一方，managed workflow 原生支持；仅用 local API（channel），不触发 FCM 配置要求 |
| Q4 | LLM 训练覆盖 | 高（Expo 主流包）；本次已 context7 ground |
| Q5 | 解耦成本 | 低——单文件单调用点，替换 = 改一个 init 函数 |
| Q6 | 风险面 | MIT；国内可用（无 Google 服务依赖路径）；与 JPush 共存无冲突（channel 是 app 级系统对象，谁建都一样） |

**Evidence**: context7 `/websites/expo_dev_versions_sdk_notifications` 2026-06-07 查证（见 frontmatter `context7_verified`）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

N/A — feature is mono-native（021 / PoC #364 均 mono 原生，无 meta-repo 迁移面）。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

`rg -n "Open Question|演进|seam" docs/adr/0052* docs/adr/0033* docs/adr/0030*` 扫描结果：

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0052 | 「出现第二类消息源 → 重审消息中心归属，评估拆 notification ctx + Outbox consumer（演进路径 (b)）」 | **accepted-as-is** | 022 不新增消息源（仍是预警触发，新增的是**送达通道**）→ trigger 未命中；push 出口随消息中心暂归 alert。PR-1 给 ADR-0052 加**复审记录**段（push 出口归属判定 + push_delivery-as-outbox 决策），不立新 ADR |
| ADR-0033 | Outbox envelope 通用事件表的消费端 infra（021 D1 已确认 placeholder 零真实 consumer） | **accepted-as-is** | D2 取 alert 自有 push_delivery 表（单消费者不摊销通用 dispatcher，021 D1 同理由）；security/outbox 通用消费 infra 仍是多消费者出现时的演进路径 |
| ADR-0030 | 「5 包减 2」后 packages/ 仅收真共享 | **mitigated** | `ALERT_PUSH_CHANNEL_ID` 常量 = mobile+server 双端真共享 → 落 `packages/types` 符合判据，非边界破坏 |

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装微型 DI 容器让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试"视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 8 条每条**必须**在 integration / e2e / 真机走查矩阵中有对应验证项（native-only 分支——厂商通道送达/杀进程——落真机走查清单，不落 IT 也必须显式列出归属）。

### Bounded Context 决策（[catalog](../../docs/conventions/server-bounded-context-catalog.md) 7Q — **D1：alert ctx 内收，不立 notification ctx**）

| Q     | 问题                | 判定                                                                                                                                                                                                                 |
| ----- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1    | 直改某 ctx 核心表？ | **No** — push_binding / push_delivery 全新表，无既有 owner                                                                                                                                                           |
| Q2    | 编排多 ctx 流程？   | **No** — 绑定/投递生命周期在 alert 域内闭环（登录/登出驱动来自 mobile 客户端显式调端点，server 侧无 auth→alert 调用）                                                                                                  |
| Q3    | 纯 platform infra？ | **No** — 业务送达链路（绑定语义/重试策略/文案渲染全是预警业务规则）                                                                                                                                                   |
| Q4    | 完全新业务领域？    | **No（复审）** — catalog 例示的 "notification" 新域以**第二类消息源**为成立要件（ADR-0052 sunset trigger #1）；022 消息源仍唯一（预警触发），新增的是送达通道。ADR-0032 体量 trigger（跨已有边界数 ≥2）亦未触发。**push 出口随消息中心暂归 alert**；第二类消息源出现时连消息中心一起拆 notification（届时 push_binding 迁移成本 = 2 表 + 2 端点改前缀，已计入接受） |
| Q5/Q6 | R2 sync / R3 async？| **No** — 零跨 ctx 写、零 caller 等待、零跨 ctx side-effect（trigger→push 是 **same-ctx** 异步，见 D2）                                                                                                                 |
| Q7    | 独立跨 ctx 读？     | **No 新增** — 021 既有两条 Q7-B（daily_bar / instrument.name）不变；推送文案从 trigger 快照渲染（FR-005），不回查任何他 ctx 表                                                                                          |

**单向边不变**：alert → {account(鉴权 artefact), security(Prisma/Redis infra)}，无人依赖 alert（叶子 ctx）。ESLint boundaries / moat 仅需注册 2 新表 owner=alert（`apps/server/scripts/checks/check-server-moat.ts`），无边变更。

### 数据模型（Prisma schema `alert`，+2 表，migration `yyyymmddhhmm_create_alert_push_tables`）

```text
PushBinding      @@map("push_binding") @@schema("alert")
  id BigInt autoincrement | accountId BigInt（逻辑引用，跨 schema 禁 FK，021 体例）
  registrationId VarChar(64) @unique  ← 一设备一账号（clarify Q1）：upsert by regId = 转绑原子化
  platform String（V1 'android'）| createdAt / updatedAt
  @@index([accountId])  ← fan-out 查询路径

PushDelivery     @@map("push_delivery") @@schema("alert")  ← D2: transactional outbox 兼投递留痕（FR-009）
  id | triggerId BigInt（普通列无 FK，引 alert_trigger；trigger 永不删，文案渲染 join 读快照）
  accountId | registrationId VarChar(64)（创建时快照——dispatch 前复核绑定仍存在）
  status String: PENDING | SENT | FAILED | FAILED_INVALID | SKIPPED_UNBOUND
  attempts Int default(0) | nextAttemptAt Timestamptz? | lastError VarChar(256)?
  createdAt | sentAt?
  @@index([status, nextAttemptAt])  ← dispatch sweep 路径 | @@index([triggerId])
```

- **状态机**：`PENDING →(成功) SENT`｜`→(可重试错误，attempts<3) PENDING + nextAttemptAt=backoff(1m/5m/15m)`｜`→(attempts 耗尽) FAILED`｜`→(极光返回 RegID 无效) FAILED_INVALID + 删除对应 push_binding`（FR-010 防重试风暴）｜`→(dispatch 时绑定已不存在/已转绑他账号) SKIPPED_UNBOUND`（FR-003 登出后零送达的服务端兜底面）。
- **留痕可观测（FR-009 / SC-006）**：push_delivery 行本身 = ledger（状态/attempts/lastError 可查）+ dispatch worker 结构化日志（成功/失败计数 per round）。消息中心兜底由 021 既有面承担，推送任何失败不触碰 trigger。

### 触发→推送解耦（**D2：push_delivery 表 = alert 自有 transactional outbox**，不走 security/outbox 通用事件表）

> **D2 理由**：三路径——(a) security/outbox 通用事件表 + 真 dispatcher：要新建订阅注册 infra + outbox 表加 attempts/重试列（security schema migration），为**单消费者**建通用分发不摊销（021 D1 同判据），且消费方=alert 自己（same-ctx，非 ADR-0033 设定的跨 ctx 通信）；(b) trigger tx 后直接 enqueue BullMQ：Redis 非事务性——tx commit 与 enqueue 之间崩溃即丢推送，违背 FR-004「落库成功 MUST 产生推送任务」；(c) **trigger tx 内同事务写 push_delivery PENDING 行**（transactional outbox pattern 本体）+ BullMQ worker 异步消费：事务保证 + 失败隔离 + 行即留痕三合一。**取 (c)**。ADR-0033 的 pattern 语义（事务内产生任务/异步消费/失败不影响业务写）完整保留，仅载体从通用 outbox_event 换成业务专表；spec 措辞「Outbox (ADR-0033, R3)」按此解读——**analyze 阶段把 spec 该句对齐**（R3 跨 ctx 前提随 D1 不立 notification ctx 而消失）。

- **fan-out（evaluate UC 改造，R1 same-ctx）**：`evaluate-alerts.usecase.ts` trigger tx 内追加——`tx.pushBinding.findMany({ where: { accountId } })` → 每绑定 `tx.pushDelivery.create({ status: 'PENDING', registrationId 快照 })`。0 绑定 → 0 行（消息中心 only）。**P2002 幂等回滚连带 delivery 行**——重跑不产生重复推送。
- **dispatch（`push-dispatch` BullMQ job，复用 `alert-queue-connection.ts` 连接 provider）**：
  1. 调度双轨：eval round 完成后立即 enqueue 一次（SC-001 ≤5min 主路径）+ repeatable `*/5 min` sweep（重试到期 + 漏发兜底；boot 幂等注册，021 prod 部署注意同款）。
  2. worker 流程（split-tx，playbook §外部 I/O）：扫 `status=PENDING AND (nextAttemptAt IS NULL OR <= now)` → 逐行：复核 binding（`registrationId+accountId` 仍匹配？否 → SKIPPED_UNBOUND）→ join trigger 读快照 → 纯函数渲染文案 → **tx 外**调 gateway → 按结果标态（conditional updateMany affected-count，单行失败隔离不废整轮）。
  3. V1 规模（自用 ≤2 设备 × 几十预警）逐行单推；不做 batch audience（同 payload 聚合是上量优化，YAGNI）。

### 极光 gateway + 推送文案（server 段新文件，全部平铺 `apps/server/src/alert/`）

- **`config/jpush.config.ts`**：discriminated union `mock | jpush`（镜像 `sms.config.ts` 体例）——`JPUSH_GATEWAY=jpush` 时 `appKey` / `masterSecret` 必填 boot-time `.parse()`。**Master Secret 仅 env，永不入库/入客户端**（PoC 暴露的凭证重置 □ 列入 PR-1 checklist）。
- **`push-gateway.port.ts` + `jpush-push.gateway.ts` / `mock-push.gateway.ts`**：external vendor I/O 是 ADR-0043 允许的 port/adapter 场景（sms gateway 同款，非自有表 repository）。REST `POST https://api.jpush.cn/v3/push`，Basic auth；返回三分类：`ok | retryable（5xx/网络/限流）| invalid_target（RegID 无效错误码）`。
- **payload 形态**（PoC 实证 + 免费版已定决策）：

```json
{
  "platform": ["android"],
  "audience": { "registration_id": ["<regId>"] },
  "notification": { "android": {
    "alert": "<纯函数渲染：股票名 + 命中条件 + 实际值>",
    "title": "预警触发",
    "channel_id": "<ALERT_PUSH_CHANNEL_ID from packages/types>",
    "extras": { "triggerId": "<id>" }
  } },
  "options": { "time_to_live": 86400 }
}
```

  `secondary_push` 为免费版默认策略不需显式传；离线保留 time_to_live 默认 86400s（spec Edge「天级上限」）。
- **`alert-push-copy.rules.ts` 纯函数**：从 trigger 快照 `{instrumentName, conditionsSnapshot[{type,threshold,actual}]}` 渲染中文文案（与 mobile 消息中心渲染语义同源，「招商银行 跌至 30.00 预警价（今日最低 29.80）」体例；FR-005 不回查活 Alert）。

### Mobile side（`src/core/` 隐私 gate + `src/alert/` push 正式模块）

**首启隐私弹窗（FR-011，US3-AS4 / state_branch #1）**：

- `src/core/consent-store.ts`：zustand persist（**AsyncStorage**——同意标记非密文，不占 SecureStore；auth store 体例的 persist 配置）。`{ privacyConsentAt: string | null }`。
- `app/_layout.tsx` 在 **AuthGate 外层**包 `ConsentGate`：native 且未同意 → 渲染全屏隐私政策屏（标题 + 摘要 + 隐私政策全文链接[复用 settings 既有隐私政策入口同源 URL] + 「同意并继续」/「不同意并退出」）；同意 → 持久化 + 放行；不同意 → `BackHandler.exitApp()`（Android）。**web 不弹直接放行**（D7：web 零采集 SDK、上架合规面仅 Android 渠道；spec web_compat_notes 留点在此定稿）。hydration 前渲染 Splash（auth store 同款防闪）。
- **同意前零初始化（FR-001 / SC-004）**：push init 调用点唯一且在 ConsentGate 放行后的 effect 内，`consented && Platform.OS === 'android'` 双 gate；未同意路径不 require jpush 模块（惰性 require，PoC 体例继承）。

**push 正式模块（`src/alert/push-*.ts` + `.native.ts` 平台分流，PoC 双文件先例；`core/jpush-poc.*` 同 PR 删除）**：

- `push-init.native.ts`：`expo-notifications.setNotificationChannelAsync(ALERT_PUSH_CHANNEL_ID, { name: '预警通知', importance: AndroidImportance.MAX })` → `JPush.init`（appKey 常量，android 读 manifest）→ ConnectEvent 监听 + 轮询兜底取 RegID（PoC 模式）。
- `push-binding.ts`：RegID 就绪 && 已登录 → `PUT push-binding`（orval typed client）；失败静默吞 + 下次启动重试（FR-002「至迟下次启动」）；登录成功事件后若 RegID 已就绪立即补上报（auth store 订阅或 login 流 hook，impl 期定最小侵入点）。
- **登出解绑**：登出流程在 `clearSession` 前 best-effort `DELETE push-binding/{regId}`（await + catch 不阻断登出）。**已知边界**：离线登出 → DELETE 失败 → 绑定残留至该设备下次任意账号登录转绑（EP9）或推送命中 invalid 清理；自用风险窗口接受，记 spec Edge 对齐（⚠️ gate review 一并看）。
- `push-click.native.ts`：`addNotificationListener` `notificationEventType==='notificationOpened'` → `router.push('/(app)/alert/messages')`（021 既有屏）。冷启动/华为小米回调不可靠（PoC #958 实证）→ 不做 payload 深链，021 既有未读角标 + 消息中心兜底（FR-008 内建兜底条款）。
- **系统通知权限关闭**（spec Edge）：`JPush.isNotificationEnabled` 检测 → 设置页加一行引导（跳系统设置）；V1 仅引导不强弹。

### Cross-cutting

- **同步链**：PR-1 swagger → `nx run server:export-openapi` → api-client regen 随 PR-1 merge；EP9/EP10 无 nullable string DTO（boundAt 非空），orval 陷阱不适用但 regen 后照例核对。
- **channel_id 不可变契约（FR-006）**：`ALERT_PUSH_CHANNEL_ID = 'nvy_alert_v1'` 落 `packages/types`（双端 import 单源）；Android channel 属性建后不可改（系统级），改强度需换 id——常量带 `_v1` 后缀留演进位。
- **business-naming**：无新模块（alert 既有三处同名已立）；mobile 新文件全在 `src/alert/` / `src/core/`。
- **PR-3 厂商通道（US2，外部门槛 gate）**：华为开发者账号 + AGC 应用 + Push Kit 开通 + 应用市场上架 + 消息「服务通讯类」申报 = **user 线下办理，工期不可控**；代码面 = `plugins/with-jpush.js` 扩展（HMS maven repo + 极光华为厂商插件 gradle 依赖 + `agconnect-services.json` 注入）+ 重打 APK。SC-002 是该 PR 的唯一验收 gate。极光控制台厂商通道配置（AppID/SecretKey 回填）user 手动。
- **prod 部署注意**：`JPUSH_GATEWAY=jpush` + 凭证进 `.env.production`（服务器原地改 + recreate，SMS 先例）；dispatch repeatable job boot 幂等注册。

## Open Decisions Resolved（⚠️ 标注项请 plan→tasks gate review）

| #       | 决策                     | 结论                                                                                                                                                                                | gate?        |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **D1**  | 推送出口 ctx 归属        | **alert ctx 内收，不立 notification ctx**（Q4 复审：022 不新增消息源，ADR-0052 sunset trigger #1 / ADR-0032 体量 trigger 均未触发）；ADR-0052 加复审记录段随 PR-1                       | ⚠️ 请 review |
| **D2**  | 触发→推送解耦载体        | **push_delivery 表 = alert 自有 transactional outbox**（trigger tx 内 fan-out PENDING + BullMQ 异步 dispatch）；不走 security/outbox 通用事件表（单消费者不摊销 + same-ctx 非 R3）；spec「Outbox (ADR-0033, R3)」措辞 analyze 阶段对齐 | ⚠️ 请 review |
| **D3**  | 投递记录持久化           | **独立 push_delivery 表**（spec Key Entity 留的二选一）——兼任 outbox 与 FR-009 留痕 ledger，一表三用                                                                                  | ✅ 随 D2 定  |
| **D4**  | 重试策略                 | attempts ≤3，backoff 1m/5m/15m（nextAttemptAt）；invalid RegID → FAILED_INVALID + 删 binding（FR-010）；耗尽 → FAILED 终态留痕                                                        | ✅ 默认接受  |
| **D5**  | dispatch 调度            | eval 完成即时 enqueue + repeatable `*/5min` sweep 双轨（SC-001 5min 预算内 + 重试/漏发兜底）；复用 alert queue 连接 provider                                                           | ✅ 默认接受  |
| **D6**  | channel 创建机制         | **expo-notifications `setNotificationChannelAsync`**（jpush-react-native 无该 API，grep 实证；config plugin 注原生代码方案更脆）；新依赖过 6Q card                                     | ⚠️ 请 review |
| **D7**  | 隐私弹窗 web 行为        | **web 不弹直接放行**（web 零采集 SDK、上架合规面仅 Android 渠道）；native（android+未来 ios）统一弹                                                                                    | ⚠️ 请 review |
| **D8**  | consent 持久化介质       | zustand persist + AsyncStorage（非密文不进 SecureStore）；卸载重装 → 重新弹（合规正确行为）                                                                                           | ✅ 默认接受  |
| **D9**  | 离线登出解绑残留         | best-effort DELETE + 转绑/invalid 清理双兜底；残留窗口（该设备登出后仍可能收推送直至转绑）自用接受——FR-003 的字面 MUST 与此有张力，gate review 确认（必要时 spec Edge 补一句）           | ⚠️ 请 review |
| **D10** | channel_id 常量落点      | `packages/types`（mobile+server 真共享，ADR-0030 判据符合）；`'nvy_alert_v1'` 带版本后缀留演进位。**impl 修正（2026-06-07 user 拍板）**：server 物理无法消费 TS-source-only workspace 包（swc CJS dist + 裸 node 不识 custom condition）→ mobile 侧 SoT 留 `packages/types`，server 侧 `push-gateway.port.ts` 本地副本 + 注释互指；改值双端同步换 `_v2` | ✅ 默认接受  |
| **D11** | 点击跳转实现深度         | 仅 `notificationOpened` 监听 → push 消息中心路由；不做 payload 深链/冷启动 launch-intent 解析（华为/小米回调不可靠 #958，FR-008 兜底条款覆盖）                                          | ✅ PoC 实证  |
| **D12** | **PR-3 厂商通道交付时机 + 真实范围**（2026-06-08 user 回头评估拍板） | **PR-3 绑定「华为应用市场上架」里程碑交付，不作孤立推送任务现推。** 真实前置 = 整条合规上架链（域名备案 → 软著 → 华为应用市场上架 → 厂商通道审核 → 自分类权益），非「配推送」单点（厂商通道审核以应用市场上架为前置，T016 明写；域名当前未备案，链未启）。**为何该做**：厂商通道唯一增益 = 华为 + 杀进程**系统级必达**，对行情预警是核心（杀进程 = 典型「没盯盘」态，重开才补达 ≈ 预警作废），产品价值真，非 vanity。**为何不现在做**：account-migration 期 ≈0 真实日活 + 免费档仅 30% 流量走厂商通道（超出仍回落自有通道）+ 仅覆盖华为（小米/OV 杀进程仍重开补达）→ ROI 现倒挂，且代价是以周计不可压缩的外部门槛。**现状诚实账**：上架前华为杀进程「必达」**兑现不了**，只到「重开补达 + 消息中心永久兜底」——已知功能缺口非 bug，对外勿宣称「必达」。**PR-3 范围修正（非纯 mobile）**：`jpush-push.gateway.ts` 现 payload 未透传华为 category（`options.third_party_channel.huawei.category`）；服务通讯类不带 category → 2023-03-31 起被默认判营销类、撞日限额静默丢（华为自分类规则）→ PR-3 需含一处 **server payload 改动 + gateway spec 断言**（除非极光控制台支持给华为通道配默认 category，则回退纯 mobile）。**今日零外部门槛折中**：高优预警走阿里云短信（prod 已激活）兜底，系统级 + 杀进程必达 + 全机型覆盖，作厂商通道前的过渡选项（成本 = 短信费 + 模板申报）。 | ✅ user 拍板 |

## Complexity Tracking

> 无 Constitution 违反需 justify。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| —         | —          | —                                    |

**Note**：(1) 零新 ctx、零新跨 ctx 边——2 新表自持 + 1 gateway port（vendor I/O 正当场景）。(2) 唯一新 infra = push-dispatch job，完全复用 021 queue 连接与 repeatable 注册模式。(3) mobile 新 UI 仅 1 全屏弹窗；push 模块 ≈ PoC 代码正式化 + 绑定调用，无新交互范式。

## Performance Budget

| Endpoint                         | P95 (ms) | P99 (ms) |
| -------------------------------- | -------: | -------: |
| EP9 PUT push-binding / EP10 DELETE |      100 |      200 |

_SoT = spec frontmatter `perf_budgets`。送达时效非端点预算：SC-001/002 的 ≤5min 由「eval 后即时 enqueue + 极光受理秒级（PoC 实测）」覆盖，repeatable 5min sweep 是兜底不是主路径。_

---

## Phase 2 准备（`/speckit-tasks` 输入要点）

### PR 策略建议（plan→tasks gate review）

**三段式 PR**（US1 server/mobile 拆两段走 Constitution §V；US2 外部门槛独立）：

- **PR-1（server，feat(alert)）**：ADR-0052 复审记录 + Prisma schema/migration（2 表）+ moat owner 注册 + jpush.config + gateway port/双实现 + `alert-push-copy.rules.ts` + EP9/EP10 UC+controller + evaluate UC fan-out 改造 + push-dispatch worker/job + Testcontainers IT（state_branches server 条目全覆盖：转绑/解绑/fan-out/重试/invalid 剔除/故障隔离）+ **api-client regen**（cite §V 例外）+ PoC 暴露凭证重置确认。
- **PR-2（mobile，feat(alert)）**：consent store + ConsentGate 弹窗 + push 正式模块（channel/init/RegID/绑定/解绑/点击）+ `jpush-poc.*` 退役 + expo-notifications 引入 + vitest（consent 决策/绑定重试逻辑/文案无关纯函数）+ `[Mobile-E2E]` hermetic（web：不弹直进 + push no-op；mock binding 端点）+ `[Contract-Smoke]`（登录 → PUT binding → 转绑（第二账号 PUT 同 regId）→ DELETE → 幂等，落 `apps/mobile/e2e/contract-smoke/alert-push.contract.ts`）+ **华为真机走查**（SC-001/003/004 + US1-AS 全条 + 离线补达）。
- **PR-3（厂商通道，feat(alert)）**：`with-jpush.js` HMS 扩展 + agconnect 注入 + 重打包 + 极光控制台/AGC 配置（user 线下：开发者账号/上架/服务通讯类申报）+ **server payload 华为 category 透传（见 D12 范围修正）** + SC-002 真机验收（杀进程 ≥10 次全达）。**外部门槛 gate，时间不可控，绑定上架里程碑交付（D12），与 PR-1/2 解耦**。

> 依赖：021 三 PR + PoC #364 已 ship；PR-2 依赖 PR-1 merge（§V）；PR-3 依赖 PR-2 的 APK 基础 + **整条合规上架链（D12：备案 → 软著 → 应用市场上架 → 厂商通道审核 → 自分类权益）**，非单点配置。

### 建议 tasks.md 层级（每 task 30min-2h，预估 **~13-16 task**）

- **PR-1 ~7**：`[Server]` ADR-0052 复审 + schema/migration/moat → `[Server]` jpush.config + gateway port/mock/jpush 红绿 → `[Server]` push-copy rules 红绿 → `[Server]` EP9/EP10 UC+controller → `[Server]` evaluate fan-out 改造 → `[Server]` dispatch worker/job（重试态机）→ `[Server-IT]` state_branches + `[Contract]` regen
- **PR-2 ~6**：`[Mobile]` consent store + ConsentGate 弹窗 → `[Mobile]` channel + push-init（expo-notifications 引入）→ `[Mobile]` RegID 上报/解绑挂点 + 点击路由 + poc 退役 → `[Mobile-E2E]` hermetic → `[Contract-Smoke]` → `[Manual]` 华为真机走查矩阵（SC-001/003/004）
- **PR-3 ~3**：`[Mobile]` with-jpush HMS 扩展 + agconnect → `[Manual]` 控制台/AGC 配置 + 申报（user）→ `[Manual]` SC-002 验收实测

---

**Plan Version**: 1.0.0 | **Created**: 2026-06-07 | **ID-namespace**: US1-3 / FR-001..011 / SC-001..006（EP 续 021 编号 EP9-EP10）| **ADR**: 0052（复审记录随 PR-1）/ 0033（pattern 保留载体换专表）/ 0043（扁平贫血+gateway port）/ 0030（packages/types 共享常量）/ 0032（Q4 复审不立新 ctx）
