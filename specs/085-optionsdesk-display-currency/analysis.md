# Specification Analysis Report: 085-optionsdesk-display-currency

> `/speckit-analyze` 产出（2026-09-17）。**只读**：未修改 spec / plan / tasks；本文件是报告本身。
> 覆盖检查一律逐条 grep / 脚本对账，不靠通读（`.claude/rules/sdd-authoring.md` § 反模式）。
> 🚨 每条 finding 下结论前都先问过「这是真问题，还是我自己探针的误报」——被排除的 3 条单列在 §已排除的假阳性。

## 扫描面声明（先列层，再扫）

| spec / plan 的层 | 扫了吗 | 方式 |
|---|---|---|
| `state_branches`（21） | ✅ | 脚本：`rg -c "^  - '"` 实测 21；tasks 覆盖表逐行同序 21 行；plan 测试映射表行号并集换算后 = 1–21 全集 |
| Functional Requirements（13） | ✅ | 脚本：编号集合相等（spec 13 ↔ tasks FR 表 13） |
| Success Criteria（7） | ✅ | 脚本：编号集合相等（🚨 SC 是系统性盲区，单列一张表） |
| Edge Cases（8） | ✅ | 脚本：行数对齐 + 落点人工核 |
| Acceptance Scenarios（16） | ✅ | 脚本：`^[0-9]+\. \*\*Given\*\*` 实测 16（🚨 标准矩阵**够不到**这一层，单列） |
| User Stories（3） | ✅ | 脚本：`^### User Story` 实测 3；US1/US2 同为 P1、US3 为 P2 |
| 散文层无编号 `MUST` | ✅ | 脚本：`rg 'MUST' \| rg -v '^- \*\*(FR\|SC)-'` 去 frontmatter 后**零命中** ⇒ 无「写在 AS 里却没 FR 承接」的隐形需求 |
| Clarifications（9 条答案） | ✅ | 脚本计数 9；人工逐条追到 FR 正文（含 Session 2026-09-17 对 09-16 第 5 问的修订） |
| Assumptions（8 条） | ✅ | 人工逐条：单一市场前提 / 券商币种可空 / 参考汇率非结算 / 只改展示口径 / 同层状态 / 三字母代码 / web_compat / 明确不在范围 |
| plan D0–D9 决策（10） | ✅ | 脚本：plan 定义的 D 编号 vs tasks 引用的 `plan Dx` **双向差集为空** |
| plan 反例臂（10 条） | ✅ | 脚本：10 个标志词在 tasks 中命中数**全部 ≥ 1**，零遗漏 |
| task 粒度（Constitution §III） | ✅ | 脚本：每 task 独立验收臂计数（阈值 12，照 082 K1 判据）⇒ F2；修复后复验 T011 24 → 11、T015 = 9 |
| 术语一致性 | ✅ | 脚本：9 个关键术语在三份产物中的出现次数比对 |
| 模糊形容词 / 占位符 / FR 近重复 | ✅ | 脚本：词表扫描（零命中）+ FR/SC 首句签名粗筛（零重复） |
| 文件清单一致性 | ✅ | 脚本：plan「新增 / 触碰文件清单」vs tasks 引用文件求差集 ⇒ F1 |
| Key Entities（5） | ⏭️ 蓄意不单扫 | 本片**零新表、零 schema 变更**，实体是呈现概念而非持久化实体；字段级 SoT 在 swagger 装饰器 |

## Findings

| ID | Category | Severity | Location(s) | Summary | Recommendation |
|----|----------|----------|-------------|---------|----------------|
| F1 | Inconsistency | LOW | plan.md「新增 / 触碰文件清单」· tasks.md T004 | tasks 新建 `refusing-fx-rate.adapter.ts`，plan 文件清单未登记该文件。plan 正文（`optionsdesk.module.ts` 条目）只写「mock 档绑**调用即抛**的拒绝壳，照 `refusing-collection.adapter.ts` 立意」，未给文件名 | **已修（2026-09-17）**：plan「新增 / 触碰文件清单」的 server 新增段补入 `refusing-fx-rate.adapter.ts`，并注明立意来源与「跨 ctx 不可 import 故另落一份」的理由 |
| F2 | Constitution §III | MEDIUM | tasks.md T001 / T005 / T006 / T011 | 四个 task 的独立验收臂超 082 K1 阈值 12：**T011=24**、T006=19、T005=15、T001=13 | **部分已修（2026-09-17）**：**T011 拆出 T015**（24 → T011=11 + T015=9，双双入阈值）—— T015 单列 FR-005 / SC-005 的四条状态臂（跨屏保持 / 离开复原 / 两页签独立 / 详情页不受影响），失败定位成本最高的那组因此独立。**T006=19 / T005=15 / T001=13 保留不拆**：臂多源于「每条 `state_branch` 都要断言」而非工作量大（本片零 schema / 零写路径 / 零新 use case），且「折算前后组顺序相同」「两次响应逐字节相同」这类断言依赖同一夹具，拆开会让共同前提重复搭建 |
| F3 | Inconsistency | LOW | plan.md frontmatter | plan `status: drafted`，而 spec 已 `tasks-ready`、tasks `not-started`。仓内 081–083 的 plan 用 `approved` 标「已过 plan → tasks gate」 | **已修（2026-09-17）**：plan `status` 推到 `approved`，与 spec `tasks-ready` / tasks `not-started` 三方语义对齐（照 081–083 体例） |

## 已排除的假阳性（我自己探针的误报）

| ID | 探针报的 | 为什么是误报 |
|---|---|---|
| FP1 | T007 / T012 / T014 的验收臂数 = **0**，疑似「无验收」 | 探针数的是 `①–⑭` 圈号，而这三个 task 的验收是**命令式判据**不是编号臂：T007 有 5 条（`git diff --stat` 非空 / `grep displayCurrency` / `mobile:typecheck` / `check-api-property-nullable` / nullable 生成类型逐字段核）；T012 有冒烟绿 + 参数名改错一字的变异留档；T014 有全量门 + 治理脚本全扫 + 私有数据扫描 + PR 协议。**均有可判定的验收**，非缺口 |
| FP2 | 占位符 / 模糊形容词扫描打印「exit=0」，按我写的图例应解读为「有命中」 | **判据本身坏了**：`exit=$?` 取的是管道末端 `head` 的退出码，`head` 恒返回 0，与 `rg` 是否命中无关。真实结论靠**输出为空**得出 —— 两项均**零命中**，结论仍成立，但那行 exit 图例无效 |
| FP3 | plan 测试映射表提取出 branch 行号 `3`（换算序号 `-14`，越界） | 该 `3` 来自该表 env-gated 行的正文「真 vendor 字段校真（22 字段 / `f3` / 新浪 `idx3` / 反向 MISS）」中的 `f3` / `idx3`，被 `rg -o '[0-9]+'` 误提。剔除后行号 **18–38 连续无洞** |

## Coverage Summary

| Requirement Key | Has Task? | Task IDs | Notes |
|---|---|---|---|
| FR-001 选择器三档 / 收起态 / 非平铺 | ✅ | T008, T009, T011, T013 | |
| FR-002 金额类四项折算 | ✅ | T005, T006, T007, T012 | |
| FR-003 价格类三项不折算 | ✅ | T005, T006 | |
| FR-004 聚合排序与显示同口径 | ✅ | T005, T006 | 防御性约束，结构上不可能违反（见 tasks §蓄意零覆盖） |
| FR-005 不持久化 / 停留保持 / 两页签独立 | ✅ | T008, T011 | 三臂 ③a/③b/③c 缺任一臂错误实现都会绿 |
| FR-006 降级标注 / 两聚合值不完整 / 不混入 | ✅ | T005, T006, T008, T010, T011 | |
| FR-007 汇率值与取数时刻 / 参考汇率措辞 | ✅ | T002, T006, T008, T010 | |
| FR-008 原币种相同时直出 | ✅ | T005, T006 | 逐字 + spy 双断言（`.equals()` 挡不住「乘 1」） |
| FR-009 切档即时重算重排 | ✅ | T003, T006, T009, T011 | |
| FR-010 作用范围限列表页 | ✅ | T011 | |
| FR-011 首次进入为原币种且与上线前一致 | ✅ | T006, T008, T010, T011 | |
| FR-012 降级组沉底 / 保持相对顺序 | ✅ | T005, T006, T011 | |
| FR-013 收起态显当前 / 降级行标 / 不改列宽字号 | ✅ | T006, T008, T009, T010, T011, T013 | |
| SC-001 金额类 100% 选定币种 | ✅ | T005, T006, T011 | |
| SC-002 排序与显示一致 / 折算前后顺序相同 | ✅ | T005, T006 | |
| SC-003 错误金额数量为 0 | ✅ | T005, T006, T011 | |
| SC-004 1 秒内重算 / 无二次跳变 | ✅ | T009, T011, T013 | 机制面（每档独立 query key）+ 真机面 |
| SC-005 再进入复原 100% / 跨页签影响 0 | ✅ | T008, T011 | |
| SC-006 与上线前 100% 一致 | ✅ | T006 | **两次响应逐字节相同**是唯一可机器化形态 |
| SC-007 列宽字号 100% 不变 | ✅ | T009, T011, T013 | |

**三层辅助矩阵**：`state_branches` 21/21 · Edge Case 8/8 · Acceptance Scenario 16/16 均逐条有落点（表在 `tasks.md`，本报告不复制）。

## Constitution Alignment Issues

**无 CRITICAL。** 逐条核对 v1.4.0 五原则：

| 原则 | 判定 | 依据 |
|---|---|---|
| I. SDD（NON-NEGOTIABLE）+ **UI feature 强制 Mockup 步** | ✅ | specify → clarify（两轮 Session）→ **Mockup**（`design/` 五帧 + 六项探测 GATE PASS，`handoff.md`）→ plan → tasks → 本 analyze。Mockup 卡点未跳 |
| II. Test-First TDD | ✅ | 每个 impl task 的 `→ verify:` 均为「先红 → 绿」，且**每条都带定向变异**证明能红 |
| III. Atomic Task 30min–2h | ⚠️ F2 | 四个 task 臂数超阈值，见 F2；无 CRITICAL |
| IV. Module Boundary（扁平 / 贫血 / 护城河 / 零-class） | ✅ | FX adapter 住 `optionsdesk/` 文件平铺、不建 `fx/` 子目录；只读自有 `broker_*` / `anchor` 表；T004 显式断言 `OptionsdeskModule.imports` 与 `eslint.config.mjs` **零改动**；零新 use case（24 个不变，ADR-0043 复审线 30） |
| V. 类型同步链 + 跨端单 PR + 两层验证 | ✅ | T007 两步分别跑（`export-openapi` → `affected -t generate`）；单 PR；**两层正交验证齐备** —— ① hermetic UI e2e = T011、② 契约冒烟 = T012 |
| Quality Gates（conventional commits / body ≤150 字符 / squash / auto-merge） | ✅ | 本片 commit 已按此执行（曾撞 `body-max-line-length` 并已修正）；T014 按 `pr-creation-protocol.md` 开 PR |

## Unmapped Tasks

| Task | 说明 |
|---|---|
| T004（config 两个 baseUrl + `ALLOWLIST` + 按 `kind` 装配） | **蓄意** —— 接线与环境门控，不承载 spec 层需求 |
| T014（覆盖收口 + 全量门 + PR） | **蓄意** —— 门 task |

两者均已在 `tasks.md`「蓄意零覆盖」段写明理由，**下轮 analyze 不应为它们补覆盖表行**。

## Metrics

- **Total Requirements**：FR 13 + SC 7 = **20**（辅助层：`state_branches` 21 · Edge Case 8 · AS 16 · US 3）
- **Total Tasks**：**15**（T001–T015；T015 为 F2 修复时从 T011 拆出，按 084 T018 / 083 T026 的「追加编号、不重排」体例，位置在 T011 之后）
- **Coverage %**：FR **13/13 = 100%** · SC **7/7 = 100%** · `state_branches` **21/21 = 100%** · Edge Case **8/8** · AS **16/16**
- **plan 决策覆盖**：D0–D9 **10/10**，双向差集为空
- **plan 反例臂覆盖**：**10/10**
- **Ambiguity Count**：**0**（占位符 0 / 模糊形容词 0 / 无编号 `MUST` 0）
- **Duplication Count**：**0**（FR / SC 首句签名粗筛无近重复）
- **Critical Issues Count**：**0**

## Next Actions

**无 CRITICAL / HIGH，可进 `/speckit-implement`。** 三条 finding 已于 2026-09-17 全部处置（见下方修复记录）。

MVP 路径不变：**T001 → T007**（server 侧折算链与契约完整，US1 在 IT 层可独立验收，SC-006 逐字节比对在此闭环）。

## 修复记录（2026-09-17，维护者批准「都修」）

| Finding | 处置 | 落点 | 复验 |
|---|---|---|---|
| F1 LOW | 已修 | `plan.md` 文件清单 server 新增段补 `refusing-fx-rate.adapter.ts` + 立意注记 | `rg refusing-fx-rate plan.md` 命中；`git diff --stat plan.md` 仅 2 处改动，无夹带 |
| F2 MEDIUM | **部分修** | `tasks.md` T011 拆出 **T015**（四条状态臂），覆盖表 / 依赖与并行 / Implementation Strategy / Clear 批次同步 | 臂数 T011 24 → **11**、T015 **9**；**越界与悬空臂号扫描零命中**；覆盖表引用含 T015 共 13 处；五层条数不变（21 / 13 / 7 / 16）。⚠️ T006=19 / T005=15 / T001=13 **蓄意保留**，理由见 F2 行 |
| F3 LOW | 已修 | `plan.md` frontmatter `status: drafted → approved` | `rg '^status:' plan.md` ⇒ `approved` |

> 拆分采用「追加编号、不重排」：重排 T012–T014 会让本报告与覆盖表中所有既有引用集体失效，而 084 的 T018、083 的 T026 都是同一体例。
> 拆分后 T011 的臂由 ⑤–⑪ 顺移为 ④–⑨，覆盖表 40+ 处引用按「组合串先于单串、单串从小到大」的次序整体重编号，避免新生成的编号被后续规则二次改写。
