# 测试分类学与命名

> **本文是「一个测试属于哪一类、该叫什么名字、新写测试怎么选」的单一来源。**
>
> 🚨 **本文只放常驻规则**（判据 / 命名 / 决策流 / 不变量 / 举例）。**任何会随代码增长而失效的数**（文件计数、比例、耗时、某次改了几个文件）**一律不进本文** —— 它们是时点事实，归 [`docs/improvements/`](../improvements/) 存档（三类记录的分工见 [docs-organization](docs-organization.md)）。判断标准：**这句话一年后还成立吗？**
>
> 三份文档分工，互不复述：
>
> | 文档                                                       | 回答的问题                                       |
> | ---------------------------------------------------------- | ------------------------------------------------ |
> | **本文**                                                   | **这个测试是哪一类？该叫什么？新写的该怎么选**   |
> | [`test-environment-matrix.md`](test-environment-matrix.md) | 各类测试跑在哪个环境、吃什么 env、隔离到什么级别 |
> | [`local-verification.md`](local-verification.md)           | 本地怎么跑、哪些失败是环境骗你的                 |

## 0. 为什么需要这份约定

根因不是「有人写错了」，而是：

**一个坐标（目录）被先后赋予了两个正交语义。**

1. 最初立的规矩：`src/` 放**按被测对象 colocate** 的测试，`test/` 放**装配好的系统**。这条编码的是 **scope（验证多少代码）**。
2. 后来拆 vitest project 时，用同一个目录判定 **size（要什么资源 / 挂不挂共享 PG globalSetup）**。

两个轴正交，共用一个坐标 ⇒ **作者按 A 摆、工具按 B 读**，且**退化 100% 静默** —— 违反者测试照样绿，只是慢，没有任何信号会报出来。

⇒ **本约定的全部要点：两个轴，两套坐标，一个由机器强制。**

> 📌 **可迁移的通则**：任何用「位置 / 命名」编码语义的机制，**加第二个语义前先问：第一个语义是什么、两者正交吗**。正交就必须另开坐标，不要复用。（同类先例：矩阵 T-9 那个 `runtime-smoke` 一名两用，也是靠「另开坐标」化解的，不是靠改名。）

## 1. 两个轴

业界一手依据：《Software Engineering at Google》第 11 章明确把二者拆开 🟢

> We make this distinction, as opposed to the more traditional "unit" or "integration," because **the most important qualities we want from our test suite are speed and determinism, regardless of the scope of the test.**

| 轴        | 问的是               | 本仓怎么编码                             | 强制？                   |
| --------- | -------------------- | ---------------------------------------- | ------------------------ |
| **size**  | **跑起来要什么资源** | **文件名后缀**                           | ✅ **机器强制**（见 §6） |
| **scope** | **验证多少代码**     | 位置（colocate / `test/`）+ 文件头一句话 | ❌ 只文档化              |

**为什么只强制 size**：size 是事实题（起没起容器、碰没碰外网），可确定性判定；scope 是判断题（「这算一个组件还是几个」没有确定边界），机器判据必然误伤。Google 自己也只把 size 编码进基础设施。

## 2. size —— 机器强制的那个轴

判据是**默认执行路径**所需的最大资源。env-gated 默认 skip 的块**不计入**（见 §2.1）。

**三档，三个后缀，无例外**：

| size       | 后缀               | 允许什么                                                                       | 典型例子                                     | 落哪个 runner                        |
| ---------- | ------------------ | ------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------ |
| **Small**  | `*.spec.ts`        | **单进程内**。禁容器、禁真网络、禁磁盘 I/O、禁 sleep。外部依赖一律 test double | 纯逻辑单测 / `*.rules.ts` 纯函数 / mock 装配 | server `unit` project；`mobile:test` |
| **Medium** | `*.it.spec.ts`     | 可起进程、可 localhost 网络。**容器 / 本机 server / 浏览器都在这一档**         | Testcontainers PG/Redis、Playwright          | server `it` project；`mobile:e2e` 等 |
| **Large**  | `*.vendor.spec.ts` | **真外网 / 真凭证**。必须 `RUN_<VENDOR>_IT` 门控，**默认 skip**                | 真 vendor 探针（行情源 / 短信 / LLM / 搜索） | server `it` project，默认全 skip     |

两个命名选择的理由（决策记录，别回头重新讨论）：

- **`.it.` 表示 size 而非 scope**（字面是 "integration test"，一个 scope 词）—— 显式重定义。改成 `.medium.` 语义更准，但要重命名全部既有 Medium 文件外加让大量冻结 spec/plan 里的命令看似 stale，收益不抵。Fowler 的判词适用 🟢：_"What you call these tests is really not that important. **Pick a term, stick to it**"_。
- **Large 用 `.vendor.` 而非 `.e2e.`** —— `e2e` 在本仓已被 `mobile:e2e` target 与若干 workflow 占用表示 Medium × Broad；再赋一个 Large 的含义就是在复制 §0 那个病。`vendor` 零歧义且自解释。

### 2.1 混合文件：size 看默认跑什么

一个 Medium 文件里挂一个 `describe.skipIf(!RUN_XXX_IT)` 的真 vendor 块，**文件仍是 `*.it.spec.ts`**，因为默认执行路径不碰外网。只有**整个文件**都被 vendor 门控才叫 `*.vendor.spec.ts`。

🚨 **两条硬错误，守卫都拦**：① 读了真 vendor env 却**没有**门控 = CI 真的打外网 ② `*.vendor.spec.ts` 里有**未门控**的顶层 `describe` = 后缀在说谎。

### 2.2 单一档的 runner 不需要后缀

`apps/mobile/e2e/`（Playwright + contract-smoke，全 Medium）与 `apps/mobile/src/`（vitest，全 Small）**各自只有一档**，目录本身就是判据，故不要求后缀（`scripts/checks/` 的治理检查单测同理，全 Small）。

**后缀的职责是在同一个 runner 内部分档** —— server 的 vitest 同时装三档，才必须靠它。守卫替这些单一档目录守住「保持单一档」（§6 不变量 4、6、7），vendor 门控（不变量 2）也随扫描一并覆盖它们。e2e hermetic 只有 GET `/me` 边界被 `check-e2e-seed-auth-mock` 机器守（lefthook + PR 门）；`page.goto` 打真外网静态判不出，仍是 review 的事 —— 纪律 canonical 在 [`.claude/rules/mobile-e2e-hermetic.md`](../../.claude/rules/mobile-e2e-hermetic.md)。

### 2.3 为什么 Small 这条线值钱

`unit` project **蓄意没有 globalSetup**。只要它保持零外部依赖，就存在一条**不需要 Docker、不需要网络的快速内环**：

```bash
pnpm exec nx test server -- --project unit
```

**这条线一旦被一个「偷偷起容器的 `*.spec.ts`」污染就没了，且 100% 静默** —— 违反者照样绿，只是慢，没人会去看。故必须机器守，不能靠自觉。

## 3. scope —— 只文档化的那个轴

Google ch11 的定义 🟢：

| scope      | 通常叫          | 验证的是                     | 本仓放哪                                 |
| ---------- | --------------- | ---------------------------- | ---------------------------------------- |
| **Narrow** | unit test       | 一个类 / 一个函数            | 与源码 colocate（`apps/*/src/**`）       |
| **Broad**  | integration/e2e | 装配好的系统、跨组件涌现行为 | `apps/server/test/` · `apps/mobile/e2e/` |

**两轴独立，六格都合法。** ch11 原话 🟢：

> Narrow-scoped tests tend to be small, and broad-scoped tests tend to be medium or large, **but this isn't always the case.** … it's possible to write a **narrow-scoped test of a single method that must be medium sized**.

⇒ 「起容器测一个 use case」（Medium × Narrow）**是合法组合，不是错误** —— 别把它当缺陷去清。它只是应当稀少（§4 步 2）。

### 3.1 位置为什么不硬性对齐 scope

`apps/server/test/` 曾是静态检查盲区（不 typecheck 不 lint），位置因此一度服从「能不能被静态检查」。该盲区**已不存在**（typecheck + lint 均覆盖 `test/**`），但**存量判定不回改**：`test/` 下的 Narrow scope 文件、`src/` 下的 `*.it.spec.ts` 都留在原位 —— 搬动是零收益 churn。

⇒ **位置只编码 scope 惯例（Narrow colocate / Broad 进 `test/`），不是硬约束。** 两边的例外**都是已知且蓄意的**，别当缺口来补。

## 4. 新写一个测试：按这个顺序决定

1. **先问 size** —— 这个测试**默认跑**的时候，需不需要容器 / 浏览器 / 本机 server？
   - 不需要 → `*.spec.ts`，与源码 colocate。**这是默认选项**。
   - 需要 → 继续第 2 步。
2. **能不能用 test double 换掉那个依赖？** 能就换 —— Google 的配比锚是 **~80% narrow-scoped 小测试 / ~15% integration / ~5% e2e** 🟢。换不掉再往下。
3. **写成 `*.it.spec.ts`**，并在文件头写一行「为什么必须要真 X」。**PG 别自己起容器**（唯一蓄意例外：把自己容器 ID 交给外部脚本、被测通路不经 node 的那类，如 `marketdata.calendar-044.probe-independence`，见矩阵 §1），从 `apps/server/test/_support/isolated-db.ts` 头部那张表选入口（只要 PG / PG + Redis / 自跑 `migrate deploy`）—— **选错就是净退化或把被测对象抽掉**。**只要 Redis、不要 PG** → 自起 `RedisContainer`（Redis 蓄意每文件独立，理由见 `isolated-db.ts` 🚨 段；三入口都会附带克隆一个用不上的 PG 库。先例 = `src/alert/*.processor.it.spec.ts`）。
4. **要打真 vendor / 真外网？** 把该块包进 `describe.skipIf(!RUN_<VENDOR>_IT)`（默认 skip），并把那个 env 名登记进 `scripts/checks/check-env-sync.ts` 的 `ALLOWLIST`（gate flag 是测试开关、非 application config，不进 `.env.example`；登记注释写明消费它的 spec。漏登不用怕——该 check 的 `process.env` 引用扫描会直接拦红）。
   - 整个文件都是真 vendor → 文件名用 **`*.vendor.spec.ts`**
   - 只是 Medium 文件里的一个块 → 文件名**保持 `*.it.spec.ts`**（§2.1）
     ⚠️ 另见矩阵 **T-4**：这些 env **没有任何 workflow 设置**，即**恒 skip、从不自动执行**。所以「测试全绿」对这些块**不构成任何证据** —— 靠它们兜底的契约要么手工真调过，要么就是没验过。
5. **位置**：Narrow 就 colocate，Broad 才进 `test/` —— 但**永远优先能被 typecheck / lint 的位置**（§3.1）。

## 5. 存量与新增的分界

**规则只对新增生效。** 既有测试即使不符合配比锚，也**不因本约定被判为缺陷**（grandfathered）。

要收敛存量时的纪律：

1. **先 pilot 再全量** —— 挑一小批转换、量 wall/CPU 变化，用数据决定要不要全量。别直接开全量。
2. **收益归收益，规范归规范** —— 收敛存量是一次性优化动作，它的过程与数据落 [`docs/improvements/`](../improvements/)，**不回写本文**。

## 6. 机器强制的是哪几条

`scripts/checks/check-test-size.ts`（PR 门 `gate-checks` job，全扫）：

| #   | 不变量                                                                                                | 为什么必须机器守                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `apps/server/src` 下非 `.it.` / `.vendor.` 的 spec **禁 import `@testcontainers/*` 或共享 PG helper** | 违反即污染 Docker-free 内环，且 100% 静默                                                                                                  |
| 2   | 任何 spec **读真 vendor `RUN_*_IT` env（`process.env.` 里，非注释）就必须有 `skipIf` 门控**           | 没门控 = CI 真的打外网 / 用真凭证                                                                                                          |
| 3   | **`*.vendor.spec.ts` 的每个顶层 `describe` 都必须被 vendor 门控**                                     | 有一个没门控 = 后缀在说谎，Large 档失守                                                                                                    |
| 4   | `apps/mobile/src` 下的 spec **禁 Playwright import**                                                  | mobile 单测是 logic-only，UI 一律走 e2e                                                                                                    |
| 5   | **`apps/server/test/` 下只许 `*.it.spec.ts` / `*.vendor.spec.ts`**                                    | 不存在第四种 size 后缀。新造一个 = 悄悄开一个不在分类学里的档                                                                              |
| 6   | **`apps/mobile/e2e/` 下禁 `.it.` / `.vendor.` 后缀**                                                  | 该目录是单一档 Medium、目录即坐标（§2.2）；后缀一出现就是给同一坐标二次赋义 —— §0 的病，且 100% 静默                                       |
| 7   | **`scripts/checks/` 下禁 size 后缀、禁容器 / 共享 PG / Playwright import**                            | 治理检查单测跑在每次 PR 门与本地全量，变重且静默。检查器自己的 spec 因 fixture 即违规样本而豁免内容规则（`FIXTURE_SPECS`，文件名规则照管） |

> 🚨 **判据一律在剥掉注释后匹配。** 注释里提到某个 `RUN_*_IT` 往往是**正确的交叉引用**（真端点由别处的 vendor 测试校真），不是 drift；不剥注释就会把它误判成真门控。

**没被强制的一律不是规则，是建议** —— 别把建议写成看起来像规则的句子。

🚨 **描述性的观察不会自愈，生成性的规则会自我传播。** 写进描述性文字的观察可以几个月无人修复；而每个 feature 都会跑一遍的东西（守卫 / 模板 / path-triggered rule / golden sample）是生成性的，会自我复制。⇒ 本约定要真生效，靠的是 §6 的守卫 + [`test-taxonomy-trigger`](../../.claude/rules/test-taxonomy-trigger.md) 路径触发 + [golden sample 注册表](golden-sample-registry.md) 的测试样板行，**不是靠这份文档被读到**。

## 7. 规范自身怎么验（不靠通读）

本约定的每条断言都应能被实验证伪。已落地的实验（含复跑命令）见 [08-02 测试分类学落地记录](../improvements/2026-08/08-02-test-size-taxonomy.md) §3；设计原则只有一条：

🚨 **每写一条验证断言，先问「如果反例存在，这条管道能看到吗」。** 看不见就重设管道，不准下结论。

具体到本约定：

- **静态守卫看不见运行时真相** —— 它扫的是 import，抓不到动态 require / 间接网络调用。要证明 Small 真的零外部依赖，得用**运行时探针**（拦 `net.connect` / `dns.lookup` / `child_process`）跑一遍，而不是信静态扫描。
- **两臂对照才算实证** —— 「跑了绿」不构成证据；必须同时给出「反例存在时它会红」的那一臂。
- **注意工具自身的假绿** —— 如 nx 对只改 env 的对照实验会命中缓存回放（见 `local-verification.md` §4）。
- 🚨 **替身数据的「形状」包含长度 / 网络模式 / 链路位置**，不只是取值合法 —— 形状不对，测试绿是运气（**只有从对端真打才看得见**）。
- **本节适用面不止「本约定」** —— 任何**会被长期依赖的检查**（部署自检 / 模板占位自检 / 覆盖矩阵）同样适用：**恒有输出 = 恒无输出**，判据必须能区分「过」与「不过」。两类的仓内实例（2026-08-04 一天五例，全是本机全绿、真环境当场崩）见 [08-27 替身形状与恒真检查实例](../improvements/2026-08/08-27-replica-shape-and-tautological-checks.md)。

### 7.1 反例臂怎么选：先问「错误实现的最终状态会不同吗」

上一节那条「两臂对照」有个**默认前提**：反例能用**输入**构造出来。被测对象若是**事后收敛 / 回收 / 对账**类机制（崩溃后补状态、孤儿行清理、水位重算），这个前提常常不成立 —— 这类操作幂等，且错误顺序下多做的那一步会被后续正常写路径覆盖回去，两种实现**留在库里的行逐字节相同**。

⇒ 拿「最终状态」写的断言**永远不会红**，正是 §7 开头那个病换个地方犯。此时必须**换观察面**：从「最终状态」换到**操作的作用域** —— 命中了几行 / 调了几次 / 什么顺序（结构化日志、spy 计数、时间戳先后都可以是这个面）。

反例臂由此分两种形态，**默认选第一种**：

| 形态                        | 怎么做                                       | 常驻 CI     | 什么时候只能用它                           |
| --------------------------- | -------------------------------------------- | ----------- | ------------------------------------------ |
| **in-test 对照臂**          | 同文件内翻转输入，断言结论随之反转           | ✅ 自动重跑 | 默认。反例能用输入构造时一律选它           |
| **out-of-test sabotage 臂** | 临时改坏被测代码 → 跑 → 记录红 → 还原 → 跑绿 | ❌ 一次性   | 反例**无法用输入构造**（上一段那类机制）时 |

🚨 **sabotage 臂的结果必须写进被测文件的文件头**（红/绿计数 + 复跑命令 + 哪一处被改坏）。它不常驻，写不进去就等于没验过 —— 而「文件头声称验过、实际没验」比没有反例臂更坏，后人会据此放心地改断言。

> 两种形态各有一个仓内实例：`apps/server/test/integration/optionsdesk-064.overlay.it.spec.ts` 的窗口基准对照臂（翻输入）；`apps/server/test/integration/marketdata.interrupt-convergence.it.spec.ts` 的收敛 no-op 臂（改被测代码，且该文件正是「最终状态守不住顺序」的实例——它改断言到了「收敛命中几行」上）。

## 8. 参考来源与证据等级

| 断言                                                                                                                                     | 来源                                                                                                               | 等级                  |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------- |
| size vs scope 二维、Small/Medium/Large 约束、80/15/5 配比锚                                                                              | [SWE at Google ch11](https://abseil.io/resources/swe-book/html/ch11.html)                                          | 🟢 一手原文           |
| 「术语叫什么不重要，选定并贯彻才重要」                                                                                                   | [Fowler, Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)                    | 🟢 一手原文           |
| NestJS 官方结构 = 两个 runner 两个 root（`rootDir:"src"` + `testRegex:".*\.spec\.ts$"` / `rootDir:"."` + `testRegex:"\.e2e-spec\.ts$"`） | [nestjs/typescript-starter](https://github.com/nestjs/typescript-starter) 的 `package.json` + `test/jest-e2e.json` | 🟢 一手配置           |
| vitest `--project <name>` 过滤、projects 间配置不继承                                                                                    | [Vitest Test Projects](https://v3.vitest.dev/guide/projects)                                                       | 🟢 一手文档           |
| Google 内部 size 的**时限**（60s/300s/900s）                                                                                             | 仅见二手转述，未取得一手页                                                                                         | 🟠 **二手，故不采纳** |
