---
feature_id: 053-optionsdesk-leg-query-pushdown
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-08-13'
updated_at: '2026-08-14'
---

# Tasks: 053-optionsdesk-leg-query-pushdown（选约表查询下沉 —— 每视角独立请求 + 响应收窄 + 表达层截断 · P4）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0064`](../../docs/adr/0064-optionsdesk-retrieval-layering.md)
**Branch**: `053-optionsdesk-leg-query-pushdown`
**主 plan**: `docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md` §2.5（本机私有，片序权威在其 §2）
**Mockup**: `design/053-leg-columns.dc.html`（3 帧，2026-08-13 定稿，六项探测全绿）+ `design/handoff.md`（local-only）

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan D-xxx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一 task 内闭环。
- 层级：`[Server]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Gate]` / `[Verify]`。

## 🚨 `state_branches` 的落层裁定（先读这条，否则会去补不可能的 IT）

spec 的 **25 条 `state_branches` 里有 11 条是纯客户端行为**（跨业务日重取与提示 / 水位失效三份 / 单视角失败隔离 / 错误态切换 / 迟到响应 / 错峰时序 / 预取失败与命中 / 切视角保留条件）—— **服务端 IT 结构上够不到它们**。

⇒ 执行口径：**每条至少有一个 `it()`，其主落层是够得到它的那一层**（服务端分支落 IT、纯客户端分支落 e2e、几何分支落真机验收）。主落层分区 **IT 13 / e2e 11 / 真机 1 = 25**；另有 6 条在次落层加断言，不影响分区。这是 `052` T015 对同一冲突的裁法，本片沿用。

📌 **矩阵值域声明**（per `sdd-authoring.md` 反模式第 4 条 —— 这一问在「逐条 grep」之前）：五张矩阵扫的是 `state_branches` / AS / Edge / SC / FR 五层。**§ 依赖与前提、§ Clarifications 定案、§ Out of Scope 的去向已逐条核回 FR/SC，无表外需求**（唯一藏着需求的是依赖表第 5 行「`K` 触及数下发并按异常呈现」，已由 `FR-019c` 吸收）。§ 背景的两段散文分别落 `SC-011`（正当性前提）与 `SC-006`（验证约束）。
🚫 **MUST NOT** 照 plan Testing Invariants 的字面「每条在 IT 里有对应 `it()`」去补 11 条不可能的 IT。

## Path Conventions

| 用途 | 路径 |
| --- | --- |
| 检索 port（`052` 已 ship，**签名不动**） | `apps/server/src/optionsdesk/leg-retrieval.port.ts` |
| 召回判据（`052` 已 ship，**判据不动**） | `apps/server/src/optionsdesk/leg-recall.rules.ts` |
| 精排 + 截断常量（本片改） | `apps/server/src/optionsdesk/leg-rank.rules.ts` |
| 编排（本片改） | `apps/server/src/optionsdesk/get-legs.usecase.ts` |
| 契约（本片破坏性改） | `apps/server/src/optionsdesk/optionsdesk.dto.ts` + `optionsdesk.controller.ts` |
| Server IT | `apps/server/test/integration/optionsdesk-053.query.it.spec.ts` |
| Mobile 取数 | `apps/mobile/src/optionsdesk/use-leg-table.ts` |
| Mobile 呈现 | `apps/mobile/src/optionsdesk/leg-picker.rules.ts` · `leg-row.tsx` · `leg-row.rules.ts` · `leg-table-header.tsx` |
| Mobile e2e | `apps/mobile/e2e/optionsdesk-query-pushdown.spec.ts` |

🚨 **五层是逻辑分层不是目录分层**（ADR-0043）—— 文件平铺，**MUST NOT** 为截断层建子目录。

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红；plan § Impl Guardrails 的 14 条同源）

1. **恢复一个「筛选」段** —— `052` 已把六维并入召回层；再写一条「排名后筛一次」就是第二份成员判据，撞守门脚本不变量 #7（`D-ORDER-1`）。
2. **水位失效只失效一个视角** —— query key 加了 `perspective` 之后原来那句失效不再覆盖三份，而**屏幕上什么都不会红**（`D-CONSIST-1`）。
3. **摘掉 `placeholderData: keepPreviousData`** —— 换 key 那一拍同步 setState 打成死循环，整屏被 error boundary 接住（React #185），**且它不会自行收敛**（`052` T013 实证 6 条红）。
4. **无限重取** —— 一致性 latch 写成计数器且方向写反即死循环。
5. **Tab 行加错误 / 加载角标** —— 与 `FR-027` 定的「后台预取失败对前台零感知」相反。
6. **截断计数用告警色** —— 截断是正常呈现约定；`K` 熔断才是异常（两者 MUST 不同款）。
7. **截断分支用合成 fixture 验** —— 测的是「slice 能不能跑」，不是「真实链上截断对不对」⇒ 走**注入小阈值**。
8. **只断言截断后的条数** —— 条数对不代表截对了；必须断言**截掉的是排序尾部**（前 `D` 条逐条相同）。
9. **改 port 入参** —— `052` 已把 `perspectives` 立好，改入参等于把留好的接口白留。⚠️ **2026-08-14 裁定：本条限入参**，出参 `LegRetrievalResult` 加 `memberCount` 一个字段（推导见 spec `FR-003`）。
10. **列改版顺手调列宽** —— 内容总宽一变，真机右侧滑不到底**且不会红**。
11. **把 `D`（实际显示条数）或「其余 N−D」下发** —— 两者都可现算，下发第二份必 drift。
12. **拿 `052` 的六维边际计数加总充当 `memberCount`** —— 边际口径下被两维同时挡下的腿**两维都不计它**，加总**少报**，而数字照样出得来。
13. **为 `memberCount` 多查一次库** —— DB 层只下结构性谓词，六维判据在取回后的纯函数里；第二次判定用同一批行即可。📌 **落法已定**（2026-08-14 裁定）：第二次判定落 **adapter**（原始链行只存在于那里），`recallCandidates(override = null)` 跑同一批已在内存的 `legs`，结果经出参 `memberCount` 上浮。🚫 **MUST NOT 落 `leg-recall.rules.ts`** —— 撞 `FR-044` / T005 的零行 diff 判据。
14. **把 `K` 的触及做成第四条常规计数** —— 它是保险丝熔断不是判据挡下，同款呈现会让「该调容量」被读成「该调展示」。

---

## Phase 1: 服务端语义翻转（阻塞其余全部）🎯

- [X] T001 [Server] **`perspective` 升为「决定返回哪个视角」+ 调用点收敛**（`FR-001`, `FR-003`, `FR-004`, plan `D-API-1`）：`optionsdesk.controller.ts:253` 传入 `perspective`（缺失 → 400 或明确默认视角，二选一并写进 DTO 描述）；`get-legs.usecase.ts:430` 的 `perspectives: LEG_TABS` 改传请求的那一个；`:649` / `:733` 两处 `for (const tab of LEG_TABS)` 收敛为单视角。🚫 **`leg-retrieval.port.ts` 签名一字不改**（Guardrail 9）。→ verify: IT 三值各自只返回该视角的腿且顺序取自服务端 + 缺 `perspective` 的 400 断言 + `git diff leg-retrieval.port.ts` **零行** + `nx test server --skip-nx-cache` 全绿。📌 **该零行判据限 T001 期**：2026-08-14 裁定后 T002 会在 `LegRetrievalResult` 加 `memberCount` 一个**出参**字段（入参仍零改动），届时本行的零行 diff 不再复现 —— 见 spec `FR-003`

- [X] T002 [Server] **截断纯函数 + 分档常量 + 三个计数**（`FR-004`, `FR-009`, `FR-010`–`FR-012`, `FR-019c`, plan `D-ORDER-1` / `D-LIMIT-1`）：`leg-rank.rules.ts` 加 `DISPLAY_LIMIT_BY_PERSPECTIVE`（三值带 `⏳` 占位标记 + 「标定在 T012」+「MUST NOT 当已标定值引用」三个标记）与截断纯函数（判据**严格大于才截**）；use case 在精排之后截断，并产出 `matchedCount`（当前条件）、`memberCount`（**adapter** 对同一批已在内存的 `legs` 用 `override = null` 再跑一次 `recallCandidates`，经 `LegRetrievalResult` 的新出参字段上浮 —— 2026-08-14 裁定，🚫 **MUST NOT** 改 `leg-recall.rules.ts` 去「同一次遍历评两套」，那撞 `FR-044`）、`K` 触及数上浮。阈值 **MUST 可注入**（use case 签名带可选参数，默认取常量）。→ verify: Small —— 边界三态（`<` / `=` / `>`）+ 降级后返回本体 + `K` 与 `N` 不共用常量的对照断言（`052` T005 留的量级断言在此变成真对照）+ **`memberCount` 零额外 DB 往返**（断言 `retrieveCandidates` 调用次数为 1，Guardrail 13）+ 未覆盖时 `memberCount === matchedCount`

---

## Phase 2: 契约收窄（US1 / US2 的共同前置）

- [X] T003 [Server] **响应按「链级 / 视角级」收窄**（`FR-002`, `FR-005`, `FR-006`, plan `D-API-1`）：`optionsdesk.dto.ts` 删 `tabOrder`、`basisByTab` → 标量 `basis`、`criteriaByTab` → `criteria`、分视角流动性排除数 → 标量、每腿 `tierByTab` → `tier` / `activityByTab` → `activity`、**删每腿 `tabs`**；新增 `perspective` 回显 + `displayLimit` + `matchedCount` + `memberCount` + `K` 触及数。🚫 **实际显示条数与「其余 N−D」MUST NOT 下发**（Guardrail 11）。→ verify: IT 断言响应形状 + **生成的 OpenAPI schema 内 `rg` 扫 `tabOrder|ByTab` 零命中**（`SC-002` 的服务端一半）+ 链级字段在三视角响应里逐字相等（`FR-020` 的检测判据来源）

- [X] T004 [P] [Server] **单笔权利金 + 相对价差下发**（`FR-032`, plan `D-COL-1`）：`单笔权利金 = bid × 合约乘数` **服务端算**（服务端已持有该常量，成交额在用它）；`相对价差` 复用 `leg-recall.rules.ts` 的 `relativeSpread` 派生值下发。🚫 MUST NOT 由客户端乘一次 —— 那是同一判据两处各算一份（ADR-0064 不变量 ③）。→ verify: Small 断言两个派生值 + `rg` 扫 mobile 侧**零处**乘合约乘数 + nullable 小数字段的 `@ApiProperty` 显式 `type: 'string'`（防 orval 误生 objectmap）

- [X] T005 [Server] **IT：服务端侧 state branch 全覆盖**（`FR-010`–`FR-015`, `SC-004`–`SC-007`, `SC-012`, `SC-015`, `SC-016`）：新建 `optionsdesk-053.query.it.spec.ts`（Testcontainers 真 PG）。覆盖 `state_branch` **1–12 / 24**（落层裁定见文件头）。→ verify: 🚨 **截断掉的必是排序尾部** —— 断言「截断前后前 `D` 条逐条相同」而非只断条数（Guardrail 8）+ **注入小阈值走遍截断分支**（`SC-006`，Guardrail 7）+ **被意图视角排除的腿在全腿视角可达**（`SC-012`，`051` 入口的回归防线）+ `K` 触及时触及数可读且 `matchedCount` 失真可被观测（`SC-016`，**先证明它会红**：`K` 注入小值时触及呈现必须出现）+ **未触发截断时 `displayLimit` 与 `matchedCount` 仍下发**（`FR-015` 的可验证形态 —— 只在截断时下发会让「逼近」恰好观测不到）+ 🚫 **`FR-043` 零改动核实**：`git diff main...HEAD -- apps/server/src/optionsdesk/anchor.rules.ts apps/server/src/optionsdesk/intent-matrix.rules.ts` **零行** + 🚫 **`FR-044` 零改动核实**：`git diff main...HEAD -- apps/server/src/optionsdesk/leg-recall.rules.ts` **零行**

- [X] T006 [Contract] **`export-openapi` + regen + 修编译红**（plan §V）：跑 `nx run server:export-openapi` + `nx affected -t generate`；修因收窄而编译红的手写 mock 工厂（`050` 那次 7 处、`052` 那次 6 处）。→ verify: `openapi.json` 逐项比对（**本片是破坏性变更，删除项 MUST 与 `FR-005` 表逐条对上，不得有表外删除**）+ `nx run-many -t build,lint -p server api-client` 绿 + `nx test server` 绿 + `check-api-property-nullable` / `check-contract-smoke-drift` 过 + 🚫 **`FR-042` 核实**：生成的 `openapi.json` 内 `rg 'RankingFeatures'` **零命中**（特征集不进契约）
  <br>⚠️ **2026-08-14 裁定：`nx affected -t build` 绿 与 `nx typecheck mobile` 绿两条已移往 T008**。起因是本条起草时套了 `050`/`052` 的经验（「regen 只打红手写 mock 工厂」），而本片是**破坏性收窄** —— 它同时打红业务消费面（`leg-picker.rules.ts` 的 `legActivityForTab` / `legTierForTab` 必须删 `tab` 参数改签名 = **T008 逐字的交付**；`use-leg-table.ts` 的取数语义 = T007/T008；`leg-criteria.rules.ts` 的级联红动了就违反 `FR-045` 零行 diff）⇒ 本条 verify 达成的前提是先做掉 T007+T008，与任务分解互斥。单 PR 模型下 `main` 看不到中间态，mobile typecheck 红在 T008 前是**结构性的、不是回归**；闸放在真正能关上它的 task 上才可审。

---

## Phase 3: Mobile 取数层（US2 · US3）

- [X] T007 [Mobile] **三 query + 错峰 + 失败隔离 + 一致性 latch + 水位失效三份**（`FR-001`, `FR-007`, `FR-008`, `FR-020`–`FR-022`, `FR-025`–`FR-027`, plan `D-ASYNC-1` / `D-CONSIST-1`）：`use-leg-table.ts` 改三个独立 query（key 由 orval 生成，含 `perspective` 与六维条件）；**错峰** = 当前视角无条件 enabled、其余两个 `enabled: currentQuery.isSuccess`；一致性检测三份 `asOf` 不全等 → 重取全部一次 + 置 **latch**（布尔闩不是计数器，Guardrail 4）；`useSetPositionBucket` 的 `onSuccess` 改用**不含 `perspective` 的前缀 key** 失效三份。🚨 **`placeholderData: keepPreviousData` MUST 保留**（Guardrail 3）。→ verify: Small（logic-only）—— latch 只重取一次 + 错峰 `enabled` 判据 + 失效 key 覆盖三份的断言（🚨 **先证明它会红**：改回带 `perspective` 的 key，该断言必须失败）

- [X] T008 [Mobile] **消费收窄契约 + 截断计数第 3 条 + `K` 异常位**（`FR-002`, `FR-016`–`FR-019`, `FR-019c`, plan `D-UI-1`）：七处 `xxxByTab[tab]` 索引形态清零（`leg-picker.rules.ts:103/131/146/291/379` + `leg-row.tsx:60,64`），这些函数签名里的 `tab` 参数**消失**，调用点编译期逐个点名；`051` 已留位的 `renderSectionFooter` 追加第 3 条「已显示前 D 条 · 其余 N−D 条未显示」+ 指向抽屉的收窄指引；`K` 触及时**另起异常位**（与截断计数不同款，Guardrail 6/14）。→ verify: Small —— `rg 'tabOrder|basisByTab|criteriaByTab|tierByTab|activityByTab|ByTab\[' apps/mobile/src/optionsdesk/ -g '!*.spec.*'` **零命中**（`SC-002` 的客户端一半）+ 未触发截断时整条不渲染 + 计数区与 sticky 区块头**不出现同一个数值**（`SC-005`）+ `nx affected -t build` 绿 + **`tsc --noEmit -p tsconfig.json`（src 半边）零红** + `nx lint mobile` 绿 + `apps/mobile` 内 `vitest run` 全绿
  <br>📌 **本 task 连带改了一处任务文本未点名的东西，如实登记**：sticky 区块头原先报 `legs.length`，而 footer 一旦说「已显示前 `D` 条」，同一个 `D` 就在一屏出现两次 —— **直接违反 `SC-005`**。故区块头改报 `matchedCount`（`memberCount > matchedCount` 时显「筛后 N · 全量 M」），依据是 plan `D-API-1` 的计数分工表本就把区块头定为这两个数。⚠️ **副作用**：既有 e2e 里 8 处 `共 N 行` 断言语义失效 —— 归 **T014**。
  <br>✅ **2026-08-14 裁定：`nx typecheck mobile` 绿 与 `nx test mobile` 绿 两条闸移往新增的 T014**（本行不再背它们）。起因是 impl 期实测发现该 target 是 `tsc --noEmit -p tsconfig.json && tsc --noEmit -p e2e/tsconfig.json` 两段串联，**`&&` 短路让 src 那 44 处红一直遮着 e2e 那半边**。T008 把 src 半边清零后，e2e 半边露出 **99 处**同源收窄红，分布 6 文件：`contract-smoke/optionsdesk-chain-leg-picker.contract.ts` **53**（T011 的文件）· `optionsdesk-leg-display.spec.ts` **24** · `optionsdesk-chain-leg-picker.spec.ts` **13** · `optionsdesk-detail-thermometer.spec.ts` **6** · `optionsdesk-criteria-sheet.spec.ts` **2** · `_support/optionsdesk-fixtures.ts` **1**。<br>🚨 **它不是机械改形状**：相当一部分红是**断言本身**打在被删字段上（有序 code 列表与每腿 `tabs` 同源派生 / 三格口径互不相同 / 分视角排除数），改它 = 逐条裁定「删 / 改写 / 换判据」。<br>📌 连带事实：`nx.json` 的 `targetDefaults.test.dependsOn = ["typecheck"]` ⇒ **`nx test mobile` 被同一条闸挡着**（T007 期同样挡着，当时被 src 红掩盖）。取证改跑 `apps/mobile` 内 `vitest run`：**104 文件 / 1521 例全绿**。

---

## Phase 4: 列改版（US4）

- [ ] T009 [Mobile] **12 列改版**（`FR-030`–`FR-034`, `SC-018`, `SC-019`, plan `D-COL-1`）：`leg-row.rules.ts` 的 `LEG_TABLE_COLUMNS` **删 `sigma`(46) / `turnover`(52)、加 `premium`(50) / `spread`(48)**，列序改为 `strike → bid → rate → premium → oi → spread → cost → delta → vol → activity → mark → action`；`leg-row.tsx` 与 `leg-table-header.tsx` 同步；`bid`/`ask` **保持合并**（`FR-031`，不拆）。⚠️ **连带清理我这次改动产生的 orphan**：`leg-row.rules.ts` 文件头那条「Δ 与 σ距 是同一个 `absDelta` 的两种呈现，两列 MUST 同时有值或同时留占位」的不变量**随 `sigma` 列退场而失去对象**，注释 MUST 同步删或改写 —— 留着会让下一个人以为还有第二列要维护；`leg-row.tsx:165` 那条同源注释同理。→ verify: Small —— **宽度合计 = 716 且首列 = 88**（`SC-018`，🚨 先证明它会红：临时改一列宽度，断言必须失败）+ 表头零折行（`SC-019`，判据取真实最宽内容：`成本vsW` 在 56px 内 / 深实值两位数价格在 88px 内 / 权利金四位数在 50px 内）+ `rg 'sigma|turnover' apps/mobile/src/optionsdesk/` 仅剩迁移留痕注释 + 🚫 **`FR-045` 零改动核实**：`git diff main...HEAD -- apps/mobile/src/optionsdesk/leg-criteria.rules.ts apps/mobile/src/optionsdesk/leg-criteria-sheet.tsx` **零行**

---

## Phase 5: 两层验证（Constitution §V 跨端片义务）

- [ ] T014 [Mobile-E2E] **e2e + contract-smoke 契约镜像随收窄与列改版同步**（`FR-002`, `FR-005`, `SC-002`，2026-08-14 impl 期新增）：把既有 6 个 e2e / contract-smoke 文件的 **99 处收窄红**改到新契约形状。🚨 **位置刻意在 T009 之后** —— T009 删 `sigma`/`turnover`、加 `premium`/`spread`，既有 e2e 断言了那些列，放 T009 之前修就要修两遍。三件事：<br>① **99 处收窄红**（`contract-smoke/optionsdesk-chain-leg-picker.contract.ts` 53 · `optionsdesk-leg-display.spec.ts` 24 · `optionsdesk-chain-leg-picker.spec.ts` 13 · `optionsdesk-detail-thermometer.spec.ts` 6 · `optionsdesk-criteria-sheet.spec.ts` 2 · `_support/optionsdesk-fixtures.ts` 1）。🚨 **相当一部分是断言本身打在被删字段上**（有序 code 列表与每腿 `tabs` 同源派生 / 三格口径互不相同 / 分视角排除数）⇒ 逐条裁定「删 / 改写 / 换判据」，**MUST NOT** 机械套形状把判别力改没；每条删掉的断言 MUST 在 commit body 里说明它守的不变量是**结构性消失**了还是**移到了别处**。<br>② **8 处 `共 N 行` 断言重定** —— T008 依 `SC-005` 把 sticky 区块头从 `legs.length` 改报 `matchedCount`（`memberCount > matchedCount` 时显「筛后 N · 全量 M」）。<br>③ **T009 删/加四列的断言同步**。<br>→ verify: 🚨 **`nx typecheck mobile` 绿**（自 T008 移入 —— 该 target 两段 `&&` 串联，本 task 是 e2e 半边的收口处）+ 🚨 **`nx test mobile` 绿**（`targetDefaults.test.dependsOn = ["typecheck"]`，被同一条闸挡着）+ `nx affected -t build` 绿 + 🚫 **`FR-045` 零改动核实**：`git diff main...HEAD -- apps/mobile/src/optionsdesk/leg-criteria.rules.ts apps/mobile/src/optionsdesk/leg-criteria-sheet.tsx` **零行**
  <br>📌 **本 task 只做「既有镜像随契约同步」** —— 新 e2e 场景归 T010、契约冒烟的**新字段解封**归 T011，两者的交付面 MUST NOT 被本 task 预支。

- [ ] T010 [Mobile-E2E] **hermetic e2e**（`state_branch` 13–23, `SC-008`–`SC-010`）：新建 `optionsdesk-query-pushdown.spec.ts`（Playwright Expo Web，`route.fulfill` 拦端点）。覆盖：错峰时序（当前视角未落地时另两个**不发请求**）· 单视角失败隔离 · 切到错误态视角显错误态非空态 · **后台预取失败 → 当前视角零感知且 Tab 行无错误/加载角标** · 跨业务日自动重取一次 + 仍不一致给提示 · 水位改动失效三份 · 迟到响应不覆盖 · 预取命中/未命中 · 切视角保留各自条件 · 截断计数出现与消失。🚨 **mock 是契约镜像不是调用序** —— handler 按 `perspective` + 六维参数**无条件作答**，禁按测试编排标志分支（`052` T013 同一条纪律）。→ verify: 跑**全套** `nx run mobile:runtime-smoke` 非单 spec（改了共享 hook ⇒ blast radius 是整套）+ 🔬 **反例探针**：摘掉 `placeholderData: keepPreviousData`，e2e 必须红（Guardrail 3 的实证）

- [ ] T011 [Contract-Smoke] **契约冒烟扩到新形状**（Constitution §V）：`apps/mobile/e2e/contract-smoke/` 用生成的 `@nvy/api-client` 打 testcontainers 真 server。→ verify: `perspective` 必填与三值往返 + 新字段解封（`displayLimit` / `matchedCount` / `memberCount` / `K` 触及数 / 单笔权利金 / 相对价差）+ **删掉的 `tabOrder` 与各 by-tab 结构确实不再出现** + nullable 小数字段的运行时类型是 string 而非 orval objectmap。📌 本地跑它要先空出 `:3000`，要停的是 `nx serve server` 那层看门进程而不是它的子进程（`052` T014 实撞）

---

## Phase 6: 标定与真机验收

- [ ] T012 [Gate] **三视角截断阈值实测标定**（`FR-013`, `FR-014`, `SC-014`）：用 dev 全部链，沿 `050` T017 / `052` T016 的分布分析做法，看「第 `N` 名之后还有没有值得看的腿」。🚫 **无断点则记为「不设该视角阈值」，不许拍数**（同 T016 对单笔权利金下限的裁定）。🚨 **全腿视角的阈值有硬下界** —— 它必须高到让 `051` 那个「点流动性排除数 → 切到全腿视角看被排除的腿」的入口仍可达 ⇒ 标定该视角时，**「被意图视角排除的腿在排序序列里的最深位置」是阈值的下界输入**，不能只看分布断点。📌 标定判据照**认知负荷**设计而不是性能（`051` 真机实测 573 行虚拟化只挂 16–17 节点、零白屏 ⇒「跑不动」不是本片的问题）。⚠️ **动手第一件事先确认数据面没被 mock 污染**（`052` T016 撞过：12 只票共用同一个 spot）。→ verify: 三个数与**推导过程**写回 spec § 标定实测 + 代码内 `⏳` / 「标定在 T012」/「MUST NOT 当已标定值引用」三个标记**扫零命中** + `nx test server` 全绿

- [ ] T013 [Verify] **真机验收 + `052` 遗留三项**（`FR-033`, `FR-036`, `SC-003`, `SC-017`, `state_branch` 25）：Mate50 dev-client。① 列改版几何 —— sticky 栈占屏比 **≤ 35%**（基线 `051` 实测 138.5dp / 27.9%）、横滑到最右端**末列完整露出**、首列冻结宽与位移语义零变化；② 视角切换与预热**手感**；③ **`052` 遗留三项** —— 抽屉是否真盖住底部 Tab 栏 / 输入法弹起后「搜」在不在屏内 / ⓘ 热区 44×44。🚨 **③ 的第一项若为否是功能缺陷不是版式问题**（说明抽屉没走 RN `Modal` 渲到 root 层，per memory `reference_drawer_overlay_bounded_by_tab_content_use_modal`）—— 撞到即**停下修**，MUST NOT 记为「已知问题」往下走。→ verify: 逐条读数写回 spec § 真机验收；**MUST 用真机读数复核，MUST NOT 用 web 那组**（`049` 实测 web 185 vs 真机 161dp，差约 13%）+ 🚨 **PR body 三件事逐条写入**（`SC-011` / `FR-019a` / `FR-019b`）：① 拆请求的**正当性前提**与它的四条代价 ② 047「no pagination, no top-N」的 **supersede** ③ 047「切 Tab 不重新请求」的**作废**。⚠️ PR 在本 task 之后才开 ⇒ 这是**开 PR 前的最后一道闸**，不是事后补

---

## Dependencies & 执行顺序

```text
T001 (语义翻转) ──> T002 (截断 + 三个计数)          [Phase 1 · 同改 use case，串行]
                      │
                      ├──> T003 (收窄 DTO) ──> T006 (regen) ──> T007 ──> T008 ──> T009
                      │         │                                                  │
                      │         └──> T004 [P] (两个新派生值)                        │
                      │                                                             │
                      └──> T005 (server IT)                                         │
                                                                                    │
                              T014 (e2e/契约镜像随收窄+列改版同步) <──────────────────┘
                                        │       [两条 mobile 闸挂它]
                                        ├──> T010 (e2e 新场景)
                                        └──> T011 (contract-smoke 新字段)
                                                        │
                                          T012 (标定) ──> T013 (真机)   [收口，需前面全绿]
```

- **T004 是本片唯一的 `[P]`** —— 它加两个派生值，与 T003 的形状收窄不同关注点，可并行。
- T001/T002 同改 `get-legs.usecase.ts` ⇒ **不可并行**。
- T006 之后**禁止**再往 PR push 前遗漏 regen —— `api-client:generate` 无 `dependsOn`，单跑它是拿 stale `openapi.json`。
- 🚨 **T014 MUST 在 T009 之后** —— T009 删 `sigma`/`turnover`、加 `premium`/`spread`，既有 e2e 断言了那些列；放 T009 之前修就要**修两遍**。它也 MUST 在 T010/T011 之前：那两个 task 各自要写新场景，而 `nx typecheck mobile` / `nx test mobile` 在 T014 之前是恒红的（`&&` 短路 + `test.dependsOn=["typecheck"]`），没有绿基线就分不清「我写的新场景红」还是「旧镜像还没修」。
- T012 必须在 T005 / T010 之后 —— 标定要在**真实链上跑通全链路**才有意义。

## Clear 检查点批次

| 批次 | Task | 批次后建议 `/clear` |
| --- | --- | --- |
| 1 | T001 · T002 | ✅ 服务端语义翻转落定 |
| 2 | T003 · T004 · T005 | ✅ 契约与 IT 完成，server 侧可独立验 |
| 3 | T006 · T007 | ✅ regen + 取数层落定 |
| 4 | T008 · T009 | ✅ 呈现层与列改版落定 |
| 4.5 | T014 | ✅ 契约镜像同步 —— **`nx typecheck mobile` / `nx test mobile` 自此恢复可跑** |
| 5 | T010 · T011 | ✅ 两层验证 |
| 6 | T012 · T013 | — |

🚨 **批次 ≠ commit 合并** —— 每 task 仍各自 atomic commit（Constitution §III）。

## `state_branches` 覆盖矩阵（**25** 条 → task，实时 grep 得出）

| # | 分支要点 | 落层 | Task |
| --- | --- | --- | --- |
| 1 | 候选数 < 阈值 → 不截断 | IT | T005 |
| 2 | 恰等于阈值 → 不截断 | IT | T005 |
| 3 | > 阈值 → 截到阈值 | IT | T005 |
| 4 | 全腿 · 被排除的腿仍可达 | IT | T005（`SC-012`） |
| 5 | 收窄使结果降到阈值以下 → 计数消失 | IT + e2e | T005 · T010 |
| 6 | 注入小阈值走遍截断分支 | IT | T005（`SC-006`） |
| 7 | `K` 未触及 → 异常提示不出现 | IT | T005 |
| 8 | `K` 被触及 → 下发 + 异常呈现 | IT + Small | T005 · T008 |
| 9 | 未覆盖 → `memberCount == matchedCount` | Small + IT | T002 · T005 |
| 10 | 收窄 → `memberCount > matchedCount` | IT | T005 |
| 11 | 每腿只带当前视角档位与活跃标 | IT + Small | T003 · T008（`SC-002`） |
| 12 | 三视角同业务日 → 正常 | IT | T005 |
| 13 | 跨业务日 → 自动重取全部（最多一次） | **e2e** | T010 |
| 14 | 重取后仍不一致 → 显式提示不无限重取 | **e2e** | T010 |
| 15 | 水位被改 → 三视角全部失效重取 | Small + **e2e** | T007 · T010（`SC-013`） |
| 16 | 单视角失败 → 其余不清空 | **e2e** | T010（`SC-009`） |
| 17 | 切到错误态视角 → 非空态 | **e2e** | T010 |
| 18 | 迟到响应不覆盖 | **e2e** | T010 |
| 19 | 当前视角未落地 → 其余不发请求 | Small + **e2e** | T007 · T010 |
| 20 | 后台预取失败 → 前台零感知 | **e2e** | T010 |
| 21 | 预取已完成 → 无可见加载态 | **e2e** | T010（`SC-008`） |
| 22 | 预取未完成 → 降级为正常加载态 | **e2e** | T010 |
| 23 | 有覆盖切走再切回 → 仍是自己那份 | **e2e** | T010 |
| 24 | 链未就绪 → 沿用既有两个显式状态 | IT | T005 |
| 25 | 列改版后横滑到最右端 | **真机** | T013 |

📌 **11 条落 e2e、1 条落真机** —— 见文件头的落层裁定。

## Acceptance Scenario 覆盖矩阵（**16** 条 → task）

| US | AS | Task |
| --- | --- | --- |
| US1 | 1 截断计数出现且两处不重复同一个数 | T008 · T010 |
| US1 | 2 未超阈值时计数不出现 | T008 |
| US1 | 3 与 `051` 两道门槛计数可区分 | T008 |
| US1 | 4 收窄后计数消失 | T010 |
| US1 | 5 无分页 / 加载更多 | T008（否定式） |
| US1 | 6 被排除的腿在全腿视角逐条可达 | T005（`SC-012`） |
| US2 | 1 单视角失败其余不受影响 | T010 |
| US2 | 2 错误态与空态可区分 | T010 |
| US2 | 3 跨业务日重取 + 提示 | T010 |
| US2 | 4 停在建仓视角改水位 → 三视角全失效 | T007 · T010 |
| US3 | 1 切视角等待显著低于冷取 | T010（`SC-008`） |
| US3 | 2 各视角保留自己的条件 | T010 |
| US3 | 3 预取失败当前视角零感知 | T010 |
| US4 | 1 一次横滑凑齐判据集 | T009 · T013 |
| US4 | 2 `bid`/`ask` 各自独立可读 | T009 |
| US4 | 3 横滑到最右端末列完整露出 | T013 |

## Edge Case 覆盖（**8** 条 → task）

| Edge Case | Task |
| --- | --- |
| 成员数恰等于阈值 → 不算截断 | T002 · T005 |
| 收窄到阈值以下那一刻计数消失 | T010 |
| 飞行途中切视角 → 迟到响应不覆盖 | T010 |
| 跨交易日切换点前后各一次请求 | T010 |
| 水位在两次请求之间被改 | T007 · T010 |
| 链未就绪 / 跨 ctx 读故障 → 沿用既有状态 | T005 |
| 标定裁定「不设 `N`」→ 退化为零截断的显式登记 | T012 |
| 列改版使总宽变化 → 后置列吸收 | T009（`SC-018`） |

## SC 覆盖（**19** 条 → task）

| SC | Task |
| --- | --- |
| SC-001 最大真实链三视角均能取数呈现 | T013 |
| SC-002 by-tab 残留为零（契约 + 客户端） | T003 · T008 |
| SC-003 列改版后占屏比 ≤ 35% + 末列完整露出 | T013 |
| SC-004 截断计数 100% 出现 / 未触发 100% 不出现 | T005 · T008 |
| SC-005 计数区与区块头不出现同一个数值 | T008 |
| SC-006 截断覆盖不依赖真实链规模 | T005 |
| SC-007 判据只有一份实现 + 已证明会红 | T005 |
| SC-008 预取命中无可见加载态 | T010 |
| SC-009 单视角失败其余零变化 | T010 |
| SC-010 跨交易日一致性可复现验证 | T010 |
| SC-011 两条 supersede 在 spec 与 PR body 登记 | **T013**（PR body）· spec 侧已落 `FR-019a` / `FR-019b` |
| SC-012 被排除的腿 100% 可在全腿视角找到 | T005 |
| SC-013 水位改动后三视角推荐标口径一致 | T007 · T010 |
| SC-014 阈值取值与推导过程写回 + 占位零命中 | T012 |
| SC-015 `memberCount` 关系断言 + 零额外 DB 往返 | T002 |
| SC-016 `K` 触及呈现可区分 + 已证明会红 | T005 |
| SC-017 `052` 遗留三项逐条有读数 | T013 |
| SC-018 列宽合计 716 与首列 88 的机器断言 | T009 |
| SC-019 表头零折行 | T009 |

## FR 覆盖（**42** 条，实时 grep 得出）

| FR 组 | 编号 | Task |
| --- | --- | --- |
| 每视角独立请求与响应收窄 | FR-001 – FR-009 | T001 · T002 · T003 · T006 · T007 |
| 截断与截断计数 | FR-010 – FR-019c | T002 · T005 · T008 · T012 |
| 一致性与失败隔离 | FR-020 – FR-023 | T007 · T010 |
| 预热 | FR-025 – FR-027 | T007 · T010 |
| 列改版 | FR-030 – FR-034 | T004 · T009 |
| 判据单点 | FR-035 | T005（否定式：判据只有一份实现） |
| 真机验收 | FR-036 | T013 |
| 跨片不变量遵从 | FR-040 – FR-045 | **故意零新测试，见下** |

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

| 事项 | 为什么故意不产 task |
| --- | --- |
| `FR-040` – `FR-045`（跨片不变量继承） | 本片**零改动**条款，覆盖是**否定式核实**而非新测试，且**判据已逐条写进对应 task 的 verify**（不是只在本表声称）：`FR-043` → T005 `git diff anchor.rules.ts intent-matrix.rules.ts` 零行 · `FR-044` → T005 `git diff leg-recall.rules.ts` 零行 · `FR-045` → T009 `git diff leg-criteria*` 零行 · `FR-042` → T006 `openapi.json` 内 `rg 'RankingFeatures'` 零命中。⚠️ **`FR-040` / `FR-041` 无「零改动文件」可锚**：`FR-040`（截断在排序之后）由 T005 的「截断掉的必是排序尾部」正面承接；`FR-041`（`tier` 跟视角走）由 T003 的收窄天然承接（`tier` 收窄成标量、值仍由服务端按视角算）—— **两者无独立断言，如实登记，不声称有** |
| spec § Out of Scope 的「`活跃` 列装不下自己的值」 | **登记不改**（Surgical Edits）—— 属 047 期问题，与本片列改版正交（本片既不改该列宽也不改其数据源） |
| 排序 / 截断下沉 SQL 的等价 IT | 本片**不下沉**（`D-SQL-1`）⇒ 判据只有一份实现，等价性无从谈起。`052` 的 port 守门判据使下沉方案当场撞红 |
| 抽屉内部 / 三支空态 | `052` T012 已 ship，本片零改动 |
| 截断产生第四种空态 | **不存在** —— 截断只在 `matchedCount > limit` 时发生，此时列表必非空 |

## MVP

**Phase 1 + Phase 2（T001–T006）** —— 交付「每视角独立作答 + 响应收窄 + 服务端截断」这一条，server 侧独立可验、独立有价值。它是本片架构投资的落点；其余是在它之上的客户端消费与体验。

## 单 PR（Constitution §V）

本片跨端 ⇒ server impl + 真后端 IT + `export-openapi` + `api-client` regen + mobile 消费 + 两层验证**全部同 PR 原子 merge**。

🚨 **PR body MUST 复述三件**（`SC-011` + spec § 背景）：① 拆请求的**正当性前提**（为将来的多路召回 / 每视角不同数据源留接口，非解当前瓶颈）与它的四条代价；② 对 047「no pagination, no top-N」的 **supersede**；③ 对 047「切 Tab 不重新请求」的**作废**。
