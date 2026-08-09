import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app/app.module.js';
import { EvaluateAlertsUseCase } from './evaluate-alerts.usecase.js';
import { DispatchPushDeliveriesUseCase } from './dispatch-push-deliveries.usecase.js';
import { ALERT_WORKER_DISABLED } from './alert-eval.processor.js';

/**
 * alert 评估手动触发 CLI (021 T012, plan D1: dev dogfood / misfire 手补)。
 *
 * `--dispatch` (022 T006): 评估轮后追加一轮 push dispatch (同直跑 UC 哲学 —
 * 到期扫描幂等, 与 server 进程 worker 并发安全: conditional updateMany 标态,
 * lost 行 no-op)。真机走查「CLI 触发 → 通知到达」即此路径。
 *
 * **直跑 UC 不过 queue** (与 marketdata trigger CLI 的入队-等待路径有意分叉):
 * 评估幂等 (tradeDate 唯一键) 使本进程直评与 cron 轮并发安全 (撞 P2002 即 skip);
 * 无 SyncRun/bullJobId 簿记需求 → 不需要全局唯一 worker 串行化, 也就不需要
 * server 在线 + 等终态 + 超时退出码的整套舞步。misfire 手补 = 评估本身, 直跑即补。
 *
 * sentinel 双置位 (镜像 017 D6 拓扑互斥): 本 CLI 进程既不消费 alert 队列也不消费
 * marketdata 队列 (字符串字面量, boundaries 白名单不含 marketdata 故不 import)。
 *
 * 退出码: 0 = 评估轮完成 / 1 = 异常。
 */
export async function runAlertEval(): Promise<number> {
  process.env[ALERT_WORKER_DISABLED] = '1';
  process.env['MARKETDATA_WORKER_DISABLED'] = '1';
  const logger = new Logger('alert-eval');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const summary = await app.get(EvaluateAlertsUseCase).execute();
    logger.log(`alert-eval done: ${JSON.stringify(summary)}`);
    if (process.argv.includes('--dispatch')) {
      const dispatchSummary = await app.get(DispatchPushDeliveriesUseCase).execute();
      logger.log(`push-dispatch done: ${JSON.stringify(dispatchSummary)}`);
    }
    return 0;
  } catch (err: unknown) {
    logger.error(`alert-eval failed: ${String(err)}`);
    return 1;
  } finally {
    await app.close();
  }
}

// entry guard: 仅 `node .../alert-eval.cli.js` 直跑时执行 (argv[1] 文件名判定, CLI 体例)。
if (process.argv[1]?.includes('alert-eval')) {
  void runAlertEval().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(String(err));
      process.exit(1);
    },
  );
}
