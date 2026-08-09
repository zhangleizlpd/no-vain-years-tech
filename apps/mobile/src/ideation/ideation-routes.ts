// 032 T012 — ideation 路由常量单源（纯逻辑，vitest 覆盖）。app/ 树下的 Stack /
// Redirect / push 一律引这里的常量，避免路由字符串散落手写漂移。
//
// 测试分层（per reference_mono_mobile_test_layering）：app/ 树的 Stack/Redirect render
// 走 Playwright e2e（T017/T019），不入 vitest（vitest 只扫 src/，见 vitest.config.ts）；
// 故把可单测的「路由解析」抽成此 src/ 纯函数，供 app/ 文件消费 + vitest 验。

// ideation 现为 (tabs) 内的嵌套 stack（app/(app)/(tabs)/ideation/），不再是 (tabs) 的兄弟
// stack —— 跨 stack 导航会在 Fabric 下触发 react-native-screens view-recycling 重挂崩（#3249），
// 收进 (tabs) 后进入=普通屏切换、列表→详情=同 stack push，均不跨 stack。group 段 (app)/(tabs) 在
// URL 透明 → 实际 URL 仍是 /ideation 与 /ideation/{id}（e2e 的 waitForURL 不受影响）。
// ⚠️ 045 起它**不再占底部 tab 槽**（href:null，入口改由抽屉菜单承载，FR-021/FR-025），但**路由
// 位置不变** —— 上面这条「不许移出 (tabs)」的结论照旧成立（中央 FAB 与全屏子屏隐藏 tab 栏的
// 逻辑都活在 tabs layout 层，移出去会一并打掉）。

/** ideation 列表根路由（= 灵感 stack 根屏，从抽屉菜单进入）。 */
export const IDEATION_LIST_ROUTE = '/(app)/(tabs)/ideation' as const;

/**
 * ideation 会话详情路由（建会话成功后 push；列表点进继续）。
 * @param id 会话 id（数字串，orval SessionResponse.id）。
 */
export function ideationSessionRoute(id: string): `/(app)/(tabs)/ideation/${string}` {
  return `/(app)/(tabs)/ideation/${id}`;
}

// 036 B2-3 — 图片查看器 / 标注画布路由（同 tab 内 stack push，参数走 query string）。
// 暂存图本地 uri（file://content://）+ 在缩略条的 index（标注态/发送态回指）+ sessionId
// （上传凭证 scope）。pin/注记本地态在 image-annotate 屏内 pin-reducer，取消/返回零副作用
// （FR-012）—— 不写回路由参数、不上传不发送。

export interface ImageViewerParams {
  uri: string;
  index: string;
  sessionId: string;
  // 兼容 expo-router HrefObject.params 的 UnknownInputParams 索引签名（值域限定 string）。
  [key: string]: string;
}

/** 图片全屏查看器路由（ThumbChip 点击 push；query 带 uri/index/sessionId）。 */
export function ideationImageViewerRoute(params: ImageViewerParams): {
  pathname: '/(app)/(tabs)/ideation/image-viewer';
  params: ImageViewerParams;
} {
  return { pathname: '/(app)/(tabs)/ideation/image-viewer', params };
}

/** 标注画布路由（查看器点「编辑/标注」push；同参数透传）。 */
export function ideationImageAnnotateRoute(params: ImageViewerParams): {
  pathname: '/(app)/(tabs)/ideation/image-annotate';
  params: ImageViewerParams;
} {
  return { pathname: '/(app)/(tabs)/ideation/image-annotate', params };
}

// 037 T011 — 设计稿（mockup）区路由（从 session 详情进入，同 tab 内 stack push）。
// sessionId 走 query string（读列表 scope + fetch-on-open 入参）。

export interface MockupScreenParams {
  sessionId: string;
  // 兼容 expo-router HrefObject.params 的 UnknownInputParams 索引签名（值域限定 string）。
  [key: string]: string;
}

/** 设计稿区路由（从 session 进入 push；query 带 sessionId）。 */
export function ideationMockupsRoute(params: MockupScreenParams): {
  pathname: '/(app)/(tabs)/ideation/mockups';
  params: MockupScreenParams;
} {
  return { pathname: '/(app)/(tabs)/ideation/mockups', params };
}
