---
feature_id: 022-alert-push-delivery
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-07'
---

# Tasks: 022-alert-push-delivery（预警推送送达 — 极光推送 Android）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `022-alert-push-delivery` | **技术单源**: local-only `docs/experience/2026-06/06-07-jpush-android-poc.md`（PoC #364 实证）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Manual]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；UC 读写 DB 单测走 **Testcontainers PG**（run via `nx test server <file>`，cwd=apps/server）；纯函数（push-copy / backoff / gate 决策）= vitest 无 DB；mobile 纯逻辑 = vitest helper-level，UI·render·a11y = Playwright Expo Web e2e（mono 测试分层）；**native-only 行为（推送送达/横幅/杀进程）= 华为真机走查矩阵显式归属（plan EXHAUSTIVE BRANCHING）**
- 无 task-meta JSON（**manual 模式**，per 004-021）
- 🚨 **零新 ctx / 零新跨 ctx 边（plan D1）**：push_binding / push_delivery 2 新表自持 owner=alert（moat 注册）；**不立 notification ctx**（ADR-0052 加复审记录段随 T001）；021 既有 2 条 Q7-B 注释不动；**跨 ctx 写永远禁**；外呼极光 = gateway port（vendor I/O，ADR-0043 允许）
- 🚨 **transactional outbox = push_delivery 专表（plan D2）**：trigger tx 内 fan-out PENDING 行；**不碰 security/outbox 通用事件表**；dispatch = BullMQ（复用 `alert-queue-connection.ts` 连接 provider）eval 后即时 enqueue + repeatable `*/5min` sweep；split-tx（**禁 tx 内持锁等 HTTP**，playbook §外部 I/O）
- 🚨 **隐私 gate（FR-001/FR-011）**：推送 init 调用点唯一且在 ConsentGate 放行后，`consented && Platform.OS==='android'` 双 gate；未同意路径**不 require jpush 模块**（惰性 require，PoC 体例）；**Master Secret 仅 server env 永不入库/入客户端**
- **三段式 PR（per Constitution §V + plan §Phase 2）**：**PR-1 = Server**（T001–T009，ships EP9/EP10 + 推送链路真后端 + **api-client regen committed**，描述 cite §V 例外）→ **PR-2 = Mobile**（T010–T015，消费 PR-1 已 merge typed client + 两层验证 + 真机走查）→ **PR-3 = 华为厂商通道**（T016–T018，**外部门槛 gate 时间不可控**，独立交付）

## Path Conventions

- server：`apps/server/src/alert/`（既有 module，扁平平铺新文件）；config `apps/server/src/config/jpush.config.ts`（镜像 `sms.config.ts` 体例）；schema `apps/server/prisma/schema.prisma`（`@@schema("alert")` +2 表）+ migration `create_alert_push_tables`；IT `apps/server/test/integration/*.it.spec.ts`
- 共享常量：`packages/types`（`ALERT_PUSH_CHANNEL_ID = 'nvy_alert_v1'`，mobile 建渠道 + server payload 双端单源，FR-006）
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）；EP9/EP10 无 nullable string DTO，regen 后照例核对
- mobile：push 模块 `apps/mobile/src/alert/push-*.ts`（`.native.ts` 平台分流，PoC 双文件先例）；consent `apps/mobile/src/core/consent-store.ts` + 弹窗组件；root gate `apps/mobile/app/_layout.tsx`（ConsentGate 在 AuthGate **外层**）；`src/core/jpush-poc.*` 同 PR 删除；插件 `apps/mobile/plugins/with-jpush.js`（PR-3 扩展）
- e2e：`apps/mobile/e2e/`（hermetic 必 mock EP9/EP10 + 003 refresh-token per memory）；contract-smoke `apps/mobile/e2e/contract-smoke/alert-push.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（mbw-poc-postgres:5433 / redis:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**；新表落库后 `prisma generate` 先行；新文件首跑 `--skip-nx-cache`

---

## Phase 1: Server — 绑定端点 + 推送链路（PR-1）

**Goal**：2 表 + EP9/EP10 ship 真后端 + trigger fan-out + dispatch worker（mock gateway 全链可测）+ api-client regen。

- [X] T001 [Server] **注册面 + 共享常量**：ADR-0052 加复审记录段（022 push 出口归 alert 判定 + push_delivery-as-outbox D2，过 `check-adr-frontmatters`+`check-adr-index`）+ Prisma schema 2 表（`PushBinding`/`PushDelivery`，`@@schema("alert")`，形态 per plan §数据模型：`registrationId @unique` / `@@index([accountId])` / `@@index([status, nextAttemptAt])` / `@@index([triggerId])`）+ migration `create_alert_push_tables` + `prisma generate` + moat `MODEL_OWNERSHIP` 注册 2 表 owner=alert `apps/server/scripts/checks/check-server-moat.ts` + `packages/types` 加 `ALERT_PUSH_CHANNEL_ID = 'nvy_alert_v1'` 常量 export。**验**：migrate deploy 绿 + moat/adr 检查全绿
- [X] T002 [US1] [Server] **jpush config + gateway port/双实现**：`apps/server/src/config/jpush.config.ts`（zod discriminated union `mock | jpush`，`JPUSH_GATEWAY=jpush` 时 `appKey`/`masterSecret` 必填 boot `.parse()`，镜像 sms.config.ts）+ vitest 红绿（mock 默认 / 部分凭证拒）+ `apps/server/src/alert/push-gateway.port.ts`（`PUSH_GATEWAY` token + `send(payload) → {kind:'ok'|'retryable'|'invalid_target', detail?}`）+ `mock-push.gateway.ts`（log + 可注入结果，IT 用）+ `jpush-push.gateway.ts`（`POST https://api.jpush.cn/v3/push` Basic auth，payload per plan §payload 形态：audience registration_id + `notification.android{alert,title,channel_id,extras.triggerId}` + `options.time_to_live 86400`；HTTP mock 单测：payload 形态快照 / 5xx·网络·限流→retryable / RegID 无效错误码→invalid_target）+ `alert.module.ts` 按 config.kind 绑 provider
- [X] T003 [P] [US1] [Server] **推送文案纯函数**：`apps/server/src/alert/alert-push-copy.rules.ts` + vitest 红绿：从 trigger 快照 `{instrumentName, conditionsSnapshot[{type,threshold,actual}]}` 渲染标题+正文（四类条件文案 ×「招商银行 跌至 30.00 预警价（今日最低 29.80）」体例，与 mobile 消息中心渲染语义同源；多条件 AND 拼接；**不回查活 Alert**，FR-005）
- [X] T004 [US3] [Server] **绑定 UC + controller（EP9/EP10）**：`upsert-push-binding.usecase.ts`（EP9：`upsert where registrationId`——他账号已绑 → 整体改绑当前账号（clarify Q1 转绑），同账号 → 刷新 updatedAt；幂等无 409）+ `delete-push-binding.usecase.ts`（EP10：`deleteMany where {registrationId, accountId}` 返 count，他人/不存在 → 0 无杂音反枚举）+ request/response DTO（registrationId 非空 ≤64 / platform 仅 `'android'` → 400 ProblemDetail）+ `push-binding.controller.ts`（`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `@Throttle` 复用 021 `alert-write-account 30/60s` 桶 + `@ApiBearerAuth()` + swagger 全响应码）+ **Testcontainers 单测**：建绑 / 同账号重报刷新 / 他账号同 regId 转绑（旧绑定消失）/ 解绑幂等 / 他人解绑 deleted:0 / platform 出域 400
- [X] T005 [US1] [Server] **evaluate fan-out 改造**：`evaluate-alerts.usecase.ts` trigger tx 内追加——`tx.pushBinding.findMany({where:{accountId}})` → 每绑定 `tx.pushDelivery.create({status:'PENDING', registrationId 快照, triggerId, accountId})`（R1 same-ctx）+ **Testcontainers 单测**：触发 ×2 绑定 → 2 行 PENDING / 0 绑定 → 0 行（消息中心 only）/ P2002 幂等回滚连带 delivery 零残留 / fan-out 异常不破坏既有触发语义（021 T011 既有测试零回归）
- [X] T006 [US1] [Server] **dispatch worker + 调度双轨**：`push-dispatch.processor.ts`（BullMQ job `push-dispatch` 复用 `alert-queue-connection.ts` 连接 provider）——扫 `status=PENDING AND (nextAttemptAt IS NULL OR <=now)` → 逐行：复核 binding（regId+accountId 仍匹配？否 → `SKIPPED_UNBOUND`）→ join trigger 读快照 → T003 渲染 → **tx 外**调 gateway → 结果标态（conditional updateMany affected-count）：ok→`SENT+sentAt` / retryable→attempts+1 + `nextAttemptAt=backoff(1m/5m/15m)`，attempts≥3→`FAILED+lastError` / invalid_target→`FAILED_INVALID` + 删对应 push_binding（FR-010）；单行异常隔离不废整轮 + `alert-eval.processor.ts` eval round 完成后即时 enqueue `push-dispatch` + boot 幂等注册 repeatable `*/5 * * * *` sweep + `alert-eval.cli.ts` 加 `--dispatch` 手动触发支持 + **Testcontainers 单测**（mock gateway 注入三态）：成功 SENT / retryable 两轮后成功 / 耗尽 FAILED 终态留痕 / invalid → FAILED_INVALID+binding 删 / 已转绑 → SKIPPED_UNBOUND / 单行炸不传染
- [X] T007 [US1] [Server-IT] `apps/server/test/integration/alert-push.it.spec.ts`（Testcontainers 全 boot，mock gateway DI 注入，覆盖 spec `state_branches` server 条目）：绑定生命周期闭环（A 登录绑 → B 同设备登录转绑 → A 触发零 delivery、B 触发有 / 登出解绑后触发 → 0 行或 SKIPPED_UNBOUND，SC-005）/ 触发 → delivery → dispatch → SENT 全链 / **gateway 故障注入 → trigger 流水 + EP6/EP7 消息中心 100% 不受影响 + 失败行可查**（FR-004/SC-006）/ invalid 剔除不再重试（FR-010）/ EP9/EP10 401·429·400 分支
- [X] T008 [Contract] `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen EP9/EP10 hooks + 类型）→ `packages/api-client` + mobile typecheck 绿。**regen 产物随 PR-1 commit**（Constitution §V，PR 描述 cite 例外）
- [X] T009 [Verify] PR-1 gate：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（**首跑 `--skip-nx-cache`**）+ moat 探针关（2 新表 owner + 零跨 ctx 写）+ ADR-0052 复审段索引过 + spec frontmatter `status: implementing` 翻 + **PoC 暴露的 Master Secret 控制台重置确认（user 手动 □，PR 描述 checklist 项）**

**Checkpoint**：PR-1 merge → 绑定端点 + 推送链路真后端可用（mock gateway 全链绿），api-client 落地。

---

## Phase 2: Mobile — 隐私 gate + 推送正式化（PR-2）

**Goal**：首启隐私弹窗 → 同意后 init → RegID 绑定生命周期接通 → 真机走查 SC-001/003/004/005。

- [X] T010 [US3] [Mobile] **consent store + ConsentGate 弹窗**：`apps/mobile/src/core/consent-store.ts`（zustand persist + **AsyncStorage**，`{privacyConsentAt: string|null}`，plan D8）+ `consent-gate-decision.ts` 纯函数（web → 放行 / native 未同意 → 挡 / 已同意 → 放行）+ vitest 红绿 + 全屏隐私政策屏组件（标题+摘要+隐私政策全文链接[复用 settings 既有同源 URL]+「同意并继续」/「不同意并退出」`BackHandler.exitApp()`；复用 `~/ui`，hydration 前 Splash 防闪）+ `app/_layout.tsx` 在 AuthGate **外层**包 ConsentGate（FR-011：同意前不进主界面、不初始化任何采集组件；同意持久化后续不弹）
- [X] T011 [US1] [Mobile] **channel + push init 正式化**：`pnpm -C apps/mobile add expo-notifications`（仅用 `setNotificationChannelAsync`，plan D6 / 6Q card 已过）+ `apps/mobile/src/alert/push-init.native.ts`（`setNotificationChannelAsync(ALERT_PUSH_CHANNEL_ID, {name:'预警通知', importance: AndroidImportance.MAX})` → `requestPermissionsAsync()`（Android 13+ POST_NOTIFICATIONS 系统弹框，12- no-op，analyze U2）→ 惰性 require `JPush.init`（appKey 常量，android 读 manifest）→ ConnectEvent 监听 + 轮询兜底取 RegID，PoC 模式继承）+ `push-init.ts` web no-op 双文件 + 调用点：ConsentGate 放行后 effect 内 `consented && Platform.OS==='android'` 双 gate（**`__DEV__` 限制去除**，正式全 build 生效）+ **`src/core/jpush-poc.ts`/`.native.ts` 删除 + `_layout.tsx` 改挂新入口** + vitest（init gating 决策纯函数：web/未同意/ios → no-op）
- [X] T012 [US3] [Mobile] **RegID 绑定生命周期 + 点击路由**：`apps/mobile/src/alert/push-binding.ts`（RegID 就绪 && 已登录 → orval typed `PUT push-binding`；失败静默吞 + 下次启动重试 FR-002；登录成功后 RegID 已就绪则立即补上报——auth store 订阅最小侵入）+ 登出流 `clearSession` 前 best-effort `DELETE push-binding/{regId}`（await+catch 不阻断登出，plan D9）+ `push-click.native.ts`（`notificationOpened` → `router.push('/(app)/alert/messages')`；不做 payload 深链，plan D11）+ 设置页加「通知权限」引导行（`isNotificationEnabled` false → 跳系统设置；web 隐藏）+ vitest（上报条件派生 / 重试触发条件 / 登出解绑次序）
- [X] T013 [P] [Mobile-E2E] `apps/mobile/e2e/alert-push.spec.ts`（Playwright Expo Web hermetic，mock EP9/EP10 + 003 refresh）：**web 不弹隐私弹窗直进 App**（D7 兑现）+ push 路径全程 no-op 不炸（jpush 模块未加载）+ 设置页通知引导行 web 隐藏 + 既有 021 alert e2e 零回归
- [X] T014 [P] [Contract-Smoke] `apps/mobile/e2e/contract-smoke/alert-push.contract.ts`（node 层 `@nvy/api-client` 打 testcontainers 真 server）：账号 A 登录 → PUT binding → 重报幂等 → 账号 B PUT 同 regId **转绑** → A DELETE → deleted:0（已转绑非己有）→ B DELETE → deleted:1。验契约对齐 + 真落库（`nx run mobile:contract-smoke`）
- [X] T015 [Verify] PR-2 gate + **华为真机走查矩阵 [Manual]**：`nx affected -t lint typecheck test build --base=origin/main` 全绿（首跑 `--skip-nx-cache`）+ e2e/contract-smoke 绿 + EAS dev build 装 Mate 50 走查（结果记 PR 描述）：① 首启弹窗→不同意退出→重启再弹→同意进入且后续不弹（FR-011）② 同意前 logcat 零 jpush 活动（SC-004 抓包/logcat 取证）③ 登录 → RegID 上报绑定成功 ④ CLI 触发 → ≤5min 通知栏**横幅**（channel importance 生效，SC-001）⑤ 点击通知 前台/后台/冷启动三态 → 消息中心（SC-003）⑥ 登出 → 触发 → 零送达；另设备登录同账号 → 正常送达（SC-005）⑦ 杀进程 → 触发 → 当时不达 → 重开 App 离线补达（US2-AS2 非华为路径语义）+ spec frontmatter `status: implemented` 翻（US1/US3 范围）

**Checkpoint**：PR-2 merge → 在线/后台推送闭环可 dogfood（US1+US3 全验收）；US2 杀进程必达待 PR-3。

---

## Phase 3: 华为厂商通道 — 杀进程必达（PR-3，外部门槛 gate）

**Goal**：厂商通道接通，SC-002 杀进程必达验收。**前置 = user 线下办理项，工期不可控，与 PR-1/2 解耦。** ⚠️ **交付时机绑定「华为应用市场上架」里程碑，非孤立推送任务（决策 + 完整 ROI/范围分析见 [plan.md](plan.md) D12）**：真实前置是整条合规上架链（备案 → 软著 → 上架 → 厂商通道审核 → 自分类权益）；上架前华为杀进程「必达」兑现不了，仅「重开补达 + 消息中心兜底」；PR-3 范围非纯 mobile（需 server 透传华为 category，见 D12）。

- [ ] T016 [US2] [Manual] **外部门槛 checklist（user 线下，代码零改动）**：华为开发者账号实名 → AGC 创建应用（包名 `com.shintongtech.novainyears`）+ 开通 Push Kit → 下载 `agconnect-services.json` → 应用市场上架（厂商通道审核前置）→ 预警消息申报**「服务通讯类」**（避开运营消息日限额）→ 极光控制台厂商通道回填华为 AppID/SecretKey。每项完成在本 task 下打点记录
- [ ] T017 [US2] [Mobile] **with-jpush 华为厂商扩展**：`apps/mobile/plugins/with-jpush.js` 注入华为厂商 gradle 依赖（极光华为厂商插件 + HMS agconnect 插件 + HMS maven repo）+ `agconnect-services.json` 资产注入（T016 产物）——**沿 PoC 教训：只注入 placeholders/gradle 链接，不注入组件声明（AAR manifest merge 自带）**；`npx expo prebuild --platform android --no-install` 检查产物（gradle 依赖/manifest 注入项）后删本地 `android/`（保持 managed）+ EAS 重打 dev/preview APK 装真机
- [ ] T018 [US2] [Verify] **SC-002 验收 [Manual] + PR-3 gate**：华为真机杀进程 → CLI 触发 ≥10 次 → ≤5min 通知栏全达（送达率 100%，厂商通道系统级代收）+ 厂商通道送达的通知点击 → 消息中心（点击回调不可靠机型 → 角标兜底确认，US2-AS3）+ 厂商通道 30% 占比回落行为知悉记录（spec Edge）+ `nx affected` 全绿 + 走查结果记 PR 描述 + spec frontmatter `status: implemented` 终翻（US2 收口）

**Checkpoint**：PR-3 merge → 「必达」承诺闭环（华为杀进程系统级送达 + 非华为离线补达 + 消息中心永久兜底）。

---

## Dependencies & Execution Order

```text
T001 ──→ T002 ──→ T004 ──→ T006 ──→ T007 ──→ T008 ──→ T009   (PR-1)
     └─→ T003 [P] ──┘    （T006 依赖 T002+T003+T005）
     └─→ T005 ────────┘
PR-1 merge ──→ T010 ──→ T011 ──→ T012 ──→ T013/T014 [P] ──→ T015        (PR-2)
T016 [Manual, 可与 PR-1/2 全程并行推进] ──→ T017 ──→ T018                  (PR-3)
（T017 依赖 T016 的 agconnect-services.json + PR-2 已 merge 的 push 模块基础）
```

- **MVP 切片** = PR-1 + PR-2（US1+US3 闭环：隐私 gate → 绑定 → 触发 → 在线/后台 5min 送达 + 离线补达，真机可 dogfood）；PR-3 是「杀进程必达」增强，外部门槛就绪即接。
- **T016 立即启动**：纯 user 线下流程（开发者账号/上架/申报周期以周计），与代码 PR 全程并行，是 PR-3 的关键路径。
- **Clear 检查点批次**（Constitution §III）：T001-T003 / T004-T006 / T007-T009 / T010-T012 / T013-T015 / T016-T018。
