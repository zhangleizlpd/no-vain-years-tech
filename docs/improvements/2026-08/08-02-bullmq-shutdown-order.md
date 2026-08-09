# BullMQ 关停顺序：无限重试 + 提前断连 = 进程永不退出

> **调优 / 改造记录**（per [docs-organization](../../conventions/docs-organization.md) 三类记录）。
> 缺陷来源：2026-08-02 做 [测试分类学](08-02-test-size-taxonomy.md) 时，全量门挂死 16 分钟，顺藤摸出的一个潜伏约两个月的缺陷。

## 1. 症状

`nx affected` 全量门**挂死 16 分钟**，且：

- 日志 **0 字节** —— nx 按 task 缓冲输出，任务不结束就一个字也不写（要看进度得加 `--output-style=stream`）
- 一个 vitest worker **100% CPU** 常驻
- `pkill` **杀不掉它** —— 该进程被 kill 后又活了 41 分钟，一直偷一整个核

## 2. 定位过程（三次错误假设 → 一次实锤）

| 轮次     | 假设                                                | 怎么被推翻                                                                                             |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1        | 「datastore URL 钉死到不可达端口 → 无退避重连风暴」 | 把钉死**加回去，门照样跑绿**；且 `lsof` 显示该进程连接**全在 testcontainers 端口**，零条指向被钉的端口 |
| 2        | 「负载敏感 flake」                                  | 是确定性代码缺陷，只是触发**时序**随机                                                                 |
| 3        | 「`pkill` 已清理干净」                              | 41 分钟后它还在转 —— 后续所有耗时测量都被它污染                                                        |
| **实锤** | —                                                   | `kill -USR1` 拉起 inspector + CDP `Debugger.pause` 取到**真实 JS 栈**                                  |

```text
reject                    :291      ← ioredis 对已断连接立即 reject
sendCommand               :333
execute / runCommand / execCommand
moveToFinished            :545      ← BullMQ Worker 收尾一个 job
processTicksAndRejections
```

### 两条可复用的取证事实

1. **Node 陷入 JS 死循环时 `SIGTERM` 无效** —— 信号处理器排在事件循环上，而循环被占死。`pkill` 静默失败，**必须 `kill -9`**。
2. **`SIGUSR1` 仍然有效** —— 它由 Node 的**看门狗线程**处理，所以即使事件循环被占死也能拉起 inspector，再用 CDP `Debugger.pause` 拿到 JS 栈。这是唯一能给自旋**命名**的手段；`sample`(1) 只给出 `Builtins_RunMicrotasks` 这类 JIT 帧，说明「在转」但说不出转的是谁。

## 3. 根因

三个条件同时成立：

| #   | 条件                                                                                                   | 出处                                                                               |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1   | 队列 Redis 连接配 `maxRetriesPerRequest: null` = **命令无限重试**                                      | BullMQ 对 Worker 的**硬要求**                                                      |
| 2   | 消费方 `onModuleDestroy` 里 `await worker.close()` 会**等 in-flight job 跑完**，且**该调用自身不超时** | [BullMQ Graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown) |
| 3   | 连接的 `disconnect()` 也挂在 `onModuleDestroy`，而 **Nest 对同模块 providers 的该钩子不串行**          | 实测（见 §5 回归测试）                                                             |

⇒ **同步的 `disconnect()` 插进异步 `await worker.close()` 中间** ⇒ job 收尾的 `moveToFinished` 对着已断连接无限重试 ⇒ 100% CPU、进程永不退出 ⇒ vitest 等这个 worker ⇒ 全量「挂死」。

各 processor 自己**已经**按官方顺序写了（`worker.close()` → `events.close()` → `queue.close()`）。坏的是**跨 provider** 的相对顺序 —— 靠 provider 注册顺序碰运气。

## 4. 修法

### 4.1 断连挪到关停第二段

NestJS 关停分三段且**段间是全局屏障**：所有 `onModuleDestroy`（含 await）跑完，才进入 `beforeApplicationShutdown` / `onApplicationShutdown`（[官方](https://docs.nestjs.com/fundamentals/lifecycle-events)）。

⇒ 三个连接 lifecycle 的断连从 `onModuleDestroy` 移到 **`onApplicationShutdown`**，**结构性保证**消费方先关：

- `marketdata-queue-connection.ts` · `alert-queue-connection.ts`（有无限重试风险）
- `security.module.ts` 的 `RedisLifecycle`（缓存连接，默认重试 20 次无此风险，**仍统一**——避免「三处里两处对、一处例外」这种要读文档才知道的不一致）

### 4.2 关停调用套超时

新增 `security/close-with-timeout.ts`，6 个关停点全部套上。语义是**尽力而为、绝不抛**——关停路径上再抛异常只会把「关得慢」升级成「关不掉」。

> 这与 4.1 是同一枚硬币的两面：**一个卡在重连，一个卡在等 job，表现都是进程永不退出。** 两条都得堵。

## 5. 回归测试怎么设计的

`test/integration/queue-shutdown-order.it.spec.ts` —— 断言**不变量**而非触发病症：

> 任一消费方的 `onModuleDestroy` 执行时，它用的队列 Redis 连接必须仍然可用。

两个刻意的设计约束，都是踩出来的：

1. **不去触发那个死循环** —— 触发了测试自己就挂了。
2. **观察者的钩子必须是 `async` 且真的耗时** —— 第一版写成同步的，**测试假绿**。因为扁平模块里 Nest 按反注册顺序销毁，同步探针根本碰不到那个窗口。改成 `await sleep(80)` 后立刻稳定复现（这正好也说明：**真 worker 的 `close()` 越慢，中招概率越高**）。
3. **不要在观察者里 `await client.ping()`** —— 连接若已断，`maxRetriesPerRequest: null` 会让这条 ping 永远重试而不是 reject，测试直接挂死。只读 `.status`。

红→绿证据：修复前两条均 `expected 'end' not to be 'end'`；修复后 2 passed。

## 6. 不是本轮引入的

`git log` 实证：

| 文件                                | 诞生            |
| ----------------------------------- | --------------- |
| `marketdata-queue-connection.ts`    | 2026-06-04 #322 |
| `alert-queue-connection.ts`         | 2026-06-07 #359 |
| `marketdata.queue-infra.it.spec.ts` | 2026-06-04 #322 |

同日的 #822 / #823 **一个都没碰过**它们。那两个 PR 只是改变了并发时序把它顶出来。

⚠️ **不声称「以前从没发生过」** —— 自旋孤儿除非有人去看 CPU 否则完全无形，没有证据说它没发生过。

## 7. 顺带发现的独立问题（**不在本次修复范围**）

`apps/server/src/main.ts` **没有 `enableShutdownHooks()`**。而 NestJS 官方明确：这些钩子只在 `app.close()` 或（SIGTERM + `enableShutdownHooks`）时触发。

后果：

- ✅ 本缺陷**只在测试路径发作**（`moduleRef.close()` 会触发）—— prod 走不到，早前「prod 滚动重启会卡」的判断**是错的，已撤回**
- ⚠️ 但反过来说，**prod 根本没有优雅关停**：SIGTERM 时 in-flight job 不会被 `worker.close()` 等完，会变成 stalled job

这是独立的可用性问题，单独跟进，别和本修复混在一个 PR。

## 8. 方法论留痕

1. **「测试必须先红」不是仪式** —— 第一版回归测试直接绿，逼我发现自己对 Nest 销毁顺序的心智模型是错的（以为是注册顺序，实为反序 + 同模块内不串行）。如果当时图省事直接改代码再补测试，会得到一个**永远绿、什么也不保护**的测试。
2. **给自旋命名要用 inspector，不要用采样器。** `sample` 只告诉你「在转微任务」，CDP `Debugger.pause` 直接给出 `moveToFinished`。
3. **孤儿进程会污染后续所有测量。** 定位期间那个 100% CPU 的孤儿存活了 41 分钟，期间我做的每一次耗时对比都不可信。排查「慢/挂」类问题时，**先确认没有上一轮的残留在跑**。
4. **改公开方法名之前先全仓 grep 调用点。** 本次把 `onModuleDestroy` 改成 `onApplicationShutdown`，**17 处测试在手动调它**（`lifecycle?.onModuleDestroy()`），全被改废 —— 先改代码再跑测试才发现，全量一次红 16 个文件。正确顺序是先 grep 出调用面再动手。注意区分接收者：`lifecycle` 那类要跟着改，`worker` / `queue` 那 62 处钩子没改名、不能碰。
