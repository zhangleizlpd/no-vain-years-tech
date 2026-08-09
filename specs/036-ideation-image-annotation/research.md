# Research — 036 ideation 图片标注 + 多模态结合

> Phase 0 研究консолидация。NEEDS CLARIFICATION 已在 `/speckit-clarify`（spec § Clarifications 5 问）+ spec Assumptions 解决；本文件仅收敛**真正的技术选型决策**（与 035 research.md 同体例）。详版基线 = [velvety-pike plan](../../docs/private/plans/2026-06/06-25-ideation-b2-3-image-annotation.md)，已 grep 实证 9 facts。

## R1 — 标注落图策略：Set-of-Mark 烧录（vs 纯坐标文字）

- **Decision**: 编号 pin **烧录进图片像素**（Set-of-Mark prompting）+ 同编号在合成文字里引用（`1：天空改蓝 2：塔变红`）。发送时仅纳入有注记的 pin（空 pin 不烧录/不计入，严格 1:1）。
- **Rationale**: SoM（[微软 arXiv 2310.11441](https://arxiv.org/abs/2310.11441)）是让视觉 LLM 精确空间 grounding 的业内事实标准——GPT-4V + SoM zero-shot 超全微调 grounding 模型；纯坐标/bounding-box 文字「even with explicit bounding boxes accuracy remains low」。这也正是用户 7 张参考截图的形态（图上 pin + 文字编号）。
- **Alternatives considered**: ① 纯坐标文字（`(x,y) 改蓝`）—— 精度低，被论文证伪；② bounding-box JSON —— 同样低精度且 UX 重。

## R2 — SoM 展平库：`react-native-view-shot`（vs Skia / 零依赖坐标）

- **Decision**: `react-native-view-shot` `captureRef`（唯一新依赖）。
- **Rationale**: Expo 官方 SDK 文档收录（`captureRef`，一等公民维护信号）；v5.x New Arch/Fabric iOS+Android+**Web** 全支持（Web 兼容是 Playwright e2e 关键）；与「RN `Image` + SVG pin overlay」混合视图 `captureRef` 直接契合；体积轻、API 成熟（低 LLM 幻觉）、MIT、无 CN 网络面、解耦成本 < 0.5 周（仅一处调用）。满足 stop-signal #2「引库前联网多维评估」。
- **Alternatives considered**:
  - ❌ `@shopify/react-native-skia` — 「Skia + 重叠 RN 组件」混合视图截图 Android 已知 bug（[issue #1633](https://github.com/Shopify/react-native-skia/issues/1633)，RN 元素消失）+ 整个图形引擎过重（本 feature 其余零需要）。
  - ❌ 零依赖纯坐标路径 — 不满足 R1 的「编号烧录进像素」（SoM 要求像素级标记）。
- **impl 期动作**: 引库 task 触发「新依赖」stop-signal，PR body 列本对比 + SoM 选型理由。

## R3 — 视觉模型路由：带图轮强制 MiniMax-M3（send-once）

- **Decision**: 带图 clarify 轮强制 `model:'minimax'`（M3 视觉）；纯文本轮维持 `model:'pro'`（DeepSeek）。图只随它那一轮发（send-once），后续纯文本轮不重注历史图。
- **Rationale**: M3 原生 OpenAI 兼容多模态（`image_url`，图 ≤10MB，JPEG/PNG/WEBP），现仓 `minimax.provider.ts` 已绑 M3 → 零换 provider（fact #1）；DeepSeek V4 视觉 API 未开放（fact #2）→ 带图轮必须切 M3（`clarify-turn.usecase.ts:482` 当前 `model:'pro'`，fact #3）。`RoutingLlmProvider` 已支持 minimax 委托、不改。send-once：图 token 远贵于文本（单图 ≈ 2k–16k token），重发每轮是反模式（clarify 决策），助手把视觉观察落进文本承载后续上下文。
- **Alternatives considered**: ① 每轮重发图 —— token 成本爆炸，反模式；② 等 DeepSeek 视觉 —— API 未开放，阻塞。
- **风险/待验**: M3 adaptive 思考 + 视觉的实测延迟/稳定性 impl 期 PoC 验（velvety-pike 已 flag）。

## R4 — `Msg` 多模态扩展：向后兼容（content `string → string | MsgPart[]`）

- **Decision**: `content` 由 `string`（`llm-provider.port.ts:42`）扩为 `string | MsgPart[]`；`toApiMessages` 透传数组（OpenAI vision content parts）。纯文本路径传 string = 旧形状不变。
- **Rationale**: 处处纯 string（fact #4）→ 扩 union 而非替换，纯文本轮零回归（SC-005）；OpenAI content parts 是 vision 多模态标准载荷。
- **Alternatives considered**: ① 新增独立 `imageMsg` 字段 —— 与 OpenAI content parts 模型不符、`toApiMessages` 双路径分叉；② 强制全部 turn 用数组 —— 破坏纯文本零回归铁律。

## R5 — 存储模型：只存烧录图 + annotationsJson（vs 原图 + 导出件）

- **Decision**: `IdeaAttachment` 只存**烧录图 ossKey** + `annotationsJson`（pin 坐标 + 注记编号）元数据；原图留用户设备、不上 OSS。
- **Rationale**: 业内「存原图 + 导出件」是为**重编辑工作流**；ideation 任务态短生命周期、无重编辑场景 → 不适用。只存烧录图省存储 + 缩隐私面（clarify 决策 + spec Assumptions）。
- **Alternatives considered**: ① 原图 + 烧录图都存 —— 双倍存储 + 隐私面，无重编辑收益；② 只存原图 + 客户端每次重烧 —— 发送一致性差、SoM payload 不可复现。

## R6 — OSS 平台层归属：`integrations/oss/`（D3，vs account 内 / ideation 复制）

- **Decision**: `buildPostObjectCredential` + `oss-policy` 上移 `integrations/oss/`（参数化 key-prefix + size），account + ideation 同源消费；account 对外契约零变。
- **Rationale**: 凭证签发是 generic vendor I/O port（与 llm/asr/codeindex 同范式，ADR-0058）；放平台基座避免 ideation 跨 ctx 碰 account 表（破护城河 §IV.2）。详见 plan Complexity Tracking。
- **Alternatives considered**: ① ideation 复制签名逻辑 —— 双份漂移源；② ideation 直 DI account UC —— 非编排的跨业务 ctx 耦合，无 R2 理由。
