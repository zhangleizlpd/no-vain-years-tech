---
feature_id: 049-optionsdesk-leg-table-scroll-filter
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-11'
updated_at: '2026-08-11'
adr_refs: ['0063', '0030', '0027']
context7_verified: []
---

# Implementation Plan: 选约表横滑范式换代 + 行权价区间筛选 + 意图 Tab 重设计

> 产物 = **仅本文（prose-only）**。本片零 server 改动 ⇒ 无 data model、无 API 契约面；`schema.prisma` 与 swagger 装饰器一行不动。**不造** `research.md` / `data-model.md` / `quickstart.md` / `contracts/`。

## Summary

把 047 已 ship 的选约表横滑从「多滚动容器 + `scrollTo` 广播」换成 ADR-0063 定案的**单 `Gesture.Pan` → 单共享位移 → 各行 `translateX`**（修自激环），并在表头栈新增**行权价区间筛选行**与**自绘横向指示条**，同时按 mockup 稿 A 重做意图 Tab。纯 mobile，零 server / 零契约 / 零 orval regen。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点                                                                                                                                                                         |
| ---------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None                                     | N/A  | `react-native-gesture-handler ~2.28.0`（`apps/mobile/package.json:66`）与 `react-native-reanimated ~4.1.7`（同文件 `:72`）**均已装**，且仓内已有 10+ 消费点（`~/ui/SwipeRow` / `DraggableList` / `LongPressMenu` / `image-annotate` 等）。本片只用这两个包的既有 API（`Gesture.Pan` / `useSharedValue` / `useAnimatedStyle` / `withDecay`），无新增、无 polyfill、无 config 改动 |

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 逐条核对：
  - **§I SDD（含 UI feature 强制 Mockup 步）**：specify → clarify（4 问 4 答）→ **Mockup（`design/` 9 帧 + 三轮渲染验证）** → plan，未跳步。
  - **§II TDD**：每 task 红→绿→typecheck/lint→`[X]`→stage→commit 六步闭环；筛选判定全部落纯函数，天然可先写测试（见 D-TEST-1）。
  - **§III 原子 task**：下方 task 切分均为 30min–2h 单 commit 粒度。
  - **§IV Module Boundary**：本片零 server 改动，不涉及 bounded context / 护城河。
  - **§V 类型同步链 + PR 边界**：零契约改动 ⇒ 无 openapi / api-client regen；**纯 mobile 单 PR**。⚠️ §V 的「跨端两层验证」按其字面只约束**跨端 feature**；本片非跨端，故**不落 `[Contract-Smoke]`**（零新端点，契约冒烟无可验之物）——这是一个显式判断，不是遗漏。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: N/A —— 本片零 server 改动、零新端点，无 real-boot smoke 可加。
- [x] **Mobile / Web**: golden-path 必须在**真机**走（US1 的 `SC-001` / `SC-002` 判据在模拟手势与宽视口下必然假绿），验收清单 = D-TEST-3 的 M1–M11；US2 / US3 的功能面另有 Playwright hermetic e2e 覆盖。
- [x] **Evidence**: 真机验收结论与探针读数在 T015 回写 `spec.md` 验证段（Mate50 dev-client，起法见 `run-local-env`）。修复前的对照基线取 ADR-0063 实测表（A 臂方向反转 558 / 松手后仍 +28 写入每 3s），**不重跑 A 臂**——那套实现即将删除，为取基线而保留它反而制造一个「还能改回去」的口子。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片零新第三方包（见 Dependencies 表）。ADR-0063 的候选对比里 G/H/I/J 四个库/方案已逐条否决，重开须走该 ADR 的 sunset trigger，不在本片。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。本片改的 `apps/mobile/src/optionsdesk/*` 全部由 047（2026-08）在 mono 内新建，无 meta-repo 迁移史。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

扫 `docs/adr/*.md` 的 Open Questions / sunset trigger，本片命中一条、擦边两条：

| ADR          | Open Question / sunset trigger                                                                             | Classification    | Mitigation / next step                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ADR-0063** | sunset #3「表格规模突破 user 定的上界（行 > 200 或列 > 20，且**过滤器 + 截断**不再是可接受的收敛手段）」    | **mitigated**     | 本片正是把「过滤器」这半边**实装**（`FR-008`–`FR-018`）。截断那半边**明确不做**（`FR-018` 保留系统侧禁令）⇒ sunset #3 的前提条件被本片部分兑现，触发线不动                                                             |
| ADR-0063     | sunset #5「出现第二个消费该表格范式的 feature → 把组件从 `optionsdesk/` 上提到 `~/ui/`」                    | `accepted-as-is`  | 本片**不新增 consumer**（改的是同一个既有 consumer）。048 才会是第二个 —— 届时按 ADR-0030 判据评估上提，本片只把组件抽干净（`leg-column-pane.tsx` 单文件、宽度参数化）为那一刻降成本                                   |
| ADR-0030     | `~/ui` 包分解 / 上提判据                                                                                     | `accepted-as-is`  | 三处 chip 重复与三家等分 Tab 均**判定不上提**（理由见 D-TAB-3），登记为独立债                                                                                                                                          |

**Evidence**: `rg -l 'sunset_trigger' docs/adr/` → 命中 0063 等；逐条读 0063 frontmatter 五条 trigger，其余三条（reanimated #7460 修复 / 出现成熟库 / 需要 web 等价形态）本片均未触及。

## Architecture Notes

### 🚨 Testing Invariants (AI 绝对禁令 — 严禁违背)

- **NO LIFECYCLE MOCKING**：本片零 NestJS 组件，该禁令**在本片无适用对象**。等价约束落在 mobile 侧：**禁止为「验证横滑」去 mock `Gesture` / `SharedValue`** —— 那等于把被测的唯一机制换成假的。横滑只有真机手验一条路（`SC-001` / `SC-002`）。
- **MANDATORY INTEGRATION**：mobile 侧对应物 = Playwright hermetic e2e 打真实渲染树（`apps/mobile/e2e/optionsdesk-chain-leg-picker.spec.ts`），**不是**组件级单测（本仓 mobile 零组件单测，per `testing.md`）。
- **EXHAUSTIVE BRANCHING**：`spec.md` 的 **19 条 `state_branches`** 每条都要有归属 —— 筛选相关 11 条落 `leg-filter.rules.spec.ts` + `use-leg-table.spec.ts`（vitest），横滑/指示条相关 5 条落真机验收单，Tab 相关 1 条落既有 e2e，键盘 1 条落真机（web 无软键盘）。**条数一律实时 grep，别抄本段数字**。

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
  export const LegRow = memo(LegRowImpl)
```

📌 **宽度必须参数化**（`contentWidth` prop）：现役把 `LEG_SCROLL_REGION_WIDTH` 写死，PoC 也用模块常量 —— 048 复用时列集会变，写死等于逼它复制一份。
🚨 **两个 testID 一字不改**（`optionsdesk-detail-leg-header-scroller` / `optionsdesk-detail-leg-scroller-${code}`）—— 名字里的 "scroller" 已不准确，但它们是 e2e 与 048 的锚点，改锚代价远大于名字不准。

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
🚫 **MUST NOT** 用「按 y 坐标判断是否接管」这类脆逻辑去精修手势区；🚫 **MUST NOT** 为绕开它把 046 三块搬出 `SectionList`（会同时破 `FR-001`〔047〕版式与「唯一纵向容器」）。

#### D-SCROLL-3 · viewport 与 `maxTx`：`onLayout` 测量 + shared value

**不用** `useWindowDimensions()`（PoC 做法）—— 那假设「表宽 = 窗宽」，将来加左右 padding 或平板分栏就**静默算错 clamp 边界**（右侧列滑不到底，不会红）。

```text
viewportW = useSharedValue(0)                 // = 容器宽 − LEG_STICKY_COL_WIDTH
onLayout  → 写 viewportW，并顺手把 tx clamp 回新合法域
worklet 内 → maxTx = Math.min(0, viewportW.value − contentWidth)
```

首帧 `width=0 ⇒ maxTx=0`（一帧不可滑，无感）。手势对象的依赖只有 shared value ⇒ **旋转屏也不重建**。

#### D-SCROLL-4 · 横向指示条（ADR-0063 派生债，`FR-005` / `FR-006`）

**位置由 mockup 定死：钉在 12 列表头正下方**（不是表格容器底部）—— 它描述的是列的位置，紧贴列头才读得懂；且落在 sticky 栈内才保证滚到哪都在（`FR-022` 的表头栈清单即含它）。左端与首列右边界对齐（首列 88px 留空）⇒ 轨道宽 = 横滑可视宽，长度比即列宽比，无需二次换算。

几何全部由**同一个** `tx` + `viewportW` 派生，单个 `useAnimatedStyle`：thumb 宽 = `max(trackW × trackW / contentWidth, 24)`（下限 24px 否则细到看不见），位置 = `(−tx / travel) × (trackW − thumbW)`，`travel ≤ 0` 时整条隐藏。视觉：轨道 `line`、thumb `ink-muted`（mockup 已锁）。

🚨 **MUST NOT 另立第二个 shared value，MUST NOT 从 JS state 派生位置** —— 那是 ADR-0063 判死的「回写路径」的近亲，且会引入「表与指示条不同步」这一**新的**失步面。只读，不可拖。

---

### D-FILTER · 行权价区间筛选（`FR-008`–`FR-018`, `FR-023`）

#### D-FILTER-1 · 文件与职责

| 文件                       | 职责                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `leg-filter.rules.ts`（新） | 全部判定：`sanitizeStrikeInput` / `parseStrikeBound` / `StrikeRange` / `UNBOUNDED_STRIKE_RANGE` / `strikeFilterState` / `filterLegsByStrike`      |
| `leg-filter.rules.spec.ts`（新） | vitest Small                                                                                                                                |
| `leg-strike-filter.tsx`（新） | 受控 presentational，零状态                                                                                                                     |
| `leg-picker.rules.ts`（改） | `legPickerSections(legs, tab, range)` 加**必填**第三参 —— 让「Tab 与 strike 的复合」有唯一可测落点，且未来任何新调用方在**编译期**被迫表态       |
| `use-leg-table.ts`（改）   | 持筛选态 + 双计数 `total` / `tabTotal` + 换 symbol 清空                                                                                          |
| `optionsdesk-copy.ts`（改） | 文案单源（`clearFilter` 已存在，复用）                                                                                                          |

判定放**新** `*.rules.ts` 而非塞进 `leg-picker.rules.ts`：后者主题是「Tab / 意图 / 水位」，仓内一贯一个关注点一个 rules 文件（`leg-row.rules.ts` / `price-format.rules.ts` / `zone-band.rules.ts`）。

#### D-FILTER-2 · 状态放 `use-leg-table.ts`（与 Tab 态 `picked` 同层）

不放屏级：`sections` 与两个计数都在 hook 里算，状态外置会让屏从「接线」变成「算账」。不持久化 ⇒ `useState` 天然满足。
🚨 **「切标的清空」不能只靠屏重挂** —— 一旦将来同路由换 param 复用组件实例就静默失效。落**显式**的 symbol-keyed reset，并用 hook 单测钉住（先例：`use-anchor-form.spec.ts` 的 `renderHook`；本仓「mobile 零组件单测」不等于「零 hook 单测」）。

#### D-FILTER-3 · 正交关系（`FR-017`）

切 Tab **保留**（strike 与 Tab 维度正交，且双计数 + 常驻清除保证筛选态永远可见，悄悄清空反而制造一个没人解释的行为）· 意图变化致 Tab 自动让位 **保留** · **切标的清空**（行权价是标的相关量纲，PEP 的 130–150 到 AAPL 无意义，不清极可能直接筛成空表）· 重进同屏 **清空** · 数据 refetch **保留**。

#### D-FILTER-4 · 非法输入三层

1. **输入时刻吞非法键**（仿 `alert/keypad.rules.ts` 的 `applyKey`）：只留数字与至多一个 `.`，**禁负号**（strike 恒 > 0），**小数位上限 2**（clarify 定案）。⇒ state 里永远只有合法形状串。`decimal-pad` 在部分 Android 输入法仍会吐 `,` / `-`，故 sanitize 不可省。
2. **空 = 该端无界**，不是错误；打字中间态（`.` / `0.`）parse 成 `null` ⇒ 不报错不生效。
3. **下界 > 上界 ⇒ 退化成「不生效」**（range → `UNBOUNDED`），🚨 **MUST NOT 筛成空表**；提示行 **MUST 渲在两个输入框之后**且用 `? : null` 保槽位（原因见 Guardrail 7）。
   形状正则与 `anchor-form.schema.ts:12` 的 `NUMERIC` 同族，但**不复用那个常量**（它带负号、且属 zod schema 层）—— 在 `leg-filter.rules.ts` 内定义并注释指回来源。

#### D-FILTER-5 · 计数、空态与右端槽位

- 未筛选：`共 M 行` **原样不动**（既有 SC-012 e2e 断言 `COPY.rowTotal(ROWS)`，无谓改动会白红一条）
- 已筛选：`筛后 N / 全量 M`，M = **当前 Tab 的筛前行数**
- **右端槽位互斥**（clarify 定案）：获焦显「完成」（收软键盘 —— 数字键盘无系统级完成键），失焦且筛选生效显「清除」。**MUST NOT 同时占两份宽度**。
- **筛后 0 行**：`LegBlockNotice` 按 active 二分，显「筛选后无匹配」而非复用 `LEG_COPY.empty`
- 🚨 **strike 解析不出的行 MUST 保留**（`FR-013`），与 047 `FR-007`「greeks 缺失也不筛除」同族：「不知道」不等于「不匹配」
- **软键盘不做整屏避让**（`FR-023`）：sticky 栈原位不动，键盘只遮下半屏数据行

---

### D-TAB · 意图 Tab 稿 A（`FR-019`–`FR-022`）

#### D-TAB-1 · 定稿形态

**稿 A：等分三格 + 选中格 `surface-sunken` 底 + 底部 3px×28 `brand-500` 短横条，行高约 40px**（mockup ⑥ 定稿，2026-08-11）。仓内先例 `portfolio/detail-tabs.tsx`（未选态用等高透明占位防跳动，照抄）。
选中态**双重编码**（底色 + 横条）是刻意的：`react-native-web` 不认 `accessibilityState`，e2e 只能靠 `textStyleOf` 样式自比较，双重编码让那条断言更稳。

#### D-TAB-2 · 六条不可动的约束

`accessibilityRole="tab"` + `accessibilityState` + `accessibilityLabel` 三件 · testID `optionsdesk-detail-leg-tab-${t}`（e2e 三处依赖）· **零 `disabled`、零条件不渲染** · notices 槽位仍在 Tab 行下方同一 sticky header · 三 Tab 仍共用一个 `SectionList` · 选中与未选**必须有 computed style 差异**。

#### D-TAB-3 · 不上提 `~/ui`（本片显式判定）

`portfolio/detail-tabs.tsx:6` 已有先例判决「等分固定 Tab ≠ 横滑 pill Tab，不强行统一」；ADR-0030 的上提判据是「出现第二个 consumer」，本片**不新增 consumer**。统一 `alert` / `portfolio` / `optionsdesk` 三家等分 Tab 是独立重构（动两片已 ship 屏及其 e2e），登记为债。

#### D-TAB-4 · 栈高预算（mockup ⑨ 的量化结论，直接约束 impl）

三稿常态占比 32.1%–33.5%，**差异仅 1.4 个百分点** ⇒ Tab 形态按可读性选而非省高选。sticky 栈净高（稿 A）= 计数 26 + 意图水位 44 + Tab 40 + 筛选行 40 + 列头 30 + 指示条 2 = **182px**，含 chrome 93 后占 844 视口 **32.6%**，数据区余 11.2 行。
⚠️ **「+2 条就地注明」那一档三稿全部越过 35% 目标（36.9%–38.2%）** —— 未选水位时会同时渲两条注明。impl 期要么让注明与筛选行共存时更紧凑，要么接受那一档的 37%（数据区仍 >10 行，`SC-011` 的 ≥3 行不受威胁）。**这一条 MUST NOT 靠删注明来"解决"**（`FR-017`〔047〕要求未选水位必须就地说明）。

---

### D-TEST · 验证三层分工

#### D-TEST-1 · vitest（Small，纯 rules + `renderHook`）

`leg-filter.rules.ts` 全量（空/单端/闭区间 · min>max ⇒ invalid 且**结果行数 = 全量**不是 0 · strike 解析不出的行保留 · 保序 · sanitize 吞 `-` `,` 第二个 `.` 与第 3 位小数）· `legPickerSections(legs, tab, range)` 复合与保序 · 计数口径 · hook 两条状态机分支（换 symbol 清空 / 切 Tab 保留）。
❌ 覆盖不了：任何横滑、手势、布局、高度、渲染。

#### D-TEST-2 · Playwright Expo Web e2e（Medium，hermetic）

**能覆盖**：筛选功能全链（输入→行数变→文案变→清除复原→min>max 不清空表→切 Tab 保留→筛后 0 专用空态）· 横滑的**位移正确性**（拖拽后动作列 x 左移 / 表头与行 Δx ≤1px / 首列 x 不动 / 纵滚后横向 Δx 不变）—— 这套判据**不依赖任何滚动容器实现**，换范式后不再脆 · 指示条存在且随拖拽移动 · Tab 选中态样式自比较。

🚨 **既有 US2-AS6 必须重写，是强制项不是可选项**：它现在用 `horizontalScroll()` 读 `scrollLeft`/`scrollWidth`（`spec.ts:523-536`）+ `page.mouse.wheel(400, 0)` 驱动（`:542-548`）。E 范式下**没有 DOM 滚动容器可读**，且 **`wheel` 不驱动 RNGH 的 Pan** ⇒ 两者全部失效。换指针拖拽且**分多步 `mouse.move`** 才能越过 `activeOffsetX(12)`；驱不动就退 `page.touchscreen` / CDP dispatch，🚫 **MUST NOT 因驱不动就把断言删成恒真**。

❌ **覆盖不了（写进 e2e 文件注释，不凑假断言）**：手感/动量/回弹 · **自激环**（E 构造上无环，但「改回去/改错」在 web 上多半静默不红 —— ADR-0063 已实证合成手势下 A 臂完全测不出问题）· 大规模虚拟化窗口 · a11y `selected` 语义（rn-web 不认）· **软键盘**（web 无 ⇒「输入时 sticky 栈被顶走 / 输入框掉焦」两个最可能的筛选 bug 零覆盖）· sticky 栈高在真机窄屏的实际占比。

#### D-TEST-3 · 真机验收单（Mate50 dev-client）

**探针纪律**（照抄 ADR-0063 三次教训）：走 `useAnimatedProps → TextInput.text`，全程 UI 线程；🚫 MUST NOT 用模块级可变对象（Fast Refresh 后 worklet 与 React 各持一份 ⇒ 恒 0）；🚫 MUST NOT 从 JS 线程读 `sharedValue.value` 下结论；🚫 视觉标尺在表头与数据行**必须同形同字符数**。探针仅挂 `__DEV__` 分支，**验完删除、不入仓**。

| #       | 判据                | 通过 / 失败签名                                                                                                          |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **M1**  | 无自激环            | 快滑 10 次松手静置 3s：写入停增、反转不涨。🚨 失败签名 = **净位移为零而写入/反转仍在涨**（静态截图此时看起来是对齐的） |
| **M2**  | 逐像素对齐          | 中途截停，表头与全部可见行同列左缘 ≤1px                                                                                  |
| **M3**  | 手势归属            | 纯纵 / 纯横 / 斜滑 / 横滑中途转纵：归属先越 12px 的方向，无粘滞                                                          |
| **M4**  | 首列钉住 + clamp    | 滑到底：行权价列一像素不动，最右「动作」列完整露出**不多不少**（滑不到底 ⇒ `maxTx` 用了 JS 闭包旧值）                    |
| **M5**  | 指示条              | thumb 长度比 = 列宽比；到底贴右缘；不溢出时整条不出现                                                                    |
| **M6**  | 旋转 / 分屏         | 各切一次后 `tx` 仍在合法域、能滑到底                                                                                     |
| **M7**  | 虚拟化仍生效        | 真票 730 行快滑到底再回：无长时间白屏占位；内存不单调涨                                                                  |
| **M8**  | 筛选 × 软键盘       | 表头栈不被顶走、表仍可见 ≥3 行；**故意输成 min>max** 时不掉焦、键盘不收                                                  |
| **M9**  | 筛选实时性          | 730 行下逐字符输入 ≤1 帧出结果（卡才触发 debounce 兜底，本片默认不做）                                                   |
| **M10** | a11y                | TalkBack 过 3 Tab + 2 输入框                                                                                             |
| **M11** | 计数 / 空态口径     | 筛出 0 行显「筛选后无匹配」+ 常驻清除，**不是**「零适格腿」                                                              |

🚨 **合成手势不算数**：`adb shell input swipe` 是单指、单向、无交错的干净手势，ADR-0063 实证 A 臂在它下面**完全测不出问题**。**M1 / M3 MUST 人手滑**。

---

### D-DEBT · 048 的 V-C gate 判据改写（本片**只备措辞，不改 048 文件**）

**处置理由**：跨分支改 in-flight feature 的 spec 命中 `implement-task-closure.md` Stop signal #4「改动溢出本 feature」；且新判据要引用的组件名与签名得等 049 impl 定型才准，现在改大概率改两次。可发现性由两条保证：本段成文措辞 + 049 PR body 的 follow-up 条目。

> **V-C（改写版，供 048 复工首步 apply）**：本 gate 验的不再是「范式是否成立」—— ADR-0063 已判定 A 范式为缺陷载体、E 范式为采纳方案，049 已在单票选约表落地并完成真机验收。改验「**E 范式在跨标的规模与雷达页结构下的手势归属与对齐**」，四条：① 单 `Gesture.Pan` 包住雷达页 `SectionList` 时横滑/纵滚各自归属正确、无粘滞；② 表头与全部行读**同一个** `tx`，滚动中逐像素齐 —— 判定签名同 ADR-0063 实测表，**必须带数值探针**；③ 纵向虚拟化仍生效；④ **seg 切换换整份 `section.data` 后 `tx` 的行为符合预期**（049 无此场景，是 048 独有的新增面）。推荐语义：切 seg 时 MUST 把 `tx` 归零 —— 列集与滚动区宽都可能随 seg 变，保留旧位移会让新列集停在越界位置。
> **规模不再是本 gate 的风险源**（V-B 已实测 210 行 / 硬上界 810 行，与 047 已 ship 的 730 行同量级）；gate 保留的理由由「范式未知」改为「结构未验」。
> 连带：048 `plan.md` 中 `LegColumnScroller({ offset, children, testID })` 的 3 处引用改为 `LegColumnPane({ tx, contentWidth, children, testID })` + `useLegColumnPan({ tx, viewportW, contentWidth })`。

---

### 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红）

1. **`GestureDetector` 的子节点 MUST 是单个带 `collapsable={false}` 的原生 View** —— 传 Fragment 或被 view-flattening 压平，手势**静默不生效**；那两条 dev 告警是唯一信号，🚫 MUST NOT `LogBox.ignoreLogs` 压掉（2026-08-10 实撞，压掉后根因被消音）。
2. **屏 MUST 自包裹 `GestureHandlerRootView`** —— 仓内根 `_layout` 不全局挂。漏了是 Render Error，红在一个看不懂的地方。
3. **`offset`（正）→ `tx`（负）的符号翻转 MUST 连带改名** —— 类型一样，不改名则真机上「方向反了」。
4. **`maxTx` MUST 在 worklet 内每帧从 `viewportW.value` 重算** —— 提到 JS 闭包，旋转后右侧滑不到底且不会红。`withDecay` 的 `clamp` 同理。
5. **`onLayout` 变宽时 MUST 顺手把 `tx` clamp 回新域** —— 否则竖→横→竖后卡在越界位置只能反向滑。PoC 没有这一面（只在挂载算一次）。
6. **NativeWind web 坑**：`className` 挂 `Animated.*` 上会被**整串吞掉** ⇒ pane / thumb 的 token 一律下沉到 plain 子 `View`（`leg-table-header.tsx:12-15` 已记，别踩回去）。坑 ②（width 挂 `ScrollView` 不约束 frame）本片自动消失，但外层 wrapper 仍要留（`overflow-hidden` 靠它）。
7. **筛选提示行 MUST 渲在两个 `TextInput` 之后，且用 `? : null` 保槽位** —— 插在前面会改变兄弟位置导致 `TextInput` 重挂，表现为「每输一个非法字符键盘就收」，而 typecheck / web e2e（无软键盘）全绿。
8. **下界 > 上界 MUST 退化成「不生效」，MUST NOT 筛成空表**。
9. **strike 解析不出的行 MUST 保留**。
10. **计数条分母 M = 当前 Tab 的筛前行数** —— MUST NOT 是全 Tab 全量或渲染窗口大小（后者是 SC-012 明禁）。
11. **未筛选时计数条 MUST 保持 `rowTotal(M)` 原文案** —— 一律换成双计数会白红既有 SC-012，且给未筛选的人两个相同的数是噪音。
12. **Tab 改版 MUST NOT 动 testID / 三件 a11y / notices 槽位 / 零 `disabled`**。
13. **e2e 横向断言 MUST 带前提自检**（拖拽前动作列确在视区外）—— 视口一宽就恒真，是这类断言最常见的假绿。
14. **`mouse.wheel(dx,0)` 不驱动 RNGH 的 Pan**，且既有 `horizontalScroll()` 在 E 范式下没有对应 DOM 节点 ⇒ 重写 US2-AS6 是强制项。
15. **`SectionList` MUST 仍是全页唯一纵向滚动容器** —— 新增的手势层 / 指示条 / 筛选行都是非滚动元素；🚫 MUST NOT 为「让筛选行不随表滚」在外面再包 `ScrollView`（屏头 20 行明令，RN 只打一条 dev warning，CI 全绿）。
16. **`renderSectionHeader` 是内联箭头** ⇒ 筛选态每按键触发整栈重渲。本片靠「状态放 hook + `LegRow` memo + `renderItem` useCallback」消化；🚫 MUST NOT 反过来往 header 里塞更多未 memo 的重组件。
17. **PoC 代码 MUST NOT 入仓** —— 只抄机制。`ScrollerE` 把宽度写死为模块常量、无 testID、带探针脚手架，三处都要在 `LegColumnPane` 里补齐 / 剥掉。
18. **`design/` 的 mockup 用 `overflow-x: auto` 原生滚动只是表达手段** —— 照抄就等于把 047 的缺陷载体再造一遍。首列 sticky 同理（RN 没有 CSS sticky，靠「渲在横滑之外」）。

## Complexity Tracking

> Constitution Check 无违规，本表为空。
