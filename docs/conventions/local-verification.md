# 本地验证：命令、前置、会骗你的失败

> **本文是本地跑 lint / typecheck / test / e2e / smoke / export-openapi 的单一来源。**
> 存在理由不是「记不住命令」，而是：**这些命令失败时红得像代码问题，其实是环境或工具链问题。**

机器强制在 `scripts/pretooluse-local-verify-guard.sh`（`PreToolUse(Bash)` hook）——「跑了必红 / 必骗人」档会被直接拦下并给出替代写法，「不够严谨」档只写在本文不拦。文档与 hook 的判据必须同步改。

## 0. 编写纪律：每条声明必须标注证据等级

> 🚨 **这一节是本文最重要的一节。** 2026-08-02 复盘发现：本文原有 4 条「必须给」的断言里，**1 条被证伪、1 条不可复现** —— 两条当初都是「看起来很有道理 + 来自 memory / 他人报告」就写进来的，然后被抄进 hook 变成硬拦截，开始保护错误的东西。

| 标记                      | 含义                                                   | 准入门槛                        |
| ------------------------- | ------------------------------------------------------ | ------------------------------- |
| 🟢 **实证**               | 有可复跑的**对照**实验：给了 X 与不给 X 两组，结果不同 | 正文里必须能找到复跑命令        |
| 🟡 **未验证-来自 memory** | 来自跨 session 记忆，本轮未实测                        | 允许写进文档，**不得**写进 hook |
| 🟠 **未验证-单次观察**    | 只见过一次，且当次**同时变了多个变量**                 | 同上，且必须写明混淆了哪些变量  |

三条配套约束：

1. **新增 hook 拦截规则前必须先有 🟢** —— 否则守卫会开始保护错误的东西（已发生过一次）。
2. **一次只变一个变量**。被证伪的那条规则，根因就是那次失败同时改了两件事（cwd 落进 `apps/server` + 没带 env），结果被算到了 env 头上。
3. **降级要留痕，不要静默删除** —— 见 §3 末尾的「已退役的说法」。

## 1. 默认前缀

```bash
pnpm exec nx <target> <project>   # 默认无前缀（2026-08-03 起，两段旧前缀均已退役）
```

| 曾经的段                       | 等级            | 退役理由（留痕防复活）                                                                                                                                                                                                                                                                                    |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`MARKETDATA_PROVIDER=mock`~~ | 🟢 实证退役     | 双层化解：① 关键 env 已烘进属主 —— vitest `test.env`（#796）/ `export-openapi` target env（#803）/ contract-smoke harness 恒钉（含 `CODE_INDEX_PROVIDER=fake`、`OSS_PUBLIC_BASE_URL=''`，#830）；② `apps/server/.env` 的 dev 默认已改 `mock`（#803）——「`.env` 就是 live 且无 FUTU 真值」的旧前提不复存在 |
| ~~`NX_DAEMON=false`~~          | 🟡 间歇性未复现 | 2026-08-03 daemon-on 全量门（含 `server:build`）多轮绿未复现；daemon 态问题无法一次性证伪 ⇒ 降级为**撞上时的 workaround**：症状 = 本地成片 spurious TS6059 而 CI 绿、单独 `tsc --build` 也绿 → 才带 `NX_DAEMON=false` 重试，别默认带、别去改 tsconfig                                                     |

`MARKETDATA_PROVIDER` 的耐久机制（显式给 `=live` 时仍成立）：`marketdata.config.ts` 蓄意不给 `FUTU_SHIM_URL` / `FUTU_SHIM_TOKEN` `.default()`，而 `.env` 的 URL 现为空串 ⇒ **显式 `live` 的 boot 必炸**（本地 live 联调这条路当前蓄意不可用，启用与否见 08-02 plan 开放问题 4）。复跑（cwd 必须是 `apps/server`，否则 `.env` 压根不加载，会先死在 `jwtSecret`）：

```bash
env -u OSS_ACCESS_KEY_ID -u OSS_ACCESS_KEY_SECRET <VAR> PORT=3099 \
  pnpm -C apps/server exec node dist/main.js
# <VAR> 为空                 → boot 成功（.env 已是 mock，#803；旧文档此臂是「失败」）
# MARKETDATA_PROVIDER=live  → boot 失败，缺 futuShimUrl / futuShimToken（🟢 2026-08-02 实测）
# MARKETDATA_PROVIDER=mock  → boot 成功，/docs-json 可达
```

**测试 / smoke 路径从不需要它**：`apps/server/vitest.config.ts` 的 `test.env` 与 `scripts/ci/server-boot-smoke.ts` 各自内部钉死 `mock`，故 `nx test server` / `nx affected … test` / `server:runtime-smoke` 即使在泄漏 `=live` 的 shell 下也恒绿。

前置：dev 栈起着（`docker compose -f docker-compose.dev.yml up -d --wait`，容器 `mbw-poc-postgres` / `mbw-poc-redis`）。

## 2. 命令矩阵

| 要验什么                                         | 命令（默认无前缀，见 §1）                                                                   | 额外前置                                                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server 单测 / IT（单文件）                       | `nx test server <file>`                                                                     | 🚨 **必须走 nx，`cwd=apps/server`；不是 `vitest --root`**（`--root` 找不到 prisma schema，🟢 实证）                                                                                                       |
| **server 单测全量（不需要 Docker）**             | `nx test server -- --project unit`                                                          | **166 文件 / 1980 用例 / ~7.4s**，零容器。🟢 实证：把 `DOCKER_HOST` 指到死端口仍全绿，同一 env 打任一 IT 则报 `Could not find a working container runtime strategy`（T-1 后成立，`check-test-size` 守着） |
| server 全量                                      | `nx test server --skip-nx-cache`                                                            | ~75s（T-1 后同机实测 74–78s）；env-gated 真 vendor IT 默认 skip                                                                                                                                           |
| mobile 纯逻辑                                    | `nx test mobile`                                                                            | vitest = **logic-only**；UI / render / a11y 一律走 e2e                                                                                                                                                    |
| mobile hermetic e2e（markets ON）                | `nx run mobile:runtime-smoke`                                                               | target 自带 `EXPO_PUBLIC_FEATURE_MARKETS=true` + `expo export`                                                                                                                                            |
| mobile 公开版 e2e（markets OFF）                 | `nx run mobile:e2e-public`                                                                  | 合规门：验行情面在公开版**不可见**。改 tab 集合 / 门控**必跑**                                                                                                                                            |
| 契约冒烟（真 server）                            | `RUN_REAL_BACKEND_SMOKE=true nx run mobile:contract-smoke`                                  | **无需任何 env 前缀** —— harness 已恒钉 mock / fake LLM / `CODE_INDEX_PROVIDER=fake` / `OSS_PUBLIC_BASE_URL=''`（#830，本地 `.env` 真值漏进来的两类假红就此绝根）；本地先**杀掉占用 :3000 的进程**        |
| OpenAPI 导出                                     | `nx run server:export-openapi`                                                              | 🚨 必走 canonical `node dist/main.js`（非 `dump.mjs`）；见下                                                                                                                                              |
| 护城河                                           | `pnpm tsx scripts/checks/check-server-moat.ts`                                              | 期望 exit 0                                                                                                                                                                                               |
| **PR 门（勾 checkbox 前必须真跑）**              | `nx affected -t lint typecheck test build runtime-smoke --base=origin/main --skip-nx-cache` | 见 [pr-creation-protocol](pr-creation-protocol.md) 第 4 条；**结果判定见 §3「exit code 会说谎」**                                                                                                         |
| **CI `gate-checks` 那一批治理脚本**              | `scripts/checks/*.ts` 全扫，见 §2.1                                                         | 🚨 上面那条 `nx affected` 门**不覆盖**它们 —— gate-checks job 另跑约 18 个 check 脚本；只跑 affected 门就推，仍可能被打红                                                                                 |
| **用「CI 那样干净」的 env 重跑任一条上面的命令** | `scripts/local-verify-as-ci.sh <上面任一命令>`（`--list` 只看泄漏清单，不跑）               | 按 `apps/server/.env.example` 的键集把**本机泄漏的 server env 全 unset** 再跑（键集派生、不硬编码）。**本地绿而 CI 红时先跑它**，判据见 §3 同名行。⚠️ 只覆盖 env 这一个维度，核数 / Docker 资源仍是本机的 |

### 2.1 推之前把 `scripts/checks/` 全扫一遍

`nx affected -t lint typecheck test build runtime-smoke` 只覆盖 lint / typecheck / test / build /
runtime-smoke 五个 target。CI 的 **`gate-checks` job 另外跑约 18 个治理脚本**（env-sync /
repo-layout / test-size / identifier-boundary / time-semantics / server-moat / scheduled-tasks /
skill-snippets / convention-orphan / …），本矩阵此前只点名了其中一个（护城河）。⇒ **affected 门
exit 0 ≠ CI 会绿。**

```bash
for f in scripts/checks/*.ts; do
  case "$f" in *.spec.ts) continue;; esac
  out=$(pnpm tsx "$f" 2>&1) && echo "✅ $(basename "$f")" || { echo "❌ $(basename "$f")"; echo "$out" | tail -12; }
done
pnpm tsx scripts/checks/check-commit-msg-parseable.ts --range origin/main..HEAD
```

⚠️ **三个脚本必带参数，裸跑报 usage —— 那不是失败**，别据此判红（上面的循环已把第一个单独列出）：

| 脚本                            | 必带参数                                           |
| ------------------------------- | -------------------------------------------------- |
| `check-commit-msg-parseable.ts` | `--file <path>` 或 `--range origin/main..HEAD`     |
| `gen-static-calendar.ts`        | `--year <YYYY> --in <txt>`（是生成器，不是 check） |
| `plan-compiler.ts`              | `<spec-dir>`                                       |

🟢 2026-08-27 实证：PR #234 本地 affected 门 exit 0、推上去被 `check-env-sync` 打红——新增
server config 项只落了出生地 `*.config.ts`，漏了 env 清单四处（规则 SoT 见
[`.claude/rules/config-env-sync.md`](../../.claude/rules/config-env-sync.md)）。

### `export-openapi` 的静默失败（最阴的一条）

target 是 `node dist/main.js & until curl -sf …/docs-json > openapi.json; do sleep 0.5; done`。**boot 失败时**：

1. `curl` 永远拿不到东西 → `until` 循环**无限空转**（不报错、不超时）；
2. `> openapi.json` 的重定向**已经先把文件截成 0 字节**；
3. 输出通常被 pipe 给 `tail` → **失败信息完全不可见**。

⇒ 现象是「命令挂住 + `openapi.json` 变空」，没有任何一行写着「boot 失败」。任何 boot 失败都会走到这里（mock 已烘进 target env #803；如今更可能的诱因是新 config factory 的 Zod 必填项）。

## 3. 会骗你的失败：先排除这几类再怀疑代码

| 现象                                                                     | 等级    | 真因                                                                                                                                                                                                                                                                                                                                                                | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 一片 **TS6305**，可能夹带一条**语义型** `TS2741`/`TS2554`                | 🟢 实证 | `apps/server/src/generated/prisma` 是**陈旧构建产物**。触发路径之一 = **切分支**                                                                                                                                                                                                                                                                                    | `pnpm -C apps/server exec prisma generate` 后重跑。⚠️ 那条语义错误会**一起消失** —— 别拿它去追「谁的 PR 破坏了类型」（2026-08-02：`dimension-executor.ts` 的 TS2741 看着像 #789/#792 语义冲突，实为陈旧 client）。<br>🔻 另一条触发路径「改完 schema 又撤回」危险得多，见 [`.claude/rules/migration-rules.md` §0](../../.claude/rules/migration-rules.md)（canonical，本表不复述）                                                                                                        |
| 大批 IT 红，日志里全是 **`ECONNREFUSED`**                                | 🟢 实证 | **不是缺 env。** 看目标端口：若是 `127.0.0.1:57058` 这类**临时高位端口**，那是 **Testcontainers 映射到宿主的端口** ⇒ 真因是 ~75 个 IT 文件并行、每个各起 PG + Redis，容器起不来 / 连不上                                                                                                                                                                            | 降并发或让 docker 喘口气后重跑；**与任何 env 前缀无关**。要根治见 `docs/private/plans/2026-08/` 的测试架构重构（共享容器 + template DB）                                                                                                                                                                                                                                                                                                                                                  |
| **「命令成功了」但结果不对**                                             | 🟢 实证 | **exit code 会说谎**：① 管道后的 `$?` 是**最后一段**的码 ② 后台/包装执行时 harness 报的码是**外层 wrapper** 的，不是 nx 的                                                                                                                                                                                                                                          | 判定成败**一律 grep 终态串**，不信单一 exit code：<br>`<cmd> > /tmp/v.log 2>&1; echo "EXIT=$?"`<br>`rg -n -e 'Successfully ran target' -e 'Failed tasks' /tmp/v.log`<br>🚨 **`\| tail` / `\| head` 已被 hook 硬拦** —— 它同时吞掉退出码**和**失败证据（nx 的失败摘要在尾部，但失败的 spec 文件名在中间）                                                                                                                                                                                  |
| **本地怎么跑都绿、只有 CI 红**（尤其某个 IT 文件整体 skipped、耗时极短） | 🟢 实证 | **你的 shell 泄漏了 CI 没有的 server env**，把某个 boot-required config 的缺失**盖住了**。2026-08-17 实撞：一个 IT 漏了 `REDIS_URL`，而 `redis.config.ts` 的 `url` 是必填 —— stub 掉 `REDIS_CLIENT` **并不能**阻止 `redisConfig` 被实例化 ⇒ DI 期 ZodError ⇒ 该文件全部用例 skipped、秒炸。本地四轮全绿 / CI 四轮全红                                               | `scripts/local-verify-as-ci.sh <你的命令>` 复跑（见 §2）。<br>🚨 **与下方退役表里「必须显式给 dev `DATABASE_URL` / `REDIS_URL`」方向相反，别混**：那条说「补值才跑得通」（已证伪）；这条说「**有值会掩盖缺失**」。⇒ 修法**不是**补 dev 值，是把占位放进 `apps/server/vitest.config.ts` 的 `test.env`，让测试**不依赖任何环境**（该文件也是 `config-env-sync` 位置 #4 的 boot-required 登记处）                                                                                            |
| 全量并行时某条 IT 红，且耗时异常长                                       | 🟢 实证 | **负载敏感 flake**                                                                                                                                                                                                                                                                                                                                                  | **单跑该 spec 复验**再下结论。2026-08-02：`anonymize.us7.it.spec.ts` 全量下 36.9s 红、单跑 3.7s 绿 4/4；同日 `server:test` 在与 mobile 三个重任务并发时红、单独重跑 360 文件 / 3194 用例全过                                                                                                                                                                                                                                                                                              |
| **变异/对照实验「红了」，但红的不是断言**                                | 🟢 实证 | **测试文件选择传错，整轮压根没跑。** 两种形态：① 多文件传参 `nx test server a.spec.ts b.spec.ts` —— nx 把它们**拼成单个 filter 字符串**，vitest 报 `No test files found, exiting with code 1`；② `--testFile=` 不是 vitest 的 flag，报 `CACError: Unknown option \`--testFile\``。两者都 **exit 1**，在「我刚做了个变异、预期它红」的语境下极易被读成「断言生效了」 | **别只看 exit code，去 grep `Tests +[0-9]` 那一行确认真的跑了用例**；见到 `No test files found` / `Unknown option` 即判工具链假红，重跑。<br>正确写法：单文件 `nx test server src/<dir>/x.spec.ts`（路径相对 `apps/server`），多文件用**目录 filter** `nx test server src/<dir>/` 或逐文件跑。<br>🚨 这条比一般假红更毒 —— 别的假红让你以为**代码坏了**，这条让你以为**断言好使**，于是带着一个从未验证过的测试往下走（🟢 2026-08-25 实撞：一轮「双向变异都红」实为四个 spec 一个都没跑） |

### 已退役的说法（留痕，别从记忆里复活）

| 曾经的断言                                                 | 判决                        | 证据                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「server 测试必须显式给 dev `DATABASE_URL` / `REDIS_URL`」 | 🔴 **证伪**                 | 三组对照全绿，含把 datastore 指向死端口跑当初红掉的 7 个 accounts IT：50/50 通过。测试路径压根不读这两个值（IT 自起 Testcontainers 并在 `beforeAll` 里自设 env）。当初归因错在**一次改了两个变量**（cwd + env）                           |
| 「跑前必 `env -u OSS_*` 四件套」                           | 🟡 **当前仓状态下不可复现** | 泄漏假 OSS creds 且**不** unset → boot 成功、零 ZodError，因为 `.env` 提供了 `OSS_PUBLIC_BASE_URL`，而该失败要求它缺失。⇒ 降级为提示：**若你的环境没有 `.env`**（CI / 新 clone / worktree），OSS 闸是全有或全无，半 unset 比不 unset 更糟 |

## 4. 跑之前先想清楚的三件事

1. **新建的 `.ts` / `.spec.ts` / config 首跑必带 `--skip-nx-cache`** —— nx cache 对新文件会**假绿**。
   🚨 **拿 env 变量做对照实验时同样必带**（🟢 2026-08-02 T-1 实证）：nx 只把 `inputs` 里声明过的 env 计入 hash，`DOCKER_HOST=...` 这类临时前缀**不进 hash** ⇒ 第二臂直接命中缓存回放，**Duration 与第一臂一字不差**、结论完全反过来。识别信号就是「两臂耗时逐项相同」。
   🚨 **测试在运行时读 project 之外的资产时同样必带**（🟢 2026-08-04 实证）：缓存 key 只看该 project 的 `inputs`，测试用 `readFileSync` 从仓内**别的目录**读进来的文件不在 hash 里（实例：`ops/jobs/marketdata-table-health.sql` ← `marketdata.table-health.it.spec.ts`）⇒ **只改那个文件时命中缓存直接返绿**。对照：把谓词判据从 AND 蓄意改成 OR，不带 flag **整轮全绿**；带 flag 当场翻红，且只有对应那条用例红。识别信号 = 日志里 `Nx read the output from the cache`。<br>⇒ 判断要不要带 flag，**不看「我改了哪些文件」，看「这个测试运行时会去读 project 外的东西吗」**。
2. **blast radius 大就跑全套，别跑单 spec**。判据 = 改动是否触及被多处消费的**共享面**（`~/ui` 原语、抽屉/题头容器、layout、design token）。触及 ⇒ `runtime-smoke` **全套**；只改一个屏的内部 ⇒ 单 spec 够。
3. **cwd 必须是 mono root**。用 `pnpm -C <dir>` / `git -C <dir>` / `--cwd`，**不要 `cd`** —— `cd` 的副作用会跨命令持续，后面的 `nx affected` 会在错的目录下解析出错的 affected 图（🟢 2026-08-02 实证）。详见 `bash-cwd-discipline` skill。

## 5. 相关

- 部署 / prod 侧的环境与回滚：[`ops/runbook/prod-deploy-rollback.md`](../../ops/runbook/prod-deploy-rollback.md)
- 本地全栈拉起（含真机 dev-client）：`run-local-env` skill + [`ops/runbook/local-dev.md`](../../ops/runbook/local-dev.md)
- PR 门 checkbox 的勾选条件：[`pr-creation-protocol.md`](pr-creation-protocol.md)
- 每 task 闭环里的测试步骤：[`.claude/rules/implement-task-closure.md`](../../.claude/rules/implement-task-closure.md)
