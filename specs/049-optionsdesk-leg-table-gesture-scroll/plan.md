---
feature_id: 049-optionsdesk-leg-table-gesture-scroll
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-11'
updated_at: '2026-08-11'
adr_refs: ['0063', '0030', '0027']
context7_verified: []
---

# Implementation Plan: 选约表横滑范式换代 + 意图 Tab 重设计（P0）

> 产物 = **仅本文（prose-only）**。本片零 server 改动 ⇒ 无 data model、无 API 契约面；`schema.prisma` 与 swagger 装饰器一行不动。**不造** `research.md` / `data-model.md` / `quickstart.md` / `contracts/`。
> 📌 本片是 optionsdesk 选约引擎重构四片中的 **P0**。主 plan：`docs/private/plans/2026-08/08-11-optionsdesk-leg-engine-master.md`（本机私有）。

## Summary

把 047 已 ship 的选约表横滑从「多滚动容器 + `scrollTo` 广播」换成 ADR-0063 定案的**单 `Gesture.Pan` → 单共享位移 → 各行 `translateX`**（修自激环），补上该范式欠的**自绘横向指示条**，并按 mockup 稿 A 重做意图 Tab 的视觉。纯 mobile，零 server / 零契约 / 零 orval regen。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点                                                                                                                                                                         |
| ---------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None                                     | N/A  | `react-native-gesture-handler ~2.28.0`（`apps/mobile/package.json:66`）与 `react-native-reanimated ~4.1.7`（同文件 `:72`）**均已装**，且仓内已有 10+ 消费点（`~/ui/SwipeRow` / `DraggableList` / `LongPressMenu` / `image-annotate` 等）。本片只用这两个包的既有 API（`Gesture.Pan` / `useSharedValue` / `useAnimatedStyle` / `withDecay`），无新增、无 polyfill、无 config 改动 |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 逐条核对：
  - **§I SDD（含 UI feature 强制 Mockup 步）**：specify → clarify → **Mockup（`design/` 9 帧 + 三轮渲染验证）** → plan，未跳步。
  - **§II TDD**：每 task 红→绿→typecheck/lint→`[X]`→stage→commit 六步闭环。⚠️ 本片主体是**手势与布局**，纯函数面很薄 —— TDD 的落点主要在 e2e 与真机验收单，见 D-TEST。
  - **§III 原子 task**：下方 task 切分均为 30min–2h 单 commit 粒度。
  - **§IV Module Boundary**：本片零 server 改动，不涉及 bounded context / 护城河。
  - **§V 类型同步链 + PR 边界**：零契约改动 ⇒ 无 openapi / api-client regen；**纯 mobile 单 PR**。⚠️ §V 的「跨端两层验证」按其字面只约束**跨端 feature**；本片非跨端，故**不落 `[Contract-Smoke]`**（零新端点，契约冒烟无可验之物）——这是一个显式判断，不是遗漏。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: N/A —— 本片零 server 改动、零新端点，无 real-boot smoke 可加。
- [x] **Mobile / Web**: golden-path 必须在**真机**走（US1 的 `SC-001` / `SC-002` 判据在模拟手势与宽视口下必然假绿），验收清单 = D-TEST-3 的 M1–M8；US2（Tab）的功能面另有 Playwright hermetic e2e 覆盖。
- [x] **Evidence**: 真机验收结论与探针读数在 T009 回写 `spec.md` 验证段（Mate50 dev-client，起法见 `run-local-env`）。修复前的对照基线取 ADR-0063 实测表（A 臂方向反转 558 / 松手后仍 +28 写入每 3s），**不重跑 A 臂**——那套实现即将删除，为取基线而保留它反而制造一个「还能改回去」的口子。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片零新第三方包（见 Dependencies 表）。ADR-0063 的候选对比里 G/H/I/J 四个库/方案已逐条否决，重开须走该 ADR 的 sunset trigger，不在本片。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。本片改的 `apps/mobile/src/optionsdesk/*` 全部由 047（2026-08）在 mono 内新建，无 meta-repo 迁移史。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR          | Open Question / sunset trigger                                                                          | Classification   | Mitigation / next step                                                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-0063** | sunset #3「表格规模突破上界（行 > 200 或列 > 20，且**过滤器 + 截断**不再是可接受的收敛手段）」            | `accepted-as-is` | **本片不实装过滤器也不实装截断** —— 两者整块移交 P3（且 P3 的方案是服务端召回 + 截断，比原设想更彻底）。本片行数与列数一律不变（仍 730 行 × 12 列）⇒ 触发线原样不动                                                            |
| ADR-0063     | sunset #5「出现第二个消费该表格范式的 feature → 把组件从 `optionsdesk/` 上提到 `~/ui/`」                  | `accepted-as-is` | 本片**不新增 consumer**（改的是同一个既有 consumer）。但本片**为那一刻降成本**：`leg-column-pane.tsx` 单文件、宽度参数化，上提时是移动文件而非重写                                                                             |
| ADR-0030     | `~/ui` 包分解 / 上提判据                                                                                    | `accepted-as-is` | 三家等分 Tab 判定**不上提**（理由见 D-TAB-3），登记为独立债                                                                                                                                                                     |

**Evidence**: 逐条读 ADR-0063 frontmatter 五条 sunset trigger，其余两条（reanimated #7460 修复 / 需要 web 等价形态）本片均未触及。

## Architecture Notes

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**：本片零 NestJS 组件，该禁令**在本片无适用对象**。等价约束落在 mobile 侧：**禁止为「验证横滑」去 mock `Gesture` / `SharedValue`** —— 那等于把被测的唯一机制换成假的。横滑只有真机手验一条路（`SC-001` / `SC-002`）。
- **MANDATORY INTEGRATION**：mobile 侧对应物 = Playwright hermetic e2e 打真实渲染树（`apps/mobile/e2e/optionsdesk-chain-leg-picker.spec.ts`），**不是**组件级单测（本仓 mobile 零组件单测，per `testing.md`）。
- **EXHAUSTIVE BRANCHING**：`spec.md` 的 `state_branches` 每条都要有归属 —— 横滑 / 指示条相关落真机验收单，Tab 相关落既有 e2e。**条数一律实时 grep，别抄本段**。

### General Architecture Notes

> ⚠️ ADR-0043 的「扁平 + 贫血 + 护城河 + 零-class」是 **server 端**范式，本片零 server 改动 ⇒ 不适用。mobile 侧的等价纪律是 `.claude/rules/mobile-impl-playbook.md` 与 `nativewind-mapping.md`。

---

### D-SCROLL · 横滑范式换 E（`FR-001`–`FR-007`）

#### D-SCROLL-1 · 新建 `LegColumnPane`，删 `LegColumnScroller`（不原地改）

**符号翻转是本次改造最危险的静默坑**：现役 `offset ∈ [0, 628 − viewportW]`（**正**，scroll offset），E 的 `tx ∈ [maxTx, 0]`（**负**，translateX）。两者类型都是 `SharedValue<number>` —— 沿用旧名则**编译绿、e2e 可能绿，真机上「方向反了」或「恒 clamp 到 0 滑不动」**。改名把翻转钉在类型层之外，`grep LegColumnScroller` 零命中即迁移完成的机械判据。

```text
apps/mobile/src/optionsdesk/leg-column-pane.tsx（新）
  LegColumnPane({ tx, contentWidth, children, testID })   // Animated.View + useAnimatedStyle(translateX)
  useLegColumnPan({ tx, viewportW, contentWidth })        // Gesture.Pan 工厂
  LegColumnScrollbar({ tx, viewportW, contentWidth })     // D-SCROLL-4

apps/mobile/src/optionsdesk/leg-table-header.tsx（改）
  删 LegColumnScroller + LegColumnScrollerProps（连同那段 scrollTo 注释）
  保留 LEG_HEADER_HEIGHT / LEG_ROW_HEIGHT / legColumnWidth / LegStickyCell
  LegTableHeader({ tx, rateSub, oiAsOf })

apps/mobile/src/optionsdesk/leg-row.tsx（改）
  LegRow({ leg, tx, today, activity, showBasisBadge })，其余一行不改
```

📌 **宽度必须参数化**（`contentWidth` prop）：现役把 `LEG_SCROLL_REGION_WIDTH` 写死，PoC 也用模块常量 —— P1/P2 改列集、048 复用时列宽都会变，写死等于逼下游复制一份。**这也是 ADR-0063 sunset #5（上提 `~/ui`）到来时能「移动文件而非重写」的前提。**
🚨 **两个 testID 一字不改**（`optionsdesk-detail-leg-header-scroller` / `optionsdesk-detail-leg-scroller-${code}`）—— 名字里的 "scroller" 已不准确，但它们是 e2e 的锚点，改锚代价远大于名字不准。

#### D-SCROLL-2 · 手势挂在包住整个 `SectionList` 的那一层

手势要同时覆盖**表头**（在 `renderSectionHeader` 里）与**所有行**（在 `renderItem` 里），二者是 `SectionList` 的不同槽位。

```text
SafeAreaView
└ GestureHandlerRootView                                        ← 屏自包裹（根 _layout 不全局挂）
  └ GestureDetector(pan)
    └ <View className="flex-1" collapsable={false} onLayout>     ← 必须是单个原生 View
      └ SectionList                                              ← 仍是全页唯一纵向滚动容器
```

**可行性三条证据**：① 方向正交由 `.activeOffsetX([-12,12])` + `.failOffsetY([-12,12])` 保证 —— 纵向超 12px 手势直接 fail，触点完全交给 `SectionList`；仓内 `~/ui/SwipeRow.tsx:28-29` 用**同一组参数**在列表内长期工作。② PoC E 臂已在**同拓扑**下 Mate50 真机验过（`GestureDetector( View[collapsable=false]( 表头 + FlatList ) )`），049 只是把「表头 + 行」从两个兄弟节点换成同一 `SectionList` 的两个槽位，对手势层透明。③ 详情屏内**零横向 `ScrollView` 竞争者**（`price-zone-chart.tsx` 的窗口 chip 行与 `position-bucket-chips.tsx` 都是纯 `flex-row`，已核）。

**已知副作用（判为可接受）**：手势区覆盖到 `ListHeaderComponent` 的 046 三块，在锚卡 / 温度计上横滑也会移动列 —— 那时表在屏外，视觉无感。
🚫 **MUST NOT** 用「按 y 坐标判断是否接管」这类脆逻辑去精修手势区；🚫 **MUST NOT** 为绕开它把 046 三块搬出 `SectionList`（会同时破 047 `FR-001` 版式与「唯一纵向容器」）。

#### D-SCROLL-3 · viewport 与 `maxTx`：`onLayout` 测量 + shared value

**不用** `useWindowDimensions()`（PoC 做法）—— 那假设「表宽 = 窗宽」，将来加左右 padding 或平板分栏就**静默算错 clamp 边界**（右侧列滑不到底，不会红）。

```text
viewportW = useSharedValue(0)                 // = 容器宽 − LEG_STICKY_COL_WIDTH
onLayout  → 写 viewportW，并顺手把 tx clamp 回新合法域
worklet 内 → maxTx = Math.min(0, viewportW.value − contentWidth)
```

首帧 `width=0 ⇒ maxTx=0`（一帧不可滑，无感）。手势对象的依赖只有 shared value ⇒ **旋转屏也不重建**。

#### D-SCROLL-4 · 横向指示条（ADR-0063 派生债，`FR-005` / `FR-006`）

**位置由 mockup 定死：钉在 12 列表头正下方**（不是表格容器底部）—— 它描述的是列的位置，紧贴列头才读得懂；且落在 sticky 栈内才保证滚到哪都在。左端与首列右边界对齐（首列 88px 留空）⇒ 轨道宽 = 横滑可视宽，长度比即列宽比，无需二次换算。

几何全部由**同一个** `tx` + `viewportW` 派生，单个 `useAnimatedStyle`：thumb 宽 = `max(trackW × trackW / contentWidth, 24)`（下限 24px 否则细到看不见），位置 = `(−tx / travel) × (trackW − thumbW)`，`travel ≤ 0` 时整条隐藏。视觉：轨道 `line`、thumb `ink-muted`（mockup 已锁）。

🚨 **MUST NOT 另立第二个 shared value，MUST NOT 从 JS state 派生位置** —— 那是 ADR-0063 判死的「回写路径」的近亲，且会引入「表与指示条不同步」这一**新的**失步面。只读，不可拖。

---

### D-TAB · 意图 Tab 稿 A（`FR-008`–`FR-011`）

#### D-TAB-1 · 定稿形态

**稿 A：等分三格 + 选中格 `surface-sunken` 底 + 底部 3px×28 `brand-500` 短横条，行高约 40px**（mockup ⑥ 定稿，2026-08-11）。仓内先例 `portfolio/detail-tabs.tsx`（未选态用等高透明占位防跳动，照抄）。
选中态**双重编码**（底色 + 横条）是刻意的：`react-native-web` 不认 `accessibilityState`，e2e 只能靠 `textStyleOf` 样式自比较，双重编码让那条断言更稳。

#### D-TAB-2 · 四条不可动的约束

`accessibilityRole="tab"` + `accessibilityState` + `accessibilityLabel` 三件 · testID `optionsdesk-detail-leg-tab-${t}`（e2e 三处依赖）· **零 `disabled`、零条件不渲染** · notices 槽位仍在 Tab 行下方同一 sticky header。

🚨 **本片只改 Tab 的壳，不碰语义**：Tab 仍是 047 定义的「腿族成员集合」。把它改成「视角」（成员判据只剩 DTE、Δ 降级为标、`tier` 跟 Tab 走、年化/周化主次显示）是 **P1/P2** 的事。两次改动不重叠 —— 本片动的是布局与选中态样式，P2 动的是格子里显示什么。

#### D-TAB-3 · 不上提 `~/ui`（本片显式判定）

`portfolio/detail-tabs.tsx:6` 已有先例判决「等分固定 Tab ≠ 横滑 pill Tab，不强行统一」；ADR-0030 的上提判据是「出现第二个 consumer」，本片**不新增 consumer**。统一 `alert` / `portfolio` / `optionsdesk` 三家等分 Tab 是独立重构（动两片已 ship 屏及其 e2e），登记为债。

#### D-TAB-4 · 栈高预算（mockup ⑨ 的量化结论，直接约束 impl）

sticky 栈净高（稿 A，**不含已移交 P3 的筛选行**）= 计数 26 + 意图水位 44 + Tab 40 + 列头 30 + 指示条 2 = **142px**，含 chrome 93 后占 844 视口 **27.8%**，数据区余约 12 行。
最坏档（未选水位时同屏两条就地注明，+40px）= **32.6%**，仍在 35% 目标内。

📌 mockup ⑨ 量的是**含筛选行**的版本（182px / 32.6% / 最坏 37.3%）。筛选行移交 P3 后每档各减 40px —— **P3 落地时会把这 40px 加回来，届时最坏档回到 37.3% 并越线**，那是 P3 要处置的问题（要么注明与筛选行共存时更紧凑，要么接受 37%）。本片不预支该处置。

---

### D-TEST · 验证三层分工

#### D-TEST-1 · vitest（Small，纯 rules）

本片的纯函数面很薄：`legColumnWidth` 与列几何常量（`leg-row.rules.spec.ts` 已有断言，改宽度参数化后须复核）。**没有新增纯函数** ⇒ 本层不新增 spec 文件。
❌ 覆盖不了：任何横滑、手势、布局、高度、渲染。

#### D-TEST-2 · Playwright Expo Web e2e（Medium，hermetic）

**能覆盖**：横滑的**位移正确性**（拖拽后动作列 x 左移 / 表头与行 Δx ≤1px / 首列 x 不动 / 纵滚后横向 Δx 不变）—— 这套判据**不依赖任何滚动容器实现**，换范式后不再脆 · 指示条存在且随拖拽移动 · Tab 选中态样式自比较。

🚨 **既有 US2-AS6 那条 e2e 必须重写，是强制项不是可选项**：它现在用 `horizontalScroll()` 读 `scrollLeft`/`scrollWidth`（`spec.ts:523-536`）+ `page.mouse.wheel(400, 0)` 驱动（`:542-548`）。E 范式下**没有 DOM 滚动容器可读**，且 **`wheel` 不驱动 RNGH 的 Pan** ⇒ 两者全部失效。换指针拖拽且**分多步 `mouse.move`** 才能越过 `activeOffsetX(12)`；驱不动就退 `page.touchscreen` / CDP dispatch，🚫 **MUST NOT 因驱不动就把断言删成恒真**。

❌ **覆盖不了（写进 e2e 文件注释，不凑假断言）**：手感/动量/回弹 · **自激环**（E 构造上无环，但「改回去/改错」在 web 上多半静默不红 —— ADR-0063 已实证合成手势下 A 臂完全测不出问题）· 大规模虚拟化窗口 · a11y `selected` 语义（rn-web 不认）· sticky 栈高在真机窄屏的实际占比。

#### D-TEST-3 · 真机验收单（Mate50 dev-client）

**探针纪律**（照抄 ADR-0063 三次教训）：走 `useAnimatedProps → TextInput.text`，全程 UI 线程；🚫 MUST NOT 用模块级可变对象（Fast Refresh 后 worklet 与 React 各持一份 ⇒ 恒 0）；🚫 MUST NOT 从 JS 线程读 `sharedValue.value` 下结论；🚫 视觉标尺在表头与数据行**必须同形同字符数**。探针仅挂 `__DEV__` 分支，**验完删除、不入仓**。

| #      | 判据             | 通过 / 失败签名                                                                                                          |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **M1** | 无自激环         | 快滑 10 次松手静置 3s：写入停增、反转不涨。🚨 失败签名 = **净位移为零而写入/反转仍在涨**（静态截图此时看起来是对齐的） |
| **M2** | 逐像素对齐       | 中途截停，表头与全部可见行同列左缘 ≤1px                                                                                  |
| **M3** | 手势归属         | 纯纵 / 纯横 / 斜滑 / 横滑中途转纵：归属先越 12px 的方向，无粘滞                                                          |
| **M4** | 首列钉住 + clamp | ① 滑到底：行权价列一像素不动，最右「动作」列完整露出**不多不少**（滑不到底 ⇒ `maxTx` 用了 JS 闭包旧值）② **甩手快滑到边界后松手**：`withDecay` 的收敛点必须落在合法区间内，**不越界也不回弹**（承 spec US1-AS4 后半，静态位置验不到这一档）|
| **M5** | 指示条           | thumb 长度比 = 列宽比；到底贴右缘；不溢出时整条不出现                                                                    |
| **M6** | 旋转 / 分屏      | 各切一次后 `tx` 仍在合法域、能滑到底                                                                                     |
| **M7** | 虚拟化仍生效     | 真票 730 行快滑到底再回：无长时间白屏占位；内存不单调涨                                                                  |
| **M8** | a11y + 栈高      | TalkBack 过 3 个 Tab；未选水位（两条注明）时数据区仍见 ≥3 行                                                             |

🚨 **合成手势不算数**：`adb shell input swipe` 是单指、单向、无交错的干净手势，ADR-0063 实证 A 臂在它下面**完全测不出问题**。**M1 / M3 MUST 人手滑**。

---

### 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红）

1. **`GestureDetector` 的子节点 MUST 是单个带 `collapsable={false}` 的原生 View** —— 传 Fragment 或被 view-flattening 压平，手势**静默不生效**；那两条 dev 告警是唯一信号，🚫 MUST NOT `LogBox.ignoreLogs` 压掉（2026-08-10 实撞，压掉后根因被消音）。
2. **屏 MUST 自包裹 `GestureHandlerRootView`** —— 仓内根 `_layout` 不全局挂。漏了是 Render Error，红在一个看不懂的地方。
3. **`offset`（正）→ `tx`（负）的符号翻转 MUST 连带改名** —— 类型一样，不改名则真机上「方向反了」。
4. **`maxTx` MUST 在 worklet 内每帧从 `viewportW.value` 重算** —— 提到 JS 闭包，旋转后右侧滑不到底且不会红。`withDecay` 的 `clamp` 同理。
5. **`onLayout` 变宽时 MUST 顺手把 `tx` clamp 回新域** —— 否则竖→横→竖后卡在越界位置只能反向滑。PoC 没有这一面（只在挂载算一次）。
6. **NativeWind web 坑**：`className` 挂 `Animated.*` 上会被**整串吞掉** ⇒ pane / thumb 的 token 一律下沉到 plain 子 `View`（`leg-table-header.tsx:12-15` 已记）。坑 ②（width 挂 `ScrollView` 不约束 frame）本片自动消失，但外层 wrapper 仍要留（`overflow-hidden` 靠它）。
7. **Tab 改版 MUST NOT 动 testID / 三件 a11y / notices 槽位 / 零 `disabled`**。
8. **e2e 横向断言 MUST 带前提自检**（拖拽前动作列确在视区外）—— 视口一宽就恒真，是这类断言最常见的假绿。
9. **`mouse.wheel(dx,0)` 不驱动 RNGH 的 Pan**，且既有 `horizontalScroll()` 在 E 范式下没有对应 DOM 节点 ⇒ 重写那条 e2e 是强制项。
10. **`SectionList` MUST 仍是全页唯一纵向滚动容器** —— 新增的手势层与指示条都是非滚动元素；🚫 MUST NOT 在外面再包 `ScrollView`（屏头 20 行明令，RN 只打一条 dev warning，CI 全绿）。
11. **PoC 代码 MUST NOT 入仓** —— 只抄机制。`ScrollerE` 把宽度写死为模块常量、无 testID、带探针脚手架，三处都要在 `LegColumnPane` 里补齐 / 剥掉。
12. **`design/` 的 mockup 用 `overflow-x: auto` 原生滚动只是表达手段** —— 照抄就等于把 047 的缺陷载体再造一遍。首列 sticky 同理（RN 没有 CSS sticky，靠「渲在横滑之外」）。
13. **本片 MUST NOT 顺手改 Tab 的语义、费率显示口径、档位着色** —— 那些属 P1/P2，混进来会让「视觉改动」这次 PR 变得无法单独回滚。

## Task 分解

### Phase 1 · 横滑换 E（阻塞其余全部 task）

- **T001 [Mobile]** `leg-column-pane.tsx` 新建：pane + pan 工厂（宽度走 prop） → verify: typecheck 绿；`grep -n "scrollTo\|useAnimatedScrollHandler\|useAnimatedReaction" leg-column-pane.tsx` **零命中**
- **T002 [Mobile]** 表头与腿行改吃 `tx`，删 `LegColumnScroller`；两个 testID 一字不改 → verify: `grep -rn LegColumnScroller apps/` 零命中
- **T003 [Mobile]** 屏级接线：`GestureHandlerRootView` + `GestureDetector` + `collapsable={false}` wrapper + `onLayout` 测宽 + 旋转 clamp；`columnOffset` 改名 `tx` → verify: 真机 dev console **不得出现** `Invalid prop 'collapsable' supplied to 'React.Fragment'` 或 `child may get view-flattened`
- **T004 [Mobile]** 横向指示条（钉表头正下方） → verify: e2e 断言 thumb 存在且拖拽后 `boundingBox().x` 单调右移
- **T005 [Mobile-E2E]** 重写既有横向判据（`horizontalScroll()` + `wheel` → 指针分步拖拽 + `boundingBox`） → verify: 该文件全部 test 绿，断言含前提自检

### Phase 2 · Tab 视觉（与 Phase 1 正交，可并行）

- **T006 [Mobile]** 按稿 A 改 `leg-picker-tabs.tsx`，D-TAB-2 四条约束全不动 → verify: 既有 US3-AS2 与样式自比较断言仍绿
- **T007 [Mobile-E2E]** 栈高回归：纵滚后表头仍可见且数据区 ≥3 行（含两条注明的最坏档） → verify: 该断言在窄视口 config 下跑；若视口过高则标注「真机验收补」，🚫 MUST NOT 凑恒真断言

### Phase 3 · 收尾

- **T008 [Mobile]** 真机验收单 M1–M8 逐条 → verify: 结论 + 探针读数回写 `spec.md`；探针代码验完删除、不入仓
- **T009 [Docs]** 主 plan 回填本片实测结论（栈高实测值 / 真机反转计数），并把 `LegColumnPane` 的最终签名同步给 P1–P3 的 plan → verify: 主 plan 四片依赖表更新

**依赖**：`T001→T002→T003→T004→T005`；`T006→T007`（与 Phase 1 正交）；`T008` 需 T003+T004+T006 全落。
**关键阻塞**：T003 未过（手势没挂上）⇒ T004/T005/T008 全部无意义。

## Out of Scope（本片明确不做）

| 事项 | 去向 |
| --- | --- |
| 行权价筛选（输入、计数、空态、清除） | **P3** |
| 服务端截断 top-N / 每 Tab 独立请求 | **P3** |
| `LegRow` memo 化 + `renderItem` `useCallback` | **不做** —— 它原本是筛选按键级重渲的配套，筛选移走后本片**不产生**新的高频重渲路径。P2/P3 若引入再评估 |
| Tab 语义改「视角」、费率主次显示、`tier` 跟 Tab 着色、推荐标 | **P1（server）+ P2（mobile）** |
| 048 的 V-C 判据改写 | 048 已冻结，等四片落完连同 048 spec 一并重写 |
| 系统侧 top-N / 分页 | 047 `FR-005` 禁令在本片**原样有效**（本片不碰行数） |
| 行可点 / 选中态 | **明禁**，047 `FR-012`，e2e 有运行时断言 |

## Complexity Tracking

> Constitution Check 无违规，本表为空。
