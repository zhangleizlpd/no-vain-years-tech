# Mobile 实现 Playbook（RHF / Strangler-Fig / Claude Design mockup）

> 新 mobile（Expo / RN）feature **实现期**工程 guardrail 的**单一详版**。沉淀自 login/onboarding/cancel-deletion 实战。
>
> **引用不复述**：目录结构 / 凭据存储 → [fe-directory-structure.md](fe-directory-structure.md)；UI mockup-first flow → [`.claude/rules/sdd-authoring.md`](../../.claude/rules/sdd-authoring.md)；Metro `.js` extensionless 由 ESLint `no-restricted-syntax` 机械拦（不赘述）；测试分层（vitest = logic-only / Playwright = UI）→ [testing.md](testing.md) 不变量 4。
>
> path-triggered 摘要 + **rule 独有的 RN 布局陷阱 / GHRV 两条 src 侧 invariant** 见 [`.claude/rules/mobile-impl-playbook.md`](../../.claude/rules/mobile-impl-playbook.md)（详版不是它的超集）。
>
> **全样板索引 → [golden-sample-registry](golden-sample-registry.md)**（「task kind → 样板文件」单一索引；本 playbook 只就地点名 + 讲 HOW，不另养聚合表，避免与 registry drift）。

## 1. RHF 表单 4 铁律（Golden Sample 分层）

mono 表单唯一标准 = **React Hook Form + zodResolver**（`@hookform/resolvers`）。4 铁律：

1. **Controller ≠ register**：RN 无原生 DOM input，**必用 `<Controller>`** 包裹受控组件，禁 web 的 `register()`。
2. **表单态 ≠ 副作用态，分层**：RHF 管表单字段态；网络/提交结果/弹窗等副作用态独立（zustand / useState），不混进 form state。
3. **isSubmitting 单源**：提交中状态以 RHF `formState.isSubmitting` 为唯一来源，不另设 `loading` bool（双源会漂）。
4. **错误 + a11y 一体**：字段错误展示 + `accessibilityLabel` / 错误 announce 同步落地（非事后补）。

**分层样板**（文件头 `// GOLDEN SAMPLE` banner，起手对照）→ [registry](golden-sample-registry.md)「表单逻辑 / 编辑表单屏」行（4 铁律逻辑权威 / 最小编辑表单屏 / login 进阶参照的「勿整屏照抄」边界都在那里，本文不复述路径）。

- **实证锚**：login / cancel-deletion（004，旧仓 #198）。

## 2. Strangler-Fig port 纪律

迁/port 既有屏时分四层处置 —— **复用皮、重写肉**：

| 层                         | 处置                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **skin（皮）**             | **复用** `~/theme`（brand token，如 brand-500 `#2456E5`）+ `~/ui` 组件库（design-token 直搬不重设计，同 nativewind-mapping rule §1 / registry） |
| **muscle（API 适配）**     | 重写：消费 **Orval 生成的函数式 hook**（**非 class 包装**；axios 实例**不删**）                                                                 |
| **nervous（状态/数据流）** | 重写：RHF + zustand，按本 feature 数据流                                                                                                        |
| **engine（路由）**         | 沿用 Expo Router 结构（`(auth)` / `(app)/(tabs)` / settings），hooks/components 重写                                                            |

- **反模式**：class 包装 Orval / 删 axios / 用 claude-design 重设计已稳定 token。
- **实证锚**：login / onboarding / cancel-deletion port（003-005）。

## 3. Claude Design mockup（design 先行）

适用所有 UI feature（mockup-first，per [`.claude/rules/sdd-authoring.md`](../../.claude/rules/sdd-authoring.md) § 前端 UI 工作流）。生成走 [`/mockup-gen NNN`](../../.claude/commands/mockup-gen.md)（2 段 prompt 模板 SoT 在该 command Step 1，本文不再养一份；project 映射见 [design-system-mapping.md](design-system-mapping.md)）。产出 = **HTML preview baseline**（非最终 RN），翻 RN 时复用 `~/theme` token + `~/ui`，**0 新 token**；**代码是真相源**，mockup drift 不算 bug（留迹路径见 sdd-authoring § Mockup 留迹路径）。

## 4. impl 期 stop-signals

→ [`.claude/rules/implement-task-closure.md`](../../.claude/rules/implement-task-closure.md) § Stop signals。

## 5. 契约冒烟（contract smoke）— 跨端 feature mobile 侧第二层验证

per [Constitution §V](../../.specify/memory/constitution.md) ②（定义不复述）：hermetic mock 是「假设契约」、server IT 不经生成客户端，契约冒烟补这条缝 —— node 层、无浏览器，用**生成的 `@nvy/api-client`** 打 testcontainers 真 server 跑一条 happy-path，验契约对齐 + 基建（真 token / 真落库 / 真状态机）。

- **怎么加**：新建 `apps/mobile/e2e/contract-smoke/<feature>.contract.ts`，导出 `export const name` + `export async function run(ctx: RealBackendCtx)`；在 `contract-smoke/run.ts` 的 `SPECS` 注册一行。boot+登录由共享 `bootRealBackend()`（`e2e/_support/real-backend-harness.ts`）摊销——spec 只写「调生成客户端 + `node:assert` 断言响应/读回/错误码」。
- **样板**：[registry](golden-sample-registry.md)「Medium 契约冒烟」行（写完从另一端点读回证落库 + 专属 ticker + 末尾自清理保同 boot 幂等）。
- **跑**：命令与前置见 [local-verification](local-verification.md) § 2 命令矩阵「contract-smoke」行（本地只需杀 :3000，**无需任何 provider 类 env 前缀**，harness 已恒钉）；CI 进 `e2e-real-backend.yml` nightly 软信号。
- **不做 UI**：点通归 ① hermetic Playwright；契约冒烟只验 client↔server↔DB，别在此层塞 UI 断言。
- **多分支编排（happy + 降级/错误路径）走 content-driven，不靠 DI override**：契约冒烟打的是 `bootRealBackend()` 起的**外部真 server 进程**（**固定 boot env**），拿不到 server IT 那套 `Test.createTestingModule().overrideProvider(...).useValue(scripted)`。要在**同一 boot** 内让 Fake provider 按场景吐不同结果（如 LLM 吐 `tool_call` vs 纯 token、search 成功 vs throw 降级），让 Fake 读 **user message 内嵌关键字**自行分支——既有范式：`chat-model-switch.contract.ts` 用 `Mvpro`/`Mvflash` 选模型；030 web-search 用 `WebSrch` 驱动 tool_call、query 含 `FAIL` 驱动 search throw（FR-009 降级）。分支**只在命中关键字时**触发，Fake 默认行为零改、保既有 contract/IT 向后兼容。env 注入路（`CHAT_FAKE_LLM=1` 等）只能绑死一种常量行为，无法 per-request scripted——这正是要走 content-driven 的原因。

## 6. hermetic e2e mock（canonical = [`.claude/rules/mobile-e2e-hermetic.md`](../../.claude/rules/mobile-e2e-hermetic.md)，写 e2e spec 时自动装载）

src 侧 invariant：改**共享 hook / util 行为**（如给 hook 加 `invalidateQueries` → 多一次 refetch）→ 跑**全 `runtime-smoke`**，不只跑被改 spec —— blast radius 是整套 e2e，sibling spec 的 mock 可能把旧调用序写死，**typecheck 拦不住**（行为 / 时序耦合非形状错）。mock 写法（契约镜像非调用序、纯函数 ≠ 恒定答案）见该 rule。

- **实证锚**：032 FU-1 / FU-1a —— clarify hook `onDone` 加 `invalidateQueries(sessionControllerGet)` 后，`ideation-clarify.spec.ts` 详情 GET 的 `briefGenerated ? turns : []` 守卫让重取返空 turns、hydrate 冲掉刚流式的气泡（CI runtime-smoke 红，typecheck 全绿）；改无条件返 `turns` 即修。单跑被改 spec 抓不到。

## 7. 导航结构陷阱（新架构 Fabric 跨 stack 重挂崩 + 配套键盘范式）

> 🚨 真机才暴露（web e2e 全绿）—— 同 `.claude/rules/mobile-impl-playbook.md` § RN 布局陷阱「视口宽松系统性漏测」家族，但这是 **navigation 维度**而非 layout 维度。

**症状**：底部 tab 屏**跨 stack 导航**到 `(tabs)` 外的兄弟 stack（如旧 `pkm`/外脑 tab `<Redirect>` 到 `(app)/ideation`）时，新架构（Fabric，`newArchEnabled: true`）下原生硬崩 `IllegalStateException: addViewAt: ... SvgView already has a parent` → dev-client 跳 `DevLauncherErrorActivity`。**平 tab 切换不崩、只跨 stack 崩；间歇性**（mount 时序竞态）。

- **根因不在 react-native-svg**：是 RN core view-recycling 契约 + react-native-screens fragment 过渡清理（`endRemovalTransition`）没把被回收子树从旧父摘干净 → Fabric `addViewAt` 在 `recycle()` 前插还挂着旧父的 view。SvgView 只是受害子树根（任何"不支持 recycle"的 native view manager 都会中招）。来源 [screens #3249](https://github.com/software-mansion/react-native-screens/issues/3249)(OPEN) / [PR #3250](https://github.com/software-mansion/react-native-screens/pull/3250)（唯一生产实证修，但**未发版**且需 patch-package + 重建原生）/ [RN core #49865](https://github.com/facebook/react-native/pull/49865)。版本组合（svg 15.12.1 / screens 4.16 / RN 0.81）是 SDK 54 官方线、**非错配**。
- **诊断**：`adb logcat` 抓 `SurfaceMountingManager: ... View: SvgView` + `dumpsys activity activities | grep mResumedActivity` 看是否停在 `DevLauncherErrorActivity`；隔离法 = 平 tab 切换 vs 跨 stack 导航分别触发对比。
- **JS-only 根治（不依赖原生 patch / 不重建 dev-client）**：把目标屏**收进 tab 自带嵌套 stack**（`app/(app)/(tabs)/<feat>/{_layout,index,[id]}`）——进 tab = 普通切换、列表→详情 = 同 navigator push，从结构上消除跨 stack 重挂。
  - 详情屏隐藏 tab 栏：**顶层 `screenOptions.tabBarStyle`** 用 plain 对象按 `useSegments()` 末段 ∈ `IDEATION_FULLSCREEN_ROUTES` 重算（`app/(app)/(tabs)/_layout.tsx`）；**所有 `Tabs.Screen` 的 options 一律静态对象** —— 函数形式会让 `href: null` 被静默丢弃、门控 tab 照常渲染（expo-router 布局期只读静态 `href`；045 实证，公开版漏出 gated tab 由 e2e-public 抓）。
  - root 层 absolute FAB / overlay 在详情屏要单独隐藏（`useSegments()` 判 `[id]`），它不随 `tabBarStyle` 隐藏。
  - 详情屏 header back 经 `makeHeaderBackOrParent`：tab 栏隐藏 → 离开只能走 header back（点不到 tab）；冷启 reload 后栈仅 `[id]` → `canGoBack=false` → `router.replace` 回父路由（列表）。
- **配套键盘（chat 输入条三端范式）**：用 `KeyboardStickyView`（react-native-keyboard-controller）**而非** `KeyboardAvoidingView`——后者在 Android edge-to-edge 顶不动；前者 iOS/Android 帧同步、web 无键盘事件即静态由浏览器处理，**三端统一无 `Platform` 分支**。`offset.opened = insets.bottom` 收掉父 `SafeAreaView edges={['bottom']}` 的底部安全区使输入条贴键盘顶沿。
- **实证锚**：PR #555（外脑→灵感 tab：ideation 列表+详情从兄弟 stack 收进 tab 嵌套 stack）。033 T012 曾把此崩误判为「旧 embedded bundle 现象」——实为 fresh code 真 bug，只因当时漏验外脑 tab 跨 stack 路径。screens 正式发版修后可考虑退役本重构或并存。

## 8. React Query 缓存失效纪律（mutation 必失效 list key）

> 🚨 真机才暴露家族（同 § 7「web e2e 全绿真机崩」）——但这是 **数据缓存维度**：列表正确渲染、只是数据陈旧。

凡 **create / delete / 改 list-visible 字段（title / status / updatedAt）** 的 mutation，**必失效对应 list query key**——否则列表屏不自动重取，**陈旧到 App 重启**。

- **根因放大器（全 App 常驻地雷，非某模块局部）**：全局 `staleTime 30s` + bottom-tabs 首访后**常驻挂载**（不 unmount→不重挂→不触发 `refetchOnMount`）+ `refetchOnWindowFocus:false`（`~/core/api/query-client.ts`）三者叠加 → 列表一旦缓存就**无任何触发器**自动重取。
- **双重盲区（眼睛 + 现有 e2e 都拦不住）**：① mutation 后**导航离开列表屏**（create→跳详情）时开发者全程看不到列表变陈旧；② hermetic e2e 若「创建后**首访**列表」则全新拉取假绿，与真实「先访列表（缓存空）→再创建→返回」顺序错开。
- **范式（二选一，优先 ①）**：① **共置 wrapper + `onSuccess` 焊死**（`ideation/use-session-mutations.ts`）——调用方拿到的就是自带失效的 hook，连数据层都不用记；② **数据 hook 自持 list+mutation+共置 invalidate**（`chat/use-conversations.ts`）。SSE / 非 mutation 流在 done/aborted 终态手动调失效 helper（`useInvalidateSessionList`）。
- **实证锚**：032 ideation create 漏失效 → 新建会话不入列（列表永久空，仅重启可见）；converge（状态徽标 open→converged）/ 每轮 turn 终态（updatedAt → 列表冒泡）同盲区。修法 = `use-session-mutations.ts` 共置 wrapper（create / generateBrief）+ `use-ideation-session` startStream done/aborted 手动失效（turn）。
- **范式 + 业内印证**：与 chat golden 同构（`use-chat.ts` onDone → `invalidateConversations`），亦是 TanStack 推荐默认 —— [TkDodo](https://tkdodo.eu/blog/automatic-query-invalidation-after-mutations)「宁可多取也别漏取」；**invalidate ≠ refetch**（只重取活跃 query，其余标脏）+ staleTime 兜底 → 事件后广失效成本可忽略。turn 是**每轮**（非每 token）的低频，不落入高频流式警告。
- **未来优化指针（非必要不上）**：若 per-turn refetch 实测成瓶颈，业内路径是 `setQueryData` 精细把该会话冒泡到列表顶（零 refetch），**而非删失效**；TkDodo 明确「精细更新有抽象成本，非必要不上」。真·高频（每 token）才考虑。

## 9. 原生模块陷阱（gesture 根 + 图片 picker 权限）

> 🚨 真机才暴露家族（同 § 7 / § 8「web e2e 全绿真机崩」）—— 这是 **native 模块维度**：手势 / 权限走原生层，web e2e 经 mock seam 绕过，系统性漏测。

### 9.1 用手势的屏必自套 GestureHandlerRootView（根 \_layout 不全局挂）

本仓**约定根 `app/_layout.tsx` 不全局挂 `GestureHandlerRootView`**（仅 `QueryClient > SafeArea > Keyboard > Stack`）—— 凡用手势（`GestureDetector` / `SwipeRow` / `LongPressMenu` / `DraggableList`）的屏**各自自套一层** `<GestureHandlerRootView style={{ flex: 1 }}>`。先例用 `grep -rl GestureHandlerRootView apps/mobile/src apps/mobile/app` 自证（样板 `profile-image/image-viewer.tsx`）。

- **漏套症状**：一进屏红屏 `GestureDetector must be used as a descendant of GestureHandlerRootView`，手势完全不识别 → 功能真机不可用（web e2e 经 headless / mock 不一定触发）。
- **CR 必查**：新增用 `GestureDetector` 的路由屏，确认顶层有自套 GHRV，**别假设根已挂**。
- **实证锚**：#606（036 标注画布 `image-annotate.tsx`）初版漏套、注释还误写「根已挂」→ 标注真机一进即崩；按约定补 GHRV。

### 9.2 相册 pick 不要 gate `requestMediaLibraryPermissionsAsync`（API 29–32 必假阴）

`ImagePicker.requestMediaLibraryPermissionsAsync()`（expo-image-picker 17.x）在 **Android API 29–32**（含 Mate50/API31）会申请 `WRITE_EXTERNAL_STORAGE`（源码 `getMediaLibraryPermissions` 在 `SDK_INT < 33` 分支无条件含 WRITE），但该权限库 manifest 被 `maxSdkVersion=28` 封顶、API≥29 系统**不可授予** → 聚合恒返 `{granted:false, status:"undetermined", canAskAgain:false}`。

- **症状**：`if(!perm.granted) return` 门控下相册**永远打不开**（系统 picker 启动即 bounce）、不报错（吞在 toast）。**与代码无关、与 install 权限态有关**（全新装必现、旧装整组授予过偶尔蒙混）→ 易误判成「改坏的回归」。
- **修法**：相册 pick **不 gate** 该权限 —— 系统 picker 让用户显式选图、回传 scoped `content://` URI 授权，app 本不需持有读权限；直接调 `launchImageLibraryAsync`。**相机**仍需 `requestCameraPermissionsAsync`（CAMERA 真需要且可授予）。已修 `use-ideation-attachments.ts` + `use-profile-image-upload.ts`。
- **诊断捷径**：「相册一闪即关」别先怀疑嵌套弹框 / manifest / 构建——在 `pickFromLibrary` 插 `console.log('[PICKDBG]', JSON.stringify(perm))`，reload dev-client，`adb logcat | grep PICKDBG`，`granted:false` 一出即锁权限门；`aapt dump permissions <apk>` 看 WRITE 的 `maxSdkVersion=28` 实证封顶。
- **实证锚**：#606（036）真机 Mate50/API31 选图卡死，绕了嵌套弹框 / manifest / targetSdk 三个错方向才插桩定位。

### 9.3 react-native-view-shot `captureRef` 截不到 GPU 层（expo-image / reanimated）= 全黑

Android 上 `captureRef` 走**软件重绘**（`view.draw(Canvas)`，CPU 重画 view 树），**读不到 GPU 硬件层**——`expo-image`（Android 硬件纹理层）+ `reanimated Animated.View`（带 transform 的变换层）都是 GPU 层 → 把**整棵子树**截成**纯黑**（连层里的普通 View 子节点一起黑）。栈：Expo SDK54 / RN 0.81 / **newArchEnabled(Fabric)** / view-shot 4.0.3 / expo-image 3 / reanimated 4。

- **陷阱**：「显示正常 ≠ captureRef 截得到」。屏幕显示 / 系统截图 / `adb screencap` 走 **GPU 帧缓冲**（PixelCopy）看得到 → 误判没问题；只有 captureRef 软件路径读不到。e2e 走 view-shot seam（假图）会**永久掩盖**此坑，真机第一次跑真 captureRef 才炸。
- **修法**：**别截活画布**，渲一个**专用静态烧录视图**给 captureRef —— **RN 内置 `Image`**（`import { Image } from 'react-native'`，软件 drawable，零新依赖）+ **静态普通 `View`** 摆 overlay（**禁 reanimated 变换层**），离屏（`position:absolute,left:-10000`）+ `collapsable={false}`。样板 = `apps/mobile/src/ideation/image-annotate/SomBurnView.tsx`（036 SoM 烧录；恒 identity 满图，顺带避开「截到当前缩放态」）。
- **生效坑**：新建文件 + 新 import 后 Metro **fast-refresh 不热替换**，必须**整体 reload**（dev 菜单 Reload，**别 force-stop**——会掉 dev-client 启动器要重连 Metro）；验证时**核对截图尺寸**确认跑的是新代码（旧=活画布尺寸，新=烧录视图尺寸）。
- **实证锚**：#606（036）真机 Mate50 发送带标注图轮，烧录图全黑（拉 `cache/ReactNative-snapshot-*.png` 逐像素确认）；改 SoM 截 `SomBurnView` 后非黑（图 + 编号 pin）。**任何未来 captureRef 含 expo-image/reanimated 的视图都会复发。**

## 10. testID 体例

→ [`mobile-testid.md`](mobile-testid.md)：`<feature>-<element>[-<state>]`，e2e 一律 `getByTestId`。

## 11. 真机数值取证（探针 + UI 树测量）

> 🚨 与 § 9 同属「真机才暴露」家族，但维度不同：§ 9 问**功能坏没坏**，本节问**判据可不可信**。§ 5 契约冒烟 / § 6 hermetic e2e 验行为对不对；而有一类正确性（动画是否收敛、逐帧写入是否停止、逐像素是否对齐）web 侧**结构上**看不到，只能在真机上量。**量错的代价不是漏测，是拿到一个长得像「通过」的读数。**

### 11.1 数值探针走 `TextInput.text`，且必须自带存活哨兵

Reanimated 4 已把 `addWhitelistedNativeProps` 变成 **no-op**（`lib/module/ConfigHelper.js` 里是空函数体 + `@deprecated`），但 `Animated.createAnimatedComponent(TextInput)` + `animatedProps={{ text }}` 这条旁路**实测仍生效**（2026-08-11 / Mate50 / reanimated 4.1.7）。形态：

```text
useAnimatedReaction(观测 shared value) → 计数落 useSharedValue → useAnimatedProps 喂 text
```

- **三条纪律**（照抄 ADR-0063 的三次教训）：全程 UI 线程；🚫 **禁用模块级可变对象**当计数器（Fast Refresh 后 worklet 与 React 各持一份 ⇒ 读数恒 0）；🚫 **禁从 JS 线程读 `sharedValue.value`** 下结论（落后一拍）。TS 侧 `text` 不在 `TextInputProps` 里，需给 animated 组件手工放行类型。
- 🚨 **存活哨兵是强制项**：计数类判据的通过签名往往是「**不涨**」（如「松手后写入停止增长」），而**探针管道静默失效的表现完全同形**。所以探针必须同时显示一个**交互期必然变化的量**（如当前位移）—— 先确认它跟着手指动，后面的计数才作数。少这一条，一个死掉的探针会稳定输出「通过」。
- **驱动方式的边界**：`adb shell input swipe` **能**驱动 RNGH 的 Pan，可以用来把界面摆到指定位置做**静态**观察；但**不能**用于验手势正确性本身 —— 它是单指、单向、无交错的干净手势，ADR-0063 已实证缺陷实现在它下面完全测不出问题。
- **实证锚**：049（#20）选约表横滑验收 —— 先验哨兵（位移数字跟手动）再验自激环，拿到「跨两个 clamp 边界静置 84 秒、写入与方向反转零增长」；对照基线是 ADR-0063 实测的缺陷实现（松手后仍 +28 写入 / 3s）。探针仅挂 `__DEV__`、**验完删除不入仓**。

### 11.2 `uiautomator dump` 的 bounds：只有 x2 跟内容走

`adb shell uiautomator dump` 是**不改一行代码**就能拿到设备像素级坐标的测量口（testID 落 `resource-id`、`accessibilityLabel` 落 `content-desc`）。但对**被 `translateX` 位移、且父层裁剪**的 RN 视图：

- **x1 被裁到裁剪边界后恒定不变** —— 拿它比「表头与各行是否对齐」是一条**构造上恒真**的断言，内容怎么错位它都相等。
- **x2 才随位移变化**（内容右缘与裁剪窗的交点），它才是可用的那一边。
- **修法**：用之前**先改一次位移、确认该坐标真的动**，再拿它当判据 —— 即「如果反例存在，我的管道能看到吗」在 UI 测量上的具体形态。
- **顺带**：`react-native-web` 不认 `accessibilityState`（故 web e2e 只能靠样式自比较断选中态），但 **Android 原生认** —— dump 里 `selected="true"` 可直接断，真机侧不必绕。
- **实证锚**：049（#20）的「表头与全部可见行同列左缘 ≤1px」—— 13 个位移载体的 x1 全等于 254，差点被当成完美对齐；改看 x2、并先证明它随位移从 700 变到 270，才拿到有鉴别力的 Δ=0px。
