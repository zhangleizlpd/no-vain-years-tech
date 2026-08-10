# Implementation Plan: 雷达跨标的聚合三视图（M2c）

**Branch**: `048-optionsdesk-radar-aggregate-views` | **Date**: 2026-08-09 | **Spec**: [spec.md](spec.md)
**Input**: [`specs/048-optionsdesk-radar-aggregate-views/spec.md`](spec.md)

> **产物 = 仅本文**（prose-only）。data model SoT = `schema.prisma`（本片零新增维度，无可写）；API SoT = `@nestjs/swagger` 装饰器。**不造** `research.md` / `data-model.md` / `quickstart.md` / `contracts/` —— 镜像 SoT 的文档必 drift（`.claude/rules/sdd-authoring.md` § 反模式；038 跟 vanilla SKILL 字面多造 3 文件被抓）。

## Summary *(mandatory)*

在 045 已 ship 的 P1 雷达页顶部渲染四视图 seg，新增三个跨标的聚合视图（机会 / 建仓腿 / 收租腿）。技术路径：server 侧新增**一个只读聚合端点**（`GET radar/legs`），复用 047 已落的期权链快照与全部派生规则；mobile 侧把 `radar-screen.tsx` 的容器换成 `SectionList`，并**复用 047 抽好的横向滚动组件族**渲染聚合表。

**零新增数据维度、零 vendor 调用、零新增运行时依赖。** 本片全部工作量在「跨标的查询 + 混族统一排序 + 呈现」三处。

## Dependencies & Defensive Additions *(Cargo-cult 防火墙)*

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

**零新增运行时依赖。** 两处曾可能触发、逐条已排除：

1. **虚拟化列表** → RN 原生 `SectionList`（047 已在 `underlying-detail-screen.tsx` 实装并 ship），**不引** `@shopify/flash-list`。
2. **横向 offset 同步** → `react-native-reanimated`（已装），且 047 已抽成 `LegColumnScroller` / `LegStickyCell`，本片直接消费，**零新机制**。

## Constitution Check *(mandatory gate)*

- [X] **Passed** — plan honors all constitution principles.

逐条：**I** SDD 走满，mockup-first 已插（`design/` 10 帧 + handoff 在案，2026-08-09）；**II** TDD 红绿由 tasks 每条绑测试；**III** 任务粒度 30min–2h；**IV** 扁平 + 贫血 + 护城河 —— 本片 server 侧只在 `optionsdesk/` 内新增 use case，跨 ctx 读快照沿用 047 已建立的路径与 `CROSS-CONTEXT-READ` 注释（D-ARCH-1）；**V** 跨端单 PR（server 端点 + IT + `api-client` regen + mobile 消费 + 两层验证同 PR 原子 merge）。无违规，Complexity Tracking 空。

## Phase 0 Research Gates *(mandatory)*

### Gate 0.1 — Integration Smoke Gate

- [X] **Server**: 聚合端点至少一条 Testcontainers 真 boot IT（PG 起真容器），覆盖 `state_branches` 全 18 条。跨标的 `asOf` 不一致（`FR-010a`）MUST 用**多票不同 `session_date` 的种子**构造，不用 mock。
- [X] **Mobile / Web**: US1 / US2 / US3 各一条 Playwright hermetic e2e（含 `SC-006` 滚动条长度 = 全量行数）；**PoC（V-C）走真机，不进 CI 门**（见 D-POC-3）。契约冒烟一条 happy-path 进 `apps/mobile/e2e/contract-smoke/`。
- [X] **Evidence**: 待 impl 期回填 commit 链接。本 gate 在 plan 阶段是**承诺项**，tasks 必须为上述每条各出一个 task。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A — 本片零新增第三方包 / SDK / 工具，且零 vendor 调用**（`FR-009`：读路径完全复用 047 落的快照，请求路径不碰 vendor）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native.** 全部前置（045 / 046 / 047）均为 mono 原生产物，无 meta-repo 迁移面。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0062（optionsdesk bounded context） | `sunset_trigger` 含「P3 下单 / 持仓联动 → 重审是否与 portfolio 合并」 | `accepted-as-is`，**未命中** | `FR-022` 明禁许愿单入口；水位仍是 047 的手选降级代理，本片只读不写 |
| ADR-0048（marketdata↔portfolio 跨层方向） | 「出现必须 server 端强一致同步读 marketdata 的场景」 | `accepted-as-is`，**未命中** | `FR-009` 是本片对该 trigger 的可验证反向守卫 —— 读的一律是 EOD 快照 + 显式 `asOf`，代码中不存在盘中拉起行情网关的调用 |
| ADR-0053（跨 ctx 纯函数 import） | 「第二个 ctx 申请 import 他 ctx 的 `*.rules.ts`」 | `accepted-as-is`，**未命中** | 本片派生**全部**复用 `optionsdesk/*.rules.ts`（`leg-tab` / `intent-matrix` / `leg-derive` / `earnings-mark`），不新增跨 ctx rules import |

**本片不新开 ADR** —— 无跨模块 / 不可逆的新决策，聚合端点落 047 已定的读路径形态。

## Architecture Notes *(mandatory)*

### 🚨 Testing Invariants（AI 绝对禁令 — 严禁违背）

- **NO LIFECYCLE MOCKING**: 对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类禁止隔离单测，必须 `Test.createTestingModule({ imports: [<TheModule>] }).compile()`。
- **EXHAUSTIVE BRANCHING**: spec `state_branches` **共 18 条**（🚨 条数一律实时 grep，本片曾因抄旧数写成 16），每条必须在 integration test 中有对应 `it()` 块。
- **测试后缀按 size 选**（`docs/conventions/testing.md`），选错 PR 门 `check-test-size` 直接红。

### General Architecture Notes

ADR-0043 扁平 / 贫血 / 护城河 / 零-class 范式强制：新 use case 直注 `PrismaService`，无 repository port，派生逻辑落 `*.rules.ts` 纯函数，禁充血 Domain Class。

## D-POC — V-C gate（本片最前置，先于一切 UI task）

### D-POC-1 · 起点不是零，是 047 已 ship 的组件族

047 plan D-UI-1 的解法**已实装并上线**，且与 `symbol` 无关：

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `LegColumnScroller({ offset, children, testID })` | `apps/mobile/src/optionsdesk/leg-table-header.tsx` | 横向滚动容器，吃外部共享 `offset` |
| `LegStickyCell({ children, className })` | 同上 | 首列单元格（渲在横向滚动**之外** ⇒ 天然钉住） |
| `LegTableHeader({ offset, rateSub, oiAsOf })` | 同上 | 表头行 |
| `LegRow({ leg, offset, today, activity, showBasisBadge })` | `leg-row.tsx` | 数据行 |
| `legColumnWidth(key)` · `LEG_HEADER_HEIGHT=30` · `LEG_ROW_HEIGHT=48` | `leg-table-header.tsx` | 列宽与尺寸常量 |

**核心机制**：首列不在横向滚动内 ⇒ 不依赖 `position: sticky`；纵向 `SectionList` 与横向容器**方向正交** ⇒ 不争手势；同步的横向容器数 `O(视口行数)`，不随总行数增长。

### D-POC-2 · 本片与 047 的两处真实差异（PoC 的靶心）

1. **规模** —— 047 单票 730 行；本片跨标的，上限待 V-B 实测。
2. **seg 切换换整份 `section.data`** —— 047 切 Tab 换的是同一票的过滤结果，本片切 seg 换的是不同成员判据的集合，且**横向 `offset` 与纵向滚动位置在切换后的行为 047 没有对应场景**。这是本片新增面。

### D-POC-3 · gate 语义与不通过的处置

- **真机跑，不进 CI 门** —— 嵌套滚动手势争用属 `.claude/rules/mobile-impl-playbook.md` § RN 布局陷阱那一族，Playwright 视口宽松必然假绿。
- 喂合成大数据集，规模取 V-B 实测值的 **≥2 倍**。
- 四条判据见 spec V-C。
- 🚨 **PoC 未过 MUST NOT 开工任何聚合表 UI task，且 MUST NOT 由 impl 自行降级绕过**（偷偷改分页 / 砍 sticky / 砍横滑列）—— 那些都在动 `FR-023` `FR-007a` 或 sticky 首列这些各自有独立理由的**产品决定**。
- **不通过 = 停下回 user 拍板**（user 2026-08-09 明示「因为技术问题，我可以权衡不同产品逻辑」），带实测证据给降级路径 + 各自代价，选完回改对应 FR，不在 impl 里静默妥协。

## D-UI — 呈现面

### D-UI-1 · seg 控件与 045 零回归

`radar-screen.tsx` 顶部加 seg 行，标的视图从「整页」变成「seg 下的默认页」。

- **045 三个组件（雷达行 / 色带 / 徽标）一行不改**，只换父容器与增加一层 seg 状态 —— 同 047 对 046 三块的处置（`FR-002` / `SC-005` 的零回归要求靠「不碰组件」这个结构保证，不靠事后回归测试）。
- seg 状态 MUST NOT 持久化跨会话（spec 未要求；`FR-004` 只要求同一会话内不丢滚动位置与排序选择）。

### D-UI-2 · 分层列集靠扩展列 key 值域，不另起组件

`FR-007a` 的常显 6 项 / 横滑 7 项：**扩展 `legColumnWidth` 的 key 值域 + 新增聚合专用列序常量**，复用 `LegColumnScroller` / `LegStickyCell` / `LegRow` 的渲染机制。

- **本片首列 = ticker + 行权价·到期两行**（047 是行权价·到期单项）⇒ `LegStickyCell` 内容变、组件不变。
- mockup 实测列宽（`design/handoff.md`）：常显 `92+78+62+68+72 = 372 < 390`；横滑区 416；总 780。**意图列 68px 是 overflow 探针逼出来的**（56px 装不下「意图未定」），MUST NOT 回调。

### D-UI-3 · 陈旧标必须落 sticky 常显列

`FR-010a` 的「落后的票行内加陈旧标」MUST 渲在**首列**（`LegStickyCell`），MUST NOT 放进横滑区。

📌 **这是 mockup 阶段用截图抓到的缺陷，六项探针全部照不到**（它既不溢出也不折行）：初版把陈旧标放进「标注」列，而标注列在横滑区 —— 不横滑就看不见，`FR-010a` 形同虚设。定案 = 陈旧票首列整格 `warning-soft` 底，横滑区详细标注保留作双保险。

### D-UI-4 · 点腿跳 P2 的 Tab 覆盖只作用于此路径

`FR-025` 要求落该腿所属腿族的 Tab。实现上经**导航参数**传递目标 Tab，由 P2 侧 `resolveLegTab` 的手点值通道消费 —— **MUST NOT 改 `resolveLegTab` 的默认落位逻辑**（那是 047 `FR-016` 的意图默认，`SC-005` 的零回归涵盖它）。

### D-UI-5 · 意图未定的呈现走「数据缺口」体系

`FR-027` 的「意图未定」MUST 用虚线 chip（承 047 `FR-026` 对 `no_date` 的处置：虚线 = 「我们不知道」，实色 = 已知答案）。**MUST NOT 置灰或降低该行的档位着色** —— 档位不依赖水位。

## D-API — 服务端读面

### D-API-1 · 单端点返回全量，三视图客户端过滤

`GET /api/v1/optionsdesk/radar/legs`，一次返回跨全部锚定标的的**全量适格腿**，三个 seg 是同一份派生结果的三种客户端过滤。

- **理由同 047 D-API-1**：分三次请求会让三个视图的 `asOf` 与档位口径可能不一致。
- 每腿自带所属视图成员标记（同 047 的 `tabs` 范式）—— **成员判据 MUST NOT 在客户端重算**，判据单点在 server `leg-tab.rules.ts`。
- 死档 / 未判档的排序**由 server 定死**（死档末尾、未判档在死档之前），客户端别再排一次。

### D-API-2 · 跨标的 `asOf` 聚合口径

响应 MUST 同时给：① 视图级 `asOf` = **全部参与聚合的票中最旧的那个** ② 每腿自己的 `asOf`（供 `FR-010a` 的逐行陈旧标）。

- 「有快照但陈旧」与「从无快照」是**两个不同的响应字段**，MUST NOT 归并（`FR-010a` 🚫 条）。
- 从无快照的票 MUST 在响应里显式列出（`FR-008` 的「不静默缺席」靠响应结构保证，不靠客户端推断）。

### D-API-3 · markets 合规门控

门控**只落客户端一层**（路由级 guard），server 端点 MUST NOT 新增第二套（`FR-026`，与 045 / 046 / 047 同构）。

## D-SORT — 排序与口径

### D-SORT-1 · 档位主键在 server 算，不给客户端可乘之机

`FR-011` 的「主排序键恒为档位且不可切」MUST 由 server 排好后返回。

- **档位是有序枚举**（好 > 可接受 > 薄 > 死档），跨族可比；**族内费率数值跨族不可比**（`FR-012`）。排序实现 MUST 以枚举序为第一键，**MUST NOT 以任何费率数值作为跨族比较量**。
- `SC-002` 的可验证形式：任取跨族相邻行对，其顺序可由二者各自的族内档位单独解释 ⇒ 单测 MUST 有一条「构造周化 2.5% 建仓腿与年化 18% 收租腿，断言二者相对序仅由档位决定」的断言。

### D-SORT-2 · 辅键在**客户端**排，且必须有第三键

`FR-014`：辅键 距 W / DTE / 标的三选一，chip 切换，**默认 距 W**（与 045 标的视图默认排序一致）。辅键仅在同档位内生效。

**分工定死（2026-08-09 analyze 第三轮定案）**：

| 层 | 负责 |
| --- | --- |
| server | 档位主键分层 + 死档 / 未判档的位次。**只保证这两件事** |
| 客户端 | 辅键在**同档位内**稳定重排 |

**为什么辅键必须在客户端**：`FR-004` 要求三个视图**各自**保留排序选择，而 D-API-1 定的是三视图共用同一份响应 ⇒ 同一份数据要同时呈现三种排序 ⇒ server 排序 + 换辅键重新请求在结构上不成立。<br>⇒ **D-API-1「客户端别再排一次」的准确措辞是「MUST NOT 改变档位分层与死档位次」**，不是禁止一切客户端排序。

🚨 **MUST 有第三键 `id ASC` 兜底**：`FR-014` 三个辅键里只有 DTE 是腿级量，「距 W」与「标的」在同一只票的所有腿上**取值完全相同** ⇒ 默认辅键（距 W）下，同档位同票的 N 条腿之间顺序未定义、跨请求可能漂移，`SC-002`「任意两行相对顺序可解释」不成立且 e2e 天然 flaky。045 自己是有兜底键的（`get-radar.usecase.ts` `ORDER BY distance_to_w_pct ASC NULLS LAST, id ASC`），本片沿用。

### D-SORT-3 · 逐票组装 `LegTabContext`（调 `legTabs()` 的前置，起草时整个漏掉）

047 的 `legTabs(context, leg)` 需要**标的级上下文** `LegTabContext = { zone, w, rentDepth }`，每票每请求算一次、该票全部腿共用：

| 字段 | 来源 |
| --- | --- |
| `zone` | 045 的区间判定（`anchor.rules.ts` `AnchorZone`） |
| `w` | 045 `computeW` 的愿买价锚 |
| `rentDepth` | `intent-matrix.rules.ts` `classifyIntent()` 的输出；水位未选 / 不开新仓 → `null` ⇒ `rentAbsDeltaBand(null)` 取**三档并集** |

🚨 **本条起草时 plan 与 tasks 零处提及**（`rg 'zone|rentDepth|LegTabContext' specs/048-*/` 零命中），而 T002 / T006 都要调 `legTabs()`。盲写最可能塞一个 stub context —— **静默改变成员集合，任何测试都不会红**。

⇒ T006 MUST 显式包含「逐票 `classifyIntent` → 组装 `LegTabContext` → 调 `legTabs()`」这一串，并对「未选水位票拿到并集带」有专门断言。

## D-ARCH — 边界与复用纪律

### D-ARCH-1 · 跨 ctx 读沿用 047 已建立的路径

聚合端点读 marketdata 的期权链快照 —— 与 047 的 `get-legs.usecase.ts` 同形，沿用其 `CROSS-CONTEXT-READ` 注释与只读约束。**跨 ctx 写永远禁**（无逃生口）。

### D-ARCH-2 · 复用 047 常量，禁复制字面量

`FR-015`：档位边界、腿族判据、意图矩阵、财报打标域 MUST 追溯到 047 已落的具名常量（`leg-tab.rules.ts` / `intent-matrix.rules.ts` / `earnings-mark.rules.ts` 顶部导出），**MUST NOT 在本片复制字面量**。

🚨 复制一份阈值到聚合侧，会让「改一处不改另一处」变成静默的口径分叉 —— P2 说这条腿是「好」档、P1 聚合说是「可接受」，而两处都不会红。

## 三条不要在下游阶段被"优化"掉的决定（承 spec，plan 期原样传递）

1. **机会视图 = 两族并集，不是跨标的版「全腿」** —— 中段 DTE 腿不进任何聚合视图。对称成「全腿」看着更整齐，但会把量级推到 730 × 标的数，且雷达页从「收敛出今天该盯谁」变成「铺开全部」。
2. **主排序键不可切** —— 档位是跨腿族唯一可比的坐标。让主键可切等于允许屏幕上相邻两行的顺序无法用族内口径解释。
3. **未选水位的腿照常进聚合、照常判档排序** —— 档位不依赖水位。踢出列表或压到底部都会让一条「好」档腿因为一个无关的未填项而看不见。

## Complexity Tracking

*本片无 Constitution 违规，无需记录。*
