# Specification Quality Checklist: 雷达跨标的聚合三视图（M2c）

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-09
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — 3 问已于 specify 阶段全部收敛（2026-08-09）
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## 机器验证（不是通读）

**末次跑于 clarify 收口后（2026-08-09）**：

| 检查                       | 命令                                                   | 结果                                                               |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| frontmatter schema         | `npx tsx scripts/check-spec-frontmatters.ts`           | ✅ 49 file(s) ✓                                                    |
| prettier 下划线陷阱        | `prettier --write` 后 `grep -nE '[a-z]\*[a-z_]+'`      | ✅ 零命中（标识符未被改写）                                        |
| `NEEDS CLARIFICATION` 残留 | `grep -c`                                              | ✅ 0                                                               |
| FR 编号连续性              | `grep -oE '^\- \*\*FR-[0-9]+[a-z]?'`                   | ✅ FR-001…FR-027 无断号（含 clarify 追加的 `FR-007a` / `FR-010a`） |
| 模糊形容词残留             | `grep -noE '流畅\|快速\|合理\|适当\|友好\|简洁\|高效'` | ✅ 零命中（`SC-006` 的「流畅」已改为两条可观测判据）               |
| `state_branches` 条数      | frontmatter 计数                                       | 16 条（specify 期 14 + clarify 追加 2）                            |
| clarify session bullet 数  | `awk` 段内计数                                         | 3（与实际问答数一致，无重复）                                      |

## Notes

### 「No implementation details」判 pass 的理由（不是放水）

spec 中出现了 `option-snapshot-coverage.check.ts` / `leg-tab.rules.ts` 等**已 ship 的实装锚点**。它们在这里不是「怎么实现本片」，而是**「本片 MUST NOT 重新定义什么」的指向** —— `FR-015` 要求档位边界与腿族判据追溯到 047 的具名常量，不给出锚点这条要求就不可执行。同样的写法见 045 / 047，是本仓既定形态。

### 三问收敛结果（2026-08-09，specify 阶段）

| #   | 问题                         | 定案                                                                                                                                            |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 机会视图「适格腿」的成员判据 | **建仓腿族 ∪ 收租腿族**，意图只标注不过滤。⇒ 机会视图与另两个 seg 是「并集 vs 分族切片」，**不是超集**；两族皆不属的中段 DTE 腿不进 P1 任何视图 |
| Q2  | 未选仓位水位标的的处置       | **照常进聚合、照常判档排序**，仅意图列标「意图未定」。判据 = 档位不依赖水位（水位只喂意图矩阵）                                                 |
| Q3  | 排序键集合与默认             | **主键固定 = 档位（不可切）+ 辅键三选一可切**（距 W / DTE / 标的），默认辅键 = 距 W                                                             |

Q1 定案后 Q2 自动解耦（意图不过滤 ⇒ 水位未选不影响成员资格），故未走「顶部横幅兜底」那条路径。

### clarify 阶段三问（2026-08-09，`status` 已翻 `clarified`）

| #   | 问题                           | 定案                                                                      | 落点      |
| --- | ------------------------------ | ------------------------------------------------------------------------- | --------- |
| C1  | 跨标的 `asOf` 不一致时顶部取谁 | **取最旧** + 落后票逐行加陈旧标；「有快照但陈旧」不归入「未就绪」桶       | `FR-010a` |
| C2  | 聚合视图列集                   | **分层** —— 决策必需 6 项常显，047 其余列横滑可达，列序按聚合场景重排     | `FR-007a` |
| C3  | 点腿跳 P2 落在哪个 Tab         | **落该腿所属族的 Tab** 并高亮，覆盖 047 `FR-016` 意图默认，仅限此跳转路径 | `FR-025`  |

**两项判定为不值得占问答 quota**：① 端点形态（1 个带参数 vs 3 个）→ 属 plan 阶段（本仓 API SoT = swagger 装饰器）② `SC-006`「流畅」→ 是撰写缺陷不是决策点，已自行改为两条可观测判据（滚动条长度反映全量 + 无持续可见空白区），刻意不取帧率因 perf 口径已排除客户端渲染。

**一处被 grep 而非通读抓到的**：C1 / C3 都产生了新的状态分支，`state_branches` 从 14 → 16。第二次踩同一个坑（见下节），说明「改 FR 后回扫 `state_branches`」必须是机械步骤而非记忆。

### 回填后的一致性修正（值得记：`state_branches` 会与 FR 脱钩）

三问收敛后改 FR 时，`state_branches` 里有 **2 条**仍写着旧判据（「意图判定放行」作为成员条件、「两族皆不属 → 不进两个意图视图」漏了机会视图），已一并修正。

⚠️ 这类脱钩**不会被任何 checker 抓到** —— frontmatter schema 只验结构不验语义。而 `state_branches` 是 IT 穷举的直接依据，脱钩的后果是**测试照旧判据写、且全绿**。改 FR 后 MUST 回扫 `state_branches`。

### 一项待验事实（不阻塞 specify，阻塞 perf 定档）

**V-B · 聚合规模的实际分布**：先验 perf 档建立在「意图视图行数由带天然收窄」这个**推断**上 —— 047 实测的是单票全链 730 行，从没量过带内还剩多少。plan 或 impl 期须实测校准；若与全链同量级，`FR-024` 虚拟化从建议升为硬前置。

### 防混淆资产

spec 新增 § **P1 四 seg ≠ P2 三 Tab** 对照表 —— specify 当天 user 本人即混过一次（把 047 P2 详情页截图当成本片范围）。下游实现前 MUST 先过该表。

---

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
