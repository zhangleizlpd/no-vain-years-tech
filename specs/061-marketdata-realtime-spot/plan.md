---
feature_id: 061-marketdata-realtime-spot
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-17'
updated_at: '2026-08-17'
adr_refs: ['0032', '0043', '0047', '0048', '0052', '0054', '0062']
context7_verified: []
---

# Implementation Plan: 行情实时面 + 美股正股盘中价接入期权台雷达

## Summary _(mandatory)_

给 `marketdata` 新建一个**实时行情面**（port + futu adapter + 按市场路由，us 接上、hk/cn 槽 fail-closed 留空），`optionsdesk` 自己起一条 30 秒 tick 把美股锚的正股现价写进锚表两个新列，雷达排序键改由「新鲜的盘中价，否则收盘价」派生。`alert` 一行不动。本片同时踩中 ADR-0054 / 0062 / 0048 三条写好的 sunset trigger，**必带 ADR amendment，不是纯 feature**。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

零新 npm 包、零 polyfill。shim 侧新增一个只读端点复用**已在调用**的 `get_global_state()`（`services/futu-shim/src/futu_shim/opend.py:147` / `:225` / `:297`），不引入新 python 依赖。

## Constitution Check _(mandatory gate)_

- [x] **Passed** — plan honors all constitution principles, OR every violation is justified in the Complexity Tracking below.

逐条核：

| 原则                | 判定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I. SDD              | 走完整链；**无 mockup 步**，且这个豁免是**靠收窄 UI 范围换来的**（2026-08-17 analyze 阶段发现并由 user 拍板）：mobile 侧改动**只有** `asOf` 的呈现粒度（日期 → 时刻），**档位不上屏**（spec FR-009 已改写）。⇒ 零新增视觉元素 ⇒ 没有 UI 形态可定 ⇒ §I 的 mockup 闸不适用。<br>⚠️ 初稿曾把「档位标记」也列进 mobile 改动并同时声称无需 mockup —— 那是**站不住的**：档位标记用文字 / 圆点 / 颜色、放在行内哪个位置，正是 mockup 该定的东西。**若将来把档位补上屏，MUST 先补走 mockup 步。** |
| II. TDD             | 每 task 红→绿→typecheck/lint→`[X]`→stage→commit                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| III. Atomic task    | 见 `/speckit-tasks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| IV. Module boundary | **新增唯一一条 module 边** `optionsdesk → marketdata`（D1）。ESLint boundaries 实证放行（`apps/server/eslint.config.mjs:333-349` 的 `from: optionsdesk` 的 `disallow` 含 `marketdata-rules` 但**不含** `marketdata`）。跨 ctx 注入需 `// CROSS-CONTEXT-SYNC:` 注释（`check-server-moat.ts` Check 2）                                                                                                                                                                                      |
| V. 类型同步链       | 本片**不新增 endpoint**、不改 DTO 形状之外的契约；雷达响应多两个字段（档位 + 时刻）⇒ 走 `export-openapi` → `api-client` regen → mobile 消费，**同 PR 原子 merge**                                                                                                                                                                                                                                                                                                                         |

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 本片**零新增 endpoint**（雷达端点 045 已有）。真启动面覆盖靠 Testcontainers IT：① 投影 tick 三段闸（非时段 / 非交易日 / 熔断）② 雷达排序在「新鲜实时 / 陈旧实时 / 无实时」三态各一条 ③ `alert` 既有 024 IT 全绿。
- [x] **Mobile / Web**: 雷达屏 golden path —— 实时档 `asOf` 呈时刻、收盘档呈交易日、降级时距 W% 呈空非 0。Playwright Expo Web 走结构面，三类真机项见 spec frontmatter `web_compat_notes`。
- [x] **Evidence**: 本 gate 的证据在 `/speckit-implement` 逐 task 产出（IT 文件路径 + 真机截图），此处声明覆盖面，不预填链接。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片**不引入任何新第三方包 / SDK / 工具**。新增的是自家 shim 的一个只读端点 + 一个复用既有 `VendorHttpClient` 的 adapter。既有 vendor（futu shim）的 6Q 已在 047 / sellput-viz 阶段过。

**Evidence**: N/A

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。本片触及的三个模块（`marketdata` / `optionsdesk` / `alert`）全部是 mono 原生（分别 015 / 045 / 024 建立），无 meta-repo 迁移史。

**Evidence**: `rg -n 'org\.springframework|mbw-[a-z]+/src/main/java|org\.mapstruct' apps/server/src/{marketdata,optionsdesk,alert}` → 0 命中。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

本片是**三条 sunset trigger 同时触发**的那一次。逐条：

| ADR         | Open Question affected                                                                                                       | Classification                | Mitigation / next step                                                                                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0054 #1 | 「第二个消费方需要实时行情 → 单消费者前提失效，重审是否把实时行情 port 升格为 marketdata 实时面 or 共享 package」            | **mitigated**                 | `optionsdesk` 即第二消费方 ⇒ 放行判据「单消费者」（该 ADR `:41`）失效。amend：实时面升格 `marketdata`，**不升 `packages/`**（它带 IO + vendor 凭据，属 server 侧数据接入，`packages/` 是无 IO 的共享类型层）                                                                                                                          |
| ADR-0054 #2 | 「marketdata 长出实时行情同步面 → alert 自持 adapter 应收回、改 Q7-B 只读或 DI marketdata 实时 port」                        | **escalated-to-next-feature** | 🚨 本片**确实**让 marketdata 长出了实时面 ⇒ 该 trigger 已 fired。但收编**故意推迟**：futu 账号**无 A 股权限**（`docs/private/runbook/futu-opend-hk.md:471` 实测：美股 LV3 / 港股 LV2 / A 股无），本片若把腾讯/新浪迁进来，alert 要么断、要么两份并存。amend 必须写明「fired，缓解物 = 后续 feature，缓解期内 cn 槽 fail-closed 留空」 |
| ADR-0062 #1 | 「盘中实时 spot 上线 → 跨 ctx 读形态从最终一致 Q7-B 只读直查升格为强一致同步读，本 ADR §3 跨 ctx 面与 ADR-0048 #2 一并重审」 | **mitigated**                 | 直接命中，ADR 自己预先规定了升格方向。amend §3 跨 ctx 面：新增一条**强一致同步读**边（DI marketdata 的 port token，D1）；Consequences 里「雷达价的时效 = 最长延迟一天」那条取舍**作废**并改写                                                                                                                                         |
| ADR-0048 #2 | 「出现必须 server 端强一致同步读 marketdata 的场景 → 跨层方向假设失效，重审是否引入 server 端只读跨 ctx 路径」               | **mitigated**                 | 场景出现（消费方是 `optionsdesk` 而非原文假设的 `portfolio`，但判据是「形态」不是「哪个 ctx」）。amend 记录：引入的是**只读同步调用**（port 方法），**不是**跨 ctx 写；方向仍单向无环（`marketdata` 不知道 `optionsdesk` 存在）                                                                                                       |

**逐条 `rg` 核实的命令**（结论已回填上表）：`rg -n 'sunset_trigger' -A 8 docs/adr/0054-*.md docs/adr/0062-*.md docs/adr/0048-*.md`

⚠️ **扫过但未命中的两条**（写下来免得下次 analyze 又当缺口）：

- **ADR-0053 #2**（「第二个 ctx import 他 ctx 的 `*.rules.ts` → 重审升共享 package」）—— 未命中：本片跨 ctx 拿的是 **port token + interface**，不是 `marketdata/*.rules.ts` 纯函数。绊线（`eslint.config.mjs` 的 `marketdata-rules` 禁令）**一个字不动**。
- **ADR-0032 新 ctx 评估** —— 未命中：实时面落进**既有的** `marketdata`，不新建 bounded context。

**Evidence**: 三份 ADR amendment 随本片 PR 合入（`docs/adr/` 三个文件的 `sunset_trigger` 条目标 fired + 各自 `## 复审记录` 追加一节）。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类，**绝对禁止** `new MyGuard()` / `jest.mock('./my.guard')` 这类隔离单元测试。这些组件依赖 NestJS DI lifecycle 顺序 (Guards→Interceptors→Pipes→Filters)，mock 隔离 = 抹掉 PR-79 类 cascade bug 的唯一信号。
- **MANDATORY INTEGRATION**: 必须用 `Test.createTestingModule({ imports: [<TheModule>] }).compile()` 装一个微型 DI 容器，让被测组件在真实 lifecycle 中触发。`createTestingModule` 之外的"测试" 视同未测试。
- **EXHAUSTIVE BRANCHING**: spec.md `state_branches` 列出的每条分支，**必须**在 integration test 文件中有对应 `it()` 块。100% 路径覆盖 — 不允许漏 cold-boot / 路由根 `/` 等非 happy-path 状态（PR #79 实证 4 层 cascade 始于一个未列状态分支）。

> 📌 本片 `state_branches` **17 条**，其中 15 条落在投影 tick 与雷达读端，2 条（分页）落在 tripwire 断言上。逐条对应见 `/speckit-tasks`。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
> The implementer LLM MUST strictly follow the "Flat + Anemic + Moat" paradigm:
>
> - **Flat Module**: ALL files live flatly in `apps/server/src/<module>/`. NEVER generate `domain/`, `application/`, `infrastructure/`, or `web/` subdirectories.
> - **Anemic Data & Zero-Class**: Data equals raw Prisma rows (snake_case handled by `@map` in schema.prisma). NEVER generate Domain Classes or Entity Mappers.
> - **No Repositories**: NEVER create Repository interfaces/adapters for your own tables. Inject `PrismaService` directly into UseCases. Put business invariants in pure functions (`*.rules.ts`).
> - **The Moat**: NEVER write `tx.<otherTable>.*`. Cross-context access MUST go through the target module's UseCase (use the Two-step Inspect+Commit saga only when caller validation must sit between read and write).

### 🚨 Impl Guardrails（并发 / 安全 / 前端 — 详版见 mono conventions）

- **并发/事务**：scheduler **逐行独立 tx**（单行失败隔离）；**外部 I/O split-tx** —— 🚨 本片 tick 的形态就是「先外呼一次拿整批报价，再逐锚写库」，**NEVER 在 tx 内等 HTTP**。锚表两列的写用 `updateMany where {id}` 幂等覆盖（无状态转换前置条件，不需要 affected-count 裁决）。→ `../../docs/conventions/server-impl-playbook.md`
- **安全**：本片零新增对外面、零 PII、零凭据比较 ⇒ 反枚举 / HMAC / AES-GCM 三条**不适用**。shim token 沿用既有 config 注入路径（凭据不进常量）。
- **前端（mobile）**：本片 mobile 侧无表单、无新屏 ⇒ RHF 四铁律不适用。改动**只有**既有雷达行的 `asOf` 呈现粒度（日期 → 时刻），复用 `~/theme` + `~/ui` 既有原子。🚨 **档位不上屏、不新增任何视觉元素**（D10）—— 这是本片 mockup 豁免的前提，不是可以顺手放宽的细节。

---

### D1 · 一跳：`optionsdesk` 直注 `marketdata` 的 port token（Q7-C 判定放行）

**决定**：投影 tick 通过 DI 拿 `marketdata` 的实时行情 port，**不新建实时投影表**、不走「marketdata 落表 → optionsdesk 读表」的两跳。

**Q7-C 判定**（catalog「禁 `@Inject()` 对方的 use case」）—— **放行**，三条判据：

1. 注入的是 **port token + interface**（ADR-0047 的 vendor 访问抽象），不是 use case：它没有业务生命周期、不写任何表、不产生痕迹。
2. ADR-0062 sunset trigger 原文自己规定的升格方向就是「**强一致同步读**」—— 从「读表」变成「同步调用」正是 ADR 预期的形态，不是绕过。
3. 方向铁律不破：`marketdata` 侧对此**零感知**，没有任何 marketdata 代码 import `optionsdesk`。锚驱动的一切仍由消费方主动拉。

**机器面三处必须同时落**：

- `optionsdesk.module.ts` 的 `imports` 从 `[SecurityModule, AccountModule]` 加到含 `MarketdataModule`（本片新增的**唯一** module 边）。
- `MarketdataModule` 的 `exports` 加上新 port token。
- 注入点上方挂 `// CROSS-CONTEXT-SYNC: <reason>` —— `scripts/checks/check-server-moat.ts` Check 2 扫**构造器注入参数类型**，缺注释直接拒（lefthook + CI 双层）。注释挂**注入参数上方**，不是 import 上方。

🚨 **不要顺手把 `marketdata` 的其他 port 也 export/import 进来** —— 本片只开这一个口子。

**为什么不是两跳**：实时面**无历史需求**（历史归 `daily_bar`，spec FR-019），落表只为了被读一次；两跳把延迟叠成 `poll1 + poll2`，而本片的验收基线是 `T + 30 s`。

### D2 · port 契约：`marketdata` 侧**新建**，键 = canonical `market:code`

🚨 **不要复用 / 搬迁 `alert/realtime-quote.port.ts`** —— 那个 port 的 `fetchQuotes(symbols)` **键是 vendor 符号**（`'sz000001'` / `'sh600519'`，转换在 `alert/realtime-quote.rules.ts` 的 `toVendorSymbol`），是腾讯/新浪的 cn 专用形态，不是通用契约。本片 `apps/server/src/alert/` 整目录的 diff **必须为空**（spec FR-018 + 退出标准）。

新 port 落 `marketdata`，键取 canonical `market:code`，vendor 符号转换下沉到各 routed adapter 内部。

**命名**：token 与 interface 就叫 `REALTIME_QUOTE_PORT` / `RealtimeQuotePort`，与 alert 那个**同名**。这是刻意的：

- 它是**终态名字** —— 后续 feature 收编 alert 后那个文件会删掉，届时全仓只剩这一个。起第二个名字会让「哪个是终态」在半年后不可读。
- 同名不会静默出错：`Symbol('X')` 每次调用产生**不同**的 token 对象，DI 不会串；单文件同时 import 两个会是**编译期**标识符冲突，不是运行期错乱。

**接口形状**（prose，实体落代码）：批量入参 canonical symbols；返回 `Map<symbol, { price, capturedAt, ... }>`；**缺标的静默省略**（对齐既有 vendor 语义）；**源故障 / 全空 → 抛**（供熔断计数）。金融数值跨边界一律 `string`（FR-S08），`Decimal` 转换在写库那一层。

#### 🚨 futu 实时 adapter **MUST 复用既有的 `FUTU_OPTION_SNAPSHOT_HTTP_CLIENT` 实例，不要新起一个**

它打的是 shim 的 `/option-snapshot`，与 `FutuOptionSnapshotAdapter` 是**同一个 shim capability**。shim 侧限频是 per-capability 的单一桶（`ratelimit.py` 的 `LIMITS["snapshot"] = (60, 30)`），而客户端每个 `VendorHttpClient` 实例**各持一个独立令牌桶**（`marketdata.module.ts:235-251` 的 factory 形态）。

⇒ 起第二个 60/30 s 的实例 = 两边合起来最多放出 **120 次/30 s**，是上游允许值的 2 倍，撞 429。且两条通路在时间上**真的相邻**：本片 tick 跑到美股收盘后（北京 04:15 前后），而美股 EOD 快照采集就在那之后。

这不是理论风险 —— `futu-shim.constraint-profile.ts:56-61` 记着同一个病灶（「桶满突发」）在 prod 上让链发现每 30 分钟顺延一次、12 只锚永远只采到前 2 只。

**不能复用 `FutuOptionSnapshotAdapter` 这个类**（它的 `getSnapshots` 对空 `contractCodes` 前置拒绝、语义是「取某标的的链」），但**必须复用它注入的那个 client 实例**。

**市场状态是另一个 capability** ⇒ 它**应当**自起一个 `VendorHttpClient` 实例与 profile（同 `option_chain` / `earnings_calendar` 的先例）。

#### 批切分归**调用方**，adapter 只做前置拒绝

spec Assumptions 假定锚数上限约 1000、而 shim 单批上限 400 ⇒ 最坏一轮 3 批。**这件事初稿三份产物都没人认领**（2026-08-17 analyze 阶段发现），当前 13 只锚够不到，但过 400 时会是一次**直接抛**。

按既有同源成例分工（`futu-option-snapshot.adapter.ts:223-229` 的原文「批切分是调用方的事」）：

- **adapter**：超 400 → 前置拒绝、**零外呼**（让 shim 去返 400 也对，但那要先烧掉一次限频配额）。
- **tick（调用方）**：按 400 切批，逐批独立成败（一批失败不拖垮其余，与 spec FR-017 的部分失败语义同一条）。

⇒ 同一段边界逻辑只有一处，不写两遍。

### D3 · 落库面：`anchor` 加两列，expand-only

| 列               | 类型              | 语义                                               |
| ---------------- | ----------------- | -------------------------------------------------- |
| `intraday_price` | `Decimal(18,4)?`  | 最近一次盘中实时价；非交易时段 / 熔断期**不清空**  |
| `intraday_at`    | `Timestamptz(6)?` | 该价的**采集时刻**（我们的墙钟，非 vendor 时间戳） |

- **`Timestamptz(6)` 不是 `@db.Date`** —— 分钟级读数用日期列会把「什么时候采的」压平成「哪天采的」，新鲜度闸当场失效。
- **expand-only**（两列 nullable、无默认、无约束变更）⇒ **不触发** expand-migrate-contract 三步法（那是破坏性变更才要走的）。既有行落 `null`，语义 = 「还没经历过任何盘中采集」。
- migration 命名照 ADR-0035：`<yyyymmddhhmm>_add_anchor_intraday_columns`。
- 🚨 改完 `schema.prisma` **必须 `prisma generate`** —— 生成物是 gitignored 构建产物，`git checkout` 撤不掉它。
- 🚨 这两列**同 `last_close` 一样不入变更痕迹表** —— 痕迹记的是「锚事实被谁改成什么」，行情投影是外部数据的单向镜像。灌进痕迹会把 PIT 回放淹没在每 30 秒一条的噪声里（`sync-anchor-quote.ts:28-30` 已为 `last_close` 立此规矩，本片同理）。

### D4 · 排序表达式与新鲜度闸

改动点唯一：`get-radar.usecase.ts:350-358` 的 `$queryRaw`，把裸 `last_close` 换成一个 spot 表达式。

```
spot := COALESCE(
          CASE WHEN intraday_at >= $cutoff THEN intraday_price END,
          last_close
        )
```

- `$cutoff` **参数绑定**，值 = `now - 新鲜度闸`，闸由 tick 间隔 `T` **派生**，倍数**定死为 3** ⇒ `3 × 30 s = 90 s`。🚨 **禁在第二处手写 90 这个数字**（spec FR-007）—— 常量落 `optionsdesk` 的 rules 层单点，`T` 是**唯一**自由变量。
  📌 **倍数为什么必须定死、又为什么是 3**：初稿写成「3–4 × T」，那等于留了第二个没人拍的自由变量，与「`T` 是唯一自由变量」自相矛盾（2026-08-17 analyze 阶段发现）。取 3 是因为熔断阈值是连续 **3** 轮 × 30 s = 90 s ⇒ **「熔断打开」与「数据被判陈旧」同刻发生**；取 4 会留出 30 秒窗口——熔断已开、雷达还按实时档排序与呈现，正是本片最想消灭的静默骗人形态。
- `ORDER BY distance_to_w_pct ASC NULLS LAST, id ASC` 与 keyset 游标语义**一个字不动**（`radar-cursor.ts` 零改动）。
- 🚨 **别把输出列取成 `distance_to_w_pct` / `id`** —— PG 的 `ORDER BY` 优先解析输出列别名，`::text` 转换后同名会让排序落到字典序上（`get-radar.usecase.ts:186-189` 记着 T014 IT 实测撞过这个）。本片不新增别名，照抄现状。
- **档位判定与 SQL 表达式必须同源**：读端回给客户端的 `priceKind` 走同一个「新鲜否」判据，**禁**在 SQL 里判一次、在 TS 里再判一次（两处必漂移，且漂移表现为「排序按实时、显示说收盘」）。

### D5 · 🚨 复核锚状态机**继续用 `last_close`**，MUST NOT 改用实时价

`get-radar.usecase.ts` 的 `advanceBreachState()` 读 `lastClose` / `lastCloseDate` 驱动 `breach_started_on`（「本轮跌破首次观测日」）。**这一处不改。**

理由三条，按分量：

1. **它是日粒度事实**：`breach_started_on` 是 `@db.Date`，判据是「本轮跌破的**首次观测日**」。用分钟级价驱动日粒度状态机，红标会在同一天内随 spot 反复穿越 W 而反复置位/清空 —— 而清空是**破坏性**的（`last_reviewed_on < breach_started_on` 的比较就此失去意义）。
2. **复审语义**：红标问的是「你确认过这个估值在跌破后仍成立吗」，那是人的动作节奏，不是分钟节奏。
3. **`last_close` 是修订后的权威值**（拆股/分红调整、错单撤销），盘中最后一笔不是。

⇒ 本片之后，同一个 use case 里会有**两个 spot 口径并存**：排序用「新鲜实时否则收盘」，状态机恒用收盘。这不是漂移，是刻意的，**必须在代码注释里写死**，否则下一个人会「顺手统一」。

### D6 · tick 载体：`@Cron('*/30 * * * * *')`，**不引 BullMQ**

`optionsdesk` 现有 `SyncAnchorQuoteScheduler` 就是进程内 `@Cron`（`sync-anchor-quote.scheduler.ts:72` 的 `@Cron('0 30 * * * *', { timeZone: 'Asia/Shanghai' })`）。本片照同一形态加第二条，秒级 cron（6 段）原生支持。

**为什么不照抄 alert 的 BullMQ repeatable**：`alert` 有自己的 `alert-eval` queue + worker + connection 一整套；`optionsdesk` 一套都没有。为一个 30 秒 tick 在本 ctx 从零搭 BullMQ 拓扑，是 senior engineer 会当场判过度的形态。熔断计数用 Redis 即可，**不需要 queue**。

⚠️ **已知代价（与既有 scheduler 同一前提，不是本片新引入）**：进程内 `@Cron` 在多实例部署下会重复触发。现状单实例；且本 tick 幂等（覆盖写同一批列，最后写赢），重复的代价只是多一次 vendor 调用（配额余量 60×）。**这条要写进 ADR amendment**，否则半年后看像设计漏洞。

**三段处置照抄 `alert/intraday-eval.processor.ts:123-144` 的结构**：① 时段闸 → ② 交易日闸（`CROSS-CONTEXT-READ` 读 `trading_day`）→ ③ 熔断计数。返回一个可断言的 outcome 联合类型（照 `IntradayTickOutcome`），供 IT 断言与排障。

🚨 **但只照抄结构，不照抄它的单市场形态** —— `intraday-eval.processor.ts:36` 的 `INTRADAY_MARKET = 'cn'` 是硬编码单市场，它自己的注释就写着「接第二个市场时改这里」。本片的 tick **MUST 从一开始就写成「按锚的 market 分组求值、两个闸逐 market 判」**，本片阶段分组里只有 `us` 一个键。理由是省一次重写：后续接港股时若 tick 是单市场形态就得改结构，写成分组形态则只是多一个键。零额外成本（spec FR-004）。

### D7 · 时段判定：读 vendor 市场状态 → **shim 新增 `GET /market-state`**

**shim 侧**（本片含一处 shim 改动，master 那句「p0 之后 shim 不再有待办」作废）：

- 新增只读端点，返回 `market_us` / `market_hk` 等市场状态字段。
- **数据已经在手上**：`opend.py` 的 `_probe_global_state()` / `_is_logged_in()` 已在调 `get_global_state()`，只是 `status()` 只取了 `qot_logined` / `trd_logined` 两个字段就把 payload 扔了。新端点是**把已有数据往外传**，不是新增一次上游调用形态。
- 🚨 **走数据路径（`session()` → `_ensure_ready()`），不要复用 `status()` 的被动路径** —— `status()` 蓄意不建 `OpenQuoteContext`（注释「a health probe must be side-effect free」），没有活 context 时它对市场状态只能返 `null`。tick 需要确定答案，含糊的 `null` 会被上游当成「状态不可得」而 fail-closed 停采。
- 限频：在 `ratelimit.py` 的 `LIMITS` 登记一条。⚠️ **别按兜底值猜也别乱换算** —— 该表已因「等价换算」踩过一次 prod 事故（`futu-shim.constraint-profile.ts:56-61`）。`get_global_state` 是对本机 OpenD 网关的调用、未必计入富途配额，**impl 时先查官方页；查不到就用兜底最严档并在注释里写明「用的是兜底值，原因是查不到官方值」**。本片用量 1 次/30 秒，任何档位都够。
- 部署验收白捡一条：`/healthz` 的 `routes` 取自 `app.url_map`（内存态，磁盘伪造不了），部署后多出 `/market-state` 即证明「跑的是那棵树」。

**server 侧**：

- 🚨 **状态值域走白名单，禁黑名单** —— 写「不是 `CLOSED` 就算开市」会把盘前 / 盘后 / 夜盘误判成常规时段，而本片只取常规时段最新成交价（spec FR-020）。
- 🚨🚨 **白名单归一化 MUST 落在 `marketdata` 的 adapter 内，port 对外只回归一后的语义**（如 `{ market, session: 'regular' | 'other' | 'unknown' }`），**MUST NOT** 让 `optionsdesk` 拿到 vendor 原始状态串自己判。
  理由是**机器绊线**：判白名单的纯函数若落 `marketdata/*.rules.ts`，`optionsdesk` import 它会被 ESLint boundaries **硬拒**（`eslint.config.mjs` 的 `from: optionsdesk` `disallow` 明列 `marketdata-rules`）。那条禁令是 **ADR-0053 sunset trigger #2 的绊线**，它旁边的注释原文写着「**别把 lint 红当成噪音顺手加进 allowlist —— 它就是设计给那一刻的**」。
  ⇒ 撞到这条 lint 红时的正确动作是**把归一化推回 adapter 侧**，不是改 allowlist。本片 Gate 0.4 已判定 ADR-0053 #2 **未命中**，改 allowlist 会让那条判定当场失效。
- 🚨 **三条降级路径各自显式**：白名单外的**已知**状态 → 不采；**未知**状态值 → 按闭市处理 + 落日志（vendor 将来加状态时我们要看得见）；状态**不可得** → fail-closed 不采 + 计入失败计数。
- 交易日闸**仍然要**（spec FR-011）：vendor 状态答「现在开不开」，`trading_day` 答「今天是不是交易日」，两者取交集，不互相顶替。
- **收盘后补一拍**（spec FR-005）：状态**离开**白名单的那一次求值里补采一次，把当日收盘价收进来。判据是「上一拍在白名单内 ∧ 本拍不在」，状态需要在 tick 之间留痕（Redis 一个键即可，与熔断键同命名空间）。

### D8 · `MARKETDATA_PROVIDER=mock` 下 tick 起手就 gate

新 port 是**采集口**（产出会被持久化进锚表）⇒ mock 档下按 054 纪律绑 `refusingCollectionPort` 拒绝壳。

🚨 **但拒绝壳不能是唯一防线** —— 若只靠它，dev 机上 tick 每 30 秒抛一次、失败计数每 90 秒熔断一次，日志被刷成噪声，054 想要的那份「你的本地进程正在试图采集」的**可见性反而被淹没**。

⇒ **tick 起手判 provider kind，mock 档直接 return `skipped-mock`、0 次 port 调用**；拒绝壳保留为兜底（防有人绕过 gate 直调）。两层各司其职。

### D9 · 熔断与失败计数

照抄 `alert/intraday-eval.processor.ts:147-166`：成功 → 清 failstreak + circuit 若 open 则 close 并 warn 回升；失败 → failstreak++，累计 ≥ **3** → open + warn 降级。**open 态不另设跳闸**，每 tick 仍探一次源（源调用即半开探针），成功即自动回升。

Redis 键用**独立命名空间**（如 `optionsdesk:intraday:*`），**MUST NOT** 与 alert 的 `alert:intraday:*` 共用。

⚠️ **本片阶段会有两套 failstreak 并存**（alert 一套、marketdata 实时面一套）—— 这是收编前的**过渡态**，**必须写进 ADR amendment**，否则半年后看像是设计漂移。

#### 🚨🚨 「市场不支持」MUST NOT 计入 failstreak

这不是一条防御性小心眼，是一个**今天就会发生**的故障：`anchor-import.rules.ts:21` 的 `IMPORTABLE_MARKETS = ['us', 'hk']` ⇒ **hk 锚合法且随时可建**。而 routed adapter 对未登记市场是 fail-closed **throw**。

⇒ 若把这个 throw 当成源故障计数：**只要库里存在一只 hk 锚，failstreak 每 30 秒 +1，90 秒后 circuit open，把 us 那半边一起降级** —— 而 us 的行情源一切正常。这直接违反 spec `state_branch` 14「该锚 MUST 恒为收盘档，MUST NOT 表现为故障」。

**实现要求**：tick 按 market 分组后**逐组独立 try/catch**；「该市场无路由」是**配置事实**，落显式降级 + 一条日志，**不进熔断计数**；只有「已登记市场的源真的调不通」才计数。

### D10 · 呈现层

- `PriceKind` **已有 `'realtime'` 值**（`marketdata.types.ts:29`，注释原文「V1 仅 `eod_close`; 实时源接入翻 `realtime` 零消费者改」）⇒ **不新增枚举值**。
- 雷达 / 详情的 `asOf` 在实时档从**日期**变**时刻**；收盘档不变。
- 🚨 **档位本身不上屏**（spec FR-009，2026-08-17 收窄）—— 它进接口响应供调用方与排查用，界面**只以 `asOf` 的粒度**表达。给档位另加视觉标记 = 引入新视觉元素 = 触发 Constitution §I 的 mockup 闸（见上方 Constitution Check 的 I. SDD 行）。
- 🚨 **降级时距 W% 显式为空，禁 0**（spec FR-014）—— 0 是一个有意义的距离值（「正好在带上」），用它表达「没有数据」会被读成一个强信号。

## Complexity Tracking

| Violation                                                                                                                                        | Why Needed                                                                                                                                              | Simpler Alternative Rejected Because                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 module 边 `optionsdesk → marketdata`（Constitution §IV 要求跨 ctx 走显式 exports + DI，本片是本 ctx 首次依赖 marketdata 的运行时 provider） | ADR-0062 sunset trigger 自己规定的升格方向就是「强一致同步读」；两跳（新建实时投影表 + Q7-B 读表）会把延迟叠成 `poll1 + poll2`，而验收基线是 `T + 30 s` | 两跳还要为一份**无历史需求**的数据建一张表 + 一条落表管线 + 一份新鲜度语义，纯增维护面；ESLint boundaries 对这条边本就放行（`marketdata` 不在 `optionsdesk` 的 disallow 里），说明边界设计时已预留 |
| 同一个 use case 内两个 spot 口径并存（排序用实时、复核锚状态机用收盘，D5）                                                                       | 状态机是日粒度事实，用分钟级价驱动会让红标在一天内反复置位/清空，而清空是破坏性的                                                                       | 「统一成实时」会破坏 045 的复核语义；「统一成收盘」会让本片的诉求本体（盘中重排）不成立                                                                                                            |
