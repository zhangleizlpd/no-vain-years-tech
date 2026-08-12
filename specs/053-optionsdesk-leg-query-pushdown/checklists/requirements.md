# Specification Quality Checklist: 选约表查询下沉 —— 每视角独立请求 + 服务端筛选与截断

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-12
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain —— **4 问 4 答已闭合**（2026-08-12 clarify session，见下）
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

### clarify 阶段的处置结果（2026-08-12，4 问 4 答）

| 开放项                                                                                     | 结论                                                                                     | 落到                                                      |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 筛选生效时机（**本次扫描新发现**，049 那条定案的语境是客户端过滤，上服务端后不再自动成立） | 实时 + 防抖；排除「客户端本地预筛」                                                      | `FR-016a` + `FR-016b`                                     |
| 预热的语义与触发时机                                                                       | 错峰（首屏只取当前视角，落地后后台补其余两个）；各视角自持筛选状态                       | `FR-024` / `FR-024a` / `FR-024b` + `SC-008` + US3-AS2/AS3 |
| 三次请求的一致性处置（主 plan 未决 #1）                                                    | 检测 + 重取（复用已有 `asOf`，最多一次，仍不一致则提示）；**并修正主 plan 对水位的描述** | `FR-003` / `FR-004` / `FR-004a` + `SC-013`                |
| 截断的作用域                                                                               | 按视角分档：意图 200 / 全腿 800                                                          | `FR-017` / `FR-017b` / `FR-017c` + `SC-012` + US2-AS6     |

### mockup 期追加的一处定案（2026-08-12）

| 开放项                                          | 结论                                                                         | 落到                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 截断计数的措辞（`FR-018` 原字面 vs 只带新信息） | **只带新信息**：「已显示前 200 条 · 其余 24 条未显示」，**不复述符合条件数** | `FR-018` 改写 + `FR-018a` + `SC-004` / `SC-004a` + `state_branches` |

否决「照字面」的判据是 mockup 面板 A 两变体同屏对照后看出来的：「符合条件 224」与 sticky 区块头的「筛后 224」**是同一个数**，一屏内出现两次会被读成两个不同的量。⇒ 这一条**光读 spec 看不出来**，必须把两个措辞放进同一屏的真实上下文里才暴露 —— 是 mockup-first 流程本身买到的。

### clarify 期买到的两条「不会红」的坑（起草时未见）

1. **一律 200 会当场打破 `051` 已交付的入口** —— `051` ship 了「流动性门槛计数点击 → 切到全腿视角看被排除的腿」。最大链 639 → 200 砍掉 439 行，任一被排除的腿存活率约 31% ⇒ 用户点进去看到一张不含目标的表，**条数与数值全都正常**。⇒ 全腿视角改取 800，并落 `FR-017b` + `SC-012` 当回归防线。
2. **主 plan 未决 #1 对水位的描述不成立** —— 原文写「改水位 → 只影响 `rent` Tab」。实际是水位 → `intent` → **推荐标**，而推荐标是**标的级、不随 Tab 变**（跨片不变量 #3）⇒ 只重取收租视角会让另外两个视角继续用旧口径打标。已落 `FR-004a` 显式修正。

### 三条判定的说明（自审留痕，别下次又当缺口补）

1. **「No implementation details」判 pass 但有边界**：`FR-023`（判据单点）描述的是「MUST NOT 存在第二份会漂移的判据实现」这一**约束**，不是「怎么下沉」这一方案。费率下沉 SQL 是 plan 的事，spec 内零表名、零 SQL、零组件名。同一取舍在 047 / 049 spec 有先例。
2. **`FR-022` 是本片唯一的跨 feature 改判**（对 047 `FR-005` 全量呈现原则的**第二次**部分 supersede），已在正文写明补偿条件（双计数 `FR-018`–`FR-020` + 分页禁令不放松 `FR-021`）。
3. **`FR-017a` / `SC-006` 是起草期取数买到的**，不是模板套话：实测 `top-200` 在建仓视角**结构性永不触发**（最大 108 vs 阈值 200），收租 / 全腿也只有 2–3 条链够得着 ⇒ 截断的呈现分支拿不到真实数据覆盖。不在 spec 阶段钉死验证手段，impl 期只会临场编一个合成 fixture 然后声称验过。

### 起草期实测的口径声明（别把它当实装输出引用）

§ 背景那张「每视角真实腿数」表是 2026-08-12 dev 库最新交易日快照，**在 SQL 里复现** `050` 的实装阈值得到，不是跑实装代码取的：`DTE` 用 `expiry_date − session_date`（实装以「当日」为基准）、有效成本的 `P` 用 `bid` 近似。**量级可信，逐条数字不可当实装输出引用。**
