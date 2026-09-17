# Specification Analysis Report: 085-optionsdesk-display-currency

> `/speckit-analyze` 产出。本文件含**两轮**：第二轮（2026-09-17 复跑，本文主体）在前，第一轮存档在文末。
> 只读：analyze 本身不改 spec / plan / tasks；第二轮的修复由同 PR 的产物改动承载，逐条记在「修复记录」。
> 覆盖检查一律逐条 grep / 脚本对账，不靠通读（`.claude/rules/sdd-authoring.md` § 反模式）。
> 每条 finding 下结论前都先问「这是真问题，还是我自己探针的误报」—— 被排除的 4 条单列在 §已排除的假阳性。

## 第二轮为什么要跑

第一轮的三条 finding 收口后（`5b9e8708`）没有复验就合入了 main。第二轮的两个目的：① 确认 F1 / F2 / F3 真的闭合；② 补第一轮**扫描面里没有的那一层** —— 产物对既有代码的**行号锚点**。

## 扫描面声明（先列层，再扫）

| spec / plan 的层 | 扫了吗 | 方式 |
|---|---|---|
| `state_branches`（21） | ✅ | 脚本实测 21 条 @ `spec.md:18-38`；tasks 覆盖表 21 行同序 |
| Functional Requirements（13） | ✅ | 脚本：编号集合相等（spec 13 ↔ tasks FR 表 13），双向差集为空 |
| Success Criteria（7） | ✅ | 脚本：编号集合相等（SC 是系统性盲区，单列一张表） |
| Edge Cases（8） | ✅ | 脚本：行数对齐 + 落点人工核 |
| Acceptance Scenarios（16） | ✅ | 脚本：`^\d+\. \*\*Given\*\*` 实测 16（标准矩阵够不到这一层，单列） |
| User Stories（3） | ✅ | 脚本实测 3；US1/US2 同为 P1、US3 为 P2 |
| 散文层无编号 `MUST` | ✅ | 脚本：去 frontmatter 与 FR/SC 行后**零命中** |
| task 臂号引用完整性 | ✅ | 脚本：覆盖表 **208 处** `TNNN-圈号` 引用，悬空 / 越界**零命中** |
| plan D0–D9 决策（10） | ✅ | 脚本：plan 定义 vs tasks 引用，双向差集为空 |
| task 粒度（Constitution §III） | ✅ | 脚本：每 task 独立验收项计数（阈值 12，照 082 K1） |
| 模糊形容词 / 占位符 | ✅ | 脚本词表扫描，均零命中 |
| **产物 → 既有代码的行号锚点（41 条）** | ✅ **第二轮新增** | 脚本逐条核「文件在不在 / 声称的行号窗口里有没有那个符号 / 漂移到第几行」⇒ F5、F7 |
| **强调标记预算** | ✅ **第二轮新增** | 跑 `scripts/hooks/posttooluse-steering-density.sh` 本体（budget=0 强制输出）⇒ F9 |
| Key Entities（5） | ⏭️ 蓄意不单扫 | 本片零新表、零 schema 变更；字段级 SoT 在 swagger 装饰器 |

## Findings（第二轮）

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F4 | Coverage 对称性 | LOW | tasks T015-④ · FR-010 · US1-AS5 | FR-010 与 US1-AS5 都点名「持仓详情页**与订单列表/详情页**」，而唯一落点 T015-④ 只断言持仓详情页。**初判 MEDIUM「订单详情零断言」，经代码路径取证后降为 LOW**：折算只发生在 `list-broker-positions.usecase.ts`（列表端点 `broker-account.controller.ts:78`，`:102` 收 `@Query`）；两个详情端点走别的 use case 且都不收 query（`:109` → `getBrokerPosition.execute` `:139`；`:146` → `getBrokerOrder.execute` `:175`），mobile 侧也各走独立 query key（`use-trading-account-position.ts:32` / `use-trading-account-order.ts:29`）。⇒ 折算路径**结构上够不到**任一详情屏。订单分段目前还是 `PlaceholderCard`（`trading-account-screen.tsx:46-52`），不渲染金额 | **已修**：结构论证写进 tasks「蓄意零覆盖」段。T015-④ 作为持仓详情的防御臂保留，订单详情不另配臂 |
| F5 | Evidence 过期 | LOW | plan Gate 0.4 表 + Evidence 行 | plan 写 use case 数 = **24**（2026-09-17），实测 **25**。083 合入时（`eecc2653`）确为 24，084（`a808ca4b`）加了 `consume-broker-events.usecase.ts` ⇒ plan 落笔时该数已过期。ADR-0043 复审线 30，未越线，无 ADR 后果 | **已修**：两处订正为 25，并写明 24 → 25 的来由与「距 30 余 5」 |
| F6 | Inconsistency | LOW | plan 测试映射表 vs tasks 覆盖表 | plan 声称某层覆盖某 branch，而 tasks 落点里没有该层的 task，共 5 条：branch 5 / 16 / 17 / 20（plan 记 Mobile vitest）与 branch 19（plan 记 Mobile E2E + Server Medium）。tasks 覆盖表 21/21 自洽，不影响 impl；plan 那张表是 over-claim | **已修**：plan 表下加一行，声明该表是「层 × 文件」粗粒度、逐臂归属以 tasks 为准，并列出 5 条差异 |
| F7 | 术语混淆 | LOW | tasks Path Conventions · plan D8 | `.chip`（`:448-454` 既有形态）把 **mockup 的 CSS 类名**写成了 RN 文件里的东西。实测 `trading-account-positions.tsx` 全文无 `chip`（`rg -c` exit 1）；`.chip` 只存在于 `design/` 的 mockup 三件。行号锚**是对的**：`:448-454` 确为行级徽标（`row.expired` 的 `self-start rounded-sm bg-warn-soft px-1`），plan D8 关于 `align-self: flex-start` 的推理也与实际 `self-start` 吻合。附带发现：该既有徽标底色 `bg-warn-soft` 是警示语义 | **已修**：两处改写为「行级徽标 + 实体 class + mockup 称 `.chip`」，并标出底色需另定 |
| F8 | Inconsistency | LOW | plan.md `EXHAUSTIVE BRANCHING` 行 | 引用 `spec.md:18-39`，实测 `state_branches` 在 `18-38`（plan 测试映射表 / tasks 两处都写对） | **已修**：订正为 18-38 |
| F9 | Convention | MEDIUM | tasks.md · plan.md | 本轮扫描期间 `.claude/rules/sdd-authoring.md` 落地强调标记预算（每份 ≤ 10，`posttooluse-steering-density.sh` 机器数）。按 hook 本体口径实测：spec **4**（达标）· plan **46**（🚫9 · 🚨15 · ⚠️11 · 大写 9 · 严禁 2）· tasks **92**（🚫45 · 🚨37 · ⚠️7 · 大写 3） | **蓄意不在本 PR 处理** —— 维护者已定单独一轮降噪。本 PR 的所有插入文本零新增标记（改动前后 hook 计数逐字不变：plan 46、tasks 92） |
| F10 | Inconsistency | LOW | 第一轮 analysis.md 的 Coverage Summary | 第一轮报告没跟自己的 F2 修复同步：FR-005 / SC-005 仍写 `T008, T011`、FR-010 仍写 `T011`，而 T015 才是实际落点 | **已修**：本文件下方 Coverage Summary 已重算 |

## 已排除的假阳性（我自己探针的误报）

| ID | 探针报的 | 为什么是误报 |
|---|---|---|
| FP-A | T014「臂 12 条 max=13 不连续」 | T014 是最后一个 task，探针的 block 边界读到文件尾，把五张覆盖表的圈号全算成它的臂。改「末 task 截到下一个 H2」后 T014 = 0 项（它本就是命令式验收） |
| FP-B | 覆盖表 12 处 `T013-①..⑦` 全部悬空 | 探针只在 `→ verify:` 之后找圈号，而 T013 的七项真机核验写在 `→ verify:` **之前**。改扫整个 task block 后，208 处引用悬空 / 越界**零命中** |
| FP-C | plan 测试映射表提出 branch 5 | 来自该行正文「**22** 字段」的裸数字（22 − 17 = 5）。与第一轮 FP3 同源（那次是 `f3` / `idx3`）—— 「剥 code span 仍漏裸数字」是这张表的固有坑，第三轮沿用此剔除法 |
| FP-D | `check-optionsdesk-rule-constants.ts:620-625` 未命中 | 探针正则太弱（`spec|\.ts`）。实读 `:598-600` + `:620-625` 确认 `siblings` 取该目录全部 `.ts`、**不排除 `*.spec.ts`**，只豁免三个具名文件 ⇒ Guardrail 3 的说法成立、锚点正确 |

## Coverage Summary（第二轮重算，已含 T015）

| Requirement Key | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-001 选择器三档 / 收起态 / 非平铺 | ✅ | T008, T009, T011, T013 | |
| FR-002 金额类四项折算 | ✅ | T005, T006, T007, T012 | |
| FR-003 价格类三项不折算 | ✅ | T005, T006 | |
| FR-004 聚合排序与显示同口径 | ✅ | T005, T006 | 防御性约束，结构上不可能违反（见 tasks §蓄意零覆盖） |
| FR-005 不持久化 / 停留保持 / 两页签独立 | ✅ | T008, **T015** | 三臂缺任一臂错误实现都会绿 |
| FR-006 降级标注 / 两聚合值不完整 / 不混入 | ✅ | T005, T006, T008, T010, T011 | |
| FR-007 汇率值与取数时刻 / 参考汇率措辞 | ✅ | T002, T006, T008, T010 | |
| FR-008 原币种相同时直出 | ✅ | T005, T006 | 逐字 + spy 双断言（`.equals()` 挡不住「乘 1」） |
| FR-009 切档即时重算重排 | ✅ | T003, T006, T009, T011 | |
| FR-010 作用范围限列表页 | ✅ | **T015** | 持仓详情有防御臂；订单详情结构上不可达，见 F4 与 tasks §蓄意零覆盖 |
| FR-011 首次进入为原币种且与上线前一致 | ✅ | T006, T008, T010, T011 | |
| FR-012 降级组沉底 / 保持相对顺序 | ✅ | T005, T006, T011 | |
| FR-013 收起态显当前 / 降级行标 / 不改列宽字号 | ✅ | T006, T008, T009, T010, T011, T013 | |
| SC-001 金额类 100% 选定币种 | ✅ | T005, T006, T011 | |
| SC-002 排序与显示一致 / 折算前后顺序相同 | ✅ | T005, T006 | |
| SC-003 错误金额数量为 0 | ✅ | T005, T006, T011 | |
| SC-004 1 秒内重算 / 无二次跳变 | ✅ | T009, T011, T013 | 机制面（每档独立 query key）+ 真机面 |
| SC-005 再进入复原 100% / 跨页签影响 0 | ✅ | T008, **T015** | |
| SC-006 与上线前 100% 一致 | ✅ | T006 | 两次响应逐字节相同是唯一可机器化形态 |
| SC-007 列宽字号 100% 不变 | ✅ | T009, T011, T013 | |

**三层辅助矩阵**：`state_branches` 21/21 · Edge Case 8/8 · Acceptance Scenario 16/16 均逐条有落点（表在 `tasks.md`，本报告不复制）。

> ⚠️ 覆盖矩阵回答的是「**有没有**落点」，不是「落点**够不够**」。F4 就是被 ✅ 掩盖的那一类 —— FR-010 有落点，但落点只覆盖它点名的两个面之一。下一轮仍需按「落点覆盖了该条需求的全部面吗」人工过一遍。

## Constitution Alignment Issues

**无 CRITICAL。** 逐条核对 v1.4.0 五原则：

| 原则 | 判定 | 依据 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE）+ UI feature 强制 Mockup 步 | ✅ | specify → clarify（两轮 Session）→ Mockup（`design/` 五帧 + 六项探测 GATE PASS）→ plan → tasks → analyze ×2。Mockup 卡点未跳 |
| II. Test-First TDD | ✅ | 每个 impl task 的 `→ verify:` 均为「先红 → 绿」，且每条都带定向变异证明能红 |
| III. Atomic Task 30min–2h | ⚠️ carried | T006 = 13 项，超 082 K1 阈值 12。第一轮已记为蓄意保留（`analysis.md` F2 行），第二轮维持该判断 |
| IV. Module Boundary（扁平 / 贫血 / 护城河 / 零-class） | ✅ | FX adapter 住 `optionsdesk/` 文件平铺、不建 `fx/` 子目录；只读自有 `broker_*` / `anchor` 表；T004 显式断言 `OptionsdeskModule.imports` 与 `eslint.config.mjs` 零改动；零新 use case（25 个不变，复审线 30） |
| V. 类型同步链 + 跨端单 PR + 两层验证 | ✅ | T007 两步分别跑；单 PR；两层正交验证齐备（hermetic e2e = T011/T015、契约冒烟 = T012） |

## Unmapped Tasks

| Task | 说明 |
|---|---|
| T004（config 两个 baseUrl + `ALLOWLIST` + 按 `kind` 装配） | 蓄意 —— 接线与环境门控，不承载 spec 层需求 |
| T014（覆盖收口 + 全量门 + PR） | 蓄意 —— 门 task |

两者均已在 `tasks.md`「蓄意零覆盖」段写明理由，下一轮 analyze 不应为它们补覆盖表行。

## Metrics（第二轮）

- **Total Requirements**：FR 13 + SC 7 = **20**（辅助层：`state_branches` 21 · Edge Case 8 · AS 16 · US 3）
- **Total Tasks**：**15**（T001–T015；T015 为第一轮 F2 修复时从 T011 拆出，按「追加编号、不重排」体例）
- **Coverage %**：FR **13/13** · SC **7/7** · `state_branches` **21/21** · Edge Case **8/8** · AS **16/16**
- **task 臂号引用**：208 处，悬空 / 越界 **0**
- **plan 决策覆盖**：D0–D9 **10/10**，双向差集为空
- **代码锚点核验**：41 条 → 38 成立 · 1 真错（F7）· 1 数字过期（F5）· 1 探针假阳性（FP-D）
- **Ambiguity Count**：**0**（占位符 0 / 模糊形容词 0 / 无编号 `MUST` 0）
- **Duplication Count**：**0**
- **Critical Issues Count**：**0**
- **强调标记**：spec 4 / plan 46 / tasks 92（预算 ≤ 10）⇒ F9，蓄意留待单独一轮

## Next Actions

**无 CRITICAL / HIGH，可进 `/speckit-implement`。** F4–F8、F10 六条已于本 PR 全部处置；F9 蓄意留待单独一轮降噪。

MVP 路径不变：**T001 → T007**（server 侧折算链与契约完整，US1 在 IT 层可独立验收，SC-006 逐字节比对在此闭环）。

## 修复记录（第二轮，2026-09-17）

| Finding | 处置 | 落点 |
|---|---|---|
| F4 LOW | 已修 | `tasks.md`「蓄意零覆盖」段新增 FR-010 的结构论证（三个端点各自的 use case + mobile 独立 query key + 订单分段仍是 placeholder） |
| F5 LOW | 已修 | `plan.md` Gate 0.4 表格与 Evidence 行两处 24 → 25，写明 084 带来的 +1 与「距 30 余 5」 |
| F6 LOW | 已修 | `plan.md` 测试映射表下新增粗粒度声明 + 5 条差异枚举，逐臂归属以 tasks 为准 |
| F7 LOW | 已修 | `tasks.md` Path Conventions 与 T010、`plan.md` D8 三处改写 `.chip` 为「行级徽标 + 实体 class + mockup 称谓」，并标出 `bg-warn-soft` 需另定 |
| F8 LOW | 已修 | `plan.md` `spec.md:18-39` → `18-38` |
| F10 LOW | 已修 | 本文件 Coverage Summary 重算，FR-005 / FR-010 / SC-005 归到 T015 |
| F9 MEDIUM | **蓄意不修** | 维护者已定单独一轮降噪。本 PR 插入文本零新增标记，hook 计数改动前后逐字不变（plan 46 / tasks 92） |

---

## 第一轮记录存档（2026-09-17）

第一轮三条 finding 与其处置，**第二轮已逐条复验**：

| Finding | Severity | 摘要 | 第一轮处置 | 第二轮复验 |
|---|---|---|---|---|
| F1 | LOW | tasks 新建 `refusing-fx-rate.adapter.ts`，plan 文件清单未登记 | plan server 新增段补入该文件 + 立意注记 | ✅ **已闭合** —— `plan.md`「新增 / 触碰文件清单」含该文件 |
| F2 | MEDIUM | 四个 task 的独立验收臂超 082 K1 阈值 12：T011=24、T006=19、T005=15、T001=13 | **部分修**：T011 拆出 T015；T006 / T005 / T001 蓄意保留（臂多源于「每条 `state_branch` 都要断言」，且断言依赖同一夹具，拆开会重复搭建共同前提） | ◐ **按原决定保留** —— T011 拆分生效（第二轮口径实测 T011=9、T015=4）；T006=13 仍超阈值，维持蓄意保留 |
| F3 | LOW | plan `status: drafted`，与 spec `tasks-ready` 不对齐 | plan `status → approved` | ✅ **已闭合** —— `plan.md` frontmatter 为 `approved` |

> 第一轮与第二轮的臂数口径不同（第一轮把定向变异也计入，第二轮只数圈号项），故同一 task 两轮数字不同；**两轮口径下 T006 都超 12**，结论不受影响。
>
> 第一轮已排除的假阳性：FP1（T007 / T012 / T014 验收臂数 = 0 疑似无验收 —— 实为命令式判据）· FP2（占位符扫描的 `exit=0` 图例失效 —— `head` 恒返 0，真实结论靠输出为空）· FP3（plan 测试映射表提取出越界行号 —— 来自 `f3` / `idx3` 被误提）。第二轮的 FP-C 与 FP3 同源。
