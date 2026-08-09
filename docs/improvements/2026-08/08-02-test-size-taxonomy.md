# 测试分类学落地：size 轴机器化 + 出网探针实证

> **这是一份「做完测到了什么」的记录**（per [docs-organization](../../conventions/docs-organization.md) 三类记录）。
> 规则本身在 [`docs/conventions/testing.md`](../../conventions/testing.md) —— 那里**不放**本文的任何数字，因为它们会随代码增长失效。
> 承接：T-1（[plan](../../plans/2026-08/08-02-env-test-architecture-refactor.md) § T-1）修的是症状，本轮修的是病因。

## 1. 做了什么

| 动作         | 内容                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 立分类学     | size（要什么资源，**机器强制**）× scope（验证多少代码，只文档化）两轴分离                                                                  |
| 后缀归位     | `*.spec.ts`=Small / `*.it.spec.ts`=Medium / `*.vendor.spec.ts`=Large，全仓零第四种                                                         |
| 改名         | 9 个 `accounts.*.e2e.spec.ts` → `.it.spec.ts`；8 个整文件 vendor 门控 → `.vendor.spec.ts`（并去掉 `-vendor.vendor` 冗余）；31 处活引用同步 |
| 守卫         | `check-unit-no-containers.ts` → `check-test-size.ts`，1 条不变量扩到 5 条                                                                  |
| 出网探针     | 新增 `apps/server/test/_support/outbound-probe.ts`（默认不挂，`NVY_OUTBOUND_PROBE=1` 开）                                                  |
| **根因修复** | `RedisLifecycle` 改惰性建连；`optionsdesk.controller.spec` 补 `REDIS_CLIENT` 覆盖                                                          |

## 2. 落地时的盘点（时点快照，会过期）

534 个测试文件（`apps/server` + `apps/mobile` + `packages` + `scripts/checks` + futu-shim pytest）：

| 格                     | 文件数 | 占比  | Google 参考锚      |
| ---------------------- | ------ | ----- | ------------------ |
| Small × Narrow         | 270    | 50.6% | ~80%               |
| Medium × Broad         | 133    | 24.9% | ~5%                |
| Medium × Narrow        | 115    | 21.5% | ~15%（与上行合计） |
| Large × Narrow / Broad | 8 / 6  | 2.6%  | —                  |
| Small × Broad          | 2      | 0.4%  | —                  |

**Medium 合计 46%，约为参考锚的 3 倍。** 本轮蓄意不减存量（grandfathered，理由见 convention §5）。要收敛时先做 10 个的 pilot 量收益。

server 侧 runner 归属：371 = `unit` 166 + `it` 205（150 `.it.` + 8 `.vendor.` + 47 从 `src` 迁入）。

## 3. 六组实验

设计原则只有一条：**每条断言都必须有「反例存在时它会红」的那一臂**。

### E1 — Small 真的零外部依赖 🟢 通过（**修根因后**）

```bash
NVY_OUTBOUND_PROBE=1 DOCKER_HOST=tcp://127.0.0.1:1 \
  pnpm exec nx test server --skip-nx-cache -- --project unit
# 然后看 apps/server/.outbound-probe.jsonl
```

| 阶段   | 结果                                                            |
| ------ | --------------------------------------------------------------- |
| 修复前 | 166 文件全绿，但探针记到 **1 条 `localhost:6380`**（dev Redis） |
| 修复后 | 166 文件 / 1980 用例 / 7.46s，**探针零条**                      |

⚠️ **「全绿」在这里完全不构成证据** —— 修复前它也是 166/166 绿。抓到问题的是探针，不是测试结果。

### E2 — Medium 真的只碰 localhost 🟢 通过

同上探针，跑全量。**2009 条记录里 `tcp-remote` = 0**，全部是 `localhost` 或 IPC socket。这实证了 Google 对 Medium 的定义（「网络只许 localhost」）在本仓成立。

### E3 — Large 真的默认 skip 🟢 通过

默认跑（不设任何 `RUN_*_IT`）时，8 个 `.vendor.spec.ts` 全部 `↓ skipped`，且探针里**零条**来自它们的记录。

### E4 — 守卫 5 条逐条能拦 🟢 通过

在文件系统上**逐条造真反例**（不是只跑单测），每条各自被点名报红，清理后复跑全绿：

| #   | 注入                                        | 命中                        |
| --- | ------------------------------------------- | --------------------------- |
| 1   | `src` 下 `*.spec.ts` import 共享 PG fixture | `small-stays-small`         |
| 2   | 读 `RUN_MARKETDATA_IT` 但无 `skipIf`        | `vendor-must-be-gated`      |
| 3   | `.vendor.spec.ts` 里留一个未门控 describe   | `vendor-file-fully-gated`   |
| 4   | `apps/mobile/src` 下 import Playwright      | `mobile-unit-is-logic-only` |
| 5   | `test/` 下放一个 `.e2e.spec.ts`             | `no-unknown-size-suffix`    |

外加 83 条守卫单测（含「注释里提到 env ≠ 真读 env」「一级间接门控」「嵌套 describe 不算顶层」三个易错点）。

### E5 — 后缀 ↔ runner 路由正确 🟢 通过

`unit` 166 + `it` 205 = 371 全量；**并集 = 全量、交集 = 空**、`unit` 里零 `.it.`/`.vendor.` 混入。

### E6 — 静态判据 vs 运行时真相

E6 不是一组独立断言，而是 E1–E3 用的**那个探针本身**。它存在的理由：`check-test-size.ts` 是静态扫 import 的，**原理上看不见**动态 require、库内部自发的请求。静态守卫对「Small 零外部依赖」只能给必要条件，探针补充分条件。

**它第一次跑就抓到了一个真缺陷**（见 §4），而那个缺陷静态守卫**永远**抓不到。

## 4. 探针抓到的真缺陷（本轮最有价值的产出）

### 现象

`unit` project（本该零外部依赖）里，`optionsdesk.controller.spec.ts` 实际连上了 `localhost:6380` —— dev Redis 容器。

而该 spec 自己的注释写着：

> DB / Redis 均不真连 —— PrismaService 懒连接; ioredis 连不上只在后台重试 (silentEmit), 不影响本 spec。

**注释是真诚的，但事实不是这样。** 它设了 `process.env.REDIS_URL ??= 'redis://127.0.0.1:6399'`（死端口）却被绕过了。

### 归因过程（三次迭代才拿到可用证据）

| 版本 | 记录                                           | 问题                                                                   |
| ---- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| v1   | `{"kind":"tcp-remote","target":"?:"}`          | 参数解析不出，**无法归因**                                             |
| v2   | 加 `detail` → `["0","1"]`                      | 发现首参是数组 = Node `normalizeArgs` 折叠后的 `[options, cb]`，没拆包 |
| v3   | 拆包 + 多留栈帧 + `expect.getState().testPath` | 拿到 `localhost:6380` + ioredis `StandaloneConnector` + 具体 spec 文件 |

⇒ **探针本身也要迭代到「能归因」才算数**。一条无法归因的记录就足以推翻结论。

### 根因（决定性实验，非推断）

`6380` 在全仓代码里只出现在 `apps/server/.env:14`（gitignored 本地真值）。备份 → 挪走 `.env` → 复跑 → 还原（逐字节校验一致）：

| 条件        | 探针记录                                  |
| ----------- | ----------------------------------------- |
| `.env` 在位 | `localhost:6380`（`.env` 的值）           |
| `.env` 挪走 | `127.0.0.1:6399`（spec 自己的死端口默认） |

⇒ **测试路径确实加载 `apps/server/.env`**（`nx test server` 的 cwd 就是 `apps/server`，`@nestjs/config` 默认行为），**并且盖过 spec 在顶层用 `??=` 设好的值**。

🔴 **这证伪了 `test-environment-matrix.md` 原 env 铁律 #1「测试路径不读 `apps/server/.env`，一行都不读」** —— 该条已按实证改写。

### 两级修复

**最终只保留根因修复**：① `RedisLifecycle` 改**惰性**建连（`get client()` 首次访问才 `new Redis`）② spec 补 `.overrideProvider(REDIS_CLIENT)`。实测**单靠这两条**，`unit` project 出网记录就归零（不依赖任何 env 钉死）。

### ❌ 被撤回的表面修复（教训）

一开始还把 `DATABASE_URL` / `REDIS_URL` 钉进 `test.env` 的不可达端口 `127.0.0.1:1`，理由是「消除本地读 `.env` / CI 没有 `.env` 的分叉」。**撤回了**，两个原因：

1. **它有害** —— 把「安静地连上 dev Redis」变成**对着立即拒绝的端口无退避疯狂重连**。单跑 `server:test` 看不出来（84s 全绿），但在 `nx affected` 与 mobile 任务并发时把事件循环饿死：**全量门挂死 16 分钟，而 nx 按 task 缓冲输出 ⇒ 日志一个字节都没有**。靠 `sample <pid>` 拿栈才定位：2035 帧深、反复 `Builtins_RunMicrotasks` = 微任务风暴。
2. **它多余** —— 撤掉后 E1 仍是探针零条。根因修好了，表面那层什么也没多解决。

⇒ **通则：治「测试碰了真外部依赖」要治被测对象（让它根本不建那个客户端），不要治端点可达性。** 把端点改成不可达，只是把「连上了」换成「一直在重连」，后者更难查。
