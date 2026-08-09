# 批7（P4.4）`pool: threads` post-批6 重测 —— forks vs threads 全量 A/B

> 08-02 plan 把 P4.4 挂在「批6 之后重测再定案」：threads 的收益集中在 `import` CPU，
> 而批6 刚从源头砍掉一部分 import。**重测前的判断是「收益重叠、大概率缩水」——实测相反。**

## 结论速览（同机全量 `nx test server --skip-nx-cache`，unit + it，交替 3 轮）

| 量              | forks（现状，vitest 默认）             | **threads**                                | Δ          |
| --------------- | -------------------------------------- | ------------------------------------------ | ---------- |
| wall            | 72.56 / 70.83 / 69.69s（均 71.03）     | **56.59 / 56.26 / 54.51s（均 55.79）**     | **−21.5%** |
| `import` CPU    | 280.52 / 273.29 / 263.54s（均 272.45） | **213.79 / 205.45 / 196.69s（均 205.31）** | **−24.6%** |
| `tests` CPU     | 300.12 / 294.86 / 294.50s（均 296.49） | 236.52 / 244.29 / 234.67s（均 238.49）     | −19.6%     |
| `transform` CPU | 23.88 / 23.93 / 22.91s（均 23.57）     | 17.16 / 15.12 / 13.98s（均 15.42）         | −34.6%     |
| 用例            | 363 passed \| 10 skipped / 3209 \| 68  | **6 轮逐字一致**                           | 零行为变更 |

口径与[批6 记录](08-03-appmodule-import-narrowing.md)严格一致（同机、同命令、全量含 unit）。交替
`forks → threads` ×3 抵消机器单调漂移；起跑 `loadavg 3.93`（非空载，已知并接受——两臂同等承受）。

> ⚠️ **基线较批6 记录少 2 个用例**（`3209|68` vs 那份的 `3211|68`）：main 上后续合入 #839/#840
> （测试 convention 合规修正）所致，**非** threads 造成 —— 两臂 6 轮全部 `3209|68`，A/B 可比性不受影响。

## 为什么收益不缩水反而变大（机制假设，非实证）

批6 把每文件的 import 图变小之后，**每 worker 的固定启动开销**（fork 出新进程 + Node runtime +
vite module runner 初始化）在总量里的**占比反而上升**，而这正是 threads 复用掉的那部分。
⇒ 收窄 import 图与换 pool **不抢同一块收益，是互补的**。`transform` CPU 降 34.6% 是同一机制的旁证
（同进程内 transform 结果跨文件复用）。

**先前的 −8.4% 是怎么来的**：那次测在 T-1/批6 之前、且只跑 `it` project（158 文件），
基数与构成都不同 ⇒ **旧数已作废，勿再引用**。

## 前置判别实验（否则整批数据无意义）

`--pool` 会不会被 nx 静默吞掉？—— `nx test server -- --project unit --pool=bogus`：
日志出现 `vitest run --reporter=default --project unit --pool=bogus` 且 **真炸**（167 unhandled errors，
exit 1）⇒ flag 确实透传并生效，两臂跑的不是同一个东西。

> 纪律来源：plan §「验证管道自己会骗你」。本轮先问「如果两臂其实一样，我的管道能看见吗」，
> 再开跑 —— 成本 10 秒，省掉一整批不可用数据。

## 第二段：稳定性 + CI 并发档（8 轮）

| 臂                                    | wall                           | `import` CPU                       | 用例              |
| ------------------------------------- | ------------------------------ | ---------------------------------- | ----------------- |
| threads r4–r7（默认并发，flake 猎捕） | 56.85 / 54.26 / 53.67 / 54.53s | 207.55 / 198.72 / 199.87 / 203.57s | 4 轮全 `3209\|68` |
| forks `--maxWorkers=4`                | 77.50 / 77.74s                 | 134.36 / 133.05s                   | 一致              |
| **threads `--maxWorkers=4`**          | **68.05 / 67.91s**             | **116.95 / 116.44s**               | 一致              |

**🚨 收益在 CI 并发档缩水：−21.5%（10 worker）→ −12.4%（4 worker）**。机制自洽：threads 省的大头是
「每个进程各付一遍启动开销」，worker 越少这块越小。**CI runner 是 4 vCPU ⇒ 该按 −12.4% 而非
−21.5% 估 CI 收益**，前者才是决策数。

> ⚠️ 4-worker 臂是**不完美的 CI 模拟**：它只压住 worker 数，压不住「总 CPU 只有 4 核」——本机
> 仍有 10 核在给 docker / PG 让路。真数只能靠 CI dispatch 拿（协议同批6：分支 dispatch nightly-perf）。

顺带一个与 pool 无关的发现：**worker 数本身就是一个杠杆** —— 10 → 4 worker 时 `import` CPU
从 272s 掉到 134s（少了一半重复的模块图求值），而 wall 只从 71.0s 涨到 77.6s。
「多开 worker」在本仓是**用大量重复 import 换少量 wall**，这条值得单独评估（不属批7 范围）。

## 第三段：乱序配对 —— 补上前两段管道看不见的东西

前 9 轮 threads 全绿，**但那不是 9 个独立样本**：vitest 默认 sequencer 按文件大小确定性排序，
9 轮跑的是几乎同一个执行顺序；而 threads 的风险（同线程内文件 A 的残留污染 B）是**顺序相关**的。
⇒ 反例若存在，前两段的管道**看不见**。

补做：`--sequence.shuffle.files --sequence.seed=<S>`，**同 seed 配对**跑 forks / threads ×3 组。
配对的意义 = 红了能一刀切开「threads 特有串台」与「本就存在的文件顺序依赖（共享 PG / Redis 状态）」。
只打乱**文件**顺序、不打乱文件内 test 顺序 —— 后者在两个 pool 下同等成立，混进来会污染判据。

| seed     | forks（对照）            | **threads**                  | 用例            |
| -------- | ------------------------ | ---------------------------- | --------------- |
| 20260803 | 67.26s（import 266.62s） | **56.61s（import 214.14s）** | 两臂 `3209\|68` |
| 424242   | 72.05s（import 275.52s） | **56.25s（import 208.60s）** | 一致            |
| 991      | 71.47s（import 282.66s） | **57.89s（import 211.07s）** | 一致            |

**6 轮全绿，零偏离**；乱序下收益仍在（−16~21%）。

**先验探针自身的效力**（否则 6 轮证明不了任何事 —— 参照 plan 坑清单 #1：`nx affected --projects`
被静默忽略且无任何报错）：对比各 log 的文件完成序，三个 seed 跑出**三套完全不同**的文件集合，
且都与确定性基线（按文件大小排 ⇒ 开头清一色大 `it` 文件）明显不同 ⇒ **shuffle 确实生效**。

## 安全性证据总账（threads 侧共 12 轮）

| 探针                   | 轮数 | 能看见什么                               | 结果                         |
| ---------------------- | ---- | ---------------------------------------- | ---------------------------- |
| 默认并发重复轮         | 7    | 与并发有关的概率性串台                   | 全绿，用例数逐字一致         |
| `maxWorkers=4`         | 2    | worker 少 ⇒ 每线程承载更多文件时的残留   | 全绿                         |
| **乱序配对（3 seed）** | 3    | **顺序相关**的跨文件污染（前两档看不见） | 全绿，同 seed forks 对照亦绿 |

**仍未覆盖**：真 CI（4 vCPU 弱核 + 不同 I/O 特性）；CI 侧的重复轮次。本地全绿 ≠ CI 全绿
（plan 历史上「CI 干净、本地中招」与其反面都出现过）。

## 业内锚（联网 fact-check，2026-08-03）

| 来源                                                                                             | 结论                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [vitest PR #5047](https://github.com/vitest-dev/vitest/pull/5047)（v1.0 起）                     | 上游**主动把默认 pool 从 threads 改成 forks**，原话「Main goal is to provide stability over _small performance boosts_」。动因：原生模块 segfault + `node:worker_threads` 的 Node bug 致 worker 卡死，且这类 bug「very difficult to debug」 |
| **vitest v4.1.6 官方 `config/pool.md`**                                                          | 「Some libraries written in native languages, such as `Prisma`, **`bcrypt`** and `canvas`, have problems when running in multiple threads and run into segfaults. In these cases it is advised to use `forks` pool instead.」               |
| vitest `guide/common-errors.md`                                                                  | threads 下原生模块的症状：`Segmentation fault` / `panicked at 'assertion failed` / `Abort trap: 6` / `internal error: entered unreachable code` —— 全是**报错点离真因极远**的那一类                                                         |
| [Mergify: threads pool state leakage](https://mergify.com/blog/vitest-thread-pool-state-leakage) | threads 的主失效面 = 模块级单例跨文件存活；forks 的 200–500ms/文件启动开销正是买这个隔离                                                                                                                                                    |

**本仓适用性逐条核过**（不照搬结论）：

| 上游点名     | 本仓实况                                                                                                                                          | 判定                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Prisma       | **Prisma 7.8.0 已去掉原生 Rust binary**（2025-11 起默认 TS query compiler + WASM）                                                                | ⬇️ 这条对本仓**已失效**，不作为论据 |
| **bcrypt**   | `bcrypt@6.0.0` 实装 `.node` 原生二进制；`BcryptTimingDefenseExecutor.onModuleInit` 里 `bcrypt.hash` ⇒ **31 个 auth 族 IT 每次 boot 都真跑原生码** | ✅ **实体命中**，非纸面风险         |
| 其他原生模块 | `@swc/core`（vitest transform 管道，每轮必走）、`@nx/nx-darwin-arm64` 等                                                                          | ✅ 在场                             |

> ⚠️ 12 轮绿**不与上游告警矛盾**：已核实 bcrypt 路径确被压到（不是「测了个没风险的子集」），
> 但原生模块 segfault 属**间歇性**失效，且症状是最贵的那类——参见本仓 nightly 两条连红
> 40/55 天才被根因定位（[08-03 记录](08-03-nightly-noise-root-causes.md)）。

## 定案：**不采纳，保持 `forks`**（2026-08-03，user 拍板）

| 侧         | 量                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 放弃的收益 | CI 约 −12.4%（`server:test` 316.69s → 约 277s，PR 门 6m08s → 约 5m30s，**省约 40s**）；本地全量 71 → 56s                             |
| 换回的东西 | 进程级硬隔离 —— forks 靠进程死亡天然清干净；换 threads 后「文件 A 泄漏的连接 / 改的 `process.env` 污染文件 B」从**不可能**变**可能** |

判据三条：

1. **PR 门 6m08s 已在业内 10 分钟线内**（plan §五），40s 属边际；而代价是**永久性**的 ——
   它是对**以后每一个新测试**的长期约束，而仓里**没有任何守卫**能拦「新测试泄漏状态」
   （`check-test-size` 只管容器，不管这个）。
2. **上游默认站在 forks 一边，且官方文档点名 bcrypt** —— 本仓 bcrypt 在测试热路径上。
   逆着上游默认走，需要的不是「12 轮绿」，而是长期承担一类**间歇 + 报错点离真因极远**的故障。
3. 12 轮绿只证明**当前这套测试**扛得住，不构成对未来的保证。

**这条就此关线，不再当悬案挂着。** 翻案的门槛（写死，省得下次重新评估）：
① bcrypt 被换成纯 JS 实现（如 `@node-rs/bcrypt` 之外的非原生方案）或从测试热路径移除，**且**
② PR 门重新逼近 10 分钟线让那 40s 变得重要，**且**
③ 先有能机器强制「测试不泄漏跨文件状态」的守卫。三条同时成立才重开。

## 复跑命令

```bash
pnpm exec nx test server --skip-nx-cache                        # forks（现状）
pnpm exec nx test server --skip-nx-cache -- --pool=threads      # threads
pnpm exec nx test server --skip-nx-cache -- --maxWorkers=4      # CI 并发档（runner 4 vCPU，本机 10 核）
```
