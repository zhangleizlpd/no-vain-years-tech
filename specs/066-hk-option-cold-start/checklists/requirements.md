# Specification Quality Checklist: 港股期权接入与锚冷启动开通港股

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-22
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

**通过，但有三条要写在明处的判断依据 —— 不写就是把「我判它过了」伪装成「它客观地过了」。**

1. **「Written for non-technical stakeholders」是按本仓既定受众判的，不是按字面判的。**
   本仓是单人开发、受众即作者，既有 spec（045 / 060 / 065）全部是同一技术密度。若按字面的
   「非技术读者可读」判，本文与它们**一样不通过**。这里判过是为了与仓内基线一致，
   而不是因为它真的面向非技术读者。下一个人别把这一格当成「本文已通俗化」的证据。

2. **「No implementation details」有三处贴边，判过但登记在此：**
   - FR-005「MUST 被规范成空值，MUST NOT 以字面量字符串落库」——「落库」是存储层措辞
   - FR-017「MUST 在交易时段表中被显式表达」——「交易时段表」指向一个具体产物
   - Clarifications 段整段是 vendor 实测数字（132 合约 / 244 vs 252 / 2023-06-27）
     三处都**刻意保留**：前两条若抽象掉就不再可证伪（「规范成空值」抽象成「正确处理」等于没说）；
     Clarifications 记的是**实测事实**，按 sdd.md 的体例它本就该落在 spec 而非 plan。

3. **有一项已知未决，但它不是 `[NEEDS CLARIFICATION]`。**
   港股未平仓合约数的归属交易日（Clarifications 第二节）正在跨交易日采样，2026-08-25 出结论。
   它没有被标成 clarification marker，因为**它不需要人来拍板，它需要一次测量** —— 标成 marker
   会把「去测」误导成「去问」。约束改由 **FR-016 的硬闸**承担：结论落地前港股期权快照
   MUST NOT 进入生产采集轮。⇒ 这一项**不阻塞** `/speckit-plan`，只阻塞对应那一个 task。

   > 📌 **后记（本段以上是评审当时的判断，保留原样；以下两处此后已变）**
   >
   > - **2026-08-23，`FR-016` 换了口径**：硬闸撤销，改为「采集照常进行、`oi_as_of` 按现行规则先写，
   >   结论落地后重标」。理由是不对称性判反了 —— 不采是**永久缺口**（供应方不提供历史快照），
   >   而 `oi_as_of` 是独立列、不进唯一键，重标只是一条确定性 `UPDATE`。**等待才是不可逆的那一侧。**
   > - **2026-08-25，那次测量已出结论**：港股 OI 在 D 日收盘当晚（16:30–21:30 之间）就已定稿，
   >   `oiAsOf = D`，归属规则按市场分叉。见 spec `## Clarifications` 的 2026-08-25 段。
   >
   > ⇒ 本段第 3 条**「它需要一次测量而不是一次拍板」的判断成立且已兑现**；只有它当时援引的
   > 那个硬闸不再存在。别照着上面那句去找 `FR-016` 的硬闸，仓里已经没有了。

**下一步**：可直接进 `/speckit-clarify` 或 `/speckit-plan`。三个未知里两个已由 PoC 实测消掉，
第三个有硬闸兜着，clarify 阶段大概率无问可提 —— 若无实质歧义可跳过 clarify 直接 plan。
