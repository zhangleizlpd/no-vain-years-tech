import { Logger } from '@nestjs/common';

/**
 * 把 **Nest 内建 ConsoleLogger** 压到 error —— 与 `vitest.config.ts` 里
 * `test.env.LOG_LEVEL='error'` 对 pino 做的事**同一档，但那条管不到这一套**。
 *
 * ## 🚨 仓里有两套 logger，只有一套听 `LOG_LEVEL`
 *
 * | 谁 | 怎么产生 | 归谁管 |
 * | --- | --- | --- |
 * | pino-http 的 request JSON | `LoggerModule.forRootAsync` 的 `pinoHttp.level` | `LOG_LEVEL` env |
 * | `[Nest] pid - date WARN [Ctx]` | 业务代码里的 `new Logger(Xxx.name)`（`@nestjs/common`）| **Nest 静态 logLevels** |
 *
 * 生产环境两套是合一的：`main.ts` 的 `app.useLogger(app.get(Logger))` 把 Nest 的调用
 * 转进 pino，于是 `LOG_LEVEL` 一把全管。**测试里不合一** —— `narrow-boot.ts` 蓄意不
 * 注册 `LoggerModule`，也没有任何 spec 调 `useLogger` ⇒ 每个 `new Logger(X)` 都落回
 * Nest 内建 ConsoleLogger、用它自己的默认级别，`LOG_LEVEL` 一个字都管不到。
 *
 * 实测（2026-08-17，CI 一轮 server-test 的 119KB 日志）：pino 那半压到 error 之后，
 * Nest ConsoleLogger 仍占 **133 行 / 28KB / 23%**，是剩余内容里最大的单一来源。
 *
 * ## 为什么留 error 不全关
 *
 * 与 pino 那侧同一个取舍：真出 5xx 时那条要还在。当前那 133 行的分布是
 * LOG 80 / WARN 22 / ERROR 30 ⇒ 本设置砍掉 102 行、留下 30 行。
 *
 * ## ⚠️ 不影响 `vi.spyOn(Logger.prototype, …)` 那类断言
 *
 * 仓里有若干 spec 断言 `Logger.prototype.log/warn/error` 被调用过（如
 * `marketdata.backfill-cli.it.spec.ts`）。spy 直接替换原型方法，跑在 Nest 的级别判断
 * **之前** ⇒ 调用照样被记录，断言不受本设置影响。
 */
Logger.overrideLogger(['error', 'fatal']);
