---
feature_id: 084-optionsdesk-broker-push-sync
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-09-16'
updated_at: '2026-09-16'
---

# Tasks: 084-optionsdesk-broker-push-sync（券商持仓实时增量同步 · 推送式）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md)

**一句话**：shim 在既有常驻交易 context 上挂推送 handler → 事件进环形缓冲（单调 `seq` + 进程 `epoch`）→ server 每 2 秒拉取、锚过滤、幂等写、按市场去抖 5 秒刷持仓；`seq` 断档或 `epoch` 变化即触发当日缺口补偿。

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx; plan Dx; state_branches n; USn）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 即其验收，红→绿在同一 task 内闭环（Constitution §II）；新测试必须**定向变异证明能红**并留档。
- 层级：`[Shim]`（futu-shim Python，**另一条部署链**）/ `[Server]` / `[Server-IT]` / `[Docs]` / `[Gate]` / `[Ops]`。本片无 `[Contract]` / `[Mobile]`（server 零 endpoint 变更、零 DTO 变更）。
- `state_branches n` = spec frontmatter `state_branches` 的**行序号**（1 起）。
- 🚨 **FR / SC 一律逐条枚举，禁范围记法**。

## Path Conventions

| 用途 | 路径 |
|---|---|
| shim 事件缓冲（新） | `services/futu-shim/src/futu_shim/trade_events.py` |
| shim 交易面（改） | `services/futu-shim/src/futu_shim/trade.py`（`TradeSupervisor` `:145` · `call` `:164-173` · `_ensure_ctx` `:250`） |
| shim 路由 / 配置（改） | `app.py`（`create_app` 内字面量 `@app.get`；既有四条交易路由 `:902-961`）· `config.py`（形态先例 `trade_call_timeout_s()` `:98`）· `deploy/install.sh`（非密收敛段） |
| shim 测试（新 / 改） | `tests/test_trade_events.py`（新）· `test_app.py`（`TRADE_ROUTES` `:339` · 401 参数化 `:318-322` · 部署探针对照 `:247-276`）· `test_readonly_guard.py`（既有，sabotage 臂复跑） |
| 部署自检 | `services/futu-shim/deploy/remote-deploy.sh`（`/healthz.routes` 校验 `:78-96`） |
| 游标纯函数（新） | `apps/server/src/optionsdesk/broker-event-cursor.rules.ts`（+ 同名 `.spec.ts`） |
| 事件规范化（改） | `apps/server/src/optionsdesk/broker-account.port.ts` · `futu-broker-account.adapter.ts`（+ `.spec.ts`） |
| 消费 use case（新） | `apps/server/src/optionsdesk/consume-broker-events.usecase.ts` |
| 同步 use case（改） | `sync-broker-account.usecase.ts`（`BrokerSyncMode` `:35` · `finish` `:422`） |
| 调度器（改） | `broker-account.scheduler.ts`（`reclaimStuckRuns` `:117-136` · `runDueBackfills` `:143` · `reconcile` scope `:246`） |
| 读端（改） | `list-broker-positions.usecase.ts`（`lastSucceededSyncAt` `:293-308`） |
| 表 / 迁移（改） | `apps/server/prisma/schema.prisma`（`BrokerSyncRun` `:2390-2417`；部分唯一索引写法先例 `:2413`） |
| 模块装配（改） | `apps/server/src/optionsdesk/optionsdesk.module.ts` |
| Server IT（新） | `apps/server/test/integration/optionsdesk-084.{push-consume,push-gap}.it.spec.ts`（隔离库 `apps/server/test/_support/isolated-db.ts` `setupIsolatedDb`） |
| Server IT（改） | `apps/server/test/integration/optionsdesk-083.broker-positions-read.it.spec.ts`（`syncedAt` 夹具 `:452-534`） |
| 上游文档（改） | `specs/082-optionsdesk-broker-pull-sync/spec.md`（SC-004 补类型限定） |

## 🚨 Impl Guardrails（plan §Architecture Notes 摘录，盲写会踩且不会红）

1. **推送路径不经查询路径的三道处理**（`trade.py:171-173` 的 `_strip_account_ids` / `_ids_as_digit_strings`，以及 `mappers.clean_value`）⇒ 组合单腿展开、成交号精度承载、账户号剔除**三条都要在推送映射里自建**。
2. **组合单腿是对象不是文本**：券商组件给的是 `ComboLeg` 对象（属性 `code` / `trd_side` / `qty_ratio` / `position_id`）。🚫 依赖 `clean_value` 的 `str()` 兜底（`mappers.py:52`）——那会产出需正则硬解的 repr 串；server 侧 `parseComboLegs`（`broker-code.rules.ts:99-107`）对数组入参只收**文本元素**，喂对象**静默返回空数组**。
3. **成交号是超出安全整数范围的整数** —— ⚠️ **券商官方文档声明为字符串，与实际不符**，082 首次上线失败即源于此。🚫 按文档的类型声明写实现，以实拉样本为准。
4. **`kind` 隔离**：缺口补偿必须写**独立的记录类型**。开盘前对账的三处判定（`broker-account.scheduler.ts:247` / `:251` 的 `scope`、`schema.prisma:2413` 的索引谓词）本就带类型过滤，**本片不改它们**，只需保证补偿写的是新类型。
5. **防重入索引谓词与上游不同**：只含**执行中**状态。🚫 照抄上游把 `succeeded` 也纳入 —— 断档一天可能合法发生多次，纳入会让当天第二次断档**再也补不回来**且静默。
6. **卡死回收必须加第三条分支**：`reclaimStuckRuns`（`:123-130`）只有 `backfill` / `reconcile` 两条，新类型不加就**没有任何路径**清理它。
7. **拉取间隔 2 秒、去抖 5 秒是常量不是配置**：与 SC-001 的验收口径强耦合；去抖下限由券商持仓查询限频（每账户 10 次 / 30 秒，且与对账、补偿共用配额）决定，3 秒即打满上限，**限频的表现是持仓静默不刷新**。
8. **事件读取 MUST 非阻塞**：🚫 长轮询 —— 会占住 shim 仅有的 4 个 waitress 工作线程，与行情面抢资源。
9. **`acc_id` 永不出港机**：shim 映射层无条件剔除；fixture 一律合成值（🚫 真实账户 / 持仓 / 交易数据，也禁「脱敏真实样本」，per `testing.md` §7）。
10. **注释出处**（`comment-provenance.md`）：关于券商行为的断言一律 `EVIDENCE:` 指向官方文档页或维护者实测观测值；拿不出出处的**不写**。
11. **新文件首跑带 `--skip-nx-cache`**（`implement-task-closure.md`）。

## Tasks

### Shim：推送缓冲与事件端点

- [X] T001 [Shim] **`trade_events.py`：环形事件缓冲（`seq` + `epoch`）**（FR-003; plan D1, D9; state_branches 22, 23; US2）：新建 `trade_events.py`。`TradeEventBuffer(maxlen)`：`collections.deque(maxlen=N)` + 单调递增 `seq` 计数器 + 进程启动时生成的 `epoch`（重启必变）；`append(row)` 与 `read(after_seq)` 全部在一把 `threading.Lock` 内（SDK 回调线程 ≠ waitress 工作线程）。`read` 返回 `{epoch, rows, next_seq, dropped}`，`after_seq` 早于缓冲最旧一条 ⇒ `dropped=True`。容量从 env 读，默认值按「覆盖服务端一次常规重启窗口」取，docblock 写明**要害是信号质量不是内存**（容量不足会让每次部署都产生补偿留痕，淹没 FR-014 的健康判据） → verify: `services/futu-shim/venv/bin/python -m pytest -q tests/test_trade_events.py` 先红 → 绿，臂：① 顺序 append 后 `read(after_seq=0)` 全量返回且 `next_seq` 正确 ② `read` 指定中间 `after_seq` ⇒ 只回其后的行 ③ 写满 `maxlen` 后继续 append ⇒ 最旧被覆盖，`read` 旧 `after_seq` ⇒ `dropped=True`（branch 23）④ 未超容量的连续读 ⇒ `dropped=False`（branch 22）⑤ 新建实例 ⇒ `epoch` 与前一实例不同 ⑥ 多线程并发 append + read 无异常、`seq` 无重复无跳号；定向变异：a. 去掉 `dropped` 判定 → ③ 红 · b. `epoch` 改为固定常量 → ⑤ 红（留档）

- [X] T002 [Shim] **推送 handler 挂载 + 推送行映射（腿展开 / 成交号 / 账户号）**（FR-001, FR-002, FR-015, FR-019, FR-020, FR-021; plan D1, D2; state_branches 13, 14, 16; US1）：`trade.py` 新增 `TradeOrderHandlerBase` / `TradeDealHandlerBase` 两个子类，`on_recv_rsp` 把行经**本 task 自建的映射**后写入缓冲；`TradeSupervisor` 建立 / 重建 context 时 `set_handler`。🚨 **不调用 `unlock_trade`**。映射三条：① `combo_legs` 逐元素读 `ComboLeg` 的 `code` / `trd_side` / `qty_ratio` / `position_id` 展开为结构化 dict，🚫 走 `clean_value` ② `deal_id` 恒转数字串、其余 `abs > 2**53-1` 的 int 列同样转串 ③ 无条件 `pop('acc_id')`。`EVIDENCE:` 注释指官方 ComboLeg 表（`openapi.futunn.com/futu-api-doc/trade/place-combo-order.html`，2026-09-16 核对）与「文档把成交号声明为 `str`、实际返回 int」的不符 → verify: `services/futu-shim/venv/bin/python -m pytest -q tests/test_trade_events.py tests/test_readonly_guard.py` 先红 → 绿，臂：① 腿为 `ComboLeg` **对象**列表 ⇒ 展开出各腿 `code` 与方向（🚨 用对象喂，不是文本）② 腿为空列表 ⇒ 输出空数组、不抛 ③ 成交行 `deal_id` 为 19 位 int ⇒ 输出为数字串且无精度损失 ④ 行内含 `acc_id` ⇒ 输出不含该键 ⑤ 订单推送行取 `trd_market`、历史订单行取 `order_market` ⇒ 归一到同一市场值（branch 13）⑥ 订单事件与成交事件字段集不同 ⇒ 各自映射不串 ⑦ 只读守卫仍绿；定向变异：a. 腿改走 `clean_value` → ① 红 · b. `deal_id` 原样透传 → ③ 红 · c. 去掉 `acc_id` 剔除 → ④ 红（留档）

- [ ] T003 [Shim] **`GET /trade/events` 路由 + 鉴权 + 三处登记**（FR-004, FR-019; plan D1, D9; state_branches 11, 22, 23; US1/US2）：`create_app()` 内以**字面量** `@app.get('/trade/events')` 注册（部署探针按字面量 grep，`test_app.py:275-276` 有断言）；参数 `epoch` / `after_seq`，**非阻塞立即返回** `{epoch, rows, next_seq, dropped}`，🚫 长轮询。`epoch` 与当前不符 ⇒ 回缓冲内全部行并给出新 `epoch`。本端点读进程内存、不打券商 ⇒ **不登记券商限频 capability**（docblock 写明理由）。三处登记：`test_app.py` 的 `TRADE_ROUTES`（`:339`）、401 参数化清单（`:318-322`）、`deploy/install.sh` 非密收敛段加缓冲容量 env → verify: `services/futu-shim/venv/bin/python -m pytest -q` 全绿（含既有）且新增臂先红 → 绿，臂：① 无 token / 错 token / 缺 scheme ⇒ 各 401 ② `epoch` 匹配 + `after_seq` ⇒ 只回其后行 ③ `epoch` 不匹配 ⇒ 回全量 + 新 `epoch`（branch 6 的 shim 半；spec 与 plan 称「事件源重启」，在本片即指 shim 进程重启）④ 缓冲已绕回 ⇒ `dropped=True`（branch 23）⑤ 🚨 断言响应**立即返回**（无事件时耗时 < 100 ms，证明没挂起占线程）⑥ `/healthz` 的 `routes` 含本路由且 `TRADE_ROUTES` 断言通过；定向变异：a. 路由改为动态注册（非字面量）→ ⑥ 红 · b. 无事件时改为轮询等待 1 秒 → ⑤ 红（留档）

### Server 基础：游标判定与事件规范化

- [ ] T004 [P] [Server] **`broker-event-cursor.rules.ts`：断档与代次判定**（FR-003, FR-009; plan D4; state_branches 5, 6, 22, 23; US2）：新建纯函数文件。导出 `decideCursor({ local: { epoch, lastSeq } | null, response: { epoch, rows, nextSeq, dropped } })` ⇒ `{ accepted: rows, gapDetected: boolean, nextCursor: { epoch, lastSeq } }`：`local === null`（首次）⇒ 接受、不判断档；`response.epoch !== local.epoch` ⇒ `gapDetected`，游标从新 `epoch` 重建，🚫 按旧序号续拉；`dropped` 为真或首行 `seq > lastSeq + 1` ⇒ `gapDetected`；序号连续 ⇒ 正常消费、不触发补偿。复杂度 O(rows) 注释 → verify: `pnpm nx test server apps/server/src/optionsdesk/broker-event-cursor.rules.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 序号连续 ⇒ `gapDetected=false`（branch 22）② 首行 `seq` 跳号 ⇒ `true`（branch 5）③ `dropped=true` ⇒ `true`（branch 23）④ `epoch` 变化 ⇒ `true` 且 `nextCursor.epoch` 取新值、`lastSeq` **不沿用旧值**（branch 6）⑤ 首次（`local=null`）⇒ 接受且不判断档 ⑥ 空 `rows` ⇒ 游标不变、不判断档（branch 9 的判定半）；定向变异：a. `epoch` 变化时沿用旧 `lastSeq` → ④ 红 · b. 只判 `dropped` 不判跳号 → ② 红（留档）

- [ ] T005 [P] [Server] **port 事件类型 + adapter 事件行规范化**（FR-006, FR-015, FR-020, FR-021; plan D2; state_branches 13, 14, 15, 16; US1）：`broker-account.port.ts` 加事件读取方法与规范化事件行类型（订单事件 / 成交事件两类，字段集不同；腿为结构化数组 `{ code, side }[]`）。`futu-broker-account.adapter.ts` 增事件行 → port 类型的映射：时间一律 `vendorTimeToDate(v, market)`；市场取 `trd_market`（🚫 `order_market`，那是历史查询的字段名）；腿**直接读结构化字段**，🚫 再过 `parseComboLegs`（那是给查询路径的文本形态用的）；腿为空 ⇒ 标记待回查（FR-020） → verify: `pnpm nx test server apps/server/src/optionsdesk/futu-broker-account.adapter.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 订单事件行 ⇒ 规范化出订单字段，市场取自 `trd_market`（branch 13）② 成交事件行 ⇒ 规范化出成交字段，`dealId` 为数字串且长度不变（branch 16）③ 腿为结构化数组 ⇒ 解出各腿代码与方向（branch 14）④ 腿为空数组 ⇒ 标记待回查、🚫 当作「无腿」正常返回（branch 15）⑤ 事件行含 `acc_id` ⇒ 不进入规范化结果 ⑥ 时间带毫秒 ⇒ 毫秒保留；定向变异：a. 市场改读 `order_market` → ① 红 · b. 空腿改为正常返回 → ④ 红（留档）

### US1：推送消费与持仓近实时刷新

- [ ] T006 [Server-IT] **`consume-broker-events.usecase.ts`：拉取 → 锚过滤 → 幂等写**（FR-004, FR-005, FR-006, FR-007, FR-016, FR-017; plan D3; state_branches 1, 2, 3, 4, 9, 11, 12; US1）：新建 use case。`execute({ connectionId, cursor, now })`：经 port 拉事件（事务外）→ `decideCursor`（T004）→ 正股判定与 `inBrokerScope` 过滤（🚫 另起一份判定，FR-005）→ 短事务幂等写：成交 `createMany({ skipDuplicates })`；订单先 `createMany({ skipDuplicates })` 再带 `vendorUpdatedAt < incoming` 条件 `updateMany`，🚫 先查后写。`marketdataConfig.kind === 'mock'` ⇒ 整拍跳过、零 port 调用。拉取失败 ⇒ 既有数据不动、留痕、返回失败 → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-084.push-consume.it.spec.ts --skip-nx-cache` 先红 → 绿（`OptionsdeskModule` 真装配，只替换 `BROKER_ACCOUNT_PORT`），臂：① 事件属锚标的 ⇒ 成交与订单写入（branch 1）② 不属锚标的 ⇒ 不写入（branch 2）③ 同一批事件重复投递两次 ⇒ 库内逐条相同（branch 3）④ 同一订单先喂较新 `updated_time` 再喂较旧（同秒不同毫秒）⇒ 库内为较新（branch 4）⑤ 🚨 先铺好数据再让 port 抛错 ⇒ 持仓 / 成交 / 订单逐条不变（branch 11）⑥ `mock` 档 ⇒ port 调用数 0（branch 12）⑦ 空事件批 ⇒ 不产生任何记录、游标不变（branch 9）⑧ 每行 `account_id` = 连接所属账号；定向变异：a. 订单写改先查后写 → 并发臂抛 `P2002` 红 · b. 锚过滤改为本文件自写 → ② 在「被标为不参与交易的锚」样本上红（留档）

- [ ] T007 [Server-IT] **去抖刷持仓 + 最近成功同步时刻计入推送**（FR-008, FR-012, FR-013; plan D3, D7; state_branches 8, 21; US1）：消费写入后按市场登记「待刷新」，**5 秒**去抖窗口内合并为一次刷新（常量旁注明出处：受券商持仓查询限频 10 次 / 30 秒约束，配额与对账、补偿共用）；刷新复用既有持仓替换与开仓时间推算路径。`list-broker-positions.usecase.ts` 的 `lastSucceededSyncAt`（`:293-308`）`OR` 条件**加第三支**使推送刷新计入。🚨 **`isStale` 算法不改**（`broker-freshness.rules.ts:76-85`）—— 来源扩大后推送通道健在时自然不再标陈旧 → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-084.push-consume.it.spec.ts apps/server/test/integration/optionsdesk-083.broker-positions-read.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 窗口内喂多条同市场事件 ⇒ 🚨 断言持仓查询**只发生一次**（branch 21；断言「持仓被刷新」对逐条刷的实现同样绿）② 刷新成功 ⇒ 该市场 `syncedAt` 更新为本次刷新时刻（branch 8）③ 🚨 **只有一条推送刷新成功记录、无对账无补齐** ⇒ 读端 `syncedAt` 取它（branch 8；083 既有夹具全是对账 / 补齐，不写这条 FR-012 就是零覆盖）④ 推送刷新后立即读 ⇒ 未标陈旧 ⑤ 083 既有 `syncedAt` 用例全部保持绿（回归）⑥ 无事件 ⇒ `syncedAt` 不变（branch 9 的读端半）；定向变异：a. 去掉去抖直接逐条刷 → ① 红 · b. `lastSucceededSyncAt` 不加第三支 → ③ 红（留档）

- [ ] T008 [Server] **2 秒心跳接入调度器**（FR-004, FR-016; plan D3; state_branches 12; US1）：`broker-account.scheduler.ts` 增一个 `@Cron` 秒级表达式（每 2 秒）+ `waitForCompletion: true`（🚨 漏了会两拍并发，cron 4.4.0 默认不等上一拍），调 `consume-broker-events`；`mock` 档整拍跳过；全路径不上抛，连接间互不连坐。游标存进程内存（🚫 建表持久化，`epoch` 比对天然覆盖重启场景） → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-084.push-consume.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 经 `SchedulerRegistry` 断言新 job 存在且 `waitForCompletion === true` ② `mock` ⇒ 零 port 调用（branch 12）③ 连接 A 抛错不影响连接 B ④ 直调两次 `run()` ⇒ 不重复消费同一批事件；定向变异：去掉 `waitForCompletion` → ① 红（留档）

### US2：断档与重启后的自愈

- [ ] T009 [Server] **迁移：缺口补偿防重入的部分唯一索引**（FR-022; plan D5; state_branches 19, 20; US2）：`schema.prisma` 的 `BrokerSyncRun` 增一条部分唯一索引，谓词**只含执行中状态**（🚫 照抄上游 `:2413` 把 `succeeded` 也纳入）；写法照同文件 `where: raw(...)` 先例。`kind` 是 `VarChar(16)`，第三个取值**不需要改列**。`pnpm db:migrate "add broker push gap reentry index"` → verify: `grep -n 'WHERE' apps/server/prisma/migrations/<新目录>/migration.sql` 命中且谓词**不含** `succeeded`；`pnpm nx run server:typecheck` 绿；迁移目录名过 `migration-naming-check`；`pnpm tsx scripts/checks/check-server-moat.ts` exit 0（本片零新表，`MODEL_OWNERSHIP` 无需改，确认它仍绿）。🔗 **本条谓词的「能红」证明在 T010 定向变异 a**（谓词纳入已完成状态 ⇒ T010-④ 红）—— 迁移属「最终状态」形态，反例构造不出来，🚫 为它单造一个永不会红的断言（`testing.md` §7.1）

- [ ] T010 [Server-IT] **缺口补偿：复用同步 use case 第三个 mode + 重试 + 防重入**（FR-009, FR-010, FR-018, FR-022; plan D5; state_branches 5, 6, 10, 17, 18, 19, 20; US2）：`BrokerSyncMode`（`sync-broker-account.usecase.ts:35`）扩为三值；补偿 = 对该市场当日做一次窗口受限的对账，复用既有流程（🚫 另写一份，避免过滤口径 / 幂等写 / 持仓刷新三处漂移）。消费方 `gapDetected` ⇒ 插一条**新类型**的执行中记录（撞 T009 索引 ⇒ 本拍跳过），执行后回写结局；失败按上游对账规则重试（同交易日最多 3 次、间隔 15 分钟，仍失败留痕放弃），🚫 降级为触发开盘前对账 → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-084.push-gap.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 序号断档 ⇒ 产生一条新类型记录且当日数据补齐（branch 5）② `epoch` 变化 ⇒ 同上且从新代次消费（branch 6）③ 🚨 已有执行中的补偿时再次断档 ⇒ 不新起第二条、本拍跳过（branch 19）④ 🚨 当日**已完成**过补偿后再次断档 ⇒ **照常新起一条**（branch 20；照抄上游谓词的实现在此红）⑤ 补偿失败、当日重试次数未用尽 ⇒ 按间隔重试（branch 17）⑥ 次数用尽 ⇒ 留痕放弃（branch 18）⑦ 产生的记录 `kind` 为新类型，🚫 对账类型（branch 10 的写入半）⑧ 补偿记录字段齐全（类型 / 市场 / 状态 / 起止 / 补回条数 / 失败原因）；定向变异：a. 索引谓词纳入已完成状态 → ④ 红 · b. 补偿写成对账类型 → ⑦ 红（留档）

- [ ] T011 [Server-IT] **卡死回收补第三条分支**（FR-011; plan D6; state_branches 7; US2）：`reclaimStuckRuns`（`broker-account.scheduler.ts:117-136`）现只处理 `backfill`（置回 `pending`）与 `reconcile`（置 `failed`）⇒ 加新类型分支，语义取 `reconcile` 那侧（置 `failed` 并计入当日失败次数，由重试规则重新发起） → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-084.push-gap.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 构造一条超时的执行中补偿记录 ⇒ 被回收为终态（branch 7）② 回收后计入当日失败次数，重试规则据此重新发起 ③ 未超时的执行中记录 ⇒ 不被回收 ④ 既有 `backfill` / `reconcile` 回收行为不变（回归）；定向变异：不加第三条分支 → ① 红且记录永久停留在执行中（留档）

### US3：可见性与不干扰既有对账

- [ ] T012 [Server-IT] **`kind` 隔离回归：开盘前对账不受补偿影响**（FR-010; plan D5; state_branches 10; US3）：本 task **不改生产代码**（隔离本就成立，起片前已取证：`broker-account.scheduler.ts:247` / `:251` 的 `scope` 与 `schema.prisma:2413` 的索引谓词都带类型过滤）—— 只补回归断言，防后续改动悄悄破坏它 → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-084.push-gap.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 🚨 当日**已有一条成功的缺口补偿**，开盘前对账时点到来 ⇒ **照常发起**（branch 10；把补偿误记成对账类型的实现在此红）② 当日补偿 + 对账各一条 ⇒ 按对账类型统计当日仍恰 1 条 ③ 补偿记录**不**撞对账的部分唯一索引 ④ 对账的「当日是否已成功」判定不把补偿计入；定向变异：把补偿改写成对账类型 → ①②③ 同时红（留档）

- [ ] T013 [Server] **订阅健康判据：最近事件到达时刻**（FR-014, FR-018; plan D8, D10; state_branches 9; US3）：健康判据 = 「最近一次事件到达时刻」+ 补偿留痕，🚨 **MUST NOT 使用 SDK 私有标记**（维护者 2026-09-13 POC-3 实测该标记恒为假、与实际收到推送矛盾，`EVIDENCE:` 注释写明）。shim 在 `/healthz` 或事件响应里带出最近事件时刻；server 每次消费写一行 `info`（拉到条数 / 写入条数 / 是否触发补偿 / 耗时），触发补偿时 `warn`，失败 `error`，**均不含账户号**。阈值（多久没事件算异常）本片不定，注释指 spec 的 Outstanding 项 → verify: `pnpm nx test server apps/server/test/integration/optionsdesk-084.push-consume.it.spec.ts --skip-nx-cache` 先红 → 绿，臂：① 消费成功 ⇒ 最近事件时刻被更新 ② 长时间无事件 ⇒ 该时刻保持不变、不产生记录（branch 9）③ 触发补偿 ⇒ 出现 `warn` 级留痕 ④ spy 捕获本用例全部日志，断言不含 fixture 连接的账户号；`grep -rn '__is_acc_sub_push' apps/server/src services/futu-shim/src` 零命中；定向变异：在日志里打印账户号 → ④ 红（留档）

### Docs · Gate · Ops

- [ ] T014 [P] [Docs] **补上游 082 的 SC-004 类型限定**（plan D11）：`specs/082-optionsdesk-broker-pull-sync/spec.md` 的 SC-004 只写「每个市场恰有 1 条成功的对账记录」，未限定记录类型（其跟踪 issue 限定了）。本片引入第三种类型后该措辞产生歧义 ⇒ 补上「开盘前对账类型」的限定，并在该行注明是 084 引入第三类型后的措辞澄清、**不改变其已上线的行为** → verify: `pnpm tsx scripts/check-spec-frontmatters.ts` 绿；`npx prettier --check specs/082-optionsdesk-broker-pull-sync/spec.md` 绿；`pnpm tsx scripts/checks/check-identifier-boundary.ts` exit 0

- [ ] T015 [Gate] **覆盖收口 + 全量门 + 启动冒烟 + 私有数据扫描 + PR**（SC-003, SC-004, SC-007, SC-008）：逐条核对下方五张覆盖预检表（**实时 grep，不抄表内数字**）。私有数据扫描：对 `git ls-files` 与 `git ls-files --others --exclude-standard` 逐文件比对仓外私有清单，**只打印命中计数**，真值不写入任何文件 / 命令行 / 日志；两臂对照（scratchpad 临时文件 ⇒ 计数 1，仓库 ⇒ 计数 0）。spec `status → implementing`、`updated_at` bump → verify: `git fetch origin && pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` exit 0（输出落文件后 grep `Successfully ran target` / `Failed tasks` 判定，🚫 `| tail`）；`services/futu-shim/venv/bin/python -m pytest -q` 全绿；治理脚本全扫 `scripts/checks/*.ts` 全 0（含 `check-test-size` / `check-identifier-boundary` / `check-server-moat` / `check-time-semantics` / `check-env-sync`）；扫描两臂结果为 1 / 0；`gh-bot pr create --repo zhangleizlpd/no-vain-years-tech --body-file` 按 `pr-creation-protocol.md`。🚨 **PR body 标「建议人工合并」、不接 auto-merge**：含迁移，且 shim 合入 main 即自动部署到交易主机

- [ ] T016 [Ops] **上线：shim 部署自检 + server 发版 + 首轮验收**（SC-001, SC-002, SC-005, SC-006; plan D1）：前置 = PR 合并、shim 自动部署完成、server 发版上线。步骤：① 港机 `/healthz.version` = 合并 SHA 且 `routes` 含 `/trade/events`；对该端点真打一次，判据 = 立即返回且结构合法 ② SC-001：维护者在券商 App 挂一张远离市价的单再撤，核两次订单状态变化各自进入库内的耗时均 ≤ 5 秒 ③ SC-005：紧接着查该市场持仓，同步时刻等于本次刷新时刻且未提示陈旧 ④ SC-002：重启 shim，核出现补偿留痕且当日数据自愈、无人工介入 ⑤ SC-006，口径同 POC-7：**休市时段**按同一采样脚本采 1 小时，行情延迟中位变化 < 10%；**盘中与批处理时段只判零新增错误**，🚫 拿盘中延迟比休市基线 → verify: ①–⑤ 观测值回填本行（定性 + 一句观测，🚫 真实代码 / 数量 / 金额）；观测明细记维护者私有子 plan；任一不达标即停，不进入 T017

- [ ] T017 [Ops] **上线后观察：开盘前对账未被污染**（SC-004; state_branches 10）：推送上线后累计 5 个交易日，每个市场每个交易日仍恰有 1 条成功的**开盘前对账**记录，且无一个交易日的对账因当日发生过缺口补偿而未发起。🚨 统计 SQL **MUST 按开盘前对账类型过滤**（本片引入第三种类型后不过滤即误判）→ verify: 观测值回填本行；🚨 **开 task 时同步建 issue** 写明触发条件与兜底复查点；与上游 T022（issue #427）**同期进行、判据独立**，两者都按类型过滤故互不干扰

## 依赖与并行

```text
T001 → T002 → T003
T004 [P]  T005 [P]
T004 + T005 → T006 → T007 → T008
T009 → T010 → T011
T010 → T012
T006 + T010 → T013
T014 [P]
全部 → T015 → T016 → T017
```

- **T001 → T002 → T003**：缓冲先立，handler 才有地方写，路由才有东西读。
- **T003 → server 侧**无代码依赖（server 以 port 替身测试），但 **T016 必须等 shim 已部署**。
- **T006 → T007**：去抖刷新依赖消费路径已能写入。
- **T009 → T010**：防重入索引必须先在库里，臂 ③④ 才测得出。
- **T010 → T012**：`kind` 隔离的回归断言需要补偿路径已存在。

## state_branches 覆盖预检（analyze 期逐条 grep 的基准）

> 🚨 **本表编号 = `spec.md` frontmatter `state_branches` 的行序，MUST 逐行同序**。

| # | branch（摘要） | 落点 |
|---|---|---|
| 1 | 事件属锚标的 ⇒ 写入并刷新 | T006-① |
| 2 | 事件不属锚标的 ⇒ 不写不刷 | T006-② |
| 3 | 同一事件重复投递 ⇒ 结果一致 | T006-③ |
| 4 | 较旧订单状态晚到 ⇒ 不覆盖 | T006-④ |
| 5 | 序号断档 ⇒ 当日补偿并留痕 | T004-② + T010-① |
| 6 | 代次变化 ⇒ 补偿且从新代次消费 | T003-③ + T004-④ + T010-② |
| 7 | 补偿执行中 ∧ 进程重启 ⇒ 被回收 | T011-① |
| 8 | 推送刷新 ⇒ 最近成功同步时刻更新 | T007-②③ |
| 9 | 通道静默 ⇒ 不产生记录、时刻不变 | T004-⑥ + T006-⑦ + T007-⑥ + T013-② |
| 10 | 补偿与对账同日 ⇒ 各自留痕、对账不受影响 | T010-⑦ + T012-①②③④ |
| 11 | 事件拉取失败 ⇒ 既有数据不动 | T006-⑤ |
| 12 | 无连接 / 开发环境 ⇒ 不拉不报错 | T006-⑥ + T008-② |
| 13 | 推送与历史查询市场字段名不同 ⇒ 分别映射 | T002-⑤ + T005-① |
| 14 | 组合单各腿可解析 ⇒ 按腿归属 | T002-① + T005-③ |
| 15 | 组合单腿解析空 ⇒ 回查补全、不静默写入 | T005-④ |
| 16 | 成交号超安全整数 ⇒ 不丢精度 | T002-③ + T005-② |
| 17 | 补偿失败 ∧ 次数未用尽 ⇒ 按间隔重试 | T010-⑤ |
| 18 | 补偿失败 ∧ 次数用尽 ⇒ 留痕放弃 | T010-⑥ |
| 19 | 已有执行中补偿 ⇒ 不新起第二条 | T010-③ |
| 20 | 当日已完成补偿 ⇒ 再次断档照常新起 | T010-④ |
| 21 | 去抖窗口内多事件 ⇒ 合并为一次刷新 | T007-① |
| 22 | 常规重启 ∧ 未超缓冲 ⇒ 续拉不判断档 | T001-④ + T004-① |
| 23 | 停机过久 ∧ 缓冲绕回 ⇒ 判断档 | T001-③ + T003-④ + T004-③ |

## Functional Requirements 覆盖预检

| FR | 落点 |
|---|---|
| FR-001 只读铁律 | T002-⑦（只读守卫 sabotage 臂复跑） |
| FR-002 不依赖解锁密码 | T002（handler 不调 `unlock_trade`，由 FR-001 的守卫连带钉住） |
| FR-003 序号 + 代次 | T001-①②⑤ + T004-④ |
| FR-004 服务端主动读、非阻塞、不开入站面 | T003-⑤ + T008-① |
| FR-005 锚过滤单点 | T006-①②（定向变异 b 钉「不许另起一份」） |
| FR-006 幂等、唯一号 | T006-③ |
| FR-007 更新时间守卫 | T006-④ |
| FR-008 去抖刷新 | T007-① |
| FR-009 断档即补偿 | T010-①② |
| FR-010 记录类型独立、对账不受污染 | T010-⑦ + T012-①②③④ |
| FR-011 执行中记录被回收 | T011-①② |
| FR-012 同步时刻计入推送 | T007-②③ |
| FR-013 陈旧判定随之调整 | T007-④ |
| FR-014 健康判据不依赖私有标记 | T013-①③ + `__is_acc_sub_push` 零命中检查 |
| FR-015 市场字段分别映射 | T002-⑤ + T005-① |
| FR-016 开发环境静默跳过 | T006-⑥ + T008-② |
| FR-017 拉取失败不动既有数据 | T006-⑤ |
| FR-018 补偿留痕字段齐全 | T010-⑧ + T013-③ |
| FR-019 账户号不出现 | T002-④ + T005-⑤ + T013-④ + T015（仓内扫描） |
| FR-020 腿结构化展开、空腿回落 | T002-①② + T005-③④ |
| FR-021 成交号精度承载 | T002-③ + T005-② |
| FR-022 并发只挡执行中 | T009 + T010-③④ |

## Success Criteria 覆盖预检（🚨 SC 是系统性盲区，单列一张）

| SC | 落点 |
|---|---|
| SC-001 挂撤单各 ≤ 5 秒进库 | T016-②（真数面）；机制面由 T006 + T008 覆盖 |
| SC-002 重启后补偿留痕且自愈 | T016-④（真数面）；机制面 T010-② |
| SC-003 重复投递差异为 0 | T006-③ |
| SC-004 对账仍每市场每日恰 1 条 | T012-②（机制面）+ T017（上线后观察，真数面） |
| SC-005 刷新后时刻正确且未标陈旧 | T007-②④（机制面）+ T016-③（真数面） |
| SC-006 行情延迟中位变化 < 10% | T016-⑤（真数面；机制面无法自动化，见下方「蓄意零覆盖」） |
| SC-007 停留执行中的记录数为 0 | T011-①③ |
| SC-008 账户号出现次数为 0 | T015（仓内扫描两臂）+ T013-④（日志面） |

## Edge Case 覆盖预检

| Edge Case（摘要） | 落点 |
|---|---|
| 休市挂单无中间状态 ⇒ 两次状态各自入库 | T016-②（真数面；POC-3 已实测该形态） |
| 组合单按腿归属、空腿回落不静默写入 | T002-①② + T005-③④ |
| 成交号超安全整数 ⇒ 不丢精度 | T002-③ + T005-② |
| 缓冲绕回 ⇒ 表现为断档、不静默跳过 | T001-③ + T004-③ |
| 同秒多笔成交 ⇒ 去抖合并 | T007-① |
| 推送与历史查询同一笔 ⇒ 唯一号去重 | T006-③ |
| 市场字段命名不同 ⇒ 分别映射 | T002-⑤ + T005-① |
| 对账执行中推送到达 ⇒ 结果一致 | T006-③④（唯一号与更新时间守卫同时生效） |

## Acceptance Scenario 覆盖预检（🚨 标准矩阵**够不到**这一层）

| AS | 落点 |
|---|---|
| US1-AS1 成交数秒内进库、持仓随之刷新 | T006-① + T007-① + T016-② |
| US1-AS2 两次状态变化保留较新 | T006-④ |
| US1-AS3 非锚标的不写不刷 | T006-② |
| US1-AS4 刷新后时刻正确、未误标陈旧 | T007-②④ |
| US1-AS5 通道静默 ⇒ 保持上次结果、不产生多余记录 | T006-⑦ + T007-⑥ + T013-② |
| US2-AS1 断档 ⇒ 补偿并留痕、数据一致 | T010-① |
| US2-AS2 代次变化 ⇒ 从新代次消费、不按旧序号续拉 | T004-④ + T010-② |
| US2-AS3 补偿执行中重启 ⇒ 记录被回收 | T011-① |
| US2-AS4 超出当日的缺口由上游每日对账兜底 | 无新代码（上游 082 既有行为）—— 见下方「蓄意零覆盖」 |
| US3-AS1 按对账类型统计当日仍恰 1 条 | T012-② |
| US3-AS2 当日已有补偿 ⇒ 对账照常发起 | T012-① |
| US3-AS3 据最近事件时刻与补偿留痕判断通道健康 | T013-①③ |

**蓄意零覆盖 / 轻验（防下轮 analyze 误报缺口）：**

- **SC-001 / SC-002 / SC-005 / SC-006 的真数面**：依赖真实账户操作与港机真实负载，只能上线后由维护者验（T016），自动化只覆盖机制。
- **SC-006 的机制面**：延迟对比依赖港机真实负载，自动化测不出；保护机制（非阻塞读、不占工作线程）由 T003-⑤ 覆盖。
- **US2-AS4（超出当日的缺口由上游每日对账兜底）**：本片**零新代码** —— 上游 082 的每日对账既有行为即是兜底，重测等于重测上游。故意不配 task。
- **FR-002（不依赖解锁密码）**：无独立断言 —— 它由 FR-001 的只读 AST 守卫连带钉住（`unlock_trade` 在禁用符号集内），单独再写一条是重复。

## Implementation Strategy

MVP = **T001 → T008**：到这里推送消费与持仓近实时刷新在测试环境完整成立（US1 可独立验收）。US2（T009–T011）补上断档自愈这条正确性底线，US3（T012–T013）补可见性与回归护栏。T014 并行，T015 门，T016 上线与首轮验收，T017 上线后观察。

Clear 检查点批次：`T001-T003` / `T004-T005` / `T006-T008` / `T009-T011` / `T012-T013` / `T014-T015` / `T016-T017`（每批次后停顿提醒 `/clear`，per Constitution §III）。
