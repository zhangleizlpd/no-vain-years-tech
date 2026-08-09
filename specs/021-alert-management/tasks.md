---
feature_id: 021-alert-management
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-06'
---

# Tasks: 021-alert-management（预警管理 V1 — EOD 价格预警 + 应用内消息中心）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `021-alert-management` | **Mockup**: [`design/`](./design/)（`股票预警管理.html` + `AlertScreens.jsx` + `AlertKit.jsx`，已验收）

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Verify]`
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；UC 读写 DB 单测走 **Testcontainers PG**（run via `nx test server <file>`，cwd=apps/server）；纯函数（validation / evaluation / limit-price rules）= vitest 无 DB；mobile 纯逻辑 = vitest helper-level，UI·render·a11y = Playwright Expo Web e2e（mono 测试分层）
- 无 task-meta JSON（**manual 模式**，per 004-020）
- 🚨 **alert = 第 6 bounded context（新立，plan D2 / ADR-0052 随 T001 落）**：4 新表自持（moat owner 注册）+ 叶子 ctx（无人依赖 alert）；**跨 ctx 仅 2 条 Q7-B 只读直查**（评估读 `marketdata.daily_bar` none 口径 + 触发快照 `marketdata.instrument.name`），`prisma.<表>.find*` 上方 **必须** `// CROSS-CONTEXT-READ:` 注释（moat 探针拒）；**跨 ctx 写永远禁**。guard 复用（`JwtAuthGuard`+`AccountIdThrottlerGuard` 经 `AccountModule` export）非业务调用无注释
- 🚨 **调度自治（plan D1）**：**不挂 017 调度链 / 不碰 marketdata DIMENSION_KEYS / 不建 outbox consumer**；alert 自持 BullMQ queue `alert-eval`（repeatable `0 23 * * *` + `0 8 * * *`，Asia/Shanghai）+ `(alertId, tradeDate)` 唯一键幂等
- **三段式 PR（per Constitution §V + plan §Phase 2）**：**PR-1 = Server 骨架**（T001–T009，ships CRUD+消息真后端 + **api-client regen committed**，描述 cite §V 例外）→ **PR-2 = Server 引擎**（T010–T014）→ **PR-3 = Mobile**（T015–T024，消费 PR-1 已 merge 的 typed client + 两层验证）
- mockup stub 瑕疵提醒（brief 验收记录 #2）：impl 一切示例/stub 条件**只用价格 4 类**（mockup 屏 5 的「RSI 超卖」不带入）

## Path Conventions

- server：`apps/server/src/alert/`（**新 module，ADR-0043 扁平平铺**）；schema `apps/server/prisma/schema.prisma`（`@@schema("alert")`，4 表）+ migration `yyyymmddhhmm_create_alert_context_tables`；IT `apps/server/test/integration/*.it.spec.ts`（run via `nx test server <file>`，cwd=apps/server）
- contract：`apps/server/openapi.json`（`nx run server:export-openapi`，canonical `node dist/main.js`）→ `packages/api-client/`（Orval `nx affected -t generate`）；**nullable string DTO（note）显式 `@ApiProperty({type:'string', nullable:true})`**（per memory：orval 误生成 object-map）
- mobile：`apps/mobile/src/alert/`（**新 feature dir**，business-naming 与 server module 同名）；routes `apps/mobile/app/(app)/alert/`（`_layout.tsx` anchor + `makeHeaderBackOrParent`）；复用 `~/core/api` / `~/theme`（quote.up/down/flat **0 重设**）/ `~/ui`；行情 merge 复用 `~/portfolio` 的 `use-quote-merge` 范式（015 EP2）
- e2e：`apps/mobile/e2e/`（**必 mock alert 8 端点 + 015 EP2 + 003 refresh-token** per memory；`getByRole` 收窄；本地跑前杀 :3000 nx serve 父进程）；contract-smoke `apps/mobile/e2e/contract-smoke/alert.contract.ts`
- dev DB：`docker compose -f docker-compose.dev.yml up -d --wait` + `prisma migrate deploy`（mbw-poc-postgres:5433 / redis:6380）；**本地 server IT/smoke 前 `env -u OSS_*`**；新 schema/表落库后 `prisma generate` 先行（per memory expo/pnpm 残缺坑）

---

## Phase 1: Server 骨架 — CRUD + 消息中心（PR-1）

**Goal**：alert ctx 立起（ADR + 4 表 + 注册面）+ 8 端点 ship 真后端 + api-client regen。

- [X] T001 [Server] **ctx 立项 + 注册面**：`docs/adr/0052-alert-bounded-context.md`（Q4 判定 + 调度自治 D1 + Q7-B ×2 + notification/outbox 演进 seam，过 `check-adr-frontmatters`+`check-adr-index`）+ Prisma schema 4 表（`Alert`/`AlertCondition`/`AlertTrigger`/`AlertReadCursor`，`@@schema("alert")`，形态 per plan §数据模型：`@@unique([alertId,type])`/`@@unique([alertId,tradeDate])`/`@@index([accountId,triggeredAt(sort:Desc)])`）+ migration `create_alert_context_tables` + `prisma generate` + datasource schemas 数组加 `alert` + ESLint boundaries 加 `{type:'alert', pattern:'src/alert/**'}` 与单向白名单（alert→{account,security}）`apps/server/eslint.config.mjs` + moat `MODEL_OWNERSHIP` 注册 4 表 owner=alert `apps/server/scripts/checks/check-server-moat.ts` + `alert.module.ts` 空壳 + `app.module.ts` 注册。**验**：migrate deploy 绿 + lint/moat/adr 检查全绿
- [X] T002 [US1] [Server] **校验纯函数**：`apps/server/src/alert/alert-validation.rules.ts` + vitest 红绿（conditions 1..4 / 同类型限 1 / PRICE\_\* 阈值>0 / DAILY\_\* 阈值∈(0,100] / note ≤22 Unicode code point / market 仅 cn / frequency 枚举）——纯函数无 DB，错误码喂 400 ProblemDetail 映射
- [X] T003 [US1] [Server] **写侧 UC**：`create-alerts-batch.usecase.ts`（EP3：单 `$transaction` 每标的各建一条 Alert+conditions，任一校验失败整体拒，plan D5）/ `update-alert.usecase.ts`（EP4：conditions 全量替换 + frequency/note/enabled，scope `where {id, accountId}` 不命中 → 404 反枚举）/ `delete-alerts-batch.usecase.ts`（EP5：`deleteMany where id in + accountId`，返 count）+ request DTO（class-validator + T002 rules）+ **Testcontainers PG 单测**：批量 2 标的各 1 条 / 同类型重复 400 / 0 条件 400 / note 23 字 400 / 他人 alert update→404 / 批量删只删本账号
- [X] T004 [P] [US1] [Server] **读侧 UC**：`list-instrument-alerts.usecase.ts`（EP1，按 market+code+accountId）/ `list-alerts.usecase.ts`（EP2，全账号预警含 conditions，market/code 平铺由 client 分组）+ `alert.response.ts` DTO（threshold Decimal→string，015 体例；note nullable 显式 type）+ **Testcontainers 单测**：空列表 / 多标的多条 / conditions 内联
- [X] T005 [P] [US3] [Server] **消息 UC（水位线）**：`list-messages.usecase.ts`（EP6：trigger 按 accountId 倒序 + cursor 分页，`unread = triggeredAt > cursor.lastReadAt`）/ `get-unread-count.usecase.ts`（EP7：count where triggeredAt > lastReadAt，无 cursor 行=全未读）/ `mark-messages-read.usecase.ts`（EP8：upsert `AlertReadCursor.lastReadAt = now`）+ `message.response.ts` DTO（conditionsSnapshot Json→`[{type,threshold,actual}]`）+ **Testcontainers 单测**：未读计数 / mark-read 后归零 / 新 trigger 再未读 / 消息倒序分页
- [X] T006 [US1] [Server] **controllers + module wiring**：`alerts.controller.ts`（EP1-EP5，`@Controller('v1/alert')`）+ `messages.controller.ts`（EP6-EP8）：`@UseGuards(JwtAuthGuard, AccountIdThrottlerGuard)` + `@ApiBearerAuth()` + `@ApiTags('alert')` + 新 named throttler 桶 `alert-read-account 120/60s` / `alert-write-account 30/60s`（`@Throttle` + `@SkipThrottle` 其余桶）+ swagger 全响应码 + `alert.module.ts` providers/controllers 落齐。account 取 `req.user.accountId`（013 体例）
- [X] T007 [US1] [Server-IT] `apps/server/test/integration/alert-crud.it.spec.ts`（Testcontainers 全 boot，覆盖 spec `state_branches` 配置侧全条）：批量建→EP1/EP2 可见 / 同类型重复 400 / 0 条件 400 / note 超长 400 / 阈值出域 400 / toggle 停用→enabled=false / 他人资源 404（PATCH+delete-batch）/ 未认证·非 ACTIVE 401 / 429（读写桶各验）/ 消息三端点水位线闭环
- [X] T008 [Contract] `nx run server:export-openapi`（canonical `node dist/main.js`）→ `nx affected -t generate`（Orval regen alert 8 hooks + 类型）→ `packages/api-client` + mobile typecheck 绿。**regen 产物随 PR-1 commit**（Constitution §V，PR 描述 cite 例外）
- [X] T009 [Verify] PR-1 gate：`nx affected -t lint typecheck test build runtime-smoke --base=origin/main` 全绿（**首跑 `--skip-nx-cache`**，per memory 新文件 cache 假绿）+ moat 探针关（alert 4 表 owner + 零跨 ctx 写）+ boundaries 0 violation + ADR-0052 索引过 + spec frontmatter `status: implementing` 翻

**Checkpoint**：PR-1 merge → 真后端 CRUD+消息可用，api-client 落地。

---

## Phase 2: Server 评估引擎（PR-2）

**Goal**：EOD 评估闭环——cron 幂等评估 → 触发流水 → 三档后置动作。

- [X] T010 [US2] [Server] **求值纯函数**：`apps/server/src/alert/alert-evaluation.rules.ts` + vitest 红绿：四类条件 ×（触发/不触发/**边界=阈值含等号** plan D7）；`PRICE_FALL_TO: low≤t` / `PRICE_RISE_TO: high≥t` / `DAILY_GAIN_OVER|LOSS_OVER: (close−prevClose)/prevClose` 含等号；`prevClose` null/0 → 不命中；AND 聚合（任一不命中→整体否）；输出 `[{type,threshold,actual}]` 快照形状（**双模 seam**：入参 `{high,low,close,prevClose}` 快照，盘中模式换数据源零改）
- [X] T011 [US2] [Server] **评估 UC**：`evaluate-alerts.usecase.ts`：load enabled alerts → 标的去重 → `// CROSS-CONTEXT-READ:` 批量读 `marketdata.daily_bar`（**adjust='none'** 最新 bar，plan D8）+ `instrument.name` → T010 纯函数求值 → 命中：单 alert 小 tx（create AlertTrigger 快照含 actual + 后置 `ONCE_DELETE`→delete / `ONCE_DISABLE`→enabled=false / `DAILY`→不动）；**P2002（同 tradeDate 重复）/ P2025（评估中被删）catch-skip**（plan D9）；标的无 bar→跳过 + **Testcontainers 单测**：触发写流水含 actual / 三档后置 / 停牌（旧 tradeDate 已评估）no-op / prevClose null 不触发 / 幂等重跑零新增 / 评估中删除竞态不炸
- [X] T012 [US2] [Server] **queue + cron + CLI**：`alert-queue-connection.ts`（镜像 `marketdata-queue-connection.ts` provider 模式，自持 `ALERT_QUEUE_REDIS` token，`maxRetriesPerRequest:null`）+ `alert-eval.processor.ts`（BullMQ worker 调 T011 UC）+ boot 幂等注册 repeatable（`0 23 * * *` + `0 8 * * *`，tz Asia/Shanghai，upsert job scheduler）+ `alert-eval.cli.ts` 手动触发（mirror marketdata CLI 体例）+ 单测（repeatable 注册幂等 / processor 委托 UC）
- [X] T013 [US2] [Server-IT] `apps/server/test/integration/alert-eval.it.spec.ts`（全 boot，造 marketdata instrument+daily_bar 种子）：「股价跌到13 当日低12.8 收14.2」触发（盘中极值口径）/ 双条件 AND 一项不命中→不触发 / 触发→EP6 消息可见+EP7 unread+1 / ONCE_DELETE→预警消失流水在 / DAILY 同 tradeDate 重跑不重复、新 tradeDate 再触发 / 停用不评估
- [X] T014 [Verify] PR-2 gate：`nx affected` 全绿（首跑 `--skip-nx-cache`）+ moat 探针验 **2 条 CROSS-CONTEXT-READ 注释齐**（daily_bar+instrument）+ 零跨 ctx 写 + dev dogfood：CLI 手动触发一轮 → 消息端点出数据

**Checkpoint**：PR-2 merge → server 闭环（建预警 → CLI/cron 评估 → 消息可查）。

---

## Phase 3: Mobile — 7 屏 + 入口接通（PR-3）

**Goal**：mockup 翻 RN，消费 PR-1 typed client，两层验证。

- [X] T015 [Mobile] **基础件**：`apps/mobile/src/alert/limit-price.rules.ts` + vitest（板块判定 688/689·300/301→±20% / 北交 8x/4x→±30% / 其余±10% / 名称含 ST→±5%；`round(prevClose×(1±pct),2)`；clarify #2 边角不准接受）+ `quote-strip.tsx`（行情条 5 字段：015 EP2 merge 三字段 + limit 纯函数两字段，缺失 `--`）+ `alert-card.tsx`（条件多行+编辑笔+toggle+频率·备注行，**无组合预警标签**；多选态 checkbox 变体）+ `alert-copy.ts` + icon 核对补缺（铃+闪电/信封/放大镜，mockup `AIcon` path 翻 react-native-svg）
- [X] T016 [Mobile] **hooks**：`use-alerts.ts`（orval 8 hooks 包装：列表/批量建/编辑/toggle 乐观更新+失败回弹/批量删 + 错误分流 toast，013 `use-watchlist-items` 范式）+ `use-alert-messages.ts`（消息列表 + unread-count focus refetch + mark-read）+ vitest（toggle 乐观态 / badge 派生 / note 计数 `[...s].length≤22` 与 server 同口径 plan D10）
- [X] T017 [P] [US1] [Mobile] **屏 1 个股预警列表**（含 1b 多选删除模式）：`alert-list-screen.tsx`（quote-strip + alert-card 列表 + 空态「暂无预警，点击下方添加预警」+ 底栏 选择删除/添加预警 + 多选态 全选/删除 disabled→danger + 右上 全部预警/完成）+ route `app/(app)/alert/[symbol].tsx`（param `cn:603305` split）+ `_layout.tsx`（anchor + `makeHeaderBackOrParent`）
- [X] T018 [P] [US1] [Mobile] **屏 2 编辑/新建 + 屏 3 添加条件 + 2 sheets**：`alert-edit-screen.tsx`（本地草稿态：条件行 名称+参数框+删除 / 「同时满足 N 项」动态橙 N / 推送方式只读 App推送 无 chevron / 频率行→sheet / 备注 n/22 / 编辑态「删除预警」/ 完成提交 EP3 或 EP4）+ `add-condition-screen.tsx`（搜条件框 + 左单分类「价格跟踪」+ 右 4 条件「添加」；已加类型置灰/再选覆盖参数）+ `frequency-sheet.tsx`（三档 + 默认每日1次）+ `value-input-sheet.tsx`（数值+单位+选好了）+ routes `edit.tsx` / `add-condition.tsx`
- [X] T019 [P] [US4] [Mobile] **屏 5 全部预警 + 屏 4 对象选择**：`all-alerts-screen.tsx`（A股单 tab + 按股票分组（组头 名+现价/涨跌额/涨跌幅 EP2 merge + chevron 下钻屏 1）+ 组内卡片就地 toggle/编辑 + 底栏 选择删除/新建预警 + 多选删复用屏 1b 组件，**无智能预警 toggle**）+ `target-select-screen.tsx`（自选 tab：013 `useWatchlistItems` checkbox 多选+全选+灰字「将为选中的每只股票分别创建预警」+去添加→edit 批量 params；搜索 tab：复用 `add-watchlist-entry` 同源搜索 hook plan D11，结果行高亮+添加→单只直进 edit）+ routes `index.tsx` / `select-target.tsx`
- [X] T020 [P] [US3] [Mobile] **屏 6 消息通知**：`message-center-screen.tsx`（提醒 tab 默认 + 待办 tab disabled / 无服务号 / 无右上 icon；消息卡片 标题「预警触发」+ 正文按 `{type,threshold,actual}` 渲染「股价跌到13.00元（今日最低12.80元）」+ ✓时间戳；未读红点变体 / 空态「暂无提醒消息」；**进入即 EP8 mark-read** plan D6）+ route `messages.tsx`
- [X] T021 [US6] [Mobile] **入口接通（2 处既有页 surgical）**：013 `watchlist-main-screen.tsx` 工具栏「＋」→ 三 icon（放大镜=开既有 `AddWatchlistEntry` / 铃+闪电→`/(app)/alert` / 信封+unread 红点→`/(app)/alert/messages`）+ 014 `bottom-bar.tsx` bell disabled→`router.push('/(app)/alert/'+symbol)`（去 onDisabledTap 路径，**其余 3 项零改动**）+ vitest（badge 显隐派生）
- [X] T022 [Mobile-E2E] `apps/mobile/e2e/alert.spec.ts`（Playwright Expo Web hermetic，**mock alert 8 端点 + 015 EP2 + 003 refresh**）：建预警全流（详情 bell→屏1→添加→条件→sheet→完成）/ 同类型重复拦 / 多选删（未勾 disabled）/ 全部预警分组+下钻+就地 toggle / 对象选择多选批量+搜索单只 / 消息中心未读红点→进入→badge 清零 / 工具栏三 icon 跳转 / 待办 disabled / 频率三档默认每日1次
- [X] T023 [Contract-Smoke] `apps/mobile/e2e/contract-smoke/alert.contract.ts`（node 层 `@nvy/api-client` 打 testcontainers 真 server）：登录 → 批量建预警（2 标的×2 条件）→ EP1/EP2 列表对齐 → EP4 编辑+toggle → 直插 trigger 行（或 CLI 评估）→ EP7 unread>0 → EP8 mark-read→0 → EP5 批量删。验契约对齐+真落库（`nx run mobile:contract-smoke`）
- [X] T024 [Verify] PR-3 gate：`nx affected -t lint typecheck test build --base=origin/main` 全绿（首跑 `--skip-nx-cache`）+ e2e/contract-smoke 绿 + 视觉 0 硬编码（grep 实现文件无 token 外 hex）+ spec frontmatter `status: implemented` 翻 + 既有 013/014 e2e 零回归（SC-006）

**Checkpoint**：PR-3 merge → 全闭环可 dogfood（建预警 → 晚间 cron → 消息中心 + 角标）。

---

## Dependencies & Execution Order

```text
T001 ──→ T002 ──→ T003 ──→ T006 ──→ T007 ──→ T008 ──→ T009   (PR-1)
              ├─→ T004 [P] ──┘
              └─→ T005 [P] ──┘
PR-1 merge ──→ T010 ──→ T011 ──→ T012 ──→ T013 ──→ T014        (PR-2)
PR-1 merge ──→ T015 ──→ T016 ──→ T017/T018/T019/T020 [P] ──→ T021 ──→ T022 ──→ T023 ──→ T024  (PR-3)
（PR-3 的 T023 contract-smoke 需 PR-2 已 merge 或 CLI 可用以造 trigger；纯 UI task 仅依赖 PR-1）
```

- **MVP 切片** = PR-1 + PR-2（US1+US2 server 闭环：建预警→评估→流水可查，CLI dogfood）；PR-3 是体验层。
- **Clear 检查点批次**（Constitution §III）：T001-T003 / T004-T006 / T007-T009 / T010-T012 / T013-T014 / T015-T016 / T017-T019 / T020-T021 / T022-T024。
