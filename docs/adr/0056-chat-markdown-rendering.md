---
adr_id: ADR-0056
status: Accepted
applies_to: [apps/mobile]
sunset_trigger: |
  - 需要「流式动画级」打磨（逐 token 平滑/光标动画）→ 评估 native-only 叠 `react-native-streamdown`（worklets + remend），web 端保持 enriched-markdown 直 re-render（streamdown 无 web 路径）
  - 出现第二个 markdown 渲染面（如 028 会话历史富文本 / 笔记），或需 KaTeX 数学/mermaid 图等 enriched-markdown 不覆盖的元素 → 重审是否抽 `~/ui` 通用 markdown 层 + 是否换库
  - enriched-markdown 停维 / 不兼容 Expo SDK / RN New Arch 升级 → 回退候选 `@ronradtke/react-native-markdown-display`（纯 JS、非 New Arch）或重选
  - 决定不再出 web 端（仅 native）→ web 约束解除，streamdown 等 native-first 流式库重新可选
---

# ADR-0056: Chat AI 回复 Markdown 渲染 — react-native-enriched-markdown（web + native）

- Status: Accepted (2026-06-14)
- Deciders: @zhangleizlpd
- Tags: mobile / chat / markdown / rendering / dependency
- Relates: [ADR-0055](0055-chat-ctx-sse-streaming-llm-provider.md)（chat ctx + SSE 流式，本 ADR 是其前端渲染面）/ [ADR-0030](0030-package-decomposition.md)（`~/ui` + `~/theme` 内联原语，markdown 样式接 token）；实施载体 = [027-ai-chat-streaming](../../specs/027-ai-chat-streaming/spec.md)（ship 后渲染增强，#447）

## Context

027 把首页建成大模型对话主干。**DeepSeek（及所有 chat-tuned LLM）默认就吐 Markdown** —— 粗体 / 有序无序列表 / 标题 / 带语言标签代码块 / 表格。这是 post-training（RLHF 偏好结构化输出）固有行为，非 system-prompt 驱动，且无法干净抑制（强行要纯文本会泄漏、并杀掉代码块格式这一最被需要的渲染面）。assistant 气泡若用纯 `<Text>` 渲染，用户看到的是字面 `**星号**` + 不成形的列表/代码 —— 故 **markdown 渲染是刚需，非锦上添花**（业内 ChatGPT/Claude/Gemini/Perplexity/DeepSeek 全部客户端渲染）。

约束（决定选型）：

1. **web + native 双全**：app 同时出 Expo Web（浏览器手测 + M2 web 端）与 native（Mate50/iOS）。库必须两端都渲染，不能 web-only 或 native-only。
2. **流式宽容**：内容逐 token 累加，组件会以「半截 markdown」（未闭合 `**` / 未闭合代码围栏）重渲，库须容忍降级、不崩不闪。
3. **维护 + 未来不返工**：选活跃维护、社区主流方向。
4. **原生足迹可接受但须知会**：带原生层的库 → 真机 dev-client APK 须 EAS 重建一次（一次性成本，用户已确认接受）。

## Decision

### 采用 `react-native-enriched-markdown`（Software Mansion）+ `katex`

- **渲染面**：native = Fabric 原生文本渲染（无 WebView，需 New Arch —— 仓内 `newArchEnabled: true` 已满足）；**web = md4c 编译为 WebAssembly + react-native-web 渲染器**（库自带 `index.web.js` + 15 个 `.web` 文件，官方 README 明列 Web 支持「react-native-web 配好即可、无额外步骤、无 config plugin」）。同一 `markdown` prop API 跨端。
- **封装**：`apps/mobile/src/ui/MarkdownMessage.tsx` —— `React.memo`（仅 `content` 变化重渲，配合「只让末条流式消息变」避免每 token 重解析全量历史）+ `markdownStyle` 逐元素接 `~/theme` token（markdown 库以 RN style 对象配置，是 NativeWind className 约定的既定例外）。assistant 气泡纯 `<Text>` 改走此组件。
- **不引入 `react-native-streamdown`**（同厂的流式动画层）：它 0 个 `.web` 文件 + 叠 `react-native-worklets`（也无 web 路径）→ 会拖垮 web 端。enriched-markdown 本体直接 re-render 即承载逐 token 更新（md4c 容忍半截 markdown）；流式动画打磨留 sunset trigger。
- **输入框键位**（连带）：web 侧 `Enter` 发送 / `Shift+Enter` 换行（RN-Web `onKeyPress` nativeEvent 含 `key`+`shiftKey` + `blurOnSubmit={false}`，`Platform.OS==='web'` 守卫；native 走发送按钮）。

## Consequences

- ✅ web + native 同库渲染，无平台分叉；web 端 Metro 直接打包 WASM（实测 1899 模块、0 resolve 错误）、零 config plugin。
- ⚠️ **原生依赖**：新增 / 升级 enriched-markdown 时真机 dev-client APK 须 **EAS 重建一次**（New Arch 已就绪）；纯 JS 改动仍走 Metro 热更，不必重建。preview/production EAS 构建下次自动带上原生层。
- ✅ 流式宽容：md4c 自动闭合未终止代码围栏，半截 markdown 当增长中的块渲染、不崩。
- ⚠️ 放弃 streamdown 的「动画级」流式平滑（对中短回复几乎无感）；真要时按 sunset trigger native-only 叠加。
- 维护：Software Mansion（Reanimated / RN-core 团队），停维的旧 de-facto `react-native-markdown-display` 官方指向的继任者方向。

## Alternatives considered

| 方案                                                           | 否决理由                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `react-native-markdown-display`（旧 de-facto，~803K/wk）       | 官方**已停维**（README 自述并指向 enriched-markdown）                                               |
| `@ronradtke/react-native-markdown-display`（活跃 fork，纯 JS） | 可用且无原生层，但非 New Arch 原生渲染、非社区主流方向；作为 enriched-markdown 停维时的回退候选保留 |
| `react-native-marked`                                          | 依赖 `react-native-svg`（原生）+ reanimated-table，web 兼容有风险，无文档化流式语义                 |
| `react-native-streamdown`（流式最佳）                          | **web 无路径**（0 `.web` 文件）+ 叠 worklets；破 web 端，否决为主渲染层                             |
| prompt 要求纯文本（不渲染 markdown）                           | 有损：泄漏 + 杀代码块格式，逆模型纹理，业内无人这么做                                               |
