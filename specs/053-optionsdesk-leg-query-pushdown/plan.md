---
feature_id: 053-optionsdesk-leg-query-pushdown
spec_ref: ./spec.md
status: drafted
created_at: '2026-08-12'
updated_at: '2026-08-14'
adr_refs: ['0032', '0043', '0053', '0062', '0064']
context7_verified: []
---

# Implementation Plan: 选约表查询下沉（P4）

## Summary

把选约表的读取路径从「一次请求返回全量腿、三视角共用一份响应」改成「**每视角一次独立请求，响应按视角收窄**」，并在精排之后补一步**表达层截断 `N`** 与其计数补偿；随之处置拆请求自带的两个新问题（跨业务日一致性、单视角失败隔离）与一笔体验代价（错峰预热）。另含一项与查询下沉正交的 **12 列改版**。

判定层（`050` 的召回 / 打标 / 精排 + `052` 的五层分层与六维检索条件）**零改动**，只改它被调用的位置与时机。

## Dependencies & Defensive Additions _(Cargo-cult 防火墙)_

| 引入的依赖 / Polyfill / Defensive Import | 目的 | Fact-check 锚点 |
| --- | --- | --- |
| None | N/A | N/A |

> 本片零新依赖。React Query 的并发 / 预取 / 失效全部用已装的 `@tanstack/react-query` 既有 API。

## Constitution Check _(mandatory gate)_

- [x] **Passed** — 无违反。逐条：**§I** SDD 全流程（specify → clarify → plan → tasks → analyze → implement）；本片 UI 增量为**列改版 + 截断计数第 3 条**，两者均在 `049`/`051` 已定稿的版式内（列序调整 + 已留位的 footer 槽），⚠️ 若列改版期发现需要新版式 → **停下补 mockup**（见 Gate 0.1 绊线）；**§II** 每 task 红→绿→typecheck/lint→`[X]`→commit；**§III** task 拆为 30min–2h 独立 commit；**§IV** 本片不新增 bounded context，跨 ctx 读仍走 `CROSS-CONTEXT-READ` 只读直查（不新增跨 ctx 写）；**§V** 跨端片走**单 PR**（server + `export-openapi` + regen + mobile 消费 + 两层验证同 PR），并落 `[Contract-Smoke]`。

## Phase 0 Research Gates _(mandatory)_

### Gate 0.1 — Integration Smoke Gate

- [x] **Server**: 新端点形状（`perspective` 作答 + 响应收窄 + 截断）由 `optionsdesk-053.query.it.spec.ts` 覆盖（Testcontainers 真 PG），每条 state branch 一个 `it()`。
- [x] **Mobile / Web**: 三条用户旅程（截断计数可见 / 单视角失败隔离 / 错峰预热时序）走 Playwright Expo Web hermetic e2e；列改版几何与切换手感走真机（web 验不到，见 spec `web_compat_notes`）。
- [x] **mockup 已走完**（2026-08-13，`design/053-leg-columns.dc.html` 3 帧）—— 列改版是本片唯一有新视觉形态的一块，绊线已在 tasks 之前触发并闭合。列宽合计与首列冻结宽经渲染实测未变（`trackWidths 302` / `paneWidths 628`）。
- **Evidence**: 待 impl 期回填（IT 文件路径 + e2e spec 路径 + 真机验收记录写回 spec § 真机验收）。

### Gate 0.2 — Cross-stack Vendor Intersection 6Q Card

**N/A** —— 本片零新第三方包（见 Dependencies 表）。

**Evidence**: N/A

### Gate 0.3 — Legacy → Mono Delta Sweep Checklist

**N/A — feature is mono-native**。optionsdesk ctx 自 `045` 起即在 mono 内建立，无 meta-repo 迁入史。

**Evidence**：`rg 'org\.springframework|mbw-[a-z]+/src/main/java' apps/server/src/optionsdesk apps/mobile/src/optionsdesk` → 0 命中。

### Gate 0.4 — ADR-deferred-mitigation Scan Step

| ADR | Open Question affected | Classification | Mitigation / next step |
| --- | --- | --- | --- |
| **ADR-0064**（检索分层） | sunset #1「多路召回落地」/ #3「规模突破阈值触发 port 第二实现」 | **accepted-as-is，未命中** | 本片仍是单路召回、单 port 实现。📌 但本片选择拆请求的**正当性前提正是为这两条 sunset 留接口**（spec § 背景）—— 前提本身写进 spec，sunset 条件未变 |
| ADR-0064 | 不变量 ①「两级截断 `K` 与 `N` 是两个数」 | **本片兑现** | `052` 只有 `K`，`N` 由本片引入 ⇒ `052` 留的量级断言（`RECALL_CANDIDATE_CAP > 758`）在本片变成**真正的对照**（见 `D-LIMIT-1`） |
| ADR-0053（跨 ctx 纯函数 import） | sunset #2 =「第二个 ctx 申请 import 他 ctx 的 `*.rules.ts`」 | **accepted-as-is，未命中** | 本片派生仍全落 `optionsdesk/*.rules.ts`，不 import `marketdata/*.rules.ts`。ESLint `boundaries` 已把 `marketdata-rules` 列进 optionsdesk 的 `disallow`，是机器绊线 |
| ADR-0063（横滑范式） | sunset =「上提 `~/ui`」 | **accepted-as-is，未命中** | 本片列改版 MUST NOT 改内容总宽合计与位移语义（`D-COL-1`） |
| ADR-0062（optionsdesk bounded context） | 无与本片相关的 Open Question | **accepted-as-is** | 本片不新增 ctx、不改边界 |

**Evidence**：`rg -l 'Open Questions' docs/adr/` 后逐份读 `0032` / `0043` / `0053` / `0062` / `0063` / `0064` 的该节。

## Architecture Notes

### 🚨 Testing Invariants（AI 绝对禁令 — 严禁违背）

- **NO LIFECYCLE MOCKING**：对 `Guard` / `Interceptor` / `Filter` / `Pipe` 子类**绝对禁止**隔离单元测试。本片虽不新增 lifecycle 组件，但**新增的查询参数校验若落 `ValidationPipe`，其测试必须走 DI 容器**。
- **MANDATORY INTEGRATION**：`Test.createTestingModule({ imports: [OptionsdeskModule] }).compile()`，`createTestingModule` 之外的「测试」视同未测试。
- **EXHAUSTIVE BRANCHING**：spec `state_branches` **25 条**，每条**有一个 `it()`，落在够得到它的那一层**（服务端分支落 IT、纯客户端分支落 e2e —— 沿 `052` T015 对同一冲突的裁法）。

### General Architecture Notes

> ⚠️ **CRITICAL ARCHITECTURE PARADIGM (ADR-0043 — ENFORCED)**
>
> - **Flat Module**：文件平铺 `apps/server/src/optionsdesk/`，**NEVER** 生成 `domain/` / `application/` / `infrastructure/` / `web/`。
> - **Anemic Data & Zero-Class**：数据 = 裸 Prisma row，**NEVER** 生成 Domain Class / Entity Mapper。
> - **No Repositories**：直注 `PrismaService`，业务不变量落纯函数 `*.rules.ts`。
> - **The Moat**：跨 ctx 读 MUST 带 `// CROSS-CONTEXT-READ: <数据范围 + 只读>` 注释（`check-server-moat.ts` 机器强制）；跨 ctx 写永远禁。

---

## D-API-1 · 端点形状：加参数，不加端点（`FR-001` / `FR-003`）

**决定**：沿用 `GET /v1/optionsdesk/underlyings/:symbol/legs`，`perspective` 参数由「只决定条件覆盖作用于谁」升为「**决定本次返回哪个视角**」。六维检索条件参数**逐字不变**（`052` 已 ship）。

🚫 **MUST NOT 开三个端点** —— 三者的链级元数据（`asOf` / `spot` / `intent` / `w` / `zone` / 水位）逐字相同，拆端点会让同一份派生在三处各写一遍。

🚨 **`perspective` 从可选变必填**（或缺省时给一个明确的默认视角）—— 这是本片语义翻转的入口，MUST 有 400 断言守。📌 `052` 已定「给了条件没给视角 → 400」，本片把它扩到「任何请求都必须指明视角」。

### 服务端调用点的改动面（**port 签名零改动**）

| 位置 | 现状 | 改法 |
| --- | --- | --- |
| `get-legs.usecase.ts:430` | `perspectives: LEG_TABS`（恒全集） | 改传请求带的那一个视角 |
| `get-legs.usecase.ts:649` / `:733` | `for (const tab of LEG_TABS)` 两处循环 | 收敛为单视角，循环退化 |
| `optionsdesk.controller.ts:253` | `execute(symbol, undefined, toRetrievalOverride(query))` | 传入 `perspective` |

📌 **`retrieveCandidates` 每请求仍只调 1 次** —— 拆的是 HTTP 请求不是 port 调用。DB 3x 是三个 HTTP 请求各自查一遍的结果，**不是**单请求内查三遍。

### 响应形状变化（**破坏性变更**，逐条见 spec `FR-005`）

`legs[]` 的语义从「legacy 载体序的全量腿」变为「**该视角、已排序、已截断的腿**」。七处 by-tab 结构按「链级 / 视角级」切一刀。

🚨 **为什么可以 breaking**：① 本片跨端走**单 PR**（Constitution §V），server 与 mobile 同树原子 merge；② optionsdesk 整栈在公开构建里被**编译期** flag 关闭且 OTA 翻不动（spec `FR-006`）⇒ **不存在旧客户端**。`050`/`051` 之所以受「只加不删」约束，是因为它们**刻意拆成两个 PR**；本片没有这个约束。

📌 **代价必须显式承担**：`packages/api-client` regen 后，所有手写 `LegTableResponse` / `LegResponse` mock 工厂会编译红（`050` 那次 7 处、`052` 那次 6 处）。**这是好事** —— 类型红是本次语义翻转的唯一自动信号。

### 计数的三处分工

| 位置 | 内容 | 数据来源 |
| --- | --- | --- |
| sticky 区块头 | 未覆盖 `共 M 行`；覆盖生效 `筛后 N · 全量 M` | `memberCount` / `matchedCount` |
| 底部第 1、2 条 | 权利金移出 / 流动性排除（`051` 已 ship） | 收窄后的链级 / 视角级计数 |
| 底部第 3 条（**本片新增**） | `已显示前 D 条 · 其余 N−D 条未显示` | `legs.length` 与 `matchedCount` |
| 底部异常位（**本片新增，仅触及时**） | 候选上限 `K` 熔断提示 + 「上面的数可能不完整」 | `K` 的触及数 |

🚨 **`D` 不下发** —— 它恒等于 `legs.length`，下发第二份必 drift。**同理「其余」也不下发**，由 `matchedCount − legs.length` 现算。

🚨 **`memberCount` 的算法（clarify 2026-08-13 定，`FR-009`）**：对**同一批已取回的链行**用 `override = null` 再跑一次 `recallCandidates`。**零额外 DB 往返** —— `leg-retrieval.adapter.ts` 的 DB 层只下结构性谓词（`optionType: 'PUT'` + 快照日 + contract ids，`:51`/`:75`），六维判据是取回后的纯函数（`:138`）⇒ 第二次判定是纯 CPU。

🚨 **落法（2026-08-14 owner 裁定，订正本节起草时的建议）**：由 **adapter 用同一批已在内存的 `legs` 再跑一次 `recallCandidates(override = null)`**，并在 `LegRetrievalResult` 上加 `memberCount` **一个出参字段**。

> ⚠️ 起草时这里写的是「**同一次遍历内评两套判据**，而非把 `recallCandidates` 整体跑两遍」。**该建议已作废** —— 它落在 `leg-recall.rules.ts` 内，与 `FR-044` / T005 的「该文件零行 diff」判据直接冲突。而 use case 侧根本拿不到原始链行（`recallCandidates` 只 push `tabs.length > 0` 的候选，`:666`）⇒ 收窄生效后被挡下的行在 use case 里结构上取不回来。三条约束（零额外往返 / 不用边际加总 / recall 文件零改动）交集为空，裁定松 `FR-003` 的**出参**面（入参 `perspectives` 一字不动，Guardrail 9 的理由面不受影响）。代价 = 多一趟 `O(n ≤ K)` 纯 CPU 遍历并丢弃重算的三个计数，**换零判据改动**。

🚫 **MUST NOT 用 `052` 的六维边际计数加总充当它** —— 边际口径下被两维同时挡下的腿两维都不计它，加总**少报**（Guardrail 12）。

---

## D-ORDER-1 · 截断在精排之后（`FR-004` / `FR-010` / `FR-040`）

**服务端顺序恒为五层加一步截断，不可换序**：

```text
召回（含用户条件覆盖 + 候选上限 K）
  → 粗排（no-op）
  → 特征加工
  → 精排
  → 表达层截断 N          ← 本片新增的唯一一步
```

🚨 **本片 MUST NOT 引入独立的「筛选」段** —— 六维条件已由 `052` 并入召回层（`recallTabs` / `intentTabsByTerm` / `intentTabsExcludedByLiquidity` 三入口退役，判据并进 `failedCriteria`），排名基准就是**当前条件下的召回集**。任何「排名后再筛一次」的实现都是第二条成员判据路径，直接违反 `052` `FR-003` 的机器判据（守门脚本不变量 #7）。

⚠️ **主 plan §3 不变量 #4 的前半句已被 `052` 推翻**（见 spec § 处理顺序）—— 本片按「截断在排序之后」执行，**MUST NOT** 按该不变量字面去恢复一个筛选段。

⇒ **可验证形态**：截断掉的必是**排序序列的尾部**，断言「截断前后前 `D` 条逐条相同」而非只断言条数。

---

## D-SQL-1 · 排序 / 截断**不下沉 SQL**（`FR-035`）

主 plan §2.2 曾把「费率下沉 SQL」移交本片，理由是「截断要求 `ORDER BY … LIMIT` 落在数据层」。**该理由不成立，本片不做。**

**理由一**：那句话把「服务端截断」与「数据库截断」当成了同一件事，它们不是。`FR-010` 要的是「服务端在精排之后截断」——server 在内存里截完全满足它，而**客户端 payload 的收益（只收 ≤ `D` 行）已经全额拿到**。DB → server 那一跳的传输量确实不变，但那是同机一跳，且实测 `p50 45.5ms / p95 54.1ms` @730 行（`050` T017）**已经把它算在内了**。

**理由二（`052` 之后新增，且是机器强制的）**：`052` 立的 `LegRetrievalPort` 有守门判据 —— 接口内 `rg` 扫 `Prisma` / `sql` / `cursor` / `offset` / `limit` 必须**零命中**（`check-optionsdesk-rule-constants.ts` 不变量 #5，带两侧探针）。把 `ORDER BY … LIMIT` 下沉意味着排序键与截断参数要进 port 入参，**当场撞守门**。

代价一条不少：

| 代价 | 说明 |
| --- | --- |
| **第二份判据实现** | 六维条件 + 费率公式要在 SQL 里再写一遍。drift 时**不会红** —— 两边各自都算得出数，只是不是同一个数 |
| **等价 IT** | 「SQL 结果 == 纯函数结果」要可自动验证。这是一条昂贵且脆的测试 |
| **破坏不变量 #8** | 「排序器只读 `RankingFeatures`，不许直接读原始腿」—— SQL 读的是原始列，不是特征 |
| **打标需要全量成员的统计量** | 活跃标基准是同到期日分组（`052` T009）⇒ SQL 里还要 window function 复现，或退回内存（那下沉就只做了一半） |

⇒ **不下沉后 `FR-035` 更强**：判据只有一份实现，等价性无从谈起（没有第二份可比）。IT 只需断言「排序与截断作用在同一个已排序序列上」。

---

## D-LIMIT-1 · 截断阈值：按视角分档、可注入、**走实测标定**（`FR-011`–`FR-015`）

常量落 `leg-rank.rules.ts`（与精排同文件 —— 截断是精排结果的直接消费者，分两处会让「排序键改了但阈值没跟」这类 drift 不可见）：

```text
DISPLAY_LIMIT_BY_PERSPECTIVE = { all: <标定>, build: <标定>, rent: <标定> }
```

判据 = **严格大于阈值才截**（`matchedCount > limit`）。

🚨 **三个值 MUST 由标定 task 产出，起手值 MUST 带 `⏳` 占位标记** —— 沿 `052` T016 的做法（该片用 `⏳` + 「标定在 052 T016」+「MUST NOT 当已标定值引用」三个标记，收尾扫零命中）。🚫 **若分布无断点，MUST 记为「不设该视角的阈值」而非拍数** —— 同 `052` T016 对单笔权利金下限的裁定。

🚨 **阈值 MUST 可注入**（use case 签名带可选参数，默认取常量）—— 这是 `FR-014` / `SC-006` 的落地手段：

- 意图视角的候选规模远小于全腿视角，**截断分支很可能在真实数据上结构性永不触发**。
- 注入小阈值（如 `3`）后，**同一批真实数据**就能走遍截断的每一条分支。
- 🚫 **MUST NOT 改用合成 fixture 造几百条腿** —— 合成数据没有 vendor 真实的 bid/ask 分布，测出来的是「我造的数据能不能被截」，不是「真实链上截断对不对」。

📌 **全腿视角的阈值有一条硬下界**（`FR-014`）：它必须高到让 `051` 那个「点流动性排除数 → 切到全腿视角看被排除的腿」的入口仍然可达。`SC-012` 是这条的回归防线。⇒ 标定该视角时，**「被意图视角排除的腿在排序序列里的最深位置」是阈值的下界输入**，不能只看分布断点。

📌 **`K` 与 `N` 的对照在本片才真正成立**：`052` T005 因为当时没有 `N`，只能用量级断言（`RECALL_CANDIDATE_CAP > 758`）占位并在常量 JSDoc 里写「共用会让『调给用户看几条』顺手改掉召回容量」。本片引入 `N` 后 MUST 加真正的对照断言：二者是两个独立常量、`rg` 扫不出共用。

---

## D-CONSIST-1 · 一致性：检测 + 重取，零新增契约字段（`FR-020`–`FR-023`）

**检测面在客户端**，因为只有客户端同时握着三份响应。

- 三份 query 全部 settled 且 `asOf` 不全相同 → 触发一次全部重取，**并置 latch**。
- latch 已置且重取后仍不一致 → 停止重取，渲染显式提示 + 手动刷新入口。
- 🚫 **MUST NOT 无限重取** —— latch 必须是「本轮已重取过」的布尔闩，不是计数器自增（计数器写错方向就是死循环）。
- 🚫 **MUST NOT 新增版本戳字段** —— `asOf` 已在契约里，且配了 `asOfFreshnessTier`。

**水位那条是另一条链路**（`FR-021`）：`useSetPositionBucket` 的 `onSuccess` 已经 `invalidateQueries`，但 query key 现在含 `perspective` ⇒ **必须失效三个视角**。用不含 `perspective` 的前缀 key 失效即可。

🚨 **这条极容易漏**：`052` 起 query key 已由 orval 生成且含全部 params，本片再加 `perspective` 后，原来那句失效会变成只失效某一个视角（或一个都不匹配），而**屏幕上什么都不会红** —— 水位 chip 亮了、意图变了，另外两个视角还是旧口径。`FR-021` 的断言必须覆盖「用户停在建仓视角时改水位」这条路径（`SC-013`）。

---

## D-ASYNC-1 · 错峰预热与失败隔离（`FR-008` / `FR-022` / `FR-025`–`FR-027`）

**React Query 三个 query，各自独立 key**（key 由 orval 生成，含 `perspective` 与六维条件）。

- **错峰**（`FR-025`）：当前视角的 query 无条件 enabled；其余两个 `enabled: currentQuery.isSuccess`（当前视角落地后才开）。这就是「首屏只取当前视角，落地后后台补其余两个」，**不需要手写 prefetch 编排**。
- **失败隔离**（`FR-022`）：三个 query 天然独立 ⇒ 一个 error 不影响另外两个的 `data`。呈现侧**按当前视角自己的 query 状态**决定渲染，MUST NOT 用「任一失败即整块降级」。
- **迟到响应不覆盖**（`FR-008`）：query key 含 `perspective` 与条件值 ⇒ 切视角 / 改条件就是**换 key**，旧 key 的响应写不进新 key。这是 React Query 的天然性质，**不需要手写 abort**。
- **后台预取不干扰前台**（`FR-026` / `FR-027`）：其余两个视角的 `isError` **MUST NOT** 渲染进当前视角；Tab 行 **MUST NOT** 加错误 / 加载角标。

🚨 **`placeholderData: keepPreviousData` MUST 保留**（`052` T012/T013 实证）：换 key 那一拍若 `data` 变 `undefined` ⇒ `intent` 变 `null` ⇒ 视角退回全腿 ⇒ 参数跟着换 ⇒ 无限来回，而这一圈全是**同步 setState、跑赢了网络**，任何响应落地之前就撞上 React 更新深度上限（error #185），**整块屏被 error boundary 接住**。摘掉它 `052` 的 e2e 当场 6 条红。本片把请求拆成三份后换 key 更频繁，这条只会更关键。

> ⚠️ **2026-08-14 实测更新（`053` T010 反例探针）：上一段描述的失败模式已被本片结构性修掉，本条仍成立但守的东西变了。**
>
> T007 为「视角 ← `intent` ← 响应」这个环加了 **`chainSource` 回退链**（当前视角未落地时回退任一已到手视角）⇒ `intent` 不再变 `null`，**自激环断了**。同一个探针在本片的实测结果：
>
> | | `052` T013 | `053` T010 |
> | --- | --- | --- |
> | 摘掉后红的条数 | 6 条 | **2 条**（189 passed） |
> | 症状 | React #185 **死循环**，整屏被 error boundary 接住，**不自行收敛** | 「换条件那一拍表闪空」 |
>
> ⇒ 它现在守的是**呈现连续性**（`FR-026`），不再是「防死循环」；严重性从「整屏挂掉」降到「闪一下」。**下一片评估这条时按新口径**，别照上一段的旧严重性定优先级。

📌 **每视角自持条件状态**（`FR-007`）：`052` T012 已 ship `Record<视角, 已提交条件>`，本片零改动 —— 它天然落进 query key ⇒ 各视角各自缓存。

---

## D-UI-1 · 截断计数（`FR-016`–`FR-018`）

- 落 `051` 已定的 `renderSectionFooter`（**非常驻区**，MUST NOT 进 sticky 栈），追加为第 3 条。
- 文案 **`已显示前 D 条 · 其余 N−D 条未显示`**。🚫 **MUST NOT 复述 `matchedCount`** —— 它已由 sticky 区块头承担。
- 附一句指向**抽屉内检索条件**的收窄指引（`FR-017`）—— 分页与「加载更多」都不存在。
- 未触发截断 ⇒ **整条不渲染**（`FR-018`），MUST NOT 显示空值或恒等的两个数。
- 视觉：与「权利金移出」同款（`--nvy-text-muted` 纯文字、**无雪佛龙**，它没有入口）。🚨 **MUST NOT 用 warning / danger 色** —— 截断是正常的呈现约定不是异常。

📌 **空态本片零新增** —— `052` T012 已交付三支空态（门槛致空 / 期限段确实没有 / 条件收紧到候选为空，第三支判据取服务端三态回执、入口是复位）。截断不产生第四种空态：截断只在 `matchedCount > limit` 时发生，此时列表必非空。

---

## D-COL-1 · 列改版（`FR-030`–`FR-033`）

**mockup 已定稿**（2026-08-13）：`design/053-leg-columns.dc.html` 3 帧 + `design/handoff.md`。渲染验证六项探测全绿，几何逐值实测。**本节只写 HOW，列集与判据的 SoT 在 spec `FR-030`–`FR-034`。**

`LEG_TABLE_COLUMNS` 改为（合计仍 **716**，首列仍 **88**）：

```text
strike 88 · bid 88 · rate 56 · premium 50(新) · oi 50 · spread 48(新)
· cost 56 · delta 42 · vol 46 · activity 42 · mark 84 · action 66     = 716
```

- 🚫 **`bid`/`ask` 不拆**（`FR-031` 已订正）—— 它已是单元格内 2 行 × 2 列，88px 是最宽真实内容逼出来的。拆开只会更宽。
- 🚫 **删 `sigma` 与 `turnover`**（`FR-034`）—— `46 + 52 = 98` 恰好填平新增两列。删 `sigma` 零信息损失（与 `delta` 由 `Φ` 构造性一一对应）。
  📌 连带：`leg-row.rules.ts` 文件头那条「Δ 与 σ距 MUST 同时有值或同时留占位」的不变量**随 `sigma` 列退场而失去对象**，注释 MUST 同步删除或改写 —— 留着会让下一个人以为还有第二列要维护。
- **单笔权利金服务端算**（`FR-032`）：新增契约字段。客户端乘一次 = 判据双写。
- 🚨 **列宽合计 MUST 不变**：`049` 的横滑范式把内容总宽当作位移钳制的输入，总宽一变，指示条长度比与 `maxTx` 全跟着变，而**真机上表现为「右侧滑不到底」且不会红**。
- ⚠️ **列宽是 mockup 估算不是实测标定**：`premium 50` / `spread 48` 按「5 字符 × 约 6.6px 等宽 + 内边距」推得，impl 期 MUST 用真机最宽真实内容复核（同 `bid` 列当年 `68 → 88` 的来路）。
- 🚨 **表头字号会倒逼列宽**：mockup 实测表头 11px 时 `成本vsW` 在 56px 内**折行**，10px 才不折。⇒ 实装若沿用别的字号，`cost` 列宽 MUST 重算（`SC-019`）。
- → verify: `LEG_TABLE_COLUMNS` 宽度合计断言 = 716 且首列 = 88（Small，`SC-018`）+ 表头零折行（`SC-019`）+ 真机横滑到最右端末列完整露出。

---

## D-TEST · 验证分层

### D-TEST-0 · Server IT（`optionsdesk-053.query.it.spec.ts`，Testcontainers 真 PG）

覆盖：`perspective` 三值各自成员集与顺序 · 响应收窄后的形状（by-tab 零残留）· 截断阈值分档 · **边界「恰等阈值不截」** · **截断掉的是排序尾部**（断言前 `D` 条逐条相同，不只断条数）· `matchedCount` 取值 · **注入小阈值走遍截断分支**（`SC-006`）· **被意图视角排除的腿在全腿视角可达**（`SC-012`，`051` 的回归防线）· 缺 `perspective` → 400。

### D-TEST-1 · vitest Small

`leg-rank.rules.spec.ts` 追加：阈值分档常量 · 截断纯函数的边界（`<` / `=` / `>`）· `K` 与 `N` 不共用常量的对照断言。
`leg-table-columns` 的宽度合计断言（`D-COL-1`）。

### D-TEST-2 · Mobile hermetic e2e（Playwright Web）

截断计数出现与消失 · **单视角失败隔离**（`SC-009`）· 一致性提示与重取 latch · **错峰时序**（当前视角未落地时另两个不发请求）· 切视角保留各自条件。
🚨 hermetic mock 是**契约镜像不是调用序**：handler 按 `perspective` + 六维参数**无条件作答**，**禁**按测试编排标志分支（`052` T013 的同一条纪律）。

### D-TEST-3 · Contract smoke（`[Contract-Smoke]`，跨端片义务）

生成的 `@nvy/api-client` 打 testcontainers 真 server，验：`perspective` 必填与三值往返 · 新字段解封 · **删掉的 `tabOrder` / 各 by-tab 结构确实不再出现** · 单笔权利金字段的运行时类型。

### D-TEST-4 · 真机验收（web 验不到的三类）

列改版后 sticky 栈占屏比 ≤ 35% 与横滑到最右端末列完整露出（`SC-003`，基线 `051` 实测 138.5dp / 27.9%）· 视角切换与预热的**手感** · **`052` 遗留三项**（抽屉是否真盖住底部 Tab 栏 / 输入法弹起后「搜」在不在屏内 / ⓘ 热区 44×44 —— clarify 2026-08-13 定「本片一并补验」，`FR-036` / `SC-017`）。

🚨 **三项里 ① 若为否是功能缺陷不是版式问题** —— 抽屉盖不住 Tab 栏意味着 `052` 那个「MUST 走 RN `Modal` 渲到 root 层」的落法没生效（memory `reference_drawer_overlay_bounded_by_tab_content_use_modal`）。撞到即停下修，MUST NOT 记为「已知问题」往下走。

---

## 🚨 Impl Guardrails（每条都是盲写会踩、且踩了不会红）

1. **恢复一个「筛选」段** —— `052` 已把六维并入召回层；再写一条「排名后筛一次」就是第二份成员判据，撞守门脚本不变量 #7（`D-ORDER-1`）。
2. **水位失效只失效一个视角** —— query key 加了 `perspective` 之后原来那句失效不再覆盖三份（`D-CONSIST-1`）。
3. **摘掉 `placeholderData: keepPreviousData`** —— 换 key 那一拍表**闪空**，呈现连续性断掉（`FR-026`）。⚠️ **2026-08-14 实测更新**：起草时这条写的是「同步 setState 打成死循环、整屏被 error boundary 接住、不会自行收敛」——那是 `052` 的实况；T007 的 `chainSource` 回退链已把该自激环**结构性堵死**，`053` T010 的同一探针只红 2 条且无死循环（`052` 当时 6 条 + React #185）。**本条仍成立，但严重性从「整屏挂掉」降到「闪一下」**，推导见 `D-ASYNC-1`。
4. **无限重取** —— 一致性 latch 写成计数器且方向写反即死循环（`D-CONSIST-1`）。
5. **Tab 行加错误 / 加载角标** —— 与 `FR-027` 定的「后台预取失败对前台零感知」相反（`D-ASYNC-1`）。
6. **截断计数用告警色** —— 截断是正常呈现约定，告警色会让人以为数据坏了（`D-UI-1`）。
7. **截断分支用合成 fixture 验** —— 测的是「slice 能不能跑」，不是「真实链上截断对不对」（`D-LIMIT-1`）。
8. **只断言截断后的条数** —— 条数对不代表截对了；必须断言**截掉的是排序尾部**（`D-ORDER-1`）。
9. **改 port 签名** —— `052` 已把 `perspectives` 立好，改签名等于把「留好的接口」白留（`D-API-1`）。⚠️ **本条自 2026-08-14 起限于入参**：出参 `LegRetrievalResult` 加 `memberCount` 一个字段是 `FR-009` 的唯一可行落点（裁定与推导见 spec `FR-003`）。**入参 `perspectives` 仍一字不动。**
10. **列改版顺手调列宽** —— 内容总宽一变，真机右侧滑不到底且不会红（`D-COL-1`）。
11. **把 `D`（实际显示条数）或「其余 N−D」下发** —— 两者都可现算，下发第二份必 drift（`D-API-1`）。
12. **拿 `052` 的六维边际计数加总充当 `memberCount`** —— 边际口径下被两维同时挡下的腿**两维都不计它**（`052` T010 有断言守）⇒ 加总**少报**，而数字照样出得来（`D-API-1`）。
13. **为 `memberCount` 多查一次库** —— DB 层只下结构性谓词，六维判据在取回后的纯函数里；第二次判定用同一批行即可（`FR-009`）。
14. **把 `K` 的触及做成第四条常规计数** —— 它是保险丝熔断不是判据挡下，与截断计数同款呈现会让「该调容量」被读成「该调展示」（`FR-019c`）。

## Task 分解（**草图；编号与顺序以 `tasks.md` 为准**）

| # | 层 | 内容 |
| --- | --- | --- |
| 1 | `[Server]` | `perspective` 升为「决定返回哪个视角」+ controller 400 校验；`get-legs.usecase.ts` 三处调用点收敛为单视角 |
| 2 | `[Server]` | 截断纯函数 + 分档常量（带 `⏳` 占位）+ 可注入阈值 + `matchedCount` + `memberCount`（同一遍历内评两套判据）+ `K` 触及数上浮到契约 |
| 3 | `[Server]` | 响应按「链级 / 视角级」收窄 + DTO / swagger（删 by-tab 七处、加三字段） |
| 4 | `[Server]` | **单笔权利金**服务端计算并下发（`FR-032`） |
| 5 | `[Server]` | IT：state branch 中落服务端那批全覆盖（含注入小阈值走截断分支、`SC-012` 回归防线、截断尾部断言） |
| 6 | `[Contract]` | `export-openapi` + `nx affected -t generate` regen + 修手写 mock 工厂编译红 |
| 7 | `[Mobile]` | `use-leg-table.ts` 改三 query + 错峰 + 失败隔离 + 一致性 latch + 水位失效三份 |
| 8 | `[Mobile]` | 消费收窄后的契约（七处 `xxxByTab[tab]` 索引形态清零）+ 截断计数第 3 条 |
| 9 | `[Mobile]` | 列改版：列序 + 删 `sigma`/`turnover` 两列（含 `leg-row.rules.ts` 头部那条随之失去对象的不变量注释）+ 加 `premium`/`spread` 两列 + 宽度合计断言 716 |
| 10 | `[Mobile-E2E]` | hermetic e2e：截断计数 / 单视角失败 / 一致性 / 错峰时序 / 切视角保留条件 |
| 11 | `[Contract-Smoke]` | 契约冒烟扩到新参数与新字段，并验删掉的结构确实不再出现 |
| 12 | `[Gate]` | **三个视角截断阈值的实测标定** + 写回 spec；占位标记扫零命中 |
| 13 | `[Verify]` | 真机验收：列改版几何 / 切换手感 / **`052` 遗留三项**（`FR-036`）→ 写回 spec |

## Out of Scope（本片明确不做）

| 事项 | 去向 |
| --- | --- |
| 新增检索条件维度 | 不做 —— 六维已由 `052` ship |
| 检索条件持久化 | 不做 —— `052` 已定 |
| 分页 / 加载更多 / 被截断腿的下钻 | 不做（`FR-019`） |
| 排序 / 截断下沉 SQL | 不做（`D-SQL-1`） |
| 召回 / 打标 / 精排判据本身 | 不动（`050` + `052` 已定） |
| 加权评分 · 排名特征集下发 | 不做 / 永不做 |
| 045 锚派生与意图矩阵 | 不动 |
| 046 三块版式 · 12 列**列宽**与首列冻结判据 | 不动（列序与两个新列本片要改，见 `D-COL-1`） |
| 横滑范式与位移语义（`049`） | 不动 |
| 跨标的聚合视图（`048`） | 冻结，六片落完连同其 spec 一并重写 |
| 标的链分析报表 | 归 P5（`055`） |
| 锚卡「仓位水位 · 未知 · 待接入」与选约区 chip 同屏同名不同值 | 不动，留待持仓接入片 |

## Complexity Tracking

> 无 Constitution 违反，本表为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| N/A | N/A | N/A |
