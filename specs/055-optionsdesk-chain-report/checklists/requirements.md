# Specification Quality Checklist: 标的链分析报表

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-14
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
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

## Notes

### ✅ 全项通过（2026-08-14 `/speckit-clarify` 后）

原唯一未过项（`FR-039` 的 `[NEEDS CLARIFICATION]`）已在 clarify 中解决：从「全腿」/「活跃度」格值下钻**落全腿视角**。

`/speckit-clarify` 共问答 **4 题**（未用满 5 题额度），另有 4 处判定为「有合理默认、不占问额」并写入 Assumptions（加载与失败态 / 不预取 / 不设到期日上界 / 只覆盖认沽腿）。

🚨 **其中 1 题是 clarify 扫描扫出的 spec 内部自相矛盾**（不是欠明确）：起草时的 edge case 写「未建锚 ⇒ 建仓格值不可用、其余三种照常」，暗示未建锚可进报表；但入口位置在详情屏 `ListHeaderComponent` 末尾，而**详情屏未建锚时是整页建锚引导**（046 `FR-011`），三块根本不存在 ⇒ 入口无处可挂。已定为**不可达**，并清理了 frontmatter / edge case / FR 三处引用。

### 🚨 档界标定实测（2026-08-14 第二轮）暴露的三处缺口 —— 已补，但把一个口径错误也一并订正

实测面 = dev `2026-08-11` / 12 链 / 3531 条认沽腿，三视角召回判据逐字按 `leg-recall.rules.ts` 复刻。

1. **口径订正** —— 起草期的标定脚本**未按视角切分候选集**，把「全腿年化」的分布读成了「收租年化」的。按真判据复算后收租年化值域仅 `[2.2, 71.4]`（成色上界本就不召回深价内腿），爆炸的只有全腿年化。⚠️ 这类错**不会红**：脚本照样出表、数字照样有量级，只是算的是另一个视角的腿。
2. **`FR-016` 的三态覆盖不到第四种成因** —— 四种格值各跑各的召回集 ⇒「有腿、过了三视角一律的门槛、但不在当前格值的召回集内」实测占全网格 **35.3%**（建仓格值）/ **28.0%**（收租格值）。已补 `FR-009a` / `FR-016a`（两级编码）。连带订正 `FR-010` 与 `SC-002`：「位置不变」原被写成「仅读数与着色变化」，漏掉**格态也会变**。<br>⚠️ 本条的两个数在本轮内**改过一次**：初稿写「占建仓段内格 85.5%」，自查时发现那是**空格占比**、不是第四成因占比（85.5% 的空格里只有 12.5% 属第四成因，其余是骨架本来就空）。同一轮还改掉一个「全腿段内填充率 100%」——把「全腿视角不设期限段」错当成了填充率，真值 **41.6%**。两处都是**口径混淆**而非算错，且都不会红。
3. **页脚计数漏了一整道门槛** —— 实装里「三视角一律」的门槛有**两道**（权利金 + 活性），而 `FR-005` 只提权利金、`FR-034` 只有两个计数。已定：骨架维持只过权利金（活性挡下的腿有合约、只是没人碰过，踢出骨架会误报成「无合约」，撞 US2），页脚加**第三个互斥计数**。已补 `FR-005` 注 / `FR-034` 三计数 / `SC-006` / Key Entities。<br>⚠️ 顺带修掉一处**既有的口径混淆**：`SC-006` 原把「权利金 27.0%」（占全量）与「行下界 57.6%」（占骨架）并列在一句里而不标分母。三个计数并列后这种混淆会直接导致加不回全量，故现在每个计数都 MUST 带分母，并有一条求和不变量。
4. **`FR-019a` 只定了档界口径、没定形态** —— 实测线性等距在三种格值上让最淡档吞掉 52.4% / 96.8% / 99.2% 的格。已补 `FR-019b`（形态按格值各自定 + 「任一档不得吞过半」的可验判据）与 `SC-012`。📌 但**「全局固定」这条不必改**：全池分位标出的固定数与被否掉的「按链自适应」是两回事。

### `/speckit-analyze`（2026-08-14）扫出的两条 spec 侧问题 —— 已修

扫描面 = spec 的**全部 10 层**（`state_branches` / 背景 / Clarifications / User Story / **Acceptance Scenario** / Edge Case / FR / Key Entities / SC / Assumptions+Dependencies），无差集。结果：**CRITICAL 0 · HIGH 0**，7 条 MEDIUM/LOW 全部修掉。其中落在 spec 上的两条：

1. **术语漂移** —— 「段外」是 mockup 已画进列头 chip 的**用户可见文案**，plan 用 4 次、tasks 用 8 次，而 **spec 里一次都没有**（只说「召回段之外的列」）⇒ 将来对照 spec 验收时该文案找不到依据。已在 `FR-009a` 把措辞与「主信号不得只靠底色」一并钉死。
2. **stale 的版式注记** —— `Assumptions` 第 3 条写「此项属版式细节，**mockup 阶段可推翻**」，而 mockup 已完成且采用了下方。已改为「2026-08-14 mockup 已定案采用下方」。

📌 另有一条**跨层缺口**落在 tasks/plan 上、但根在 spec 的 `Key Entities`：四项实体里的「链级读数」（含**现价**）在 tasks.md **零命中** —— 三项格/列/行都在 DTO task 里逐项列了，唯独第四项漏了，而页头要显示现价与三时点。已在 T006 与 plan 切分意图里补齐，并加了「`spot` 非空」的机器断言兜底。

### 一次迭代中的修正

- **`SC-008` 原写「三处的改动行数为 0」** —— 那是实现层度量，不是用户可验的结果，撞「Success criteria are technology-agnostic」。已改写为可观测的等价陈述：「本片前后，同一标的的锚判定结果、意图判定结果、选约表返回的腿集合与顺序逐条一致」。

### 两处刻意保留的技术性表述（判定为不违反，理由在此备查）

1. **`SC-007`「新增第三方运行时依赖数为 0」** —— 这是 owner 明确设定的**约束**，不是泄漏的实现选择；本仓已有先例（046 的同名约束）。约束本身就是验收面。
2. **`FR-040` 引用了详情屏的手势结构作为「必须独立屏」的理由** —— 该理由是本条 requirement 得以成立的**判据**，去掉它这条 MUST 会读成偏好。本仓 spec 惯例保留此类判据（054 spec 同形）。

### 领域术语密度

本 spec 含较高密度的期权领域术语（隐含波动率、年化费率、价外幅度、平值）。判定为**不违反**「written for non-technical stakeholders」：本 feature 的唯一干系人即领域专家本人，且这些术语在仓内 045–053 各 spec 中已是既有词汇，替换成通俗说法反而会与既有判据脱钩。
