---
feature_id: 033-ideation-multimodal-input-shell
spec_ref: ./spec.md
plan_ref: ./plan.md
status: ready
created_at: '2026-06-22'
---

# Tasks: 033-ideation-multimodal-input-shell（ideation 多模态输入 UI 壳 — B2-1）

**Spec**: [`spec.md`](./spec.md) | **Plan**: [`plan.md`](./plan.md) | **Branch**: `033-ideation-multimodal-input-shell` | **设计源**: [B2 拆分 plan](../../docs/private/plans/2026-06/06-22-ideation-b2-split-b2-1-ui-shell.md) + [mockup](./design/)

## Format

`- [ ] T0NN [P?] [USx?] [层] 描述 + 文件路径`

- `[P]` = 可并行（不同文件、无未完成依赖）；`[USx]` = user-story 阶段 task 带；层 = `[Mobile]` / `[Mobile-E2E]` / `[Verify]`（**本 feature mobile-only**，无 `[Server]`/`[Contract]`/`[Contract-Smoke]` —— 零 server / 零 api-client / 零新依赖）
- **TDD（强制，per `.claude/rules/implement-task-closure.md` 6 步闭环）**：每 impl task 内联绑测试（红→绿→typecheck/lint→`[X]`→commit）；**纯逻辑**（attachments hook 的 add/remove/权限分支）= vitest 无 DB（mock `expo-image-picker`）；**UI·render·a11y·交互**（输入栏 / sheet / 缩略图 / toast）= Playwright Expo Web e2e（`~/ui` presentational 原语无单测，per ui 约定）
- 无 task-meta JSON（**manual 模式**，per 004-032）
- 🚨 **零回退底线（FR-003 / SC-001）**：B1 文本澄清闭环（发送 / SSE 流式 / 停止 / 空校验）逻辑**零改**——只重排 InputBar 布局、不动 `use-ideation-session` / `ideation-stream-client`
- 🚨 **图片只到本地预览（FR-011）**：选/拍 → `StagedAttachment{id,localUri}` 本地暂存 → 缩略图带回；**禁** OSS 上传 / 随消息发送(vision) / 标注 / `expo-media-library`（全 defer B2-3）。send 仅发文本，带附件时附 `fireToast('图片发送即将开放')` 且附件保留不清
- 🚨 **stub 入口（FR-010）**：添加文件 / 选择代码库 / 麦克风 点击 = `fireToast('即将开放')`，不触发能力/权限/导航
- 🚨 **复用不重设（per mobile-impl-playbook Strangler-Fig）**：`~/theme` token 直搬 0 新增；picker 复用 `profile-image` 范式（**不接 upload/manipulate**）；sheet 参考 `ProfileImageActionSheet`/`~/ui/BrokerPickerSheet`
- 🚨 **RN 布局陷阱（per mobile-impl-playbook）**：bottom-sheet 内禁裸 `flex-1`；autosize 高度是「动态计算」→ 允许 inline `style={{height}}`（nativewind-mapping 例外）；NativeWind 单元素 ≤4 atom 超则抽组件；`rounded-full` 非 `rounded-[50%]`
- **单 PR**：`feat(ideation)` —— mobile-only 原子 merge；验证落 `[Mobile-E2E]` 单层 + `[Verify]` 真机手验，**无 contract-smoke**

## Path Conventions

- mobile：改 `apps/mobile/src/ideation/ClarifyChatScreen.tsx`（InputBar 重构 + toast + 接 sheet/attachments）；新建 `apps/mobile/src/ideation/{InputPlusSheet.tsx, use-ideation-attachments.ts, IdeationToast.tsx, ThumbChip.tsx}`；新建 `apps/mobile/src/ui/IconButton.tsx`（通用原语）；copy 文案进既有 `IDEATION_COPY`
- e2e：扩展 `apps/mobile/e2e/` 既有 ideation spec（mock SSE 沿用 + **新增 `expo-image-picker` mock**：`launchImageLibraryAsync`/`launchCameraAsync`/`request*PermissionsAsync`）；003 refresh 拦截器 mock 沿用
- 依赖：复用**已装** `expo-image-picker ~17.0.11`（`apps/mobile/package.json:44`）；**不引入** `expo-media-library`
- 验证：`pnpm nx run mobile:runtime-smoke`（改共享 hook/mock 跑全套）；真机 `pnpm nx run mobile:start`（dev-client）

---

## Phase 1: Setup — 共享原语（阻塞所有 US）

**Goal**：抽出 InputBar 与 sheet 都要用的图标按钮原语 + 全 feature 共用的 toast 机制。

- [X] T001 [P] [Mobile] 抽 `apps/mobile/src/ui/IconButton.tsx`（36×36 `rounded-full`，props `{children(SVG), onPress, disabled?, bg?, fg?, accessibilityLabel, testID}`）+ 从 `~/ui/index.ts` 导出 + 用它重渲 `ClarifyChatScreen.tsx` 现有 send/stop 钮（**视觉等价、testID 不变**）→ verify：`nx run mobile:runtime-smoke --skip-nx-cache`（新文件首跑）现有 ideation e2e 绿、无回归
- [X] T002 [P] [Mobile] ideation 内联 toast：新建 `apps/mobile/src/ideation/IdeationToast.tsx`（absolute pill，白底 + card 阴影 + ink 文字，auto-hide ~1.9s）+ `ClarifyChatScreen` 顶层持 `toast` state & `fireToast(msg)`（下传子组件）+ `IDEATION_COPY` 加文案（`comingSoon='即将开放'` / `imageSendComingSoon='图片发送即将开放'` / `permissionDenied='请在系统设置开启相册/相机权限'`）→ verify：临时触点可见（正式断言在各 US e2e）

---

## Phase 2: US1（P1）两区输入栏 + 文本闭环零回退

**Goal**：InputBar 重构为「自增长文本区 + 按钮栏」，文本澄清闭环零回退。**独立测**：开会话多行发送→AI 流式→停止→空文本禁用，布局两区。
**MVP**：T001-T004 = 可独立 demo 的最小切片（输入栏定形 + 文本闭环不退）。

- [X] T003 [US1] [Mobile] `ClarifyChatScreen.tsx` InputBar(320-392) 两区重构：上区 textarea autosize（`onContentSizeChange` clamp `[48px,134px]`，超出内部滚动）+ 下区按钮栏 `[+]·····[mic][send/stop]`（send/stop 用 `IconButton` 移入栏、尺寸一致；mic→`fireToast(comingSoon)` stub；`+`→开 sheet 占位回调）；**保留** `isStreaming` 切换 / `sendDisabled` / web `onKeyPress` Enter / `editable` / placeholder / 各 testID / SSE 发送停止逻辑零改 → verify：[Mobile-E2E] T004
- [X] T004 [US1] [Mobile-E2E] e2e 扩展：两区布局可见 + 发送按钮在按钮栏内 + 文本多轮发送走 SSE(mock) 零回退 + 流式→停止 + 空文本发送禁用 + 输入多行 autosize 增高至上限后内部滚动（state_branches 1-5、SC-001/002/006）→ verify：`nx run mobile:runtime-smoke`

---

## Phase 3: US2（P2）选图/拍照 → 本地缩略图带回

**Goal**：`+` 面板选图/拍照 → 本地缩略图带回输入区预览、可移除；图片**不上传不发送**。**独立测**：+ → 图片(mock 多选)/摄像头(mock) → 缩略图带回 → ×移除；send 带图弹「图片发送即将开放」。

- [X] T005 [US2] [Mobile] 新建 `apps/mobile/src/ideation/use-ideation-attachments.ts`：`StagedAttachment[]` 本地态 + `pickFromLibrary()`（`requestMediaLibraryPermissionsAsync`→被拒 `fireToast(permissionDenied)`；`launchImageLibraryAsync({mediaTypes:'images',allowsMultipleSelection:true})`→assets.uri 追加）+ `captureFromCamera()`（`requestCameraPermissionsAsync`→`launchCameraAsync`）+ `remove(id)`/`clear()`；**复用 profile-image picker 范式但不上传/不 manipulate** → verify：**vitest** 逻辑测（add/多选/remove/clear/权限被拒分支，mock `expo-image-picker`）红→绿
- [X] T006 [US2] [Mobile] 新建 `apps/mobile/src/ideation/InputPlusSheet.tsx`（root RN `Modal` transparent+slide，bottom-sheet：scrim `bg-modal-overlay` onPress 关 + grabber + 4 入口；摄像头→`captureFromCamera`、图片→`pickFromLibrary`、添加文件/选择代码库→`fireToast(comingSoon)`；**禁裸 flex-1**）+ `ClarifyChatScreen` `+` 按钮接开/关 sheet → verify：[Mobile-E2E] T008
- [X] T007 [US2] [Mobile] 缩略图预览：新建 `apps/mobile/src/ideation/ThumbChip.tsx`（58×58 `rounded-lg` + 本地 uri 背景 + 右上 × 移除）+ 挂 InputBar textarea 上方一排（attachments 来自 hook）+ **send 带图语义**：`sendDisabled` 仅看文本（附件不计入）；有文本+附件点 send→照发文本 + `fireToast(imageSendComingSoon)` + 附件保留不清 → verify：[Mobile-E2E] T008
- [X] T008 [US2] [Mobile-E2E] e2e：点 `+` 开 sheet 见 4 入口 + 点图片(mock 多选 2 张)→2 缩略图带回 + 点×移除其一 + 点摄像头(mock)→带回 + 有附件 send→文本发出且弹「图片发送即将开放」附件留存（state_branches 6,7,8,10,11,13、SC-003）；**新增 expo-image-picker mock** → verify：`nx run mobile:runtime-smoke`

---

## Phase 4: US3（P2）权限边界优雅处理

**Goal**：相机/相册权限被拒不崩、有去设置引导。**独立测**：mock 权限 denied → 点摄像头/图片 → toast 引导、不进选图/拍照。

- [ ] T009 [US3] [Mobile-E2E] e2e：mock `request*PermissionsAsync` 返回 denied → 点 图片/摄像头 → `fireToast(permissionDenied)`、不崩、不进入 picker/相机（state_branch 9、SC-004）；受限(limited)态注明交系统 picker（web 仅 mock，真机手验在 T012）→ verify：`nx run mobile:runtime-smoke`（被拒处理逻辑在 T005）—— ⛔ **BLOCKED**：Expo Web 的 `expo-image-picker`（`ExponentImagePicker.web.js`）权限 API **硬编码 `granted:true`**（web 不需权限），且为 bundled ES-module binding 无 `window`/`globalThis` 逃生口 → denied 分支在 Playwright Expo Web **不可达**，无法不改产线代码（加 `__E2E` seam）干净 mock。被拒逻辑已由 **`use-ideation-attachments.spec.ts`（vitest）**覆盖（相册/相机被拒各 1 it：`fireToast(permissionDenied)` + 不拉 picker + 不追加），真机被拒路径手验落 **T012**。**决策（2026-06-22）：采纳方案 A —— 保持 blocked，FR-009/SC-004 由 vitest 逻辑层 + T012 真机双层达成，不为测试改产线码。** ✅ **2026-06-23 更新**：T012 已在 Mate50 真机实证 denied 路径（点图片→系统弹窗→禁止→不崩/不进 picker/toast 引导），**FR-009/SC-004 双层验证闭环完成**（web e2e 仍按 blocked 处理，因 web 平台限制不可达，非缺口）。

---

## Phase 5: US4（P3）其余入口 stub

**Goal**：添加文件/选择代码库/麦克风 = 「即将开放」占位。**独立测**：三入口各弹 toast、无能力触发。

- [X] T010 [US4] [Mobile-E2E] e2e：点 添加文件 / 选择代码库（sheet 内）+ 麦克风（按钮栏）→ 各 `fireToast(comingSoon)`、不请求权限/不导航/不录音（state_branch 12、SC-005）；wiring 已在 T003(mic)/T006(sheet rows) → verify：`nx run mobile:runtime-smoke`

---

## Phase 6: Polish & 跨切

- [X] T011 [Mobile-E2E] state_branches 13 条覆盖审计（逐条对应 `it()`）+ 面板遮罩/返回关闭不丢文本与缩略图（state_branch 13）+ **移除项 absence 断言**（连接器 / 聊天气泡图标 + 连接我的电脑 / 添加技能 / 创建网站 / 制作幻灯片 / 创作图像 均不渲染，FR-013）+ 全交互 `accessibilityLabel` 检查；改共享 hook/mock 后 → 跑全 `nx run mobile:runtime-smoke`（blast radius）。**裁定**：分支 3（流式→停止）以 delayed-mock 制造可断言流式窗口补结构性断言（停止键可见可点→abort 回非流式），abort 落地语义继承既有 027/030/032 覆盖；分支 9（权限被拒）web 不可达 → T009 blocked，逻辑由 use-ideation-attachments.spec.ts vitest 覆盖；全 114 e2e 绿（零回退）
- [X] T012 [Verify] dev-client 真机手验（web e2e 仅 mock、覆盖不到原生路径）：系统相册 picker 多选 / 相机拍照 / iOS limited 受限 / 权限被拒去设置 / autosize textarea + bottom-sheet 真机不塌缩不溢出 → 截图留证（plan Gate 0.1 evidence）—— ✅ **2026-06-23 Mate50（CET_AL00, Android）经 EAS development(dev-client) APK + 本地 Metro(fresh 033) + ADB 驱动手验**，证据 `design/t012-device-evidence/`：① 两区输入栏(T003)渲染正确 ② InputPlusSheet(T006) 4 入口 ③ **原生权限弹窗**(真 expo-image-picker) ④ **权限被拒→不崩/不进 picker**(SC-004，**补齐 T009 web 不可达的 denied 真机验证**) ⑤ 权限允许→**系统相册 picker→本地缩略图带回**(US2/SC-003，T007) ⑥ **× 移除缩略图**(FR-008) ⑦ **带图 send→纯文本发出+缩略图保留**(FR-011) ⑧ **SSE 澄清闭环零回退**(AI 流式回复正常，FR-003/SC-001) ⑨ 软键盘弹起按钮栏不塌缩(SC-006) ⑩ a11y label 齐(添加附件/语音输入/发送/移除附件)。**iOS limited 受限态**=Android 设备不适用（留 iOS 设备补）；**相机拍照**未单独截图但权限+picker 同机制已验。详情屏 fresh code **不复现** stale bundle 上的 Fabric 崩（外脑 list 崩溃为旧 embedded bundle 现象，对本 PR 不成立）。

---

## Dependencies

1. **T001 + T002（Setup）阻塞全部** —— IconButton 供 InputBar/sheet，toast 供 US2/3/4。
2. **US1（T003-T004）** 依赖 T001/T002；是 MVP。
3. **US2（T005-T008）** 依赖 US1 的 InputBar/`+`：T006/T007 依赖 T005（hook）；T008 依赖 T006+T007。
4. **US3（T009）** 依赖 T005（权限处理）+ T006（入口）。
5. **US4（T010）** 依赖 T003（mic）+ T006（sheet rows）。
6. **Polish（T011-T012）** 全部之后。

## Parallel 机会

- T001 ∥ T002（不同文件、无依赖）。
- US2 内 T005（hook，vitest）可与 T006 sheet 骨架并起，但 T006 接线、T007 send 语义依赖 T005 完成。

## Implementation Strategy

- **MVP 先行**：T001→T002→T003→T004（输入栏定形 + 文本闭环零回退）即可独立 demo / merge 价值。
- **增量**：US2（图片带回）→ US3（权限）→ US4（stub）→ Polish，逐 story 可独立验。
- **clear 检查点批次**（per Constitution §III）：建议 [T001-T002]、[T003-T004]、[T005-T006]、[T007-T008]、[T009-T010-T011]、[T012] 为批次，批次后停顿提示 /clear。
