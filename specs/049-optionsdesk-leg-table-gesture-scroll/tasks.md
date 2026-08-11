---
feature_id: 049-optionsdesk-leg-table-gesture-scroll
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-08-11'
updated_at: '2026-08-11'
---

# Tasks: 选约表横滑范式换代 + 意图 Tab 重设计（P0）

> 编号 = **执行顺序**；下面的 `##` 分组是给人读的，故组内编号会跳（T005 / T007 落 E2E 组）。
> 每条 task = 30min–2h 单 commit，走 `implement-task-closure` 六步闭环。
> 本片**纯 mobile、零 server、零契约** ⇒ 无 `## Server` / `## API Client` 组，也不落 `[Contract-Smoke]`（plan § Constitution Check 有显式判断）。

## 开工前置（不是 task，是环境）

真机链路要先起来，否则 T003 之后每一条的 verify 都没法做：`run-local-env` 全栈模式（Mate50 dev-client + Metro）。**T003 起的每条 verify 都含真机项**，只跑 web e2e 会系统性假绿（ADR-0063 §验证方式的教训）。

## Mobile

- [X] T001 新建 `apps/mobile/src/optionsdesk/leg-column-pane.tsx`：`LegColumnPane({ tx, contentWidth, children, testID })`（`Animated.View` + `useAnimatedStyle(translateX)`，宽度走 **prop 不写死**）+ `useLegColumnPan({ tx, viewportW, contentWidth })`（`activeOffsetX([-12,12])` / `failOffsetY([-12,12])` / `onBegin` 存起点 / `onUpdate` clamp / `onEnd` `withDecay`，clamp 每帧读 `viewportW.value`）。token 下沉 plain 子 `View`（NativeWind web 坑）(FR-001, FR-004, plan D-SCROLL-1/3)
  → verify: `nx run mobile:typecheck` 绿；`grep -nE "scrollTo|useAnimatedScrollHandler|useAnimatedReaction" apps/mobile/src/optionsdesk/leg-column-pane.tsx` **零命中**（这是「没退回 A 范式」的机械判据）

- [X] T002 `leg-table-header.tsx` 删 `LegColumnScroller` + `LegColumnScrollerProps`（连同那段 `scrollTo` 注释），`LegTableHeader` 改吃 `tx`；`leg-row.tsx` 的 `LegRow` 同改。**两个 testID 一字不改**（`optionsdesk-detail-leg-header-scroller` / `optionsdesk-detail-leg-scroller-${code}`）(FR-001, FR-007, plan D-SCROLL-1)
  → verify: `grep -rn LegColumnScroller apps/` **零命中**；typecheck 绿；`leg-row.rules.spec.ts` 的 12 列几何断言仍绿（列宽参数化后须复核 `LEG_SCROLL_REGION_WIDTH` 的消费点）

- [X] T003 `underlying-detail-screen.tsx` 屏级接线：外包 `GestureHandlerRootView`；`SectionList` 外再包一层 `<View className="flex-1" collapsable={false}>` 作 `GestureDetector` 的**单个原生子节点**；`onLayout` 写 `viewportW` 并顺手把 `tx` clamp 回新域；`columnOffset` 改名 `tx` (FR-001, FR-003, FR-004, plan D-SCROLL-2/3)
  → verify: 真机 dev console **不得出现** `Invalid prop 'collapsable' supplied to 'React.Fragment'` 或 `child may get view-flattened` 任一（🚫 MUST NOT 用 `LogBox.ignoreLogs` 压掉 —— 那两条告警是「手势没挂上」的唯一信号）；真机横竖屏各切一次后仍能滑到最右列
  → verify（承 spec Edge Case ②，**这条最容易在 impl 期被"顺手优化"掉且不会红**）: 真机在**锚卡 / 温度计 / 区间时序**区域横滑，列位移**照常发生**（那时表在屏外、视觉无感，是设计意图不是 bug）；且 `grep -nE "nativeEvent.*locationY|pageY|measure\(" apps/mobile/src/optionsdesk/underlying-detail-screen.tsx` **零命中** —— 🚫 MUST NOT 用 y 坐标判定手势归属，那是脆逻辑

- [X] T004 `LegColumnScrollbar({ tx, viewportW, contentWidth })` 落 `leg-column-pane.tsx`，渲在 **12 列表头正下方**（`.tblwrap` 内绝对定位，`top` = 表头高、`left` = 首列宽），2px 高；thumb 宽 = `max(trackW × trackW / contentWidth, 24)`，位置由**同一个** `tx` 派生；`travel ≤ 0` 时整条不渲染 (FR-005, FR-006, plan D-SCROLL-4)
  → verify: 真机看「thumb 长度比 = 列宽比 / 拖到底贴右缘 / 表格不溢出时整条不出现」；🚫 全文件 `grep useSharedValue` 只应命中屏级那一个 `tx`（指示条 MUST NOT 另立第二个来源）
  → verify（承 spec Edge Case ① 后半）: 构造无横向溢出的场景（临时把 `contentWidth` 传成小于可视宽，或宽屏 web 视口）→ 指示条整条不渲染**且拖拽不产生位移**（`tx` 恒 0）—— 两件事都要验，只验前者会漏掉「没有余量却仍能拖动」这种越界

- [ ] T006 `leg-picker-tabs.tsx` 按 mockup 稿 A 改视觉：等分三格（`flex-1`）+ 选中格 `bg-surface-sunken` + 底部 3px×28 `bg-brand-500` 短横条（未选态用等高透明占位防跳动，抄 `portfolio/detail-tabs.tsx`）(FR-008, FR-010, plan D-TAB-1/2)
  → verify: 既有 e2e「三 Tab 全部可进入」与选中态样式自比较断言仍绿；🚫 testID / 三件 a11y / notices 槽位 / 零 `disabled` 一律未动（`git diff` 自查）；🚫 **本 task 不碰 Tab 的语义、费率口径、档位着色**（那些属 P1/P2，混进来这次 PR 就无法单独回滚）

## E2E

- [ ] T005 重写 `apps/mobile/e2e/optionsdesk-chain-leg-picker.spec.ts` 的横向判据：`horizontalScroll()`（读 `scrollLeft`/`scrollWidth`）与 `page.mouse.wheel(400, 0)` 在 E 范式下**双双失效**（没有 DOM 滚动容器；wheel 不驱动 RNGH 的 Pan）⇒ 换**指针分步拖拽**（多次 `mouse.move` 才能越过 `activeOffsetX(12)`）+ `boundingBox()` 位移断言 (FR-001, FR-003, SC-002, SC-003, plan D-TEST-2)
  → verify: 🚨 **先对旧实现验红再对新实现验绿**（Constitution §II 的实质，不是形式）——写完断言后 `git stash` 掉 T001–T004 的实现（或 `git checkout` 到 T001 之前那个 commit）跑一次，**新断言在 A 范式下必须红**；红不了说明这条断言测的不是它该测的东西（要么视口宽到恒真，要么指针根本没驱动手势），此时**断言作废重写**，不许拿它去验新实现。同源教训见 ADR-0063：「A 臂的职责是必须能复现失步，复现不出说明探针不可信，整轮作废」。确认红之后 restore 实现，本 task 以**绿**收尾并 commit
  → verify: 该文件全部 test 绿；断言必须含**前提自检**（拖拽前动作列确在视区外，否则视口一宽就恒真）；断言四项：动作列左移 · 表头与行 Δx ≤1px · 首列 x 不动 · 纵滚后横向 Δx 不变；🚫 若指针驱不动就退 `page.touchscreen` / CDP dispatch，**MUST NOT 把断言删成恒真**

- [ ] T007 新增栈高回归断言：纵滚到腿区后表头仍可见，且数据区可见 **≥3 行**腿数据；覆盖「未选水位 → 同屏两条就地注明」的最坏档 (FR-011, SC-006, plan D-TAB-4)
  → verify: 在窄视口 config 下跑；若现有 config 视口过高导致断言恒真，**标注「真机验收补」并挪进 T008**，🚫 MUST NOT 凑一条恒真断言充数

## 收尾

- [ ] T008 真机验收单 M1–M8 逐条（Mate50 dev-client + 数值探针）(SC-001 – SC-006, plan D-TEST-3)
  → verify: M1 自激环判定**必须靠探针计数**（净位移为零而写入/反转仍在涨 = 失败签名，静态截图此时看起来是对齐的）；M1/M3 **必须人手滑**，`adb shell input swipe` 不算数；结论 + 探针读数回写 `spec.md` 验证段；🚫 探针代码验完删除、**不入仓**

- [ ] T009 回填主 plan（`docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md`）：本片实测的栈高值与真机反转计数、`LegColumnPane` / `useLegColumnPan` 的最终签名（P1–P3 要照着接） (plan D-DEBT)
  → verify: 主 plan 的四片依赖表与未决项已更新；`LegColumnPane` 签名与代码逐字一致

## 依赖

```text
T001 → T002 → T003 → T004 → T005 → T008
T006 → T007 ──────────────────────┘
（T006/T007 与 T001–T005 正交，可并行）
T008 → T009
```

**关键阻塞**：T003 未过 = 手势根本没挂上 ⇒ T004 / T005 / T008 全部无意义，不要往下做。

## Clear 检查点批次

per `implement-task-closure` 的 clear 批次纪律（批次 ≠ commit 合并，每 task 仍各自 atomic commit）：

1. **批次 A**：T001 – T003（同一条机制链：pane → 调用方 → 屏级接线）
2. **批次 B**：T004 – T005（指示条 + 它的 e2e）
3. **批次 C**：T006 – T007（Tab 视觉 + 栈高，与 A/B 正交）
4. **批次 D**：T008 – T009（真机验收 + 回填）

## FR / SC 覆盖矩阵

| 需求 | 覆盖 task |
| --- | --- |
| FR-001 单一位移来源、无回写路径 | T001 · T002 · T003 · T005 |
| FR-002 首列钉住 | T002（沿用 `LegStickyCell` 未改）· **T005**（e2e「首列 x 不动」断言）· T008(M4) |
| FR-003 手势归属 | T003 · T005 · T008(M3) |
| FR-004 位移 clamp + 视口变化 | T001 · T003 · T008(M4/M6) |
| FR-005 指示条常显 | T004 · T008(M5) |
| FR-006 指示条与表同源 | T004（`grep useSharedValue` 判据） |
| FR-007 列集/列宽不变 | T002（`leg-row.rules.spec.ts` 回归） |
| FR-008 Tab 视觉稿 A | T006 |
| FR-009 Tab 行为契约不变 | T006（`git diff` 自查 + 既有 e2e） |
| FR-010 选中态样式可区分 | T006 · T005（样式自比较） |
| FR-011 栈高预算 | T007 · T008(M8) |
| SC-001 自激环：写入停增、反转不涨 | **T008(M1) 独占**（e2e 覆盖不到，见下方说明） |
| SC-002 表头与行同列左缘 ≤1px | T005 · **T008(M2)** |
| SC-003 纯纵滑时横向位移为 0 | T005 · T008(M3) |
| SC-004 滑到最右末列完整可见、旋转后仍满足 | T008(M4) · T008(M6) |
| SC-005 Tab 选中态样式可区分 | T005 · T006 |
| SC-006 数据区 ≥3 行（含最坏档） | T007 · T008(M8) |

📌 **`SC-001` 故意零 e2e 覆盖，是刻意的不是遗漏** —— ADR-0063 已实证：合成手势（单指、单向、无交错）下缺陷实现**完全测不出问题**，web 侧凑一条断言只会制造假绿。它由 T008 的真机数值探针独占。`SC-002` 的 web 侧断言只验「静态截停时对齐」，验不到「净位移为零但写入仍在涨」那一档，故同时挂 T008。

## state_branches 分派

| 分支 | 归属 |
| --- | --- |
| 无横向溢出 → 指示条不渲染、拖拽不产生位移 | T004（两件事各一条 verify）· T008(M5) |
| 有溢出 → 指示条常显、长度比 = 可视宽/内容宽 | T004 · T008(M5) |
| 滑到最右 → 末列完整露出、thumb 贴右缘 | T005 · T008(M4) |
| 纵滑 → 列不横移 | T005 · T008(M3) |
| 松手 → 惯性衰减收敛 | **T008(M1) 独占**（web 无惯性可验） |
| 视口变化 → 位移拉回合法域 | T003 · T008(M6) |
| Tab 任一为空 → 仍可进入 | T006（既有 e2e 回归） |

## Edge Cases 分派

> 🚨 **单独一张表是刻意的**：`state_branches` / Edge Case / SC 是三个不同的层，塞进同一张表会让「条数 vs spec 实际条数」的机械核对失效。046 曾因矩阵值域够不到某一层，导致该层需求**零覆盖且零告警**。

| Edge Case | 归属 |
| --- | --- |
| 无横向溢出（宽屏 / 未来减列）→ 指示条不渲染 **且** 拖拽不产生位移 | T004（两件事各一条 verify） |
| 在锚卡 / 温度计 / 区间时序区域横滑 → 位移照常发生，**禁 y 坐标判定** | **T003**（真机项 + `grep` 零命中判据） |
| 未选水位同屏两条就地注明 → 表头栈最高档，数据区仍 ≥3 行 | T007 · T008(M8) |

## MVP

**T001 – T005 + T008** = 完整的缺陷修复，可独立交付并解开 048 的堵。T006/T007（Tab 视觉）是同 PR 的增量，但即使延后也不影响 MVP 成立。
