import { Injectable, type DynamicModule } from '@nestjs/common';
import { Cron, ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEDULER_DISABLED, scheduleModuleOptions } from './schedule-options.js';

@Injectable()
class ProbeScheduler {
  @Cron('0 0 3 * * *')
  handle(): void {}
}

/** 起 DI 并跑完生命周期 (cron 在 onApplicationBootstrap 挂载), 返回注册的 cron job 数。 */
async function cronJobCount(scheduleModule: DynamicModule): Promise<number> {
  const moduleRef = await Test.createTestingModule({
    imports: [scheduleModule],
    providers: [ProbeScheduler],
  }).compile();
  await moduleRef.init();
  try {
    return moduleRef.get(SchedulerRegistry).getCronJobs().size;
  } finally {
    await moduleRef.close();
  }
}

const asyncScheduleModule = (): DynamicModule =>
  ScheduleModule.forRootAsync({ useFactory: () => scheduleModuleOptions() });

describe('scheduleModuleOptions (一次性 CLI 进程不注册定时任务)', () => {
  afterEach(() => {
    delete process.env[SCHEDULER_DISABLED];
  });

  it('未置位 ⇒ 注册定时任务 (服务端进程)', async () => {
    expect(await cronJobCount(asyncScheduleModule())).toBe(1);
  });

  it('置位 ⇒ 零定时任务 (CLI 进程)', async () => {
    process.env[SCHEDULER_DISABLED] = '1';
    expect(await cronJobCount(asyncScheduleModule())).toBe(0);
  });

  // CLI 的真实时序: 文件顶部 `import { AppModule }` 先求值模块定义, 函数体里才置位。
  it('模块定义之后才置位 ⇒ forRootAsync 仍零定时任务', async () => {
    const scheduleModule = asyncScheduleModule();
    process.env[SCHEDULER_DISABLED] = '1';
    expect(await cronJobCount(scheduleModule)).toBe(0);
  });

  it('对照: forRoot 在模块定义时求值, 同样时序下置位无效 (AppModule 必须用 forRootAsync 的理由)', async () => {
    const scheduleModule = ScheduleModule.forRoot(scheduleModuleOptions());
    process.env[SCHEDULER_DISABLED] = '1';
    expect(await cronJobCount(scheduleModule)).toBe(1);
  });
});
