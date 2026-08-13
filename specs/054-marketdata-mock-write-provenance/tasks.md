---
feature_id: 054-marketdata-mock-write-provenance
spec_ref: ./spec.md
plan_ref: ./plan.md
status: drafted
created_at: '2026-08-13'
updated_at: '2026-08-13'
---

# Tasks: 054-marketdata-mock-write-provenance（mock 行情写入留痕 —— 假数据不得与真行情同形落进真表）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **架构 canonical**: [`ADR-0047`](../../docs/adr/0047-marketdata-pluggable-data-access.md)（本片 amend 其 § 2 绑定表）
**Branch**: `054-marketdata-mock-write-provenance`
**问题陈述**: `docs/private/plans/2026-08/08-13-mock-writer-gap-problem-statement.md`（本机私有；2026-08-13 由 052 T016 标定期实撞得出）

## Format

`- [ ] TNNN [P?] [层级] **标题**（FR-xxx, plan D-xxx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）。
- **测试不独立成 task** —— 每个 impl task 的 `→ verify:` 就是它的验收，红→绿在同一个 task 内闭环。
- 层级：`[Server]` / `[Docs]`。本片**零 mobile、零 endpoint、零 DTO** ⇒ 无 `[Contract]` / `[Mobile]` / `[Contract-Smoke]`，也无 `export-openapi` regen。

## Path Conventions

| 用途                              | 路径                                                                   |
| --------------------------------- | ---------------------------------------------------------------------- |
| 拒绝式采集 adapter（本片新建）    | `apps/server/src/marketdata/refusing-collection.adapter.ts`            |
| mock adapter（收窄 `implements`） | `apps/server/src/marketdata/mock-market-data.adapter.ts`               |
| DI 绑定（31 个 `useFactory`）     | `apps/server/src/marketdata/marketdata.module.ts`                      |
| provider 配置                     | `apps/server/src/config/marketdata.config.ts`                          |
| 容器 env 映射                     | `docker-compose.tight.yml`（`:170`）                                   |
| 既有 boot IT（本片的红点）        | `apps/server/test/integration/marketdata.boot-015.it.spec.ts`          |
| 新增写手 IT                       | `apps/server/src/marketdata/option-snapshot-remediation.it.spec.ts`    |
| 新增「零写库」IT                  | `apps/server/test/integration/marketdata-054.mock-no-write.it.spec.ts` |

🚨 **文件平铺**（ADR-0043）—— **MUST NOT** 为「采集口 / 读取口」这个分类建任何子目录。分类活在类型与命名里，不活在目录里。

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **照着 `MockMarketDataAdapter` 手写一个对等的拒绝类** —— 它现有 **931 行 / 34 个方法**；手写 27 个采集口接口的实现是 senior engineer 会当场判过度的形态。用**带类型参数的工厂**（每个属性访问都抛，约 15 行）顶掉全部（plan `D-2`）。类型守卫不在这里 —— 它在「`mock` 已收窄」+「`@ts-expect-error` 负向断言」两处，与拒绝侧怎么造无关。
2. **拒绝壳对 `then` 也返回函数** —— 若用 `Proxy` 实现工厂，`get` 陷阱必须对 `then` / `Symbol.toStringTag` / `constructor` 这类**返回 `undefined`**。否则 JS 会把这个对象当 thenable，`await` 它的代码会**挂住而不是报错** —— 挂住不会红，是本清单里唯一一条连红都不给的坑。
3. **顺手把 `TRADING_CALENDAR_PORT` 也拒了** —— 它是**闸口不是采集口**，三个消费方里 `freshness-sla.check` 是只读检查；拒了它 dev 下这类检查全起不来，违 `FR-009`。它留 mock（plan `D-3`），写手会在下一步撞上采集口，结果相同。⚠️ 工厂形态下类型挡不住这个误用，靠 T001 的读取口断言接住。
4. **改 `?? 'mock'` 时只处理 `undefined`、不处理空串** —— compose 去掉 `:-mock` 之后，变量缺失会被 compose 喂成**空串**，而 `??` 是 nullish 合并、**空串不触发**。只加 `undefined` 判断 = 白改，且 prod 静默跑 mock 的路径原封不动（plan `D-5`）。
5. **为「日志好看」去逐个写手加 `catch` 分支判断错误类型** —— 那是清单式方案的复活，正是 `FR-010` 要消灭的东西。既有写手都已整轮 `try/catch` 且不上抛，让专属错误走既有路径即可（plan `D-4`）。
6. **给空满足的 FR 补 task** —— `FR-001` / `FR-002` / `FR-003` / `FR-005` / `FR-006` 都是「**若**被持久化，则……」条件句；本片选「拒绝写入」支 ⇒ 前件恒假 ⇒ 蓄意空满足（plan `D-7`）。需要的只有 T002 那条把「前件恒假」本身验掉的断言。
7. **改 mock fixture 的 `128.40`** —— 它是**刻意选的**（`mock-market-data.adapter.ts:839` 注释：`spot 取 128.40 (< K=130) ⇒ PUT 实值`），改绝对值会打乱一批 fixture 编码的实值/虚值语义。「让假数据一眼假」这条业界实践本片已裁定**知道且蓄意不做**（plan `D-7b`）。
8. **把 `.env.example:104` / `vitest.config.ts:49` 的 `MARKETDATA_PROVIDER='mock'` 改成必填** —— 「**缺失** → mock」是带论证的刻意保留（plan `D-5`）；本片只让「**非法值**」抛。
9. **remediation IT 只断言返回值、不断言落库行** —— `FR-011` 要的是**写库路径**的验证。返回值绿而 `source` 列写错照样全绿，那正是本 feature 起因的同构失败。

---

## Phase 1: 结构性阻断（US1 + US3 主体，阻塞其余）🎯

- [ ] T001 [Server] **采集口 / 读取口分类落地 + 拒绝式工厂 + mock 收窄**（`FR-003`, `FR-004`, `FR-009`, `FR-010`, plan `D-1` / `D-2` / `D-3`）：新建 `refusing-collection.adapter.ts`，导出一个**带类型参数的工厂**（返回按目标 port 类型标注的拒绝壳，任何属性访问抛专属 `MockCollectionRefusedError`，消息写明「`MARKETDATA_PROVIDER=mock` 使然，不是故障」；`then` / `Symbol.toStringTag` / `constructor` 必须返 `undefined` —— Guardrail 2）；`marketdata.module.ts` 把 **28 个** `useFactory` 的 `cfg.kind === 'mock' ? mock : …` 改为拒绝壳；`mock-market-data.adapter.ts` 的 `implements` 收窄到 `QuotePort` + `TradingCalendarPort`。→ verify: **红点是现成的** —— `marketdata.boot-015.it.spec.ts:62` 现断言 `MOCK_PORTS` 全 `toBeInstanceOf(MockMarketDataAdapter)`、`:76` 调 `bars.getBars(…)` 期望 fixture，改绑定第一刻即红；把它**分裂**为「读取口 → `MockMarketDataAdapter`」+「采集口 → 调用即抛 `MockCollectionRefusedError`」两组断言（state_branch 4 / 5）+ 同文件加 **`@ts-expect-error` 负向类型断言**：把 `mock` 绑到任一采集口的代码若**能**通过类型检查，`@ts-expect-error` 会以「unused」反向报红 —— `FR-010`「结构上走不通」的机器判据（state_branch 11）+ `nx test server --skip-nx-cache` 全绿

  📌 **28 这个数是逐 provider 判定出来的，不是估的**：`marketdata.module.ts` 共 31 个 port provider，其中 **30 个**在 `kind === 'mock'` 时绑 `MockMarketDataAdapter`（`INSTRUMENT_SEARCH_PORT` 例外 —— 它绑 `LocalInstrumentSearchAdapter` 直查真 `Instrument` 表），减去留守的 `QUOTE_PORT` / `TRADING_CALENDAR_PORT` ⇒ **28 待改**。

- [ ] T002 [Server] **boot IT 的采集口清单补全到 28**（`SC-004`, plan `D-2`）：`marketdata.boot-015.it.spec.ts` 现有 `MOCK_PORTS` **只列 7 个 port**（`INSTRUMENT_UNIVERSE` / `TRADING_CALENDAR` / `EOD_BAR` / `FUNDAMENTAL` / `FINANCIALS` / `CORPORATE_ACTION` / `QUOTE`）—— T001 的分裂断言因此只覆盖 **5/28** 个采集口。把采集口清单补全到 28 个，逐个断言「解析为拒绝壳 + 调用即抛」。→ verify: 28 个采集口逐条断言通过 + 2 个读取口仍解析 `MockMarketDataAdapter`

  📌 **为什么必须单独一条而不是并进 T001**：`SC-004` 的原文是「已知每条走 vendor 且写库的定时路径都被覆盖，**没有**『只修了撞到的那一条』的遗留」。T001 改了 28 个绑定但只验了 5 个 —— 那正是 `SC-004` 要禁止的形态在**判据层**的复现。这条 task 存在的唯一理由就是把 `SC-004` 变成可执行的断言。

  📌 **手列清单会 stale，这是蓄意接受的**：有人加第 29 个采集口时它不会自动跟上。防再入机制是 T001 的 `@ts-expect-error`（守在编译期），手列清单只是当下集合的**显式快照**。

- [ ] T003 [Server] **「`kind=mock` 下写手跑完零写库」IT**（`FR-004`, plan `D-7`）：新建 `marketdata-054.mock-no-write.it.spec.ts`，起 Testcontainers PG，`MARKETDATA_PROVIDER` 取 mock 全 boot `AppModule`，直调 `OptionSnapshotRemediation.retrySameDay` / `.backfillPremarket` 与 `TradingCalendarSyncService.run`，断言目标表**行数零增长**且各写手不上抛（既有 `try/catch` 吞掉专属错误）。→ verify: 覆盖 state_branch 1（判定需采集 → 零写库）/ 2（判定无需采集 → 零写库，与 1 走不同分支但结论同）/ 3（非定时写路径同判据 —— 同一 port 层，用手工触发的同步入口再验一次）+ 该 IT 在 T001 **之前**跑必红（现状会写 3617 行）

---

## Phase 2: 配置层 fail-fast（US3）

- [ ] T004 [P] [Server] **`provider` 非法值 boot 抛 + compose 去掉 `:-mock` 兜底**（`FR-008`, plan `D-5`）：`marketdata.config.ts:38` 改为显式枚举校验（`'mock' | 'live'` 之外一律抛，**含空串**）；`docker-compose.tight.yml:170` 把 `${MARKETDATA_PROVIDER:-mock}` 改为 `${MARKETDATA_PROVIDER}`。→ verify: config 单测覆盖 `'liv'` / `'Live'` / `''` 三形态均抛（state_branch 12）+ **缺失仍解析为 mock**（Guardrail 8 的反向断言）+ `marketdata.boot-015.it.spec.ts` 既有「`kind=live` 缺 `LIXINGER_TOKEN` 即 fail-fast」仍绿 + `npx tsx scripts/checks/check-env-sync.ts` 绿（改前基线已实测绿；Check H 仍满足 —— compose 照旧引用该键，只是不再兜底）

  📌 **为什么两处缺一不可**：`.env.production:59` 确实写着 `=live`，但只要 env-file 没加载，compose 的 `:-mock` 就把生产容器喂成 mock，再经 `??` 的空串盲区一路穿到底、零告警。这个仓自己在 `docker-compose.tight.yml` 内**6 处**注释里把「同 `MARKETDATA_PROVIDER` 静默陷阱」当作该类 bug 的标准范例引用 —— 范例本身从未被修，本 task 一并修掉。

---

## Phase 3: 验证能力补位（FR-011）

- [ ] T005 [Server] **写手写库路径 IT 顶替 dev 手工验证**（`FR-011`, plan `D-6`）：新建 `option-snapshot-remediation.it.spec.ts`，起 Testcontainers PG，用**测试内的 stub 采集口**（不经 mock adapter）喂确定性数据，覆盖 ① 当日重试落 `source = eod` 与 ② 盘前兜底落 `source = premarket_backfill` 两条，并造一次批内部分失败。→ verify: 断言**落库行**的 `source` 列值与行数（不是返回值 —— Guardrail 9）+ 覆盖 state_branch 5（live 语义下来源标识零变化）/ 8（部分写：已落部分仍带正确来源标识）

  📌 **为什么必须新增而不是改既有单测**：`marketdata` 目录现有 IT **只有 1 个**（`eod-backed-quote.adapter.it.spec.ts`）；`option-snapshot-remediation.spec.ts` 与 `sync-option-snapshot.usecase.spec.ts` 都是 Small 档单测，不起容器、不碰真表。T001 落地后 dev 彻底跑不了这条路，这个 IT 是它唯一的替代验证面（spec Edge Cases「拆东墙补西墙」点名要补的那条）。

---

## Phase 4: 决策留痕与运维面（FR-007）

- [ ] T006 [P] [Docs] **ADR-0047 § 2 amend + 水位线与预期日志写进 runbook**（`FR-007`, plan `D-7` / `D-8`）：`docs/adr/0047-marketdata-pluggable-data-access.md:85` 的「全部 \| `MockMarketDataAdapter`（dev/test 默认，零 env）」一行拆为「读取口 → Mock / 采集口 → Refusing」两行并记因由；`ops/runbook/scheduled-tasks.md` 补两条 —— ① **水位线**：本 feature 生效之前写入的 dev 库行一律「来源不可考」，且该集合随每日 `truncate + reload` 递减到空；② dev 下每天会出现的**「采集被拒」日志是预期行为**，不是故障。→ verify: 覆盖 state_branch 6（历史无痕行判「不可考」）+ `npx markdownlint-cli2 --config .markdownlint-cli2.jsonc` 绿 + ADR 改动被 `docs/adr/README.md` 索引一致性扫过

---

## Dependencies

```text
T001 ──┬── T002   (清单补全要先有拒绝壳可断言)
       ├── T003   (零写库 IT 需要拒绝壳已绑上；T003 在 T001 前跑必红，这是它的价值)
       └── T005   (dev 验证面失效之后才谈得上"顶替"，但技术上不阻塞)
T004 [P]          (纯配置层，与 T001 无文件重叠)
T006 [P]          (纯文档，唯一软依赖是 T001 的最终命名)
```

MVP 与并行：**T001 + T002 + T003** 是完整的 MVP —— T001 落机制、T002 让机制的覆盖面可验（`SC-004`）、T003 验「伪造行情不再落库」这个结果。T004 / T006 可与 Phase 1 并行。

## 判据覆盖矩阵（`state_branches` 12 条 → task）

| #   | state_branch                                  | Task                                    |
| --- | --------------------------------------------- | --------------------------------------- |
| 1   | mock · 写手触发 · 需采集 → 零写库             | T003                                    |
| 2   | mock · 写手触发 · 无需采集 → 零写库           | T003                                    |
| 3   | mock · 非定时写路径 → 同判据                  | T003                                    |
| 4   | mock · 纯读路径 → 保持可用                    | T001 · T002                             |
| 5   | live · 任意写路径 → 行为与来源零变化          | T001 · T005                             |
| 6   | 既有无痕行 → 判「来源不可考」                 | T006                                    |
| 7   | 同 (合约, 交易日) 真行 + 伪造行并存 → 取哪条  | **故意零覆盖**（见下表）                |
| 8   | 部分写 → 已落部分仍带正确来源标识             | T005                                    |
| 9   | dev 同步成功 → 伪造行被冲掉                   | **故意零覆盖**（见下表）                |
| 10  | dev 同步失败 → 伪造行留存且状态可感知         | **故意零覆盖**（见下表）                |
| 11  | 新增写入路径、作者什么都没多做 → 自动继承约束 | T001（`@ts-expect-error` 负向类型断言） |
| 12  | provider 配置缺失 / 拼错 → 不得静默落 mock    | T004                                    |

## 自审：spec 有哪几层 / 扫了哪几层（per `sdd-authoring.md` 规则 ④）

实时 `grep` 计数（**不抄 `checklists/` 的历史数字**）：`FR` **11** 条 · `SC` **5** 条 · `state_branches` **12** 条 · Acceptance Scenario **8** 条 · Edge Case **6** 条，共 5 层。**5 层全部下表建矩阵，无差集。**

📌 首轮零命中扫描抓到 **`SC-001`~`SC-005` 全部零命中** —— 与 045 实证的失败形态同构（对着 FR 展开 tasks，SC 因不产出代码行而失声）。下表是补扫结果，不是初稿。

### SC 覆盖矩阵（5 条）

| #      | Success Criterion                                                      | Task                                                                                                                                              |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-001 | 判定「有没有伪造行」< 1 分钟、单次只读查询、无需启动应用               | T006（水位线规则；执行面是 `scheduled-tasks.md` 已 ship 的数据形状自检 SQL）。⚠️ T001 之后该判定**退化**为「只需查水位线之前的行」—— 更强而非更弱 |
| SC-002 | 复现事故完整条件，伪造数据要么不落库要么可辨，且能在下结论**之前**拦下 | T003                                                                                                                                              |
| SC-003 | 混入伪造行的库上覆盖率判定与「缺数」等价                               | **故意零覆盖**（见下表）                                                                                                                          |
| SC-004 | 已知每条走 vendor 且写库的定时路径全覆盖，无「只修了撞到的那条」       | T001（28 个绑定全改）· **T002（28 个逐条断言 —— 这条才是 SC-004 的判据）** · T003（三个写手各调一次）                                             |
| SC-005 | `provider = mock` 下既有只读能力零回归                                 | T001 · T002（boot IT 读取口断言）                                                                                                                 |

### Acceptance Scenario 覆盖（8 条）

| 来源        | 场景                                                   | Task                                                   |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------ |
| US1-AS1/2/3 | 判定查询对「纯伪造 / 纯真实 / 两者并存」三种数据的结果 | **空满足**（T001 后不再产生新伪造行）；历史部分归 T006 |
| US1-AS4     | 本 feature 之前的无痕行 → 判「来源不可考」             | T006                                                   |
| US2-AS1/2   | 覆盖率探针不判达标 · 读路径不与真行情无差别            | **空满足**（同上）                                     |
| US3-AS1     | 新增写入路径未接约束 → 检查明确指出                    | T001（`@ts-expect-error` 负向类型断言）                |
| US3-AS2     | provider 缺失或拼错 → 不得静默落 mock 后继续写库       | T004                                                   |

### Edge Case 覆盖（6 条）

| Edge Case                                     | Task                                                                                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 既有污染怎么办                                | T006（水位线）                                                                                                                         |
| 幂等键冲突（同 (合约, 交易日) 真行 + 伪造行） | **故意零覆盖**（同 state_branch 7）                                                                                                    |
| mock 写入被禁的代价（dev 验不了补救路径）     | T005（IT 顶替，这正是它存在的理由）                                                                                                    |
| dev 库唯一清理机制                            | **明确排除**（Clarifications Q1）                                                                                                      |
| prod 被误配成 mock                            | T004 —— ⚠️ **写 spec 时这条只是推测，plan 阶段联网复核时定位到精确机制**：`docker-compose.tight.yml:170` 的 `:-mock` + `??` 的空串盲区 |
| 部分写                                        | T005                                                                                                                                   |

## 故意零覆盖登记（per `sdd-authoring.md`「预期的零覆盖要写明是故意的」）

| 事项                                                              | 为什么故意不覆盖                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| state_branch 7（真行与伪造行并存时读取侧取哪条）                  | T001 之后**不可能产生新的伪造行** ⇒ 该组合只存在于历史数据里，归 T006 的水位线处置。为一个封闭且递减到空的集合写读取侧取数规则是净负收益                                                                                |
| state_branch 9 / 10（dev 同步成功 / 失败）                        | spec Clarifications Q1 **明确排除** —— 它落在 host 定时任务 + 通知链上，与本片的 server 代码面不正交。另开                                                                                                              |
| `FR-001` / `FR-002` / `FR-003` / `FR-005` / `FR-006` 的正向实现   | 条件句前件在本方案下恒假（plan `D-7`）。**唯一**需要的是 T003 把「前件恒假」本身验掉，不是为每条补实现                                                                                                                  |
| `SC-003`（覆盖率判定与「缺数」等价）                              | 同上族的空满足：`FR-005` 无伪造行可判 ⇒ 覆盖率探针不存在「被骗」的输入。**若将来 T001 的类型约束被绕开**，这条会立刻从空满足退回真需求 —— 那也正是 T001 的 `@ts-expect-error` 守着的东西                                |
| 让 mock fixture 数据「一眼假」（RFC 2606 / Stripe 4242 式自识别） | plan `D-7b` 已裁定**知道且蓄意不做**：T001 之后 mock 产出已不可能落库，这层只剩纵深防御价值，而成本落在一批与本片无关的 fixture 断言上。**残余风险已知** —— 它挡不住「有人拿 dev 的**读**数据下结论」，若再撞一次即单开 |
| mobile / 契约冒烟 / 真机验收                                      | 本片零 endpoint、零 DTO、零 UI ⇒ 无 `export-openapi` regen、无 `packages/api-client` 重生成、无 mobile 消费面                                                                                                           |

## 单 PR（Constitution §V）

纯 server + docs，六条 task 同分支同 PR。**无跨端** ⇒ 不触发「server impl + regen + mobile 消费同 PR 原子 merge」那条。
