---
feature_id: 076-option-contract-size
spec_ref: ./spec.md
status: drafted
created_at: '2026-09-06'
updated_at: '2026-09-06'
adr_refs: ['0035', '0043', '0062', '0064']
context7_verified: []
---

# Implementation Plan: 期权合约股数落库 —— 单笔权利金与成交额按每张合约的真实股数算

## Summary _(mandatory)_

`option_contract` 加一列 `contract_size`（expand-only），链发现逐合约从供应方 `lot_size` 取值落库（标准合约存、非标 null），并在既有的软下架对账步里对未到期行做回填 / 更新（链发现是纯 insert，新列不在这里补就永远空着）；快照轮只比对不写。读端两处派生（单笔权利金 / 成交额）改吃合约行自己的股数，`US_OPTION_CONTRACT_MULTIPLIER` 退役，null 即显式空。零新 endpoint、零新 class、零 mobile 代码；契约只改字段说明。specify 期五项 PoC 已把供应方字段语义与写路径形态实测坐实（spec「取证」节），本 plan 不再复述数据。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| ---------------------------------------- | ---- | --------------- |
| None                                     | N/A  | N/A             |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 单 feature 单分支单 PR（§V；server + migration + 契约说明 regen 同 PR，mobile 零代码）；TDD 红绿闭环、每条新断言定向变异证能红（§II）；扁平 / 贫血 / 护城河零违背（§IV：零新表、`marketdata` 写自己的表、`optionsdesk` 经**既有** `CROSS-CONTEXT-READ` 直查多带一列、零新 port、零新 class）；mockup-first 免（§I：无 UI 改动，屏上只有一个既有数字的取值变）。无需 Complexity Tracking。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 写路径由 `sync-option-contract.usecase.spec.ts`（既有单测面）+ `marketdata-option-withdrawal.it.spec.ts`（Testcontainers 真 DI，对账函数已有专臂）承载；读路径由 `optionsdesk-052.retrieval.it.spec.ts` / `optionsdesk-071.hk-realtime.it.spec.ts` 加臂。spec `state_branches` 13 条在 D8 逐条落点。
- [x] **Mobile / Web**: 零代码 ⇒ 无新 e2e 交互面。契约冒烟 `optionsdesk-chain-leg-picker.contract.ts:606-640` 既有不变量「`contractPremium × volume === turnover`」在任何股数下恒成立，保留；新增一条港股夹具臂（股数 500）钉数值。
- [x] **Evidence**: impl 期 IT / 契约冒烟 commit；部署后 prod 核对 SQL（FR-015）回填 spec。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

零新三方依赖、零新 vendor 端点。两个既有端点各多读一个已在响应里的字段（`/option-chain` 与 `/option-snapshot` 的 `lot_size`），字段语义已在 specify 期实测（22 只港股锚三式互证 22/22、美股标准 / 非标对拍），不凭文档字面。**Evidence**: spec「取证」§1–§2 + `docs/private/evidence/hk-option-contract-lot-size-2026-09-06.*`。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

- [x] mono-native，无迁移面。**Evidence**: N/A。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR      | Open Question / sunset trigger affected                                              | Classification | Mitigation / next step                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ADR-0064 | 不变量 ③「判定 / 派生值服务端单点算并下发，客户端 MUST NOT 重算」                    | accepted-as-is | 本片**沿用并加固**：两个派生值仍只在 `get-legs.usecase.ts` 一处算，只是乘数来源从常量换成合约行；mobile 仍零重算                                                                                                   |
| ADR-0035 | migration 命名 / expand-only / `migration_refs` frontmatter                          | accepted-as-is | 本片 migration 走 expand-only 加 nullable 列、无回填、可回滚；impl 期把 migration 名写进 spec frontmatter `migration_refs`（073 先例）                                                                                |
| ADR-0062 | optionsdesk ↔ marketdata 边界（port 注入 / `CROSS-CONTEXT-READ` 直查）               | accepted-as-is | 零新 port；读端只在**既有**两处直查的 `select` 多带一列，`CROSS-CONTEXT-READ` 注释原位                                                                                                                              |
| ADR-0068 | 5 条 sunset（fillMode / laddering / φ-exit / 财报复测 / 窗不进离线）                  | accepted-as-is | 均不触发：本片不碰召回、窗、行军                                                                                                                                                                                   |
| —        | 047 spec **FR-028**「MUST NOT 存合约乘数、MUST NOT 做乘数感知计算」（非 ADR，是 FR） | **superseded** | spec 076 FR-013 裁决：标准合约存、非标 null；047 FR-028 加 superseded 注记指向 076，`schema.prisma:1102` 与 `option-chain.port.ts:58`、`leg-derive.rules.ts:37-42` 三处旧注释同步更正。FR-043（非标跳过无套利门）不受影响 |

其余 ADR 的 Open Question 段逐一扫过（`grep -rl "Open Question" docs/adr/`），与本片无交集。

## Architecture Notes _(mandatory)_

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类**绝对禁止**隔离单元测试（本片零新 lifecycle 组件，禁令仍全文有效）。
- **MANDATORY INTEGRATION**: 写路径回填 / 更新与读路径取值 MUST 在 Testcontainers 真 DI（`Test.createTestingModule` 真 boot）下验证，MUST NOT 只靠 mock Prisma 的单测证「更新了」。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` 13 条每条在 D8 有对应 `it()`，100% 路径覆盖（含非标 null、缺值 null、跨市场混入、链不干净不更新、快照不一致只警不写、读端 null 显式、美股逐值零变化、首轮回填、已到期不回填、无链锚零影响）。
- **PROVE-IT-CAN-FAIL**: 每条新断言用定向变异证明会红（把港股夹具股数改回 100 / 删掉对账里的更新 / 让读端 null 回落 100 / 让非标也落值），rebase 后重做。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**：Flat Module / Anemic + Zero-Class / No Repositories / The Moat。本片零新表、零新 endpoint、零新 class；改动落 `marketdata` 既有采集 use case + adapter 的**取值**、`optionsdesk` 既有读路径的**一列**、两个派生纯函数的**入参**。

**D1 · schema 与 migration（expand-only，单 PR）**

- `OptionContract` 加 `contractSize Int? @map("contract_size")`，落在 `isStandard` 之后（`schema.prisma:1130`）。列注释写三句：① 标准合约 = 一张合约对应的正股股数（供应方 `lot_size`，港股逐标的不同，美股实测恒 100）② 非标合约恒 null —— 供应方对非标照报 100（specify 期 PoC-A 实测 APTV1），与 OCC 调整后交割物不符 ③ 已到期合约不回填（Q1 裁决）。
- migration `<yyyymmddhhmm>_add_option_contract_contract_size`，一行 `ALTER TABLE … ADD COLUMN "contract_size" INTEGER`，注释体例照 `20260903_2057_add_option_contract_withdrawn_at`（病根 / 语义 / 为什么不回填 / 不建索引）。🚫 不在 migration 里回填 —— 值只有供应方有，migration 打不了 vendor；回填由 D3 在下一轮链发现自然完成。
- `schema.prisma:1102-1105` 那段「MUST NOT 存合约乘数 lot_size」改写为「非标 MUST NOT 存（理由原文保留）；标准合约 MUST 存 `contract_size`，见 076」。
- 改完 `prisma generate`（rule §0：改了又撤回也要 generate）；`check-server-moat` 的 `MODEL_OWNERSHIP` 不动（无新表）。

**D2 · port + 链发现 adapter（取值单点）**

- `OptionContractStatic` 加 `contractSize: number | null`（`option-chain.port.ts:61-92`），`:58` 那条「不含合约乘数」注释改为「含标准合约的股数；非标恒 null」。
- `futu-option-chain.adapter.ts` 的行映射（`:255-271`）：`contractSize = isStandard ? positiveIntOrNull(raw.lot_size) : null`。`positiveIntOrNull` 走既有 `numToString` 判带外缺失（`'N/A'` 字符串在 `Number()` 下为 NaN ⇒ null，`:118-122`），再校 `Number.isInteger(n) && n > 0`；标准合约取到 null 时打一条 warn **日志**（logger，带 code；adapter 层无采集轮上下文，不进 findings），本行照常返回 —— 采集不因一列缺值丢整行（FR-005）。
- **跨市场混入行（FR-004）是结构保证**：`dropForeignMarketRows`（`:285`）在 `:347` 对整窗行集过滤，混入的 `US.ALB…` 行在到达 `sync-option-contract` 之前已被丢弃，其 `lot_size` 从不进 `contractRow`。加一条 adapter spec 臂钉住「混入行被丢 ⇒ 不出现在返回集」即可，不需要第二道判据。
- 🚫 **MUST NOT 从正股行取**（FR-003）：链端点只返回期权合约行（fixture `hk-option-chain-00700` 132 行全是合约），本处无正股行；快照端点有正股行，D4 只对 `option_type ≠ 'N/A'` 的行读 `lot_size`。

**D3 · 写路径：insert 带值 + 对账步回填 / 更新（唯一写手）**

- `contractRow()`（`sync-option-contract.usecase.ts:100-115`）多带 `contractSize: c.contractSize` —— 新合约首次入库即有值。
- 既有行：`createMany(skipDuplicates)` 是纯 insert（`:57-65` 注释自陈幂等靠唯一键挡重，逐行 upsert 每晚多付约 2.5 万条），🚫 不改成 upsert。回填 / 更新落在 `reconcileListingState`（`:329`）：
  1. 入参 `discoveredCodes: ReadonlySet<string>` 扩成 `sizeByCode: ReadonlyMap<string, number | null>`（code → 本轮股数；`:275-276` 收集处同步）。🚫 别叫 `discovered` —— 那是既有的到期日集合（`:275`），撞名。软下架 / 复采两条 `updateMany` 取 `[...sizeByCode.keys()]`，逻辑零变化。
  2. 新增第三步：`findMany` 该标的 `expiryDate ≥ businessDate ∧ withdrawnAt IS NULL` 的 `{ code, contractSize }`，内存对比 `sizeByCode.get(code)`，把「库值 ≠ 本轮值」的 code 按**新值分组**（含 null 组），每组一条 `updateMany({ where: { code: { in } }, data: { contractSize } })`。分组数 = 该票本轮不同股数的个数（今日样本每票 1 个，资本调整期最多 2 个）⇒ 每票常数条语句，`O(n)` 内存比对，n ≤ 单票未到期合约数（prod 实测上限 4602）。
  3. 变更条数 > 0 ⇒ `stats.findings.push({ kind: 'notice', step: 'option_contract_size', detail: { symbol, filled, changed } })`：`filled` = null → 值（首轮回填），`changed` = 值 → 另一值（资本调整信号）。两个数分开是为了让「首轮回填 12 万行」与「某票某天变了 300 行」在报告里长得不一样。
- 🚨 **只在 `gap.ok` 分支执行**（FR-007）：`:288-296` 已把不干净的轮次 return 掉，本步跟在 `:297` 同一调用点内，天然同闸。变异证据：把第三步挪到 gap 判定之前 ⇒ IT「链不干净不更新」臂红。
- 已到期合约：`findMany` 谓词 `expiryDate ≥ businessDate` 天然排除（Q1 裁决），不需要额外判据；IT 用一张已到期夹具钉「仍为 null」。
- 非标合约：本轮 `sizeByCode.get(code) === null`，若库里有值（不该有）会被回写 null —— 这是对的：写手只有一处，库值 MUST 跟本轮供应方一致。

**D4 · 快照轮只比不写（FR-008）**

- `OptionSnapshotRow` 加 `contractSize: number | null`（`option-snapshot.port.ts:116-149`）；`futu-option-snapshot.adapter.ts` 行映射（`:236-256`）对期权行取 `lot_size`（同 D2 的正整数校验），正股行恒 null。
- `sync-option-snapshot.usecase.ts` 工作集 `WorkingContract`（`:197-205`）多 select `contractSize`；批循环（`:589-640`）里对每行：`contract.isStandard ∧ contract.contractSize !== null ∧ row.contractSize !== null ∧ 两者不等` ⇒ 计入本票不一致计数 + 样本（逐票前 N 条 `code: 库值≠快照值`，N = 具名常量 `CONTRACT_SIZE_MISMATCH_SAMPLES`）。批循环结束后 count > 0 ⇒ 一条 `notice` finding（`step: 'option_contract_size_mismatch'`，`detail: { symbol, mismatched, samples }`）。🚨 `SyncRunFinding` 的值域是 `failure / reject / skip / interrupt / notice / unjudged`（`sync-run.recorder.ts:20-83`），**没有 warn**，🚫 不为本片新开 kind。🚫 MUST NOT 在此写库、MUST NOT 影响该行入库。
- 为什么值得做：D3 的更新只在链发现整轮干净时发生；若某天链发现连续不干净（vendor 抖动）而供应方已改了股数，快照轮是唯一还在逐日看这个数的路径。它是 notice 不是 failure —— 不改变任何采集结局。

**D5 · 读端：合约行带出股数，两处派生改入参**

- `ChainContractRow`（`leg-retrieval.adapter.ts:72` 的 `Pick`）加 `contractSize`；两处 `select`（`:404` 实时 roster / `:733` 离线）多带 `contractSize: true`。
- `LegChainRow` 加 `readonly contractSize: number | null`（`leg-retrieval.port.ts:91-130`）；`toLegRows`（`:819-860`）在 `expirationCycle` 旁带出 `contractSize: contract.contractSize`。实时窄路径的 `answered` 行由骨架行展开（`{ ...leg, … }`），自动携带，零额外改动。
- `leg-derive.rules.ts`：`computeTurnover(volume, premium, contractSize)` / `computeContractPremium(bid, contractSize)`，`contractSize === null` ⇒ null（显式态，FR-009）；删 `US_OPTION_CONTRACT_MULTIPLIER`（`:42`）与两处引用（`:362 / :378`），同名 spec 的 `expect(US_OPTION_CONTRACT_MULTIPLIER).toBe(100)`（`:377`）一并删（本片产生的 orphan）。`:37-42` 那段「乘数是市场规则不是合约属性、蓄意不落库」注释改写：合约属性、随链发现落库、非标 null。
- `get-legs.usecase.ts:840 / :859` 两处调用改传 `row.contractSize`；`:838-839` 注释「服务端已持有合约乘数」改为「合约行自带股数」。
- 🚨 **美股逐值零变化是数据保证不是结构保证**（FR-010）：美股标准合约的 100 自此来自供应方（PoC-A 实测 PEP 100），首轮回填前是 null。IT 里用「股数 100 的美股夹具」钉两个派生值与改前逐值相同；契约冒烟既有的 `contractPremium × volume === turnover` 不变量保留。

**D6 · 契约与文档（形状零变化）**

- `optionsdesk.dto.ts:1474`（`contractPremium` 说明「bid × 合约乘数」）与 `:1613`（`turnover` 说明「× 100」）改为「× 该合约的股数（合约主数据，港股逐标的不同；股数未落库 / 非标 ⇒ null）」。类型 `string | null` 不动（`:1483 / :1619`）。
- regen：`nx run server:export-openapi` → `nx affected -t generate`（api-contract.md：漏掉前者 orval 会拿旧 json 静默 regen）。verify：`git diff packages/api-client apps/server/openapi.json` 只含说明文字。
- 047 spec `FR-028`（`specs/047-*/spec.md:312`）加一行 superseded 注记指向 076 FR-013；🚫 不改 047 其余文字（冻结记录）。

**D7 · 部署与回填窗口（FR-015 / SC-003）**

- expand-only ⇒ 先部署代码即可，回滚只换镜像不回退 schema（migration-rules §2 前提）。
- 回填时刻 = 部署后第一轮**成功**链发现：港股主轮 16:20 HKT、美股夜轮。窗口内两个派生值为 null（Q2 裁决，spec state_branch 11）。
- 部署后核对 SQL（单条，只读）：未到期 ∧ 标准 ∧ `withdrawn_at IS NULL` ∧ `contract_size IS NULL` 的行数 = 0；并抽两只（09988 → 500、PEP → 100）。tasks 期为它立独立 task + issue + 到期日（071 T010 纪律）。
- 采集报告若已消费 `findings`（`marketdata-sync-report.sh`），首轮那条 `filled` 会是六位数，属预期，不是告警。

**D8 · 验证与测试分层（`state_branches` 落点）**

| #   | branch                       | 落点                                                                                                              |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | 标准合约落供应方值           | `futu-option-chain.adapter.spec.ts`（hk 500 / us 100 夹具）+ `sync-option-contract.usecase.spec.ts`（`contractRow` 带值） |
| 2   | 非标 → null                  | adapter spec（`option_standard_type = NON_STANDARD` ∧ `lot_size 100` ⇒ null）                                     |
| 3   | 缺值 / 哨兵 / 非整数 → null + 留痕 | adapter spec 三臂（缺失 / `'N/A'` / `5.5`）                                                                          |
| 4   | 跨市场混入行不参与           | adapter spec（09988 窗混入 `US.ALB` 行 ⇒ 返回集不含）                                                             |
| 5   | 既有未到期行回填 / 更新 + notice | `marketdata-option-withdrawal.it.spec.ts` 加臂（null → 500 出 `filled`；500 → 1000 出 `changed`）                 |
| 6   | 链不干净不更新               | 同上 IT（gap 不 ok ⇒ 股数不变、无 finding）                                                                       |
| 7   | 快照不一致只留痕不写         | `sync-option-snapshot.usecase.spec.ts` + IT 一臂（notice finding、库值不变、该行照常入库）                        |
| 8   | 读端有值 ⇒ 两个数按股数算    | `optionsdesk-052.retrieval.it.spec.ts` 加臂（hk 500 夹具：`contractPremium = bid × 500`）                          |
| 9   | 读端 null ⇒ 两个数 null      | `leg-derive.rules.spec.ts`（纯函数）+ 052 IT 臂（夹具股数 null ⇒ 两列 null、其余列在）                            |
| 10  | 美股逐值零变化               | 052 IT（股数 100 夹具与改前基线逐值相同）+ 契约冒烟既有不变量                                                     |
| 11  | 首轮回填前 null              | 与 9 同一断言面（夹具即「未回填」形态），预检表写明                                                               |
| 12  | 已到期不回填                 | withdrawal IT（已到期夹具经一轮对账后仍 null）                                                                    |
| 13  | 无链锚零影响                 | 蓄意零覆盖 —— 无合约行 ⇒ 无写无读，结构性不可达，预检表写明                                                       |

契约冒烟：`optionsdesk-chain-leg-picker.contract.ts` 保留既有不变量；新增港股夹具臂落 `071-hk-realtime.contract.ts`（两市同码夹具已在，给 hk 合约播 500、us 播 100，断言 `contractPremium / bid` 分别为 500 / 100）。

### 🚨 Impl Guardrails（并发 / 安全 / 前端）

- **并发 / 事务**：对账步的三条 `updateMany` 不包事务（既有两条本就不包）；同一维度一轮内按标的逐个处理（`dimension-executor.ts:1249` `for (const inst of pending)`），同一标的在一轮内只有一个写手。跨轮次重叠由 tick driver 的 due 判定挡 —— 本片未逐行核，impl 期若发现同标的两轮可并跑再议加锁（推断，未验证）。快照轮零写。
- **配额**：零新 vendor 调用，两个端点各多读一个已返回的字段。
- **时间语义**：不新造任何「今天」；对账谓词沿用 `businessDate`（链发现自己的业务日）。`check-time-semantics.ts` 照跑。
- **守卫脚本**：`check-optionsdesk-rule-constants.ts` 把 `leg-derive.rules.ts` 列在扫描面（`:94`），删常量后照跑确认零误报；`check-server-moat` / `check-test-size` / `check-api-property-nullable` 照跑。
- **安全**：不触鉴权 / PII。
- **前端**：零改动。`formatContractPremium`（`leg-row.rules.ts:127-131`）对 null 已走 `COPY.noValue`。
- **类型加宽的涟漪**：三个 port 类型加的是**必填**字段，所有构造这些行的测试替身 / 夹具会被 typecheck 逼出（grep `isStandard:` / `expirationCycle` 命中 `option-snapshot-remediation.it.spec.ts`、`fake-leg-retrieval.adapter.ts`、`optionsdesk-064.overlay.it.spec.ts`、`leg-retrieval.port.spec.ts`、`get-chain-report.usecase.spec.ts`、`sync-option-oi-settle.usecase.spec.ts`、`option-snapshot-guard.rules.spec.ts`、`option-anomaly.rules.spec.ts` 等）。各 task 一并补 `contractSize`（按臂语义取 null 或 100），🚫 不把字段做成可选去躲编译错误 —— 可选就是给下一个漏掉它的调用点留静默通道。
- **绊线**：`optionsdesk-047.schema.it.spec.ts:88-115` 用穷举列集钉死 `option_contract`（标题即「也无合约乘数列 (FR-028 反向断言)」）。T001 加列后它第一个红，翻它 MUST 在同一 commit message 写明理由（071 FR-017 先例）。

### 决策备选与既有事实核录

**备选否决**：① 标的级落值（正股 lot × 倍数存 instrument）—— 否，板手数改革（2026-11 起）会让同一标的新旧系列股数不同，标的级会静默错；② 读端每次现查供应方 —— 否，离线档恒零外呼（068 FR-011）；③ 存供应方名义价值 —— 否，派生值随现价变；④ null 时回落 100 —— 否（Q2），把错数再显示一天；⑤ migration 打供应方回填历史 —— 否（Q1），已到期码供应方未必认；⑥ 链发现改逐行 upsert 顺带更新 —— 否，`:60` 注释实测每晚多付约 2.5 万条写，且对账步已是既有的「按 code 更新」落点；⑦ 信供应方对非标给的乘数 —— 否，PoC-A 实测 APTV1 报 100；⑧ 快照轮也写股数 —— 否，两个写手必漂移，且快照轮不知道链是否干净。

**既有事实核录**（2026-09-06 plan 期逐项 grep / 实取，🚫 未照抄二手行号）：

- schema：`schema.prisma:1116` `model OptionContract`；`:1130` `isStandard`；`:1139` `withdrawnAt`；`:1102-1105` FR-028 禁令注释
- 链发现 port / adapter：`option-chain.port.ts:58` 「不含合约乘数」；`:61-92` `OptionContractStatic`；`futu-option-chain.adapter.ts:118-122` `numToString`；`:150-154` `strOrNull`（哨兵 `N/A`）；`:198-200` `isStandardContract`；`:255-271` 行映射；`:285` / `:347` `dropForeignMarketRows`
- 写路径：`sync-option-contract.usecase.ts:57-65` 幂等 = `createMany(skipDuplicates)`；`:100-115` `contractRow`；`:275-276` `discovered` / `discoveredCodes` 收集；`:282` createMany；`:288-296` gap 不 ok 早退；`:297` 调对账；`:329-360` `reconcileListingState`（两条 `updateMany` + notice finding）
- 快照路径：`option-snapshot.port.ts:116-149` `OptionSnapshotRow`；`futu-option-snapshot.adapter.ts:236-256` 行映射；`sync-option-snapshot.usecase.ts:197-205` `WorkingContract`；`:525-540` 工作集查询；`:589-640` 批循环
- 读路径：`leg-retrieval.adapter.ts:72` `ChainContractRow`；`:404` / `:733` 两处 select；`:819-860` `toLegRows`；`leg-retrieval.port.ts:91-130` `LegChainRow`；`leg-derive.rules.ts:37-42` 常量与注释、`:352-379` 两个派生函数；`leg-derive.rules.spec.ts:374-377` 引用常量的断言；`get-legs.usecase.ts:838-840` / `:859` 两处调用
- 契约：`optionsdesk.dto.ts:1474-1483` `contractPremium`；`:1613-1619` `turnover`；契约冒烟 `optionsdesk-chain-leg-picker.contract.ts:606-640` 不变量
- 守卫：`check-optionsdesk-rule-constants.ts:94` 扫描面含 `leg-derive.rules.ts`；全仓无脚本引用 `US_OPTION_CONTRACT_MULTIPLIER`
- 先例：migration `20260903_2057_add_option_contract_withdrawn_at`（expand-only 注释体例）；047 spec `FR-028`（`specs/047-*/spec.md:312`）
- 数据面（prod，2026-09-06）：hk 22 只有链锚全部单一 root、非标 0、撤单 0；us 未到期非标 1,132 / 标准 91,220；供应方字段实测见 spec「取证」

## Complexity Tracking

无违规，无需 justify。
