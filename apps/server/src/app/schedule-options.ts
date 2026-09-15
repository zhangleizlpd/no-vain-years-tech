import type { ScheduleModuleOptions } from '@nestjs/schedule';

/**
 * 一次性 CLI 进程的定时任务开关 (`*.cli.ts` 在 `createApplicationContext(AppModule)` 前置位)。
 *
 * CLI 复用整个 AppModule (017 plan D6: 不 fork module 树), 而 AppModule 带 `ScheduleModule`
 * ⇒ 不置位时 CLI 进程里全部 `@Cron` 与服务端进程**重复触发** (2026-09-14 回填 CLI 进程内实际
 * 多跑了锚标的盘中 tick, 见 #411)。置位后 ScheduleExplorer 跳过 cron / interval / timeout 注册,
 * `SchedulerRegistry` 照常可注入。
 *
 * 与 `MARKETDATA_WORKER_DISABLED` 分开: 那个只停 BullMQ worker, 且被多个 IT 单独置位。
 */
export const SCHEDULER_DISABLED = 'SCHEDULER_DISABLED';

/**
 * 🚨 必须经 `ScheduleModule.forRootAsync` 的 `useFactory` 调用: `forRoot(options)` 的参数在
 * `import { AppModule }` 时就已求值, 早于 CLI 函数体里的置位 (对照臂见同目录 spec)。
 */
export function scheduleModuleOptions(): ScheduleModuleOptions {
  const enabled = !process.env[SCHEDULER_DISABLED];
  return { cronJobs: enabled, intervals: enabled, timeouts: enabled };
}
