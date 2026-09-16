# Specification Analysis Report: 084-optionsdesk-broker-push-sync

> `/speckit-analyze` 产出（2026-09-16）。**只读**：未修改 spec / plan / tasks；本文件是报告本身。
> 覆盖检查一律逐条 grep / 脚本对账，不靠通读（`.claude/rules/sdd-authoring.md` § 反模式）。
> 🚨 每条 finding 在下结论前都先问过「这是真问题，还是我自己探针的误报」——被排除的 3 条单列在 §已排除的假阳性。

## 扫描面声明（先列层，再扫）

| spec / plan 的层 | 扫了吗 | 方式 |
|---|---|---|
| `state_branches`（23） | ✅ | 脚本：tasks 覆盖表逐行同序，编号集合与 1–23 求差集 |
| Functional Requirements（22） | ✅ | 脚本：编号集合相等 |
| Success Criteria（8） | ✅ | 脚本：编号集合相等（🚨 SC 是系统性盲区，单列一张表） |
| Edge Cases（8） | ✅ | 脚本：行数对齐 + 落点人工核 |
| Acceptance Scenarios（12） | ✅ | 脚本：行数对齐（🚨 标准矩阵**够不到**这一层，单列） |
| Clarifications（5 条答案） | ✅ | 脚本：每条定值追到对应 FR 正文 + 人工追到 task |
| plan D1–D11 决策 | ✅ | 脚本：plan 定义的 D 编号 vs tasks 引用的 `plan Dx` 求差集 |
| plan 反例臂（9 条） | ✅ | 人工逐条追到 task 的臂或定向变异 |
| task 粒度（Constitution §III） | ✅ | 脚本：每 task 的独立验收臂计数（阈值 12，照 082 K1 的判据） |
| 术语一致性 | ✅ | 脚本：关键术语在三份产物中的出现次数比对 |
| 模糊形容词 / 占位符 / FR 近重复 | ✅ | 脚本：词表扫描 + 首字签名粗筛 |
| Assumptions（7 条） | ✅ | 人工逐条：三方取证结论 / 推送无补发 / 范围口径不变 / 单券商 / 上游措辞精度 |
| Key Entities | ⏭️ 蓄意不单扫 | 本片零新表，实体沿用上游定义；字段级 SoT 在 `schema.prisma` |

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| G1 | Coverage Gap | LOW | tasks.md T009；tasks.md T010（定向变异 a） | **T009（索引迁移）自身 0 个验收臂、0 条定向变异**，verify 只有 `grep` 与 `typecheck`。它要保的判据恰是本片最易写错的一条（谓词**不能**含已完成状态，照抄上游即错）。⚠️ 但它并非无保护：该判据的**行为面**已由 T010-④「当日已完成补偿后再次断档 ⇒ 照常新起」+ 其定向变异 a「索引谓词纳入已完成状态 → ④ 红」覆盖 ⇒ 不是覆盖缺口，是**追溯不显式**：下一轮 analyze 单看 T009 会再报一次 | T009 的 verify 末尾加一句交叉引用：「本条谓词的『能红』证明在 T010 定向变异 a」。🚫 为它单造一个反例臂 —— 迁移属「最终状态」形态，输入构造不出反例（`testing.md` §7.1），重复造只会得到一个永不会红的断言 |
| T1 | Inconsistency（术语） | LOW | spec.md（「事件源」×8）；plan.md（×2）；tasks.md（×0） | **术语漂移**：spec 与 plan 用「事件源重启」指代券商侧进程重启（`epoch` 变化的触发源），tasks 里一律写成「shim 重启 / 进程重启」，**「事件源」出现 0 次**。语义不冲突、实施不会错，但 analyze 期若以术语做对账锚点会失配 | tasks 的 T003-③ / T010-② 首次出现处补一次「事件源（shim 进程）」的对应说明；或反过来在 spec 术语首现处注明「下文 tasks 中称 shim 进程」。二选一即可，不必全文替换 |
| D1 | Traceability | LOW | plan.md §D9（配置）；tasks.md T001 / T003 | **plan D9 未被任何 task 的 `plan Dx` 标签引用**。其内容（shim 缓冲容量 env、server 侧不新增配置项）实际已被 T001（「容量从 env 读」）与 T003（「`install.sh` 非密收敛段加缓冲容量 env」）承接 ⇒ 不是覆盖缺口，是**标签缺失**。analyze 靠 `plan Dx` 做机器对账，缺标签会让下一轮误判成缺口 | T001 与 T003 的标题括注里各补一个 `D9`（如 `plan D1, D9`） |

**无 CRITICAL / HIGH。** 这不是「没查到」—— 对照上游 082 那次 analyze 报出的 2 个 HIGH（调度器重入产生重复对账、SC-010 的仓内检查恒绿），本片的同类问题在**起片前的取证阶段**就已消化：调度器重入由 clarify Q3 定案并落成 FR-022 + T009 索引；「检查恒绿」形态由 T015 的两臂对照（scratchpad 计数 1 / 仓库计数 0）预先堵住。

## 已排除的假阳性（我自己探针的误报）

🚨 逐条记下，避免下一轮重复报同一条：

| 探针输出 | 为什么是误报 |
|---|---|
| 「Clarifications Q3 → FR-022 未体现」 | 我拿 `只阻挡` 做关键词，FR-022 正文写的是「**已完成的补偿 MUST NOT 阻挡**当日后续的补偿」。语义完整承接，关键词选死了 |
| 「T002 有 13 个臂 ⚠️ 超粒度」 | 圈码被重复计数 ——「定向变异：a. … → ① 红」里的 ① 也计入了。按「臂：」到「定向变异」之间重数，实际 **7 个独立臂**；全部 17 个 task 独立臂均 ≤ 8，无超粒度 |
| 「T008 / T011 / T012 / T013 无定向变异」 | 第二个探针数的是 `a. ` / `b. ` 编号形态，而这四个 task 的定向变异是**单条、不编号**（如 T008「定向变异：去掉 `waitForCompletion` → ① 红（留档）」）。两个探针结论矛盾时，是后者的匹配规则太窄 |

## Coverage Summary

| 层 | 总数 | 有 task 覆盖 | 覆盖率 | 备注 |
|---|---|---|---|---|
| `state_branches` | 23 | 23 | 100% | 逐条落点见 tasks §state_branches 覆盖预检 |
| Functional Requirements | 22 | 22 | 100% | FR-002 由 FR-001 的只读守卫连带钉住（tasks 已写明是蓄意） |
| Success Criteria | 8 | 8 | 100% | SC-001 / SC-002 / SC-005 / SC-006 真数面在 T016（人工），机制面均有自动化 |
| Edge Cases | 8 | 8 | 100% | — |
| Acceptance Scenarios | 12 | 12 | 100% | US2-AS4 蓄意零覆盖（上游既有行为、零新代码），tasks 已写明 |
| plan D 决策 | 11 | 11 | 100% | D9 内容有承接、缺标签（D1 finding） |
| plan 反例臂 | 9 | 9 | 100% | 逐条落在 T002 / T005 / T006 / T007 / T010 / T011 / T012 的臂与定向变异 |

## Constitution Alignment Issues

**无。** 逐条复核：

| 原则 | 结论 |
|---|---|
| I. SDD（NON-NEGOTIABLE） | specify → clarify（5 问）→ plan → tasks 逐步走完，两处人工卡点均已停下等批准；纯后端无 Mockup 步 |
| II. Test-First TDD（NON-NEGOTIABLE） | 每个 impl task 的 `→ verify:` 内红→绿闭环，测试不独立成 task；关键判据配定向变异留档 |
| III. Atomic Task = 30min–2h | 17 个 task，独立臂均 ≤ 8，无 082-K1 那种超粒度形态；Clear 检查点批次已在 tasks 末尾给出 |
| IV. Module Boundary | server 文件全部平铺 `optionsdesk/`；**本片零新增跨 ctx 边**，零跨 ctx 写 |
| V. 类型同步链 | server 零 endpoint / 零 DTO 变更 ⇒ 无 OpenAPI 变更、无 api-client regen、无 mobile 改动；读端 `syncedAt` 取值来源变了但响应结构不变 |

## Unmapped Tasks

**无。** 17 个 task 全部带 FR 或 SC 引用（脚本核）。

## Metrics

- 总需求：FR 22 + SC 8 = **30**
- 总 task：**17**（Shim 3 / Server 5 / Server-IT 5 / Docs 1 / Gate 1 / Ops 2）
- 覆盖率（需求有 ≥1 task）：**100%**
- Findings：**3**（CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 3）
- 已排除的探针误报：**3**
- 模糊表述：0 ｜ 占位符残留：0 ｜ FR 近重复：0 ｜ 无 FR/SC 承接的 MUST：0

## Next Actions

**无阻塞项。** 3 条 LOW 都属追溯 / 措辞层面，不改变任何实施行为：

1. **G1**：T009 verify 末尾加一句指向 T010 定向变异 a 的交叉引用
2. **T1**：tasks 首次出现处补一次「事件源（shim 进程）」的术语对应
3. **D1**：T001 / T003 标题括注补 `D9`

三条都是 tasks.md 的一行级编辑，可在 `/speckit-implement` 起手前顺手做掉，也可以不做（不影响实施正确性，只影响下一轮 analyze 会不会重报）。

**建议**：修掉这 3 条后进入 `/speckit-implement`（该步是 Constitution §I 的人工审批卡点，需维护者显式批准）。
