---
feature_id: 033-ideation-multimodal-input-shell
spec_ref: ./spec.md
status: drafted
created_at: 2026-06-22
updated_at: 2026-06-22
adr_refs: ['0024', '0027', '0030', '0040', '0057']
context7_verified: []
---

# Implementation Plan: ideation 多模态输入 UI 壳（B2-1）

## Summary *(mandatory)*

重构 ideation 澄清对话底部输入栏为「自增长文本区 + 按钮栏」两区，加 `+` 附件面板（root Modal bottom-sheet）：图片/摄像头经现有 `expo-image-picker` 选/拍 → 本地缩略图带回输入区预览（可移除）；添加文件/选择代码库/麦克风为「即将开放」toast stub。**纯 mobile，零 server / schema / api-client / 新依赖**；上传 + 随消息发送(vision) + 标注 + sheet 内嵌实时照片画廊 defer B2-3。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
|---|---|---|
| None（无新增） | 图片选择/拍照复用**已装** `expo-image-picker ~17.0.11`（`apps/mobile/package.json:44`），API 用法见现成代码 `apps/mobile/src/profile-image/use-profile-image-upload.ts:156-192`（`requestCamera/MediaLibraryPermissionsAsync` + `launchCamera/ImageLibraryAsync`）。多选加 `allowsMultipleSelection:true`（expo-image-picker 原生支持） | N/A — 无新依赖 |
| **显式不引入** `expo-media-library` | sheet 内嵌实时照片画廊（读相册渲缩略图条）需要它 → 本段 D1 决策**不做**，以系统 picker 替代，留 B2-3 | spec FR-014 + design/handoff.md D1 |

## Constitution Check *(mandatory gate)*

- [x] **Passed** — plan honors all constitution principles.
  - **§I SDD + mockup-first**：spec → clarify（7 问）→ **Mockup（design/ input-composer.dc.html 已落）** → 本 plan，未跳步。
  - **§II TDD**：每 task 红→绿（mobile 逻辑 vitest / UI Playwright Expo Web e2e）→ tasks.md `[X]` → commit。
  - **§III Atomic task**：tasks 按 30min-2h 拆（IconButton / InputBar 重构 / sheet / picker hook / e2e）。
  - **§IV Module Boundary**：**N/A**（无 server bounded context 改动；纯 `apps/mobile/src/ideation/` + `apps/mobile/src/ui/`）。
  - **§V 单 PR + 类型链**：mobile-only 单 PR；**无 server endpoint / 无 api-client regen / 无 contract-smoke**（零 server 改动），验证落 `[Mobile-E2E]` 单层。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: **N/A** — 本 feature 零 server 改动（无新 endpoint）。
- [x] **Mobile / Web**: P1（两区输入栏 + 文本闭环）+ P2（选图/拍照→缩略图）golden-path 落 Playwright Expo Web e2e（picker 走 mock）；picker/相机/权限真机行为补 dev-client 手动验（picker 在 web 仅 mock）。
- [x] **Evidence**: impl 阶段产出 `apps/mobile/e2e/` ideation spec 扩展 + dev-client 手动验截图（picker/权限）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** — 本 plan **不引入新第三方包**（复用已装 `expo-image-picker`；显式不引 `expo-media-library`）。**Evidence**: `apps/mobile/package.json:44` 已含 expo-image-picker；无新增。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature 为 mono-native**（ideation B2 阶段新 UI，无任何从旧 meta-repo 迁入的代码/路径/类名）。Evidence: `rg -n 'mbw-|org\.springframework|src/main/java' specs/033-ideation-multimodal-input-shell/` → 无命中。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
|---|---|---|---|
| ADR-0045（OSS 图片上传 sunset：大文件/私有/multipart） | 本段**不触发** —— 图片只到本地预览、不上传 | accepted-as-is | 上传在 B2-3 触发评审；本段无 OSS 交互 |
| ADR-0057（ideation ctx）| 无新 open question | accepted-as-is | 本段纯 mobile UI，不动 ctx 边界 |

无其它受影响 Open Questions。Evidence: `rg -n 'Open Question' docs/adr/0045*.md docs/adr/0057*.md` 人工核对；本段不上传/不动 server，未引爆任何 deferred mitigation。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants

- **NO LIFECYCLE MOCKING / Moat / ADR-0043 flat-anemic**：**N/A** —— 本 feature **零 server 组件**（无 Guard/Interceptor/Filter/Pipe、无 Prisma、无 UseCase）。
- **EXHAUSTIVE BRANCHING（适用）**：spec.md `state_branches` 每条**必须**在 `apps/mobile/e2e/` 有对应 e2e 断言（Playwright Expo Web）。13 条分支 100% 覆盖——含权限被拒、带图发送 toast、面板关闭不丢态等非 happy-path。
- **hermetic mock = 契约镜像**：扩展既有 ideation e2e mock 时，SSE turns 保持 append-only canonical 状态（per mobile-impl-playbook）；**新增的 picker mock**（mock `launchImageLibraryAsync`/`launchCameraAsync` 返回固定 assets + 权限态）是纯函数，不按测试编排分支。改共享 hook → 跑全 `runtime-smoke` 非单 spec。

### General Architecture Notes

> 本 feature **mobile-only**，ADR-0043 server 扁平/贫血/护城河范式 **N/A**。遵循 mobile 侧：NativeWind 映射规则 + Strangler-Fig 复用 `~/theme`+`~/ui` + RN 布局陷阱。

**核心改造锚点与文件**：

1. **InputBar 重构**（改 `apps/mobile/src/ideation/ClarifyChatScreen.tsx` 的 `InputBar` 函数，现 320-392）：
   - 现状 = 单 `TextInput`(multiline) + 单 send/stop 圆钮（`w-9 h-9`）。改为**两区**：上区 textarea + 下区按钮栏 `[+] ········ [mic] [send/stop]`。
   - **autosize**：`onContentSizeChange` 测 `contentSize.height`，clamp `[minH≈48px(≈2行), maxH≈134px]`，超出内部滚动（`scrollEnabled` + 状态存高度）。动态高度是「className 表达不出的动态计算」→ 允许 inline `style={{height}}`（per nativewind-mapping rule 例外）。
   - **保留不动**：`isStreaming` → send 切 stop、`sendDisabled`、web `onKeyPress` Enter 发送、`editable`、placeholder（`IDEATION_COPY.clarifyInputPlaceholder`）、各 `testID`。SSE 发送/停止逻辑零改（FR-003 零回退）。
2. **抽 `apps/mobile/src/ui/IconButton.tsx`**（`~/ui` 无 IconButton）：36×36 `rounded-full`，props `{ icon(children SVG), onPress, disabled?, bg?, fg?, accessibilityLabel, testID }`。`+`/`mic` = 透明底 ink-muted；send = brand-500(有内容)/surface-sunken(空)。统一 ≤4 atom（per nativewind-mapping § 2）。send/stop 改用它重渲（视觉等价、testID 不变）。
3. **`apps/mobile/src/ideation/InputPlusSheet.tsx`**（新）：**root RN `Modal`**（`transparent` + `animationType="slide"`），bottom-sheet：scrim（`bg-modal-overlay` onPress 关）+ grabber + 4 入口（摄像头/图片/添加文件/选择代码库；本段**不嵌实时照片条** per D1）。范式参考 `apps/mobile/src/profile-image/profile-image-action-sheet.tsx` + `~/ui/BrokerPickerSheet`。**RN 布局陷阱**：sheet 内**禁裸 `flex-1`**（intrinsic 高度，per mobile-impl-playbook RN 布局陷阱）。摄像头/图片 → 调 attachments hook；添加文件/选择代码库 → `fireToast('即将开放')`。
4. **`apps/mobile/src/ideation/use-ideation-attachments.ts`**（新 hook）：本地 staged attachments state（`StagedAttachment[] = { id, localUri }`，**client-only、无持久化、无上传**）。
   - `pickFromLibrary()`：`requestMediaLibraryPermissionsAsync` → 被拒则 `fireToast`（引导去设置）；`launchImageLibraryAsync({ mediaTypes:'images', allowsMultipleSelection:true })` → `result.assets.map(a=>a.uri)` 追加。
   - `captureFromCamera()`：`requestCameraPermissionsAsync` → `launchCameraAsync({ mediaTypes:'images' })` → asset.uri 追加。
   - `remove(id)` / `clear()`。**不**做 ImageManipulator resize/webp（那是上传优化，B2-3 再做）；复用 profile-image 的 picker 调用范式但**不接 upload**。
5. **缩略图预览**：InputBar textarea **上方**一排 thumbChip（58×58 `rounded-lg` + 本地 uri 背景 + 右上 × 移除按钮）。复用频次/原子数 → 抽 `ThumbChip`（ideation 内联或 `~/ui`，按 ≤4 atom 判）。
6. **send 带图语义（FR-011 定稿）**：`sendDisabled` **仅由文本决定**（`text.trim()===''` → 禁用；附件不计入可发送性，因图片本段不发）。有文本 + 有附件点 send → **照发文本** + 附带 `fireToast('图片发送即将开放')`（附件**保留不清**，不静默丢弃）。
7. **toast「即将开放」机制**：`~/ui` **无 Toast**（per nativewind-mapping § 5）。本段在 `ClarifyChatScreen` 顶层持 `toast` state + `fireToast(msg)`（auto-hide ~1.9s），渲染一个 ideation 内联 `IdeationToast`（absolute pill，白底 + card 阴影 + ink 文字），`fireToast` 下传给 `InputBar`/`InputPlusSheet`/attachments hook。**不**新建通用 `~/ui/Toast`（避免动通用层，本 feature scope 内联）。
8. **权限被拒**：`!perm.granted` → `fireToast('请在系统设置开启相册/相机权限')`（不抛错、不崩，SC-004）；受限(limited)态交系统 picker 自身呈现。

**复用决策**：`~/theme` token 直搬 0 新增（mockup 已用 NVY token，per handoff 尺寸表）；sheet 范式参考 ProfileImageActionSheet/BrokerPickerSheet；picker 范式参考 use-profile-image-upload。**移除项**（FR-013）：连接器/聊天气泡图标 + 连接我的电脑/添加技能/创建网站/制作幻灯片/创作图像。

### 🚨 Impl Guardrails（mobile）

- **NativeWind**（per `.claude/rules/nativewind-mapping.md`）：视觉值走 class 禁字面量（autosize 动态高度除外）；单元素 ≤4 atom 超则抽 `~/ui`；RN-Web 用 `rounded-full` 非 `rounded-[50%]`；toast/sheet 动效 web/native 差异用 modifier。
- **RN 布局陷阱**（per `.claude/rules/mobile-impl-playbook.md`）：bottom-sheet 内禁裸 `flex-1`；缩略图横排若用 ScrollView 需包 View 约束 frame；**autosize textarea + sheet 尺寸约束改动须真机/窄视口验**，别只信 web e2e（Playwright 视口宽松会假绿）。
- **RHF 4 铁律**：**N/A** —— 输入栏是 chat composer（非 RHF 表单），沿用现有 `ClarifyChatScreen` 受控 state。
- **e2e**：扩展 `apps/mobile/e2e/` ideation spec；picker 在 web 走 mock（mock `expo-image-picker` 模块）；覆盖全部 state_branches；改共享 mock → 跑全 `nx run mobile:runtime-smoke`（blast radius，per memory）。003 refresh 拦截器 mock 沿用。

## Complexity Tracking

> 无 Constitution 违反，无需填写。
