# Specification Analysis Report — 083-optionsdesk-trading-account-positions

> 2026-09-15 `/speckit-analyze`。只读：本报告不改 spec / plan / tasks。
> 方法：① 机器核对（编号覆盖、覆盖表行数、既有路径 / nx target / 符号存在性、行号抽查）② 本地定向 grep（Clarifications 是否有 FR 承接、既有测试是否与新增文案冲突）③ 独立上下文的只读评审子 agent 做语义交叉比对（作者本人通读有盲区，per `.claude/rules/sdd-authoring.md` 反模式）。评审子 agent 的断言中会改变结论的两条已由主线程复核。

## 扫描层 vs spec 层（先答「值域够不够得到需求所在的层」）

| spec 层 | 是否扫描 | 方式 |
|---|---|---|
| frontmatter `state_branches`（42） | ✅ | 脚本：任务头引用 + 覆盖表行序 |
| User Scenarios 验收场景（22） | ✅ | 脚本：覆盖表行数；子 agent 语义核对 |
| Functional Requirements（21） | ✅ | 脚本 + 语义 |
| Success Criteria（10） | ✅ | 脚本 + 语义 |
| Edge Cases（11） | ✅ | 脚本 + 语义 |
| Clarifications（3 个 Session） | ✅ | grep「决定是否有 FR 承接」 |
| Assumptions / Key Entities | ✅（轻） | 语义通读 |

差集：无。

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|---|---|---|---|---|---|
| H1 | Underspecification | HIGH | spec FR-010；plan D14；tasks T012-④、T013、T015-⑨ | 「已有数据时重读失败」的视图未定义。T012-④ 规定请求失败即使有旧数据也显示错误卡；页面进入 / 回前台 / 下拉都会自动重读，网络一抖就把已显示列表换成错误卡。详情页同理：只测了首次加载 404，没测「已显示数据、重读得到 404」（FR-020 原意正是这个转换） | spec 新增 FR：首次加载失败 ⇒ 错误卡 + 重试；已有数据时重读失败 ⇒ 保留数据 + 轻提示；详情 404 优先于旧数据。改 T012-④，T013 / T015 各补一臂 |
| H2 | Coverage Gap | HIGH | spec FR-008；plan D15；tasks T015、T016 | FR-008 要求下钻页支持下拉重读，T015 无验证臂、T016 正文未提；详情页 500 / 断网时显示什么三份文档都没定义 | spec 补详情页加载失败状态；T015 / T016 各加「下拉重读」与「加载失败 + 重试」臂 |
| H3 | Inconsistency | HIGH | tasks T015 正文与臂 ②；plan D10；tasks T002；spec FR-013 | T015 要显示批次「剩余 / 原始数量」，但批次输出（D10 / T002）没有原始数量字段，FR-013 也只要求剩余数量 | D10 / T002 输出加 `originalQty`（mockup 已按此画），FR-013 同步补上 |
| H4 | Underspecification | HIGH | plan D8、D9、D11；tasks T006、T007、T012 | 持仓详情与订单详情响应不带 `market`。FR-017 要求时间 MUST 标注时区，`marketTzLabel(market)` 需要它；深链直接进入详情时 mobile 拿不到市场 | D8 行字段、D9 / D11 响应加 `market`；T006 / T007 加断言臂，T016 用它渲染时区标签 |
| H5 | Logic Gap | HIGH | spec FR-009、state_branches 6 / 7；plan D7；tasks T003 | 陈旧判据只看「今天的时点」：昨天对账已失败（数据已旧两天）、今天刚过时点仍在 1 小时宽限内 ⇒ 判为不陈旧 | 判据改为「最近成功同步早于**最近一个已过宽限**的对账时点」（今天未过宽限时取上一交易日时点）；改 FR-009 与 branch 6 / 7 措辞，T003 加臂「昨天未成功 + 今天宽限内 ⇒ 陈旧」 |
| H6 | Contract Violation | HIGH | plan D7；tasks T003-⑤ | `previousTradingDay` 返回 null 时回落前一个日历日，违反端口契约「`null` = 不可判定，调用方 MUST NOT 猜」（`marketdata/trading-calendar.port.ts:52-69`；同文件 `lastClosedSession` 注释亦写明 MUST NOT 拿不可信基准日判陈旧） | null ⇒ 陈旧「不可判定」，需维护者定对外表现（见 Next Actions Q1）；T003-⑤ 改为该口径 |
| H7 | Hidden Regression | HIGH | tasks T012、plan D17；既有 `apps/mobile/src/optionsdesk/trading-account.rules.spec.ts:46-50` | 081 测试断言 `tradingAccount` 文案段**全部**字符串不含「暂无 / 空仓 / 无数据」；T012 往同一段加「暂无交易账户」「暂无持仓」⇒ 该测试必红，实现者可能为过测试删掉它 | 新文案放独立段（如 `tradingAccountPositions`），081 占位的禁词不变量保持；D17 / T012 写明路径，并在 T012 verify 里要求 081 该测试不改一行仍绿 |
| M1 | Coverage Gap | MEDIUM | spec Clarifications（mockup Session）；tasks T011、T014；plan D14 | 「万」缩写只写在 Clarifications，没有 FR 承接（T011 引用的 FR-007 原文无此条）；plan 自加的「亿」档、只作用于主列表、详情页全精度在 spec 均无 | spec 新增 FR-022 写明缩写规则与适用范围；T011 / T014 改引 FR-022 |
| M2 | Inconsistency | MEDIUM | spec US1-AS6 vs FR-009 | AS6 写「最近一次同步失败 ⇒ 提示陈旧」，FR-009 有 1 小时宽限，宽限内不标陈旧 | AS6 改为「满足 FR-009 陈旧条件时提示」 |
| M3 | Terminology / Logic | MEDIUM | spec FR-003、FR-012、branch 20 / 21；plan D2、D8 | 「券商」与「券商连接」混用：`brokerCount` 是连接数，券商标却显示 `brokerCode`；同一券商两个连接时两行标签完全相同，无法区分 | spec 统一术语；券商标内容需维护者定（见 Next Actions Q2） |
| M4 | Underspecification | MEDIUM | spec FR-016、US3-AS1、branch 25 / 35；plan D9；spec FR-014 | ① 订单列表过滤键（plan 按 `vendorUpdatedAt`，依据 V2）没写进 spec，FR-016 读起来像按下单时间 ② 「当前持仓周期」两套定义：FR-014 按成交累计归零划分，FR-016 按开仓时间过滤；开仓时间为回落值时两者不一致 | FR-016 写明「订单最后更新时间 ≥ 开仓时间」；FR-013 / FR-016 的「当前持仓周期」统一指向一个定义并注明回落时的口径 |
| M5 | Inconsistency | MEDIUM | spec FR-010、branch 3；plan D14 | 「暂无持仓」口径：spec 是「最近一次成功同步结果为空」，plan 是「过滤后无可展示行」（全是非锚 / 未归类持仓也显示「暂无持仓」）；此时未归类提示显示与否未定义 | spec 改为「无可展示的锚标的持仓」，并写明空态下未归类条数 > 0 仍显示提示 |
| M6 | Underspecification | MEDIUM | plan D1、D9、D11、D15、D16 | plan 引入 spec 没写的用户可见行为：「订单不存在」卡；非锚 / 未归类持仓详情返回 404；冷启动页券商历史请求失败时隐藏整行；D1 声称按 id 读的两个接口「不存在 / 他人 / 不在锚集」响应相同，但订单详情是否按锚集过滤未定义 | spec 补：FR-020 扩到订单；新增「冷启动券商历史请求失败只隐藏该行」；D11 明确订单详情按订单正股适用同一锚集规则（或明确不过滤并删掉 D1 的「三种情况」说法） |
| M7 | Constitution §III（粒度） | MEDIUM | tasks T005、T013、T015 | 三个 task 明显超过 30min–2h：T005（controller + DTO + 模块 + 用例 8 步 + 13 臂 IT）、T013（两个 hook + 屏改造 + 新 e2e 9 臂）、T015（路由 + layout + 三段屏 + 10 臂） | 各拆两个：T005 → 端点骨架与列表主体 / 同步时刻与陈旧；T013 → 数据与重读 hook / 状态卡渲染；T015 → 路由与汇总 + 订单段 / 批次段 |
| M8 | Wrong Reference | MEDIUM | tasks T020 | 引用 `docs/runbook/local-dev.md` 不存在，实际为 `ops/runbook/local-dev.md` | 改路径 |
| M9 | Consistency | MEDIUM | spec FR-013 vs plan D10 / tasks T002-① | FR-013 写「成本 = 开仓订单成交均价」，D10 用周期内该订单成交的数量加权均价；订单成交跨越反手时两者不同 | FR-013 措辞改为「该批次成交的数量加权均价」（常规情况下等于订单成交均价） |
| L1 | Test Quality | LOW | spec SC-004；tasks T015-⑥、T016-③ | 「恰 2 次点击」由测试脚本自己点出，近乎同义反复；「期权行 → 本合约订单 → 订单详情」路径未覆盖 | 保留现臂，补一条期权行经本合约订单进入订单详情的臂 |
| L2 | Coverage Depth | LOW | tasks T005（branch 20） | 映射了 branch 20（单连接不显示券商标），IT 只测 `brokerCount=2` | T005-⑧ 补 `brokerCount=1` 一例 |
| L3 | Ambiguity | LOW | spec FR-004、branch 13 | 「离开页面」未定义：进详情再返回（列表屏未卸载）算不算离开，决定折叠状态是否保留 | spec 写明「离开交易账户页」（进详情再返回保留折叠态） |
| L4 | Wrong Reference | LOW | plan「Dependencies」段 | `watchlist-main-screen.tsx:64-67` 缺目录，实际在 `apps/mobile/src/portfolio/` | 补全路径 |
| L5 | Underspecification | LOW | plan Guardrail 2；tasks T005 | `AuthenticatedUser` 仓内有两份（`account/jwt-auth.guard.ts:6`、`auth/jwt-access.guard.ts:4`），optionsdesk 用的是 `account/` 的 guard | T005 写明从 `account/jwt-auth.guard.ts` import |
| L6 | Resolved（待确认已核实） | LOW | spec US1-AS3；plan D6 | 空头持仓市值为负是否有出处：POC-1 私有样本空头持仓市值全部为负（维护者 2026-09-13 采集），与 mockup / spec 一致 | 无需改动；T005 注释可按定性 + 私有证据路径写 `EVIDENCE:` |

## Coverage Summary

| Requirement | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-001 | ✅ | T001, T005, T006, T018 | |
| FR-002 | ✅ | T005, T006, T007, T008, T019 | M6：订单详情是否按锚集过滤待定 |
| FR-003 | ✅ | T001, T005 | M3 术语 |
| FR-004 | ✅ | T001, T012, T014 | L3 |
| FR-005 | ✅ | T001 | |
| FR-006 | ✅ | T001 | |
| FR-007 | ✅ | T005, T011, T012, T014 | M1：缩写规则无 FR |
| FR-008 | ⚠️ | T005, T009, T013, T020 | H2：下钻页重读无验证 |
| FR-009 | ✅ | T003, T005, T013 | H5 / H6 判据问题 |
| FR-010 | ⚠️ | T005, T012, T013 | H1 / M5 |
| FR-011 | ✅ | T001, T005, T013 | |
| FR-012 | ✅ | T005, T012, T014 | M3 |
| FR-013 | ✅ | T002, T006, T015 | H3 / M9 |
| FR-014 | ✅ | T002, T015 | M4 |
| FR-015 | ✅ | T002, T006, T015 | |
| FR-016 | ✅ | T006, T015 | M4 |
| FR-017 | ⚠️ | T004, T007, T012, T016 | H4：详情缺 `market` |
| FR-018 | ✅ | T008, T017 | |
| FR-019 | ✅ | T016 | |
| FR-020 | ⚠️ | T006, T015 | H1 / M6 |
| FR-021 | ✅ | T001, T005, T014 | |
| SC-001 | ✅ | T022 | 上线后人工 |
| SC-002 | ✅ | T001, T014 | |
| SC-003 | ✅ | T002, T022 | |
| SC-004 | ✅ | T015, T016 | L1 |
| SC-005 | ✅ | T020, T022 | 真机计时 |
| SC-006 | ✅ | T005, T006, T007, T008 | |
| SC-007 | ✅ | T003, T005, T013 | |
| SC-008 | ✅ | T022 | 上线后人工 |
| SC-009 | ✅ | T008, T017 | |
| SC-010 | ✅ | T021 | |

## Constitution Alignment

- **§I SDD / §II TDD / §IV 边界 / §V 类型同步链**：无违背。§V 两层验证（hermetic e2e T013–T017 + 契约冒烟 T019）齐全。
- **§III 粒度**：M7（三个 task 超出 30min–2h）。非 NON-NEGOTIABLE 原则，按 MEDIUM 处理，但建议 implement 前拆分。

## Unmapped Tasks

无（22 个 task 均映射到 FR / SC / US；T009 / T010 / T018–T022 映射到 Constitution §V、plan Gate 与 SC）。

## Metrics

- Total Requirements：31（FR 21 + SC 10）
- Total Tasks：22
- Coverage：100%（每条 FR / SC ≥ 1 个 task）；其中 4 条 FR 覆盖有缺口（⚠️）
- Ambiguity Count：2（L3、M5）
- Duplication Count：0
- Critical Issues Count：0
- 按严重度：HIGH 7 · MEDIUM 9 · LOW 6（L6 为已核实关闭项）
- 机器核对：state_branches 42 / FR 21 / SC 10 任务头全引用；覆盖表行数与 spec 一致（42 / 21 / 10 / 11 / 22）；plan / tasks 引用的既有路径仅 M8、L4 两处有误；nx target（`server:export-openapi` / `runtime-smoke`、`mobile:e2e` / `e2e-public` / `contract-smoke` / `runtime-smoke` / `typecheck`）与治理脚本路径均存在；子 agent 抽查 11 处行号引用全部属实

## Next Actions

无 CRITICAL，但 **7 条 HIGH 建议全部在 `/speckit-implement` 前修掉**：其中 H5 / H6 会让陈旧提示静默判错，H7 会在第一个 mobile task 撞红既有测试，H1 会在网络抖动时把用户正在看的列表换成错误卡。

需要维护者先定的三点（其余按 Recommendation 直接改）：

- **Q1（H6）交易日历判定不了上一交易日时，陈旧提示怎么表现**：A. 不标陈旧（避免误报，记 warn 日志）· B. 标陈旧（宁可误报）· C. 显示「无法判断数据是否最新」
- **Q2（M3）同一券商有两个连接时，券商标显示什么**：A. 连接的人读标签（082 连接行已有 `label`）· B. 券商名 + 手机尾号 · C. 只按券商去重计数，同券商多连接不显示标签
- **Q3（H1）已有数据时重读失败怎么提示**：A. 保留列表，在同步时刻行位置显示一行「刷新失败，显示的是上次加载的数据」· B. 保留列表，弹一次性 toast · C. 保留列表，不提示

修复落点：spec（FR-008 / FR-009 / FR-010 / FR-013 / FR-016 / FR-020 措辞 + 新增 FR-022 与重读失败 FR + US1-AS6 + branch 6 / 7 / 20 / 25）→ plan（D1 / D7 / D8 / D9 / D10 / D11 / D14 / D15 / D17 + 两处路径）→ tasks（拆 T005 / T013 / T015，改 T003 / T012 / T020，补 T005 / T006 / T007 / T015 / T016 臂，重排编号与覆盖表），改完复跑 `/speckit-analyze`。

## 修订后复核（2026-09-15）

> 上表的 task 编号是修订**前**的编号，已失效；修订后以 `tasks.md` 为准（25 个 task）。

**维护者决定**：Q1 = A（日历不可判定 ⇒ 不标陈旧 + 告警日志）· Q2 = A（标签显示连接名称）· Q3 = A（保留列表，同步时刻行显示「刷新失败，显示的是上次加载的数据」）。

**修订**：spec 新增 FR-022（万缩写）/ FR-023（重读失败保留数据）、branch 43–47、3 条 Edge Case、US1-AS10，改写 FR-001 / 003 / 004 / 006 / 007 / 009 / 010 / 012 / 013 / 016 / 018 / 020、SC-007、branch 3 / 4 / 6 / 7 / 13 / 20 / 21 / 25 / 34 / 35 / 39 / 40、US1-AS6 / US2-AS7 / US3-AS1；plan 改 D1 / D2 / D4 / D7 / D8 / D9 / D10 / D11 / D14 / D15 / D17、反例臂、Guardrail 与测试映射；tasks 重排为 25 个（原 T005 / T013 / T015 各拆两个，订单详情提到批次段之前）。

**复核方式**：① 独立上下文只读子 agent 逐条核对 22 条发现 ⇒ 19 条已消解、3 条部分（H2 订单详情重读臂 · M4 branch 25 / 34 与 US2-AS7 仍写「当前持仓周期」· L3 FR-004 旧措辞），并报 8 条修订引入的问题（依赖倒置：批次段先于订单详情路由 · 订单详情缺 FR-023 臂 · plan 陈旧夹逼臂旧判据 · 兜底排序键三处不一 · T020 依赖不全 · MVP 路径与依赖图冲突 · plan E2E 映射漏 5 条 · T016 聚焦臂测不到聚焦）⇒ 全部已修 ② 主线程脚本复核（修完之后）：47 条 `state_branches` / 23 条 FR / 10 条 SC 均被任务头引用；五张覆盖表行数 = spec（47 / 23 / 10 / 14 / 23）；覆盖表内全部「T0xx-臂」引用在对应 task 行真实存在（悬空 0）；plan 测试映射覆盖 1–47；散文无未编号 MUST；三份文件无裸下划线字段名、无真实合约代码；`check-spec-frontmatters` 通过。

**结论**：CRITICAL 0 · 未消解 HIGH 0 · 未消解 MEDIUM 0。可进入 `/speckit-implement`（analyze → implement 为人工审批卡点）。
