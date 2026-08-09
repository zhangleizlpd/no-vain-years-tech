---
feature_id: 048-optionsdesk-radar-aggregate-views
spec_ref: ./spec.md
plan_ref: ./plan.md
status: not-started
created_at: '2026-08-09'
updated_at: '2026-08-09'
---

# Tasks: 048-optionsdesk-radar-aggregate-views（optionsdesk M2c — 雷达跨标的聚合三视图）

**Spec**: [`spec.md`](./spec.md) ｜ **Plan**: [`plan.md`](./plan.md) ｜ **Mockup**: [`design/handoff.md`](./design/handoff.md)（10 帧）｜ **Branch**: `048-optionsdesk-radar-aggregate-views`

> 🔁 **本文为 2026-08-09 全面重修版**。初版按「文件 / 组件」分解，结果**一个组件吃掉 8 条 FR 而只写了 2 条**，`/speckit-analyze` 扫出 11 条 FR 零覆盖（覆盖率 62%）。重修改为**需求（FR）覆盖优先**，组件只是实现载体；并内建下方覆盖矩阵，使漏覆盖在写 tasks 时即可见。<br>🔁 **2026-08-09 analyze 第三轮再修**（零提示子 agent 独立复核）：修 `excluded` 漏排除、意图与成员资格互斥、greeks 缺失腿无兜底位、T001↔T026 循环依赖、`state_branches` 6 条不可观测、辅键排序层未定、缺第三键等 15 条。

## Format

`- [ ] TNNN [P?] [层级] **标题**（承接 FR-xxx, plan Dx）：做什么 → verify: 怎么验`

- `[P]` = 可与相邻 task 并行（不同文件、无未完成依赖）
- 层级：`[Mobile-PoC]` / `[Server]` / `[Server-IT]` / `[Contract]` / `[Mobile]` / `[Mobile-E2E]` / `[Contract-Smoke]` / `[Gate]`
- **层级 → size 映射**（`docs/conventions/testing.md`）：`[Server]` verify 落 **Small** `*.spec.ts`（零容器）· `[Server-IT]` = **Medium** `*.it.spec.ts` · `[Mobile]` = Small（logic-only）· `[Mobile-E2E]` / `[Contract-Smoke]` = Medium
- **测试不独立成 task**（per `sdd.md`），绑在每个实现 task 的 `verify:` 里；**IT 例外**
- 每 task = 30min–2h 单 commit 单元；`- [ ]` pending / `- [X]` done
- 🚨 **每条 task MUST 显式列出承接的 FR**；下方覆盖矩阵是它的机器可验形式

## Path Conventions

| 面 | 路径 |
| --- | --- |
| server 业务 | `apps/server/src/optionsdesk/`（扁平，无 domain/application/infrastructure） |
| server IT（Medium） | `apps/server/test/integration/optionsdesk-048.*.it.spec.ts` |
| mobile | `apps/mobile/src/optionsdesk/`（**全 Small 单一档，目录即坐标、免后缀**） |
| mobile 屏 | `apps/mobile/src/optionsdesk/radar-screen.tsx` |
| mobile e2e（Medium） | `apps/mobile/e2e/optionsdesk-radar-aggregate-views.spec.ts`（feature-slug，**无编号前缀**） |
| markets-OFF 断言 | **只能落** `apps/mobile/e2e/markets-feature-gate.spec.ts`（config `testMatch` 锁死单文件） |
| contract-smoke | `apps/mobile/e2e/contract-smoke/optionsdesk-radar-aggregate-views.contract.ts` + **在 `run.ts` 注册** |

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红的坑）

1. **档位排序 MUST 用枚举序，MUST NOT 用费率数值**（`FR-011`/`FR-012`, D-SORT-1）——盲写必然 `sort((a,b) => b.rate - a.rate)`，而两族数值域**重叠**（周化 2.4% vs 年化 18%）：排出来看着有序、语义全错，**任何测试都不会红**，除非专门构造跨族相邻对断言。
2. **禁复制 047 的阈值字面量**（`FR-015`, D-ARCH-2）——一律 import `leg-tab.rules.ts` / `intent-matrix.rules.ts` / `earnings-mark.rules.ts` 的具名导出。复制一份 ⇒ P2 说「好」档、P1 说「可接受」，**两处都不会红**。
3. **「影响该不该动手」的标一律进常显区**（`FR-010a` / `FR-021a`）——陈旧标与财报标都栽过：放横滑区不横滑就看不见，等于没标。**六项渲染探针一个都照不到**（既不溢出也不折行），只有看截图或对需求才发现。
4. **未选水位的腿照常判档、照常排序**（`FR-027`）——盲写容易当"缺数据"降级（置灰 / 置底 / 剔除）。档位**不依赖水位**。
5. **三套「异常」体系互不相同，MUST NOT 合并**：`FR-027` 意图未定（虚线 chip，**照常判档**）· `FR-017` greeks 缺失（左边框留空，**不判档**）· `FR-016` 死档（灰边框 + 下沉底，**排底部**）。合并会让「不知道你的仓位」「这条腿数据坏了」「这条腿没价值」变成同一个视觉，而三者应对完全不同。
6. **`SectionList` MUST 是页面唯一纵向滚动容器**（`FR-024`, D-POC-1）——包进 `ScrollView` ⇒ 内层拿到无界高度、虚拟化**静默失效**，界面看着正常、低端机崩，RN 只给 console 一行黄字。
7. **成员判据 MUST NOT 在客户端重算**（D-API-1）——每腿自带所属视图标记。客户端重算极易漏掉「greeks 缺失腿合法进收租视图」那一支（卖 put 走锚轴 `K ≤ W` 不读 Δ）。
8. **「有快照但陈旧」与「从无快照」是两个响应字段**（`FR-008`/`FR-010a`, D-API-2）——归并会让每逢周一大片票整票消失。
9. **聚合行 MUST NOT 渲染票级徽标**（`FR-020` 适用范围）——那是「标的」视图（一行一票）的约定；聚合是一行一腿，同票多腿会重复同一组徽标，且常显区仅余 18px。

10. **`excluded` 的锚 MUST 在聚合查询的基础 `WHERE` 里排除**（`FR-006a`）——它是**基础条件不是筛选项**。045 `get-radar.usecase.ts` Guardrail 12 明确：雷达侧排除、锚管理侧照常显示并带 `exclude_reason`，**两者 MUST NOT 共用查询**。漏了就是「用户主动剔除过的票冒进聚合视图」，**而且不会红**。

11. **调 `legTabs()` 前 MUST 逐票组装 `LegTabContext`**（`zone` + `w` + `rentDepth`，D-SORT-3）——三份文档起草时**零处提及**它，而没有它 `legTabs()` 调不了。塞 stub context 会**静默改变成员集合**：收租腿在市场轴上的 Δ 带由 `rentDepth` 决定，给错等于换了一套成员判据，**任何测试都不会红**。
12. **`state_branches` 的承接看分派表，不是「全在 T008」**——18 条里有 6 条 server 面没有可断言对象（门控 / 导航 / 渲染位置）。按「全在 T008」写会凑出 6 个平凡绿。
---

## Phase 0 · V-B 计数 → V-C PoC gate（🚧 阻塞 Phase 2–4 全部 UI task）

- [X] T000 [Server] **V-B 规模实测（只读计数，零实现依赖）**（承接 spec V-B）：对当前锚定标的全集，**逐票组装 `LegTabContext`（`zone` + `w` + `rentDepth`）后调 047 `legTabs()`** 实际计数，产出跨标的两族带内总行数与响应体量级估算。🚨 **MUST NOT 手写「DTE ∈ 带内」这类简化 SQL** —— 收租腿真实判据含轴二分与 `rentDepth` 依赖，只按 DTE 数会显著高估，而这个数字是 T001 合成数据规模、`FR-024` 是否升硬前置、`perf_budgets` 重估幅度的**唯一输入** → verify: 产出计数结果并回写 spec V-B 结论；一次性脚本不入仓<br>📌 **本条 2026-08-09 由 analyze 第三轮从 T026 拆出**：原设计里 T001（第一个 task）要用 T026（倒数第三个 task）的产出，是**循环依赖** —— T001 要么开不了工，要么拍脑袋取规模，那样 PoC gate 的结论不成立（gate 的全部意义就是在真实规模上验）。编号取 `T000` 而非重编全表，是为保持既有 task ID 的引用稳定。<br>✅ **2026-08-09 实测完成**：机会视图 ≈ **210 行**（收租 ≈ 191 · 建仓 ≈ 18）、硬上界 **810 行**、响应体 ≈ **180 KB**（单行 `877 B`）⇒ **`FR-024` 维持「建议」不升硬前置**，T001 的合成数据集取 **≥ 1620 行**（硬上界 2 倍）。完整口径与三条打折因素见 spec § V-B。

- [ ] T001 [Mobile-PoC] **047 双向滚动范式在跨标的规模下的成立性**（spec V-C, D-POC-1/2/3）：起最小 PoC 屏，复用 `LegColumnScroller` / `LegStickyCell` / `LegRow` / `LegTableHeader`，喂合成大数据集（规模 = V-B 实测值 ≥2 倍），**真机跑**（非 web e2e —— 手势争用属 RN 布局陷阱族，Playwright 视口宽松必然假绿）→ verify: 四条判据全过 ① 横滑与纵滚手势各自归属、无粘滞 ② 横滑时 ticker 列真钉住 ③ 虚拟化真生效（滚动中视图回收）④ **seg 切换换整份 `section.data` 后横向 `offset` 与滚动位置行为符合预期**（047 无此场景）。🚨 不过则停下回 user 拍板，**MUST NOT 自行降级绕过**。PoC 代码不入仓。

## Phase 1 · Server 读面（与 T001 正交，可并行推进）

- [ ] T002 [P] [Server] **聚合成员判据 rules**（承接 `FR-005` `FR-006`, D-API-1）：新增 `radar-legs.rules.ts`，导出「机会 = 建仓族 ∪ 收租族」「两族皆不属者不入任何视图」，**import** `leg-tab.rules.ts` 既有判据 → verify: Small spec 覆盖三视图成员关系 + 中段 DTE 腿不入任一视图 + 断言引用的是导入常量而非字面量
- [ ] T003 [P] [Server] **跨族档位排序比较器**（承接 `FR-011` `FR-012` `FR-014`「server 侧」, D-SORT-1/2）：枚举序为第一键；辅键 距 W / DTE / 标的（**客户端**切，见 D-SORT-2），默认 距 W；🚨 **MUST 有第三键 `id ASC` 兜底** —— 「距 W」与「标的」是票级量，同票多腿取值相同，无第三键则同档位内顺序未定义、跨请求漂移，`SC-002` 不成立且 e2e 天然 flaky（045 自己有 `ORDER BY distance_to_w_pct ASC NULLS LAST, id ASC`） → verify: Small 单测含 ① 「构造周化 2.5% 建仓腿与年化 18% 收租腿，断言相对序**仅由档位决定**」② property 断言「任何输入下费率数值不参与跨族比较」（`SC-002` 的可验证形式）③ 三个辅键各一条
- [ ] T004 [P] [Server] **`asOf` 聚合口径 rules**（承接 `FR-010` `FR-010a`, D-API-2）：视图级 `asOf` = 参与聚合各票中**最旧**；逐腿 `asOf` 透传；「有快照但陈旧」与「从无快照」分属两个字段 → verify: Small 单测覆盖跨票不一致 / 全一致 / 单票 / 全无快照
- [ ] T005 [P] [Server] **派生与常量单点复用**（承接 `FR-015` `FR-021`, D-ARCH-2）：档位边界 / 腿族判据 / 意图矩阵 / 财报打标域全部 import 047 具名导出，本片零字面量 → verify: Small 单测断言导入来源 + `rg` 扫本片新增文件**零阈值字面量**（`0.40` `0.55` `150` `365` `2%` `15%` 等）
- [ ] T006 [Server] **`get-radar-legs.usecase.ts`**（承接 `FR-005` **`FR-006a`** **`FR-005a`** `FR-008` `FR-009` `FR-023`, D-API-1/2）：直注 `PrismaService` 跨标的读 047 快照（带 `CROSS-CONTEXT-READ` 注释），🚨 **MUST 逐票 `classifyIntent()` → 组装 `LegTabContext`（`zone` + `w` + `rentDepth`）→ 调 047 `legTabs()`**（D-SORT-3；塞 stub context 会静默改变成员集合且不会红）；greeks 缺失腿按 `FR-005a` 作显式例外无条件入机会视图；组装**全量腿**（零截断零分页）+ 视图成员标记 + 排序 + 双 `asOf` + 「从无快照票」清单；🚨 **基础 `WHERE` MUST 排除 `excluded = true`**（基础条件非筛选项，承 045 Guardrail 12），**MUST NOT 与锚管理列表共用查询**（两侧对该字段态度相反） → verify: Small usecase spec 覆盖 happy / 零锚 / 全票无快照 / 部分票无快照 / **excluded 票不出现在任一视图** / **未选水位票拿到三档并集带**（`rentAbsDeltaBand(null)`）/ **greeks 缺失腿在机会视图可见但不判档**，且断言返回行数 = 逻辑全量
- [ ] T007 [Server] **controller 端点 + DTO + swagger**（承接 `FR-026`「server 不加第二套门控」, D-API-3）：`@Get('radar/legs')` 挂 `optionsdesk.controller.ts`，nullable string 的 `@ApiProperty` 必显式 `type: 'string'` → verify: `nx run server:export-openapi` 后 `openapi.json` 含该路径且 schema 无 `objectmap`
- [ ] T008 [Server-IT] **聚合端点 IT 覆盖 server 可观测的 12 条 `state_branches`**（Gate 0.1）：`optionsdesk-048.radar-legs.it.spec.ts`，Testcontainers 真 PG；跨标的 `asOf` 不一致 **MUST 用多票不同 `session_date` 的真实种子**构造 → verify: **下表 12 条**各一个 `it()` 块，全绿<br>🚨 **本条 2026-08-09 由 analyze 第三轮从「全部 18 条」收窄**：原写法把 18 条全押给一条 server IT，而其中 **6 条在 server 面根本没有可断言的对象** —— markets 门控（`FR-026` 明令 server MUST NOT 有第二套，server 侧不存在该分支）、点腿跳转 / 腿族 Tab 落地（纯客户端导航）、以及三条**渲染位置**断言（首列行内标记 / 动作列角标 / 徽标不渲染，server 最多下发一个 flag）。照原写法只能靠平凡绿凑数 —— 047 自己就留过「不 seed 就落进 fail-open 分支恒判 CURRENT，**断言退化成平凡绿**」的教训注释。

**`state_branches` → task 分派表（18 条无遗漏，`T028` 按此核对，禁按「全在 T008」推定）**：

| 分支 | 承接 |
| --- | --- |
| 已选水位成员 · `excluded` 排除 · 未选水位 · 从无快照 · 空态 · greeks 缺失 · 死档 · `asOf` 非当日 · 跨标的 `asOf` 不一致 · 腿族互斥 · 中段 DTE 不入 · 排序辅键 | **T008**（12 条，server IT） |
| 不动区首列标记 · 跨财报动作列角标 · 复审逾期首列标记 | **T017 / T016**（Small 渲染判定，见 M-4 的 `*.rules.ts` 抽取） |
| 点腿跳 P2 落腿族 Tab · 腿族 Tab ≠ 意图 Tab 仍按腿族落地 | **T021**（+ T023 e2e 端到端） |
| markets 开关关闭 | **T022**（`markets-feature-gate.spec.ts`，config `testMatch` 锁死单文件） |
- [ ] T009 [Contract] **`api-client` regen**（Constitution §V）：`nx run server:export-openapi` **再** `nx run api-client:generate`（🚨 项目名是 `api-client` 不是 `packages/api-client`；且该 target **无 `dependsOn`**，单跑会拿上一版 `openapi.json` regen —— 陈旧 client 合进 main 时 lint/typecheck/test/build **全绿、CI 无一处会红**，见 `docs/conventions/api-contract.md`） → verify: 生成 hook 类型含新端点，`nx affected` typecheck 绿

## Phase 2 · Mobile 骨架（依赖 T001 通过 + T009）

- [ ] T010 [Mobile] **四视图 seg 控件**（承接 `FR-001` `FR-003`, D-UI-1）：新增 `radar-seg.tsx`，四项「标的（默认）/ 机会 / 建仓腿 / 收租腿」，**空视图不置灰、可进入** → verify: Small 单测断言四项恒可点 + 默认项 = 标的 + 空成员时仍可进入
- [ ] T011 [Mobile] **`radar-screen.tsx` 换 `SectionList` + seg 状态**（承接 `FR-002` `FR-004` `FR-024`, D-UI-1）：标的视图从整页变 seg 下默认页；**045 的雷达行 / 色带 / 徽标三个组件一行不改**；🚨 `SectionList` 是**唯一**纵向滚动容器，禁再包 `ScrollView` → verify: Small 单测 + 断言无嵌套同向滚动容器；切 seg 不丢滚动位置与排序选择；**并断言滚动中不出现持续可见空白占位区**（`SC-006` ②；T001 的 PoC 代码不入仓，此处是它唯一的常驻验证）
- [ ] T012 [Mobile] **聚合列集与列宽**（承接 `FR-007` `FR-007a`, D-UI-2）：扩展 `legColumnWidth` key 值域承接 ticker 列与聚合列序，复用 `LegColumnScroller` / `LegStickyCell` **不另起并行组件**；常显 `92+78+62+68+72=372`、横滑区 416、总 780 → verify: Small 单测断言常显合计 < 390（**意图列 68px 是 overflow 探针逼出来的，MUST NOT 回调到 56**）
- [ ] T013 [Mobile] **`use-radar-legs.ts` 数据源**（承接 `FR-023`, D-API-1）：单端点一次取回全量，三视图为**客户端过滤**（切 seg 零新请求）；**MUST NOT 重算成员判据、MUST NOT slice**；辅键在**同档位内**客户端重排是本片既定分工（D-SORT-2），但 **MUST NOT 改变档位分层与死档 / 未判档的位次** → verify: Small 单测断言切 seg 零新请求 + 档位分层与死档位次与 server 返回一致 + 列表长度 = 响应长度

## Phase 3 · Mobile 行渲染（初版被压成一条、漏掉 6 条 FR 的那块）

- [ ] T014 [Mobile] **行主体：费率随行口径 + 距 W + 意图列**（承接 `FR-013` `FR-013a` `FR-019`「建议语义」）：建仓腿行主显周化、收租腿行主显年化，折年恒为小字副标并标「参照 · 不排序」；动作标签一律建议语义、无拦截 → verify: Small 单测断言**同一列在两族行上主数字口径不同** + 折年不参与任何排序输入 + 无任何 disabled/拦截态 + **薄档行同屏显 `ask` 口径值**（`FR-013a`；🚫 `ask` MUST NOT 进入任何档位判定或排序输入）
- [ ] T015 [Mobile] **档位着色与四态动作**（承接 `FR-016` `FR-017` `FR-018` `FR-005a`）：四档着色沿用 047 色板；**死档摊开不折叠、灰底、排底部**；**greeks 缺失不判档**（左边框留空、费率显缺失占位、动作「无法判档」、不参与档位着色与主排序）；动作四态 = 挂 OCO / 暂不挂 / 死档剔除 / 无法判档 → verify: Small 单测逐一断言四态文案 + 死档不折叠 + greeks 缺失行不着档位色（**三套异常体系互不相同，见 Guardrail 5**）
- [ ] T016 [P] [Mobile] **财报标进常显区（动作列角标）**（承接 `FR-021a`, D-UI-3 同族）：动作列内渲角标，零新增列宽；横滑区完整文案保留作双保险；建仓腿恒无标 → verify: Small 单测**先抽 `radar-leg-row.rules.ts` 纯函数**（本仓 mobile 无组件 render 测，`[Mobile]`=logic-only；047 范式是把呈现判定抽成 `leg-row.rules.ts` 再测），断言其返回的槽位归属 = 动作列（非横滑区）+ 建仓腿行无角标 + 五态值域完整
- [ ] T017 [P] [Mobile] **票级行内标记：陈旧 + 不动区**（承接 `FR-010a` `FR-028`, D-UI-3）：两者同族，均落**首列（sticky 常显列）**；陈旧票首列整格 `warning-soft` 底 + 顶部时间条取最旧并转 warning；不动区票 ticker 旁渲行内标记，**不置顶、不进顶部横幅** → verify: Small 单测同上抽纯函数后断言两种标记的槽位归属 = 首列（**非横滑容器**）+ 不动区票的腿仍按档位排在应在位置
- [ ] T018 [P] [Mobile] **意图未定**（承接 `FR-027`, D-UI-5）：虚线 chip + 不置灰 + **照常判档着色、照常排序** → verify: Small 单测断言未选水位行仍有档位色且排在其档位应在的位置（与 `FR-017` 的「不判档」形成对照断言）
- [ ] T019 [Mobile] **空态 / 未就绪横幅 / 常驻页脚**（承接 `FR-003` `FR-008` `FR-019`「页脚」）：空态「今日无解，空仓是常态」；从无快照票走顶部横幅显式可见；页脚常驻「触发 ≠ 开仓 —— 人工终决」 → verify: Small 单测覆盖三态（有数据 / 全空 / 部分票未就绪）+ 断言页脚在**全部三个聚合视图**恒存在

## Phase 4 · Mobile 交互

- [ ] T020 [Mobile] **辅键排序 chip 切换**（承接 `FR-014`「客户端」, D-SORT-2）：chip 切 距 W / DTE / 标的，默认 距 W；**主键档位不可切**（无 UI 入口） → verify: Small 单测断言三键可切 + **不存在任何切换主键的入口** + 切换后顺序变化符合「同档位内重排」
- [ ] T021 [Mobile] **点腿跳 P2 + Tab 覆盖**（承接 `FR-025`, D-UI-4）：经导航参数传目标 Tab，由 P2 手点值通道消费；**MUST NOT 改 `resolveLegTab` 默认落位逻辑** → verify: Small 单测断言建仓腿跳转落建仓腿 Tab、收租腿落收租腿 Tab、且 P2 自身入口默认行为不变
- [ ] T022 [Mobile] **markets 合规门控**（承接 `FR-026`「客户端单层」）：三视图随期权台 tab 一并门控，路由级 guard → verify: `markets-feature-gate.spec.ts` 加断言（**只能落该单文件**）

## Phase 5 · 验证与收口

- [ ] T023 [Mobile-E2E] **US1 一屏看全局**（`SC-001` `SC-002` `SC-003`）：hermetic e2e 断言机会视图跨标的混族按档位排序、每行标 ticker/口径/意图、费率主数字口径与腿族一致 → verify: `nx run mobile:e2e` 绿
- [ ] T024 [P] [Mobile-E2E] **US2 分族 + US3 缺口可见**（`SC-004` `SC-006`）：分族视图只含本族；「没数据」与「有数据但今天没好腿」可区分；**滚动条长度反映全量行数而非已加载行数** → verify: 同上
- [ ] T025 [Contract-Smoke] **契约冒烟 happy-path**（Constitution §V）：生成客户端打 testcontainers 真 server → verify: 注册进 `run.ts` 后 `RUN_REAL_BACKEND_SMOKE=true nx run mobile:contract-smoke` 绿
- [ ] T026 [Server-IT] **perf 探针 + V-B 实测校准**（spec V-B, frontmatter `perf_budgets`, 承接 `FR-024` 的规模判据）：`RUN_PERF_IT` 门控探针量 p50/p95/p99 与响应体；同时产出 V-B 判据（两族带内跨标的实际行数）→ verify: 回填 `perf_budgets`（当前 150/300 是**未校准先验**，按 045/047 先例大概率高估 3–8 倍）+ 回写 V-B 结论；若行数与全链同量级 → `FR-024` 虚拟化从建议升硬前置
- [ ] T027 [Gate] **045 零回归 + `FR-020` 适用范围核验**（`SC-005`, 承接 `FR-020`）：标的视图行版式 / 排序 / 徽标顺序 / 点行跳转四项逐一比对；**并断言三个聚合视图均未渲染票级徽标**（`FR-020` 适用范围 = 仅标的视图） → verify: 逐条 grep + e2e 断言，任一不符即回 T011
- [ ] T028 [Gate] **收口自审（机器化零命中扫描）**（承接 `FR-022`「故意零实现」, `.claude/rules/sdd-authoring.md` § 反模式第 4 条）：起手先列「spec 有哪几层 / 我扫了哪几层」，差集要么补扫要么写明故意不扫；对 **7 层**（FR / SC / Edge Case / `state_branches` / **Acceptance Scenario** / 前置验证 / Clarifications 定案）逐条 grep 交叉核对；**条数一律实时 grep，禁抄 `checklists/` 历史数字**；🚨 **Clarifications 的计数须覆盖三种条目格式**（`- **Q:` / `- Q:` / 非 Q/A 定案），只 grep 一种会漏数 → verify: ① 7 层零命中扫描全空 ② `FR-022`（禁许愿单入口）**确认为故意零实现**并 grep 断言代码中不存在该入口 ③ 编号连续性

---

## FR → task 覆盖矩阵（**34 条全覆盖**，写 tasks 时即可验）

| FR | Task | FR | Task | FR | Task |
| --- | --- | --- | --- | --- | --- |
| FR-001 | T010 | FR-011 | T003 | FR-021 | T005 |
| FR-002 | T011 | FR-012 | T003 | FR-021a | T016 |
| FR-003 | T010, T019 | FR-013 | T014 | FR-022 | T028（故意零实现） |
| FR-004 | T011 | FR-014 | T003, T020 | FR-023 | T006, T013 |
| FR-005 · 005a | T002, T006, T015 | FR-015 | T005 | FR-024 | T011, T026 |
| FR-006 | T002 | FR-016 | T015 | FR-025 | T021 |
| FR-007 | T012 | FR-017 | T015, T018 | FR-026 | T007, T022 |
| FR-007a | T012 | FR-018 | T015 | FR-027 | T018 |
| FR-008 | T006, T019 | FR-019 | T014, T019 | FR-028 | T017 |
| FR-009 | T006 | FR-020 | T027（适用范围核验） | **FR-006a** | **T006** |
| FR-010 | T004 | | | | |
| FR-010a | T004, T017 | | | **FR-013a** | **T014** |

**其余层**：SC 6/6（T023/T024/T026/T027）· Edge Case 6/6（第 6 条锚复审逾期由 T017 首列标记承接，已与 FR-020 消解矛盾）· `state_branches` 18/18（T008 整体覆盖）· Acceptance Scenario 11/11 · 前置验证 V-B（T026）/ V-C（T001）· Clarifications 定案 14/14（🚨 计数须覆盖**三种格式**：`- **Q:` 3 条 + `- Q:` 9 条 + 非 Q/A 定案 2 条 —— 只 grep 一种格式会漏数，本片已因此连错三次：7 → 12 → 14）。

## Dependencies

```text
T000 (V-B 计数) ──> T001 (PoC gate) ──🚧──> Phase 2 / 3 / 4 全部
T002 [P] T003 [P] T004 [P] T005 [P] ──> T006 ──> T007 ──> T008
                                                   └──> T009 ──> Phase 2
T010 ──> T011 ──> T012 ──> T013 ──> T014 ──> T015 ──> T016 [P] T017 [P] T018 [P]
                                                                    └──> T019
T019 ──> T020 ──> T021 ──> T022 ──> Phase 5
T023 ──> T024 [P] ──> T025 ──> T026 ──> T027 ──> T028
```

**关键阻塞**：T001 未过则 Phase 2–4 一条都不能开工。T002–T009 与 T001 **完全正交**，可同时推进。

## Parallel 机会

- **Phase 1 起手**：T002 / T003 / T004 / T005 四条 rules 纯函数，不同文件、零依赖，可同批。
- **Phase 3 中段**：T016 / T017 / T018 三条呈现细节各自独立文件。
- **跨 Phase**：T001（真机 PoC）与 T002–T009（server）正交 —— 压工期的主要口子。

## Implementation Strategy

**MVP = T001–T015 + T023**：PoC 过 + server 端点 + 机会视图能按档位排序跑通并正确渲染四态。此时 `SC-001`「一屏看全局」核心价值已交付。

**增量顺序**：机会视图（US1，P1）→ 分族视图（US2，P2）→ 缺口可见性（US3，P2）→ 交互与收口。三个 US 各自可独立验收。
