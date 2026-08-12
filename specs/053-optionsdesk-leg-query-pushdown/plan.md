---
feature_id: 053-optionsdesk-leg-query-pushdown
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-12'
updated_at: '2026-08-12'
adr_refs: ['0032', '0043', '0053', '0062']
context7_verified: []
---

# Implementation Plan: 选约表查询下沉（P3 · 末片）

## Summary

把选约表的读取路径从「一次请求返回全量腿、三视角共用一份响应」改成「**每视角一次独立请求**，筛选参数进请求，服务端按 排名 → 筛选 → 截断 作答」，并补齐随之而来的显示（截断计数、三个空态）与异步/一致性状态（错峰预热、单视角失败隔离、业务日不一致自动重取）。判定层（`050` 的召回 / 打标 / 精排）**零改动**，只改它被调用的位置与时机。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

> 本片零新依赖。防抖用 `useEffect` + `setTimeout` 自写（约 10 行），**不引 lodash.debounce / use-debounce** —— 引一个包换 10 行代码，且 RN 侧还要处理 unmount 清理，自写反而更可控。React Query 的并发 / 预取 / 失效全部用已装的 `@tanstack/react-query` 既有 API。

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 无违反。逐条：**§I** SDD 全流程已走（specify → clarify → **mockup** → plan，UI feature 的 mockup 卡点已过）；**§II** 每 task 红→绿→typecheck/lint→`[X]`→commit；**§III** task 拆为 30min–2h 独立 commit；**§IV** 本片不新增 bounded context，跨 ctx 读仍走 `CROSS-CONTEXT-READ` 只读直查（不新增跨 ctx 写）；**§V** 跨端片走**单 PR**（server + `export-openapi` + regen + mobile 消费 + 两层验证同 PR），并落 `[Contract-Smoke]`。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 新端点形状（`tab` + 筛选参数 + 截断）由 `optionsdesk-053.query.it.spec.ts` 覆盖（Testcontainers 真 PG），每条 state branch 一个 `it()`。
- [x] **Mobile / Web**: 三条 P1 用户旅程（筛选收窄 / 截断可见 / 单视角失败隔离）走 Playwright Expo Web hermetic e2e；占屏比与软键盘走真机（web 验不到，见 spec `web_compat_notes`）。
- [x] **Evidence**: 待 impl 期回填（IT 文件路径 + e2e spec 路径 + 真机验收记录写回 spec § 真机验收）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片零新第三方包（见 Dependencies 表）。

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。optionsdesk ctx 自 `045` 起即在 mono 内建立，无 meta-repo 迁入史。
**Evidence**：`rg 'org\.springframework|mbw-[a-z]+/src/main/java' specs/053-optionsdesk-leg-query-pushdown/` → 0 命中。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| ADR-0053（跨 ctx 纯函数 import） | `sunset_trigger` #2 =「第二个 ctx 申请 import 他 ctx 的 `*.rules.ts`」 | **accepted-as-is，未命中** | 本片派生仍全落 `optionsdesk/*.rules.ts`，不 import `marketdata/*.rules.ts`；spot 直取快照行里 vendor 给的标的价。ESLint `boundaries` 已把 `marketdata-rules` 列进 optionsdesk 的 `disallow`，是机器绊线 |
| ADR-0063（横滑范式） | sunset =「上提 `~/ui`」 | **accepted-as-is，未命中** | 本片不碰横滑机制，筛选行是 sticky 栈内新增一条、不进横滑区、不改 `contentWidth` |
| ADR-0062（optionsdesk bounded context） | 无与本片相关的 Open Question | **accepted-as-is** | 本片不新增 ctx、不改边界 |

**Evidence**：`rg -l 'Open Questions' docs/adr/` 后逐份读 `0032` / `0043` / `0053` / `0062` / `0063` 的该节；无一条被本片触发。

## Architecture Notes

### 🚨 Testing Invariants（AI 绝对禁令 — 严禁违背）

- **NO LIFECYCLE MOCKING**：对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类**绝对禁止**隔离单元测试。本片虽不新增 lifecycle 组件，但**新增的查询参数校验若落 `ValidationPipe`，其测试必须走 DI 容器**。
- **MANDATORY INTEGRATION**：`Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()`，`createTestingModule` 之外的「测试」视同未测试。
- **EXHAUSTIVE BRANCHING**：spec `state_branches` **22 条**，每条在 IT / e2e 里必须有对应 `it()`。100% 路径覆盖，不允许漏。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
>
> - **Flat Module**：文件平铺 `apps/server/src/optionsdesk/`，**NEVER** 生成 `domain/` / `application/` / `infrastructure/` / `web/`。
> - **Anemic Data & Zero-Class**：数据 = 裸 Prisma row，**NEVER** 生成 Domain Class / Entity Mapper。
> - **No Repositories**：直注 `PrismaService`，业务不变量落纯函数 `*.rules.ts`。
> - **The Moat**：跨 ctx 读 MUST 带 `// CROSS-CONTEXT-READ: <数据范围 + 只读>` 注释（`check-server-moat.ts` 机器强制）；跨 ctx 写永远禁。

---

## D-API-1 · 端点形状：加参数，不加端点（`FR-001` / `FR-002` / `FR-007`）

**决定**：沿用 `GET /v1/optionsdesk/underlyings/:symbol/legs`，加三个查询参数：

| 参数 | 值域 | 语义 |
| --- | --- | --- |
| `tab` | `all` \| `build` \| `rent` | 视角。**必填** |
| `strikeMin` | 数值串，两位小数 | 行权价下界，缺省 = 不限 |
| `strikeMax` | 数值串，两位小数 | 行权价上界，缺省 = 不限 |

🚫 **MUST NOT 开三个端点** —— 三者的区块级元数据（`asOf` / `spot` / `intent` / `w` / `zone` / 水位）逐字相同，拆端点会让同一份派生在三处各写一遍。

### 响应形状变化（**本片是 breaking change，与 `050`/`051` 的「只加不删」不同**）

`legs[]` 的语义从「legacy 载体序的全量腿」变为「**该视角、已排序、已截断的腿**」。连带：

- **删** `tabOrder`（每视角一份有序 code 列表）—— 数组顺序**就是**顺序，再下发一份 code 列表是同一信息的第二份表达，必 drift。
- **删** `basisByTab`，改标量 `basis`（该视角的口径）—— 客户端只渲染当前视角的列头。
- **新增** `tab`（回显）· `memberCount`（该视角**筛选前**成员数）· `matchedCount`（**筛选后**符合条件数）· `displayLimit`（该视角的截断阈值）。

🚨 **为什么可以 breaking**：本片是跨端片走**单 PR**（Constitution §V），server 与 mobile 同树原子 merge，**不存在旧客户端**。`050`/`051` 之所以受「只加不删」约束，是因为它们**刻意拆成两个 PR**。本片没有这个约束，而继续背着 `tabOrder` / `basisByTab` 会留下两份顺序表达 —— 那正是 `051` 花力气消灭的东西。
📌 **代价必须显式承担**：`packages/api-client` regen 后，所有手写 `LegTableResponse` mock 工厂会编译红（`050` 那次是 7 处）。**这是好事**——类型红是本次语义翻转的唯一自动信号。

### 计数的三处分工（与 mockup 定案一致）

| 位置 | 内容 | 数据来源 |
| --- | --- | --- |
| sticky 区块头 | 未筛选 `共 M 行`；筛选生效 `筛后 N · 全量 M` | `memberCount` / `matchedCount` |
| 底部第 1、2 条 | 权利金移出 / 流动性排除（`051` 已 ship） | `gateCounts` |
| 底部第 3 条 | `已显示前 D 条 · 其余 N−D 条未显示` | `legs.length` 与 `matchedCount` |

🚨 **`D` 不下发** —— 它恒等于 `legs.length`，下发第二份必 drift。**同理 `其余` 也不下发**，由 `matchedCount − legs.length` 现算。

---

## D-ORDER-1 · 排名基准 = 该视角**筛选前**的全量成员（`FR-009` / `FR-025` / 跨片不变量 #4）

**服务端处理顺序，恒为四段且不可换序**：

1. **召回**（`leg-recall.rules.ts`，零改动）→ 得该视角成员集，`memberCount = 成员集.length`
2. **打标 + 精排**（`leg-mark.rules.ts` / `leg-rank.rules.ts`，零改动）→ **基准 = 步 1 的全量成员集**
3. **筛选**（本片新增，纯函数 `leg-filter.rules.ts`）→ `matchedCount = 筛后.length`
4. **截断** → `legs = 筛后.slice(0, displayLimit)`

🚨 **实现者最自然的写法是「先筛再排名」（少算一些），那样写出来照样能跑、数字照样有，只是全错** —— 活跃标（`isTopRanked`）的分母变了。`leg-tab.rules.ts` 头部的警告说的正是这种「不会红」的 drift。
⇒ **可验证形态**（`SC-005`）：IT 断言「同一条腿在筛选前后的 `activityByTab` 逐字段相同」。这条比断言顺序更硬 —— 顺序可能因为筛掉的腿本来就在后面而看不出差别。

---

## D-SQL-1 · 🚨 费率下沉 SQL：**主 plan 给的理由不成立，建议不做**（待 user 定）

主 plan §2.2 末把「费率下沉 SQL」移交本片，理由逐字是：

> 「P3 才是下沉的正确时机：那时要 server 截断 top-N，`ORDER BY … LIMIT` 必须在 SQL 里，费率随之必须下沉。」

**这句话把「服务端截断」与「数据库截断」当成了同一件事，它们不是。** `FR-017` 要的是「服务端在排名与筛选之后截断」——server 在内存里 `slice(0, D)` 完全满足它，而**客户端 payload 的收益（只收 ≤ D 行）已经全额拿到**。DB → server 那一跳的传输量确实不变，但那是同机一跳，且实测 `p50 45.5ms / p95 54.1ms` @730 行（`050` T017）**已经把它算在内了**。

⇒ 下沉的**唯一理由消失**，而代价一条不少：

| 代价 | 说明 |
| --- | --- |
| **第二份判据实现** | 四条召回门槛 + 费率公式要在 SQL 里再写一遍。drift 时**不会红**——两边各自都算得出数，只是不是同一个数（`050` 否决下沉时的原话） |
| **等价 IT** | `FR-023` 要求「SQL 结果 == 纯函数结果」可自动验证。这是一条昂贵且脆的测试 |
| **破坏不变量 #8** | 「排序器只读 `RankingFeatures`，不许直接读原始腿」—— SQL 读的是原始列，不是特征 |
| **`markActivity` 需要全量成员的统计量** | 活跃标基准 = 全量成员 ⇒ SQL 里还要 window function 复现，或退回内存（那下沉就只做了一半） |

### 三个选项

| 选项 | 内容 | 判断 |
| --- | --- | --- |
| **C（建议）** | **不下沉**。读全链 → 内存跑 召回/打标/精排/筛选/截断。`FR-023` 由「判据只有一份实现」自动满足 | 零新增代价；不变量完好；`FR-017` 全额满足 |
| A | 全下沉：召回 + 费率 + 排序 + 截断全进 SQL | 为未来的大链铺路，与你选做截断的初衷一致；但代价是上表四条全付 |
| B | 半下沉（只把 `ORDER BY … LIMIT` 下沉，召回仍在内存） | ❌ **不成立** —— SQL 不知道哪些行是成员，无法正确截断 |

📌 若选 C，`FR-023` 仍然成立且更强：**判据只有一份实现**，等价性无从谈起（没有第二份可比）。IT 只需断言「排序与截断作用在同一个已排序序列上」。
📌 若选 A，必须新增 `[Server]` task：SQL 镜像 + 等价 IT（造 ≥ 100 条随机腿，逐条比对纯函数与 SQL 的 `(顺序, memberCount, matchedCount)` 三元组），且 `RankingFeatures` 不变量要在 plan 里显式记为「本片放宽」。

**本 plan 余下部分按 C 撰写**；若你选 A，`D-TEST` 与 Task 分解需加 2–3 条，我会回改。

---

## D-LIMIT-1 · 截断阈值按视角分档，且**可注入**（`FR-017` / `FR-017a` / `FR-017c`）

常量落 `leg-filter.rules.ts`：

```text
DISPLAY_LIMIT_BY_TAB = { all: 800, build: 200, rent: 200 }
```

判据 = **严格大于阈值才截**（`matchedCount > limit`）。

🚨 **阈值 MUST 可注入**（use case 签名带可选参数，默认取上面的常量）—— 这是 `FR-017a` / `SC-006` 的落地手段：

- 实测 `top-200` 在**建仓视角结构性永不触发**（最大 108），收租 / 全腿也只有 2–3 条链够得着 ⇒ **截断的分支拿真实数据覆盖不到**。
- 注入小阈值（如 `3`）后，**同一批真实数据**就能走遍截断的每一条分支。
- 🚫 **MUST NOT 改用合成 fixture 造 201 条腿** —— 合成数据没有 vendor 真实的 bid/ask 分布，测出来的是「我造的数据能不能被 slice」，不是「真实链上截断对不对」。

📌 全腿视角取 800 的判据与绊线见 `FR-017b` / `FR-017c`：它必须高到让 `051` 那个「切到全腿视角看被排除的腿」的入口仍然可达（`SC-012` 是这条的回归防线），且 800 是**起手档不是标定值**，链规模逼近阈值时要可观测。

---

## D-CONSIST-1 · 一致性：检测 + 重取，零新增契约字段（`FR-003` / `FR-004` / `FR-004a`）

**检测面在客户端**，因为只有客户端同时握着三份响应。

- 三份 query 全部 settled 且 `asOf` 不全相同 → 触发一次 `invalidateQueries` 重取全部，**并置 flag**。
- flag 已置且重取后仍不一致 → 停止重取，渲染 `warnbar`（显式提示 + 手动刷新入口）。
- 🚫 **MUST NOT 无限重取** —— flag 必须是「本轮已重取过」的 latch，不是计数器自增（计数器写错方向就是死循环）。
- 🚫 **MUST NOT 新增版本戳字段** —— `asOf` 已在契约里（`051` 之前就有），且配了 `asOfFreshnessTier`。

**水位那条是另一条链路**（`FR-004a`）：`useSetPositionBucket` 的 `onSuccess` 已经 `invalidateQueries`，但 query key 现在带 `tab` ⇒ **必须失效三个视角**。用不带 `tab` 的前缀 key 失效即可（`['optionsdesk','legs',symbol]`）。
🚨 **这条极容易漏**：改完 query key 加了 `tab` 之后，原来那句 `getOptionsdeskControllerLegsQueryKey(symbol)` 会变成只失效某一个视角（或一个都不匹配），而**屏幕上什么都不会红** —— 水位 chip 亮了、意图变了，另外两个视角还是旧口径。`FR-004a` 的 IT/e2e 断言必须覆盖「用户停在建仓视角时改水位」这条路径（`SC-013`）。

---

## D-ASYNC-1 · 错峰预热与失败隔离（`FR-005` / `FR-006` / `FR-024`–`FR-024b`）

**React Query 三个 query，各自独立 key**：`['optionsdesk','legs',symbol,tab,strikeMin,strikeMax]`。

- **错峰**：当前视角的 query 无条件 enabled；其余两个 `enabled: currentQuery.isSuccess`（当前视角落地后才开）。这就是 `FR-024` 的「首屏只取当前视角，落地后后台补其余两个」，**不需要手写 prefetch 编排**。
- **失败隔离**（`FR-005`）：三个 query 天然独立 ⇒ 一个 error 不影响另外两个的 `data`。呈现侧**按当前视角自己的 query 状态**决定渲染，MUST NOT 用「任一失败即整块降级」。
- **迟到响应不覆盖**（`FR-006`）：query key 含 `tab` 与筛选值 ⇒ 切视角 / 改筛选就是**换 key**，旧 key 的响应写不进新 key。这是 React Query 的天然性质，**不需要手写 abort**。
- **后台预取不干扰前台**（`FR-024b`）：其余两个视角的 `isError` **MUST NOT** 渲染进当前视角；Tab 行 **MUST NOT 加错误 / 加载角标**（mockup 已显式未画，理由见 handoff）。

📌 **每视角自持筛选状态**（`FR-024a`）：筛选值存 `Record<LegTab, {min,max}>`，切视角不带走。它天然落进 query key ⇒ 各视角各自缓存。

---

## D-UI-1 · 筛选行（`FR-007`–`FR-016b`）

- 形态**逐字继承 `049` mockup**（前置灰标签 + 两个输入 + 中缝 `–` + 右端互斥槽位）。落位在 Tab 行与 12 列表头之间，**进 sticky 栈**（+40dp）。
- **实时 + 防抖**（clarify 定案）：本地 state 即时回显（输入框不卡），**防抖后**才进 query key。⇒ 输入框的值与 query key 的值是**两个 state**，别合并。
- **两位小数 + 拒绝非法输入**（`FR-010`）：校验落纯函数 `leg-filter.rules.ts`，客户端与服务端**共用同一份判据**（客户端拦一道给即时反馈，服务端仍必须校验 —— 客户端校验不是安全边界）。
- **下界 > 上界 ⇒ 筛选不生效、表保持全量 + 提示**（`FR-012`）：🚨 **MUST NOT 把非法区间发给服务端**（服务端收到 `min > max` 会诚实地返回 0 行，而 spec 要的是「保持全量」）。⇒ 非法时**不进 query key**，只渲染提示。
- 🚫 **MUST NOT 用客户端本地预筛充当即时反馈**（`FR-016b`）—— 手上只有截断后的那一段，本地预筛会给出看起来完全正常的**错误子集**。

---

## D-UI-2 · 三个空态必须一眼可分（`FR-013`）

| 空态 | 触发 | 文案指向 | 入口 |
| --- | --- | --- | --- |
| a 门槛致空（`051` 已 ship） | `memberCount === 0` 且该视角流动性排除数 > 0 | 门槛 | 切全腿视角 |
| b 期限段确实没有（`051` 已 ship） | `memberCount === 0` 且该视角流动性排除数 === 0 | 数据事实 | **无** |
| c 筛后 0 行（**本片新增**） | `memberCount > 0` 且 `matchedCount === 0` | **用户自己筛的、可撤销** | **清除筛选** |

🚨 **c 的标题必须换词**（「当前筛选无结果」而非「暂无合格腿」）—— 只改副标不够：a/b/c 三者的**标题**若相同，用户扫一眼分不出「系统说没有」与「我自己筛没了」。

---

## D-UI-3 · 截断计数（`FR-018` / `FR-018a` / `FR-019` / `FR-020`）

- 落 `051` 已定的 `renderSectionFooter`（**非常驻区**，MUST NOT 进 sticky 栈），追加为第 3 条。
- 文案 **`已显示前 D 条 · 其余 N−D 条未显示`**（mockup 面板 A 定案 b）。🚫 **MUST NOT 复述 `matchedCount`** —— 它已由 sticky 区块头承担。
- 附一句指向**筛选**的收窄指引（`FR-018a`）—— 分页与「加载更多」都不存在。
- 未触发截断 ⇒ **整条不渲染**（`FR-020`），MUST NOT 显示空值或恒等的两个数。
- 视觉：与「权利金移出」同款（`--nvy-text-muted` 纯文字、**无雪佛龙**，它没有入口）。🚨 **MUST NOT 用 warning / danger 色** —— 截断是正常的呈现约定不是异常。

---

## D-COL-1 · 列改版（`FR-030`–`FR-032`）

新列序：`行权价/到期` → `bid` → `ask` → `折算费率` → **`单笔权利金`（新）** → `OI` → `相对价差` → 其余。

- `bid`/`ask` 由共用一格拆成两列 —— 挂许愿单要同时看两侧报价来定挂单价，共用一格时两个数字号不同、不便比对。
- **单笔权利金服务端算**（`FR-031`）：新增契约字段。客户端乘一次 = 判据双写。
- 🚨 **列宽合计 MUST 不变**：`049` 的横滑范式把 `contentWidth` 当作位移钳制的输入，总宽一变，指示条长度比与 `maxTx` 全跟着变，而**真机上表现为「右侧滑不到底」且不会红**。⇒ 新列的宽度 MUST 从后置列压缩吸收，首列 88 不动。
- → verify: `rg 'contentWidth' apps/mobile/src/optionsdesk/` 的取值与 `049` 一致 + 真机横滑到最右端最后一列完整露出。

## D-TEST · 验证分层

### D-TEST-0 · Server IT（`optionsdesk-053.query.it.spec.ts`，Testcontainers 真 PG）

覆盖：`tab` 三值各自成员集 · 筛选与成员判据复合 · **排名基准不被筛选污染**（`SC-005`：同一腿筛前筛后 `activityByTab` 逐字段相同）· 截断阈值分档 · **边界「恰等阈值不截」** · `memberCount` / `matchedCount` 取值 · **注入小阈值走遍截断分支**（`SC-006`）· **被意图视角排除的腿在全腿视角可达**（`SC-012`，`051` 的回归防线）· 非法区间 / 越界区间。

### D-TEST-1 · vitest Small（`leg-filter.rules.spec.ts`）

纯函数：区间闭合性 · 只填一端 · 两位小数校验 · 非法区间判定 · 阈值分档常量。

### D-TEST-2 · Mobile hermetic e2e（Playwright Web）

筛选交互（实时防抖 / 清除 / 完成槽位互斥）· 三个空态一眼可分 · 截断计数出现与消失 · **单视角失败隔离**（`SC-009`）· 一致性提示。
🚨 hermetic mock 是**契约镜像不是调用序**：`GET` 按 `tab` + 筛选参数无条件返回对应状态，**禁**按测试编排标志分支。

### D-TEST-3 · Contract smoke（`[Contract-Smoke]`，跨端片义务）

生成的 `@nvy/api-client` 打 testcontainers 真 server，验新参数序列化 + 新字段解封 + 删掉的 `tabOrder`/`basisByTab` 确实不再出现。

### D-TEST-4 · 真机验收（web 验不到的三类）

sticky 栈加回筛选行后的**占屏比 ≤ 35%**（`SC-003`，基线 `051` 实测 138.5dp / 27.9%，推算约 32.7%）· **软键盘**不做整屏避让且输入框 + ≥3 行结果同屏 · 视角切换与预热的**手感**。

---

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红）

1. **先筛再排名** —— 少算一些、跑得通、数字有，但活跃标分母全错（`D-ORDER-1`）。
2. **水位失效只失效一个视角** —— query key 加了 `tab` 之后原来那句失效不再覆盖三份（`D-CONSIST-1`）。
3. **非法区间发给服务端** —— 服务端诚实返回 0 行，而 spec 要的是保持全量（`D-UI-1`）。
4. **客户端本地预筛** —— 手上只有截断后的一段，给出的是看起来正常的错误子集（`FR-016b`）。
5. **无限重取** —— 一致性 latch 写成计数器且方向写反即死循环（`D-CONSIST-1`）。
6. **Tab 行加错误 / 加载角标** —— 与 `FR-024b` 定的「后台预取失败对前台零感知」相反（`D-ASYNC-1`）。
7. **三个空态共用标题** —— 只改副标，用户分不出「系统说没有」与「我自己筛没了」（`D-UI-2`）。
8. **截断计数用告警色** —— 截断是正常呈现约定，告警色会让人以为数据坏了（`D-UI-3`）。
9. **截断分支用合成 fixture 验** —— 测的是「slice 能不能跑」，不是「真实链上截断对不对」（`D-LIMIT-1`）。
10. **保留 `tabOrder` / `basisByTab`** —— 留着就留下两份顺序表达，正是 `051` 花力气消灭的东西（`D-API-1`）。

## Task 分解（**草图；编号与顺序以 `tasks.md` 为准**）

| # | 层 | 内容 |
| --- | --- | --- |
| 1 | `[Server]` | `leg-filter.rules.ts` 纯函数（区间判定 + 精度校验 + 阈值分档常量）+ Small 测 |
| 2 | `[Server]` | `GetLegsUseCase` 改按 `tab` 作答 + 四段顺序 + 两个计数 + 可注入阈值 |
| 3 | `[Server]` | DTO / controller 查询参数 + 响应形状（删 `tabOrder`/`basisByTab`，加 4 字段）+ swagger |
| 4 | `[Server]` | IT：22 条 state branch 全覆盖（含注入小阈值走截断分支、`SC-012` 回归防线） |
| 5 | `[Contract]` | `export-openapi` + `nx affected -t generate` regen + 修手写 mock 工厂编译红 |
| 6 | `[Mobile]` | `use-leg-table.ts` 改三 query + 错峰 + 失败隔离 + 一致性 latch + 水位失效三份 |
| 7 | `[Mobile]` | 筛选行 UI + 防抖 + 非法区间不进 key + 每视角自持状态 |
| 8 | `[Mobile]` | 截断计数第 3 条 + 三个空态（c 新增，标题换词） |
| 9 | `[Mobile-E2E]` | hermetic e2e：筛选 / 三空态 / 截断计数 / 单视角失败 / 一致性 |
| 10 | `[Contract-Smoke]` | 契约冒烟扩到新参数与新字段 |
| 11 | `[Verify]` | 真机验收：占屏比 / 软键盘 / 切换手感 → 写回 spec |

> ⚠️ 若 `D-SQL-1` 选 A（下沉），在 2 与 4 之间插入「SQL 镜像 + 等价 IT」两条。

## Out of Scope（本片明确不做）

| 事项 | 去向 |
| --- | --- |
| 行权价以外的筛选维度 | 不做 |
| 筛选条件持久化 | 不做（`FR-016`） |
| 分页 / 加载更多 / 被截断腿的下钻 | 不做（`FR-021`） |
| 召回 / 打标 / 精排判据本身 | 不动（`050` 已定） |
| 加权评分 · 排名特征集下发 | 不做 / 永不做 |
| 045 锚派生与意图矩阵 | 不动 |
| 046 三块版式 · 12 列**列宽**与首列冻结判据 | 不动（列序与两个新列本片要改，见 `D-COL-1`） |
| 横滑范式与位移语义（`049`） | 不动 |
| 跨标的聚合视图（`048`） | 冻结，四片落完连同其 spec 一并重写 |
| 锚卡「仓位水位 · 未知 · 待接入」与选约区 chip 同屏同名不同值 | 不动，留待持仓接入片 |

## Complexity Tracking

> 无 Constitution 违反，本表为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| N/A | N/A | N/A |
