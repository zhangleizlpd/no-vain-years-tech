# Specification Analysis Report: 082-optionsdesk-broker-pull-sync

> `/speckit-analyze` 产出（2026-09-14）。**只读**：未修改 spec / plan / tasks；本文件是报告本身。
> 覆盖检查一律逐条 grep / 脚本对账，不靠通读（`.claude/rules/sdd-authoring.md` § 反模式）。

## 扫描面声明（先列层，再扫）

| spec / plan 的层 | 扫了吗 | 方式 |
|---|---|---|
| `state_branches`（31） | ✅ | 脚本：tasks 覆盖表逐行同序 + 引用的测试点在对应 task 内存在 |
| Edge Cases（13） | ✅ | 脚本：行数对齐 + 落点人工核 |
| Functional Requirements（19） | ✅ | 脚本：编号集合相等 |
| Success Criteria（10） | ✅ | 脚本：编号集合相等 |
| Acceptance Scenarios（15） | ✅ | 脚本：行数对齐（标准矩阵够不到这一层，单列） |
| Clarifications（5 条答案） | ✅ | 人工逐条追到 FR 与 task 测试点 |
| Assumptions | ✅ | 人工逐条：一次性动作 / 快照 / 范围切换 / 删锚 / 选户 |
| plan D1–D15 决策 | ✅ | 人工逐条追到 task |
| plan 反例臂（7 条） | ✅ | 人工逐条追到 task 测试点 |
| Key Entities | ⏭️ 蓄意不单扫 | 由 plan D7 → T010 承接；字段级 SoT 在 `schema.prisma`，spec 只写意图 |

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| U1 | Underspecification | **HIGH** | plan.md:175, plan.md:185; tasks.md:102（T016） | **调度器重入会产生重复对账**。cron 4.4.0 在 `waitForCompletion` 为假时每拍照常触发，不等上一拍的 Promise（`node_modules/.pnpm/cron@4.4.0/.../dist/job.js:121-133`；构造默认 `false` `:27`）。`@nestjs/schedule` 6.1.3 原样透传装饰器选项（`scheduler.orchestrator.js:56-60`）。补齐一次约 74 s（POC-8）＞ 心跳间隔 60 s ⇒ 两拍并发，两次都判定「本交易日未成功」并各插一条 `running` 对账记录 ⇒ 违反 SC-004「恰有 1 条成功对账」，且同一 use case 并发写同一连接。仓内无任何调度器防重入先例（grep `inFlight\|isRunning\|重入` 零命中于调度器）。T016-② 只覆盖补齐认领的并发，不覆盖对账 | ① `@Cron('0 * * * * *', { timeZone: 'Asia/Shanghai', waitForCompletion: true })` ② 数据层兜底：同步记录加部分唯一索引 `(connection_id, market, trading_date) WHERE kind='reconcile' AND status IN ('running','succeeded')`（`schema.prisma:4` 已开 `partialIndexes`），插入冲突即视为本拍跳过 ③ T016 加臂：09:10 ET 两个 `run` 并发 ⇒ 对账记录恰 1 条；plan D9 同步改写「不加锁」那句的理由 |
| U2 | Underspecification | **HIGH** | tasks.md:110（T019）；spec.md:177（SC-010） | **SC-010 的仓内检查恒绿**。T019 用 `[0-9]{16}` grep 完整账户号，但 POC-1 原始输出里富途 `acc_id` 实测为 **8 位与 18 位**，没有 16 位 ⇒ 真实账户号就算泄漏进仓也匹配不到。`check-identifier-boundary.ts` 同样只抓 16 位（master §5-2 已记「兜不住」） | T019 / T020-⑧ 改为**运行时取真值比对**：本机脚本从 `docs/private/evidence/broker-account-poc/` 读出账户号集合，在仓库工作树、fixture、测试快照中逐值搜索，**只打印命中计数**，真值不落任何文件、命令行参数与日志；判据 = 计数 0。两臂对照：先在临时文件里放一个真值确认计数为 1，再删 |
| I1 | Inconsistency | MEDIUM | tasks.md:112（T020-⑦）；master §4 POC-7 判据变更记录 | **SC-009 上线对比口径与 POC-7 判据不一致**。T020-⑦ 拿「含港股盘中时段」的延迟中位与 POC-7 **休市**基线 30.5 ms 比，负载本身就会抬高延迟 ⇒ 会把正常的盘中负载误判成「交易连接拖慢行情」。POC-7 冻结的判据是「延迟对比两侧都取休市时段；负载时段只判零新增错误」 | T020-⑦ 拆两段：休市时段中位与 30.5 ms 比（< 10%）；盘中 / 批处理时段只判 journal 零新增 error（逐条归因） |
| C1 | Coverage Gap | MEDIUM | spec.md:143（FR-009 括注）；tasks.md:98（T015-⑦）、tasks.md:96（T014-⑧） | FR-009「**范围为全部标的时刷新全部市场**」没有测试点。T015-⑦ 只断言单只标的所属市场的持仓进库；T014-⑧ 的 `target='*'` 只测成交与订单 | T015 加臂：`target='*'` 补齐成功后美股、港股两个市场的持仓都被刷新 |
| U3 | Underspecification | MEDIUM | tasks.md:96（T014 订单写入） | T014 的订单写法「不存在则插，存在则 `updateMany`」是**先查后写**，并发执行时（U1 场景，或补齐与对账同时写同一连接）会撞唯一约束抛 `P2002`，被当成基础设施失败进入重试。与 plan Guardrail 7 / Microsoft Learn Idempotent Consumer「用冲突即忽略的原子写替代先查后写」相悖 | 改为两步原子写：先 `createMany({ skipDuplicates })` 插入，再对全部入参执行带 `vendorUpdatedAt < incoming` 条件的 `updateMany`；T014 加臂：两个 use case 并发写同一批订单 ⇒ 无异常、结果为最新版本 |
| K1 | Constitution（§III 粒度） | MEDIUM | tasks.md:102（T016） | T016 含调度器全部实现 + **16 个测试点**，明显超出「30min–2h 单 commit」粒度（§III 非 NON-NEGOTIABLE，但 clear 批次也因此失衡） | 拆成两个 task：T016a 补齐认领与结局（①–⑥、⑮）；T016b 对账编排（⑦–⑭、⑯）+ U1 的并发臂 |
| I2 | Inconsistency | LOW | spec.md:148（FR-014） | FR-014 字面「持仓集合 = 券商本次报告的持仓集合」没带范围过滤；而 Edge Case「锚被删除 ⇒ 持仓随范围移除」与 plan D8 都以「过滤后的集合」为准。按字面实现会保留非锚标的持仓 | FR-014 改为「= 券商本次报告并经 FR-005 范围过滤后的持仓集合」 |
| I3 | Inconsistency | LOW | spec.md:168（SC-001）、spec.md:182（Assumptions）；plan.md:219（D15） | 一次性回填的时机措辞不一致：spec 写「上线**前**」，plan D15 / T020 写「发版**后**、首个交易日对账前」。后者才正确 —— 待执行记录要靠已上线的调度器认领 | spec 两处改为「上线时（发版后、首个交易日对账前）」 |
| G1 | Coverage Gap | LOW | plan.md:201（D12）；tasks.md T001 / T002 / T015 | D12「shim 与 server 日志不含账户号」无测试点。T001-④ 只断言响应行不含 `acc_id`，没断言日志 | T002 加臂：错误路径（409 / 503 / 429）日志不含账户号；T015 的 warn / error 日志断言不含连接末 4 位以外的账户数字 |
| G2 | Coverage Gap | LOW | preset `tasks-template.md` T003（Verify Backend Physics） | 模板要求的 server 真启动冒烟未列 task。Gate 0.1 已论证「零新 endpoint」，且 066–078 同类 spec 均未列、CI 也不跑 `server-boot-smoke`；但本片新增 `AppModule` 级装配（`validate-config` 的配置项、`ScheduleModule` 下的新 cron、按 `marketdata.kind` 绑定 port），模块级 IT 覆盖不到 `AppModule` 启动 | T019 加一步本地 `pnpm tsx scripts/ci/server-boot-smoke.ts` exit 0（live 与 mock 各一次） |

**Duplication**：0。**Ambiguity**（模糊形容词 / 占位符）：0 —— SC-009 的「短暂卡顿」已由「中位数」口径量化。

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-001 每行直接记归属账号 | ✅ | T010, T014 | |
| FR-002 只存所属账号手机号后四位（2026-09-14 amend，原「末 4 位」） | ✅ | T001, T002, T012, T019, T020 | 验证管道见 U2 |
| FR-003 选户规则 | ✅ | T001, T002, T012 | |
| FR-004 只读 | ✅ | T003 | sabotage 臂 |
| FR-005 范围开关 | ✅ | T006, T011, T014 | |
| FR-006 正股判定 | ✅ | T005, T013, T014 | |
| FR-007 组合单按腿 | ✅ | T005, T013, T014 | |
| FR-008 交易所时区 | ✅ | T004, T012 | |
| FR-009 补齐覆盖 / 触发 / 重试上限 / 刷新持仓 | ⚠️ | T009, T014, T015, T016, T017 | 「全部标的刷新全部市场」缺臂（C1） |
| FR-010 开盘前对账调度 | ⚠️ | T004, T009, T016, T022 | 重入未覆盖（U1） |
| FR-011 对账区间与留痕 | ✅ | T009, T015, T016 | |
| FR-012 唯一号幂等 | ✅ | T010, T014 | |
| FR-013 订单守卫 | ⚠️ | T010, T014 | 写法先查后写（U3） |
| FR-014 持仓集合替换 | ✅ | T008, T015 | 措辞见 I2 |
| FR-015 失败不改数据 | ✅ | T015 | |
| FR-016 开仓时间 | ✅ | T007, T015 | |
| FR-017 同步记录 / 不主动通知 | ✅ | T010, T015, T016 | |
| FR-018 开发环境跳过 | ✅ | T012, T016, T017 | |
| FR-019 不降低行情服务 | ✅ | T001, T002, T020 | 上线对比口径见 I1 |
| SC-001 | ✅ | T020 | 上线后人工比对 |
| SC-002 | ✅ | T016, T017, T021 | |
| SC-003 | ✅ | T014 | |
| SC-004 | ⚠️ | T016, T021 | 重入会破坏「恰 1 条」（U1） |
| SC-005 | ✅ | T015 | |
| SC-006 | ✅ | T007, T015, T020 | |
| SC-007 | ✅ | T015, T021 | |
| SC-008 | ✅ | T013, T020 | |
| SC-009 | ⚠️ | T001, T020 | 对比口径（I1） |
| SC-010 | ⚠️ | T001, T012, T019, T020 | 检查恒绿（U2） |

**Clarifications → 落点**：Q1 对账重试 → FR-010 / T009-⑤⑥ / T016-⑫ ✅ · Q2 对账区间 → FR-011 / T009-⑦⑧⑨ / T016-⑬ ✅ · Q3 补齐后刷新持仓 → FR-009 / T015-⑦ ✅（全部市场分支见 C1）· Q4 不主动通知 → FR-017 / T015-⑧ ✅ · Q5 补齐重试上限 → FR-009 / T009-⑩⑪ / T016-④⑤ ✅

**plan D1–D15 → 落点**：D1 T014/T015 · D2 T001/T002/T003 · D3 T012 · D4 T004 · D5 T005/T013 · D6 T006 · D7 T010 · D8 T007/T008/T015 · D9 T009/T016（U1）· D10 T017 · D11 T011 · D12 **部分**（G1）· D13 T001/T020 · D14 T010/T018 · D15 T020。

**plan 反例臂 → 落点**：FIFO 反例 T007-① · 重放幂等 T014-⑥ / T017-②③ · 对账补缺对照 T015-⑧ · 同秒不同毫秒 T014-⑦ · 失败不清空从有数据起步 T015-① · AST 守卫 sabotage T003 · 重试上限两侧夹逼 T009-⑩⑪ / T016-④⑤ —— 7 / 7 ✅。

**Assumptions → 落点**：上线一次性回填 T020 ✅ · 不做每日快照（蓄意无 task）· 范围切到全量后维护者执行一次全部标的补齐（一次性动作，蓄意无 task）· 删锚后历史保留（Edge Case 轻验）· 选户命中多于 1 个判失败 T001-③ ✅。

## Constitution Alignment Issues

无 CRITICAL。§I SDD 步序完整；§II 每 task 红→绿闭环且关键判据有定向变异；§IV 扁平 / 贫血 / 护城河（跨 ctx 只读、`CROSS-CONTEXT-READ` 在 T013）；§V 无契约变更。§III 粒度问题见 K1（MEDIUM）。Quality Gates：T019 不接 auto-merge，理由（不可逆迁移 + shim 合入即部署交易主机）符合 git-workflow 例外。

## Unmapped Tasks

无。T018 承接 plan Gate 0.4（ADR-0062 sunset #4）；T022 承接 FR-010 的 POC-6 参数复核。

## Metrics

- Total Requirements：29（FR 19 + SC 10）
- Total Tasks：22
- Coverage：100%（29 / 29 至少 1 个 task；其中 6 项有 ⚠️ 质量问题）
- Ambiguity Count：0
- Duplication Count：0
- Critical Issues：0 · High：2（U1, U2）· Medium：4（I1, C1, U3, K1）· Low：4（I2, I3, G1, G2）

## Next Actions

- **U1、U2 建议在 `/speckit-implement` 前修掉**：U1 是调度器设计缺陷（改 plan D9 / D7 + tasks T010 / T016），U2 是 SC-010 的验证管道看不见反例（改 T019 / T020）。
- MEDIUM 四项同批修更省：I1 改 T020-⑦；C1 给 T015 加臂；U3 改 T014 写法与加臂；K1 拆 T016。
- LOW 四项可随手修：I2、I3 是 spec 措辞；G1、G2 是 T002 / T015 / T019 加检查。
- 修完重跑 `/speckit-analyze` 复核。

## 修复记录（2026-09-14，user 批准「都修」）

| ID | 改在哪 | 复核 |
|---|---|---|
| U1 | spec：FR-010 补「同一市场同一交易日至多一条进行中的对账」+ 新增 `state_branches` 第 24 行（共 32 行）· plan：D9 防重入两层（`waitForCompletion: true` + 部分唯一索引）、卡死回收区分补齐 / 对账、D4 cron 字面量、D7 部分唯一索引、反例臂「并发直调」· tasks：T010 建索引、T016-⑨ 断言 cron 选项、T017-⑤ 两个 `run()` 并发直调恰 1 条 | ✅ |
| U2 | tasks：T020 改为运行时读 POC 原始输出里的真值、逐值子串搜索仓库文件、只打印计数，两臂对照（scratchpad 放真值 ⇒ 1，仓库 ⇒ 0）；T021-⑧ prod 面经 stdin 传远端比对 | ✅ |
| I1 | plan：D13 写明对比口径同 POC-7 判据 · tasks：T021-⑦ 休市比延迟、盘中与批处理只判零新增错误 | ✅ |
| C1 | tasks：T015-⑩（`target='*'` 刷新美股、港股两个市场）+ 定向变异 b | ✅ |
| U3 | plan：D7 订单两步原子写 · tasks：T014 写法改为先 `createMany({ skipDuplicates })` 再条件 `updateMany`，加并发臂 ⑪ 与变异 c | ✅ |
| K1 | tasks：原 T016 拆为 T016（心跳骨架 + 补齐认领）与 T017（对账编排 + 数据层防重入），其后顺延为 T018–T023 | ✅ |
| I2 | spec：FR-014 改为「经 FR-005 范围过滤后的持仓集合」· tasks：T006 / T008 标注 FR-014 | ✅ |
| I3 | spec：SC-001 与 Assumptions 改为「上线时（发版后、首个交易日对账前）」· plan：D15 标题同步 | ✅ |
| G1 | plan：D12 注明日志断言归属 · tasks：T002-⑨（shim 三条错误路径日志不含账户号）、T015-⑪（server 日志） | ✅ |
| G2 | plan：Gate 0.1 补本地启动冒烟 · tasks：T020 跑 `scripts/ci/server-boot-smoke.ts`（mock / live 各一次） | ✅ |

**复核结果（脚本对账）**：tasks 23 个、编号连续、层级标签合规；覆盖表引用的测试点在对应 task 内全部存在；`state_branches` 覆盖表 32 行与 spec 逐行同序（抽查第 24 / 25 / 30 / 31 / 32 行关键词两侧一致）；FR 19、SC 10、AS 15、EC 13 与 spec 相等；spec frontmatter 校验通过、FR / SC 行外 `MUST` 为 0、FR 引用全部存在；spec 与 plan 旧措辞零残留；tasks prettier 试跑仅排版变化。复核中顺带发现 T010 一行含两个裸下划线标识符，已把 `snake_case` 包 backtick。

**修复后 Metrics**：Total Requirements 29 · Total Tasks 23 · Coverage 100% · Critical 0 · High 0 · Medium 0 · Low 0。
