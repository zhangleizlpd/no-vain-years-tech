import type { ModuleMetadata } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

type Imports = NonNullable<ModuleMetadata['imports']>;

/**
 * 收窄 boot：`Test.createTestingModule({ imports: narrowTestModule([XxxModule]) })`
 * 替代 boot 整个 AppModule（批 6，per 08-02 plan「方案定型」）。
 *
 * 职责 = 把「AppModule 层的横切 forRoot 注册」内聚在这一个文件 —— 与 `app.module.ts`
 * 的同步义务集中于此：若未来 AppModule 新增横切 forRoot、收窄 boot 在 DI 期炸出
 * 「拿不到 XXX:MODULE_OPTIONS」，加到这里，别在各 spec 里散落补。
 *
 * 当前横切层只需 Throttler（2026-08-03 对 `app.module.ts` 逐一核过，67 文件全绿实证）：
 *
 * - **ThrottlerModule**：真 app 的 `forRootAsync`（全仓 31 个命名桶）注册在 AuthModule；
 *   不含 AuthModule 的收窄 boot 缺 `THROTTLER:MODULE_OPTIONS`，`AccountIdThrottlerGuard`
 *   在 DI 期直接炸。这里给宽松单桶 1000/60s（恒不触发）；controller 上未注册的命名
 *   `@Throttle` 引用被 guard 忽略不报错（先例 = `src/optionsdesk/optionsdesk.controller.spec.ts`）。
 * - **ScheduleModule 蓄意不注册**：`SchedulerRegistry` 全仓零使用者，`@Cron` 无 forRoot
 *   时惰性，IT 全部显式触发。
 * - **LoggerModule(pino) 蓄意不注册**：无任何 provider 注入 `PinoLogger`，缺席零 DI 风险。
 *
 * 🚨 两类文件**不适用**本 helper（直接写显式 `imports: [AuthModule(, <Feature>Module)]`）：
 *
 * - imports 已含 AuthModule（auth 族 / 限流断言族）—— AuthModule 自带真注册，再叠一份
 *   宽松桶 = 双注册。
 * - **断言限流行为（429 / Retry-After）的 IT** —— 宽松桶 = 把被测对象抽掉；必须经
 *   AuthModule 拿真配置。
 */
export const narrowTestModule = (modules: Imports): Imports => [
  ...modules,
  ThrottlerModule.forRoot({ throttlers: [{ limit: 1_000, ttl: 60_000 }] }),
];
