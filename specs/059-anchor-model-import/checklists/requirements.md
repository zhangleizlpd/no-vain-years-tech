# Specification Quality Checklist: 锚的模型导入通道

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-08-16
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

### 起草时刻意做的四处「去实现化」

输入材料（master plan + P1 子 plan）是实现导向的，以下四处在落成 spec 时被显式改写。记在这里是为了让 `/speckit-plan` 知道**这些信息没有丢，只是搬了家**：

1. **实现名不进 spec**：`buildModelImportPatch` / `confidence_source` / `source: 'model'` 等改写为业务语言（「置信度来源标记为模型」/「变更痕迹标记来源为模型」）。→ 归 plan.md。
2. **FR-010 去掉技术选型**：不写「nginx 层判定」，改为「判据 MUST 在通道层完成，MUST NOT 依赖服务端对某个可被覆写的请求头做授权判断」——**承重的是后半句**（授权不能靠可覆写的头），前半句的具体形态归 plan。
3. **SC 不写具体时刻**：不写「06:00」，改为「当日采集开始前 / 当轮采集」。时刻是部署事实（写在 `sync_dimension.cron_expr` 里，会变），spec 要锁的是「同一轮内生效」这个可验证性质。
4. **Edge Cases 里「僵尸锚」补齐了危险性说明**：只说「必须拒绝」读者无法判断分量，故写明失败形态是「建立成功但永远无行情，且与『尚未采集』不可区分」。

### 校验方式说明（诚实交代）

上表的勾选是**起草后逐项对照 spec 正文人工核对**的结果，不是「先写完再发现问题再修」的迭代产物——四处去实现化是在起草时就应用的约束。frontmatter 已过机器校验（`pnpm tsx scripts/check-spec-frontmatters.ts`，58 个文件全绿）；正文的质量项无机器载体，勾选依据是人工判断。

### 蓄意保留的具体性

- FR-003 保留了「该校验目前只存在于客户端，服务端缺失」这句现状描述。它不是实现细节，是**这条需求为什么现在必须做**的判据——本片开的是程序化写入面，客户端校验管不到。
- Assumptions 里保留了「港股锚不触发期权链采集」这条。它是范围决策的依据（为什么收港股却不担心配额），去掉会让「本期收美股 + 港股」看起来像随手划的。

### `/speckit-clarify` 已完成（Session 2026-08-16）

四项全部有解，答案已写入 spec 的 `## Clarifications` 段并落到对应 section：

| #   | 问题           | 结论                                                                 | 落点                |
| --- | -------------- | -------------------------------------------------------------------- | ------------------- |
| 1   | 收件箱状态流转 | 三态（待处理 / 已采纳 / 已否决）                                     | Key Entities        |
| 2   | 通道限频       | 直写 6r/m、提交 2r/m，独立计量                                       | FR-017              |
| 3   | 新建锚数上限   | **不设**，但响应必须标明新建 / 更新                                  | FR-016 + Edge Cases |
| 4   | 估值偏离护栏   | **不设**（数由本人流程算出，非文本读取；大幅重估恰是最该记录的信号） | Assumptions         |

`status` 流转：`draft` → `clarified`（clarify 后）→ `planned`（plan 后，2026-08-16 同日）。

### clarify 期间顺带修掉的一处上游不一致

master plan 契约 6 要求差异报告「返回给调用方**并且落库**」，而 P1 子 plan 只写了返回 —— 两份设计文档矛盾。核对后结论是**已由既有机制满足**：变更痕迹本就记录被清空的人工调整位及其原值，锚变更痕迹表天然就是差异报告的持久面。已在 FR-007 补一条子项写明「MUST NOT 为此另建第二份存储」，把这条判据钉在 spec 里而不是留在两份 plan 的差异中。
