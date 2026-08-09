import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app/app.module.js';
import { MARKETDATA_WORKER_DISABLED } from './marketdata-sync.worker.js';
import { CALENDAR_MARKETS, TradingCalendarSyncService } from './trading-calendar-sync.service.js';
import { shanghaiToday } from './trading-day-gate.js';

/**
 * 交易日历历史 seed CLI (sync-1 S1-T2, FR: 部署切表驱动前先填历史): 一次性拉多年指数 kline
 * 落 `trading_day`。空表兜底虽有 DbTradingCalendarAdapter fail-open (S1-T3), 但 seed 后判定
 * 才精确 (真节假日)。照 `marketdata-backfill.cli.ts` 范式 (sentinel 前置 → NestFactory
 * ApplicationContext → service → close), 但**同步直写** (无队列 / 无 worker / 无终态等待)。
 *
 * 用法: node dist/marketdata/marketdata-trading-day-seed.cli.js --from 2015-01-01 [--to 2026-07-14] [--markets cn,hk,us]
 * 退出码: 0 成功 / 1 解析或执行异常。
 */

/** 缺省 seed 起点 (多年历史; 覆盖 A/港/美股近十年交易日, 单次 vendor 区间调用即可)。 */
const DEFAULT_SEED_FROM = '2015-01-01';

export interface SeedArgs {
  markets: string[];
  from: string;
  /** 缺省 = 上海时区今日 (运行时求值)。 */
  to?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 解析 argv: `--from 2015-01-01 --to 2026-07-14 --markets cn,hk,us`。 */
export function parseSeedArgs(argv: string[]): SeedArgs {
  const args: SeedArgs = { markets: [...CALENDAR_MARKETS], from: DEFAULT_SEED_FROM };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--markets') args.markets = (argv[++i] ?? '').split(',').filter(Boolean);
  }
  if (!ISO_DATE.test(args.from)) throw new Error(`--from 须为 YYYY-MM-DD (得 "${args.from}")`);
  if (args.to !== undefined && !ISO_DATE.test(args.to)) {
    throw new Error(`--to 须为 YYYY-MM-DD (得 "${args.to}")`);
  }
  if (args.markets.length === 0) throw new Error('--markets 不可为空');
  return args;
}

/** NestFactory 接线 entry: 解析 (可 throw) → sentinel 前置 → 起 DI → syncRange → close。 */
export async function runSeed(argv: string[]): Promise<number> {
  const args = parseSeedArgs(argv); // 先解析 fail-fast, 坏参不必启动 DI。
  const logger = new Logger('marketdata-trading-day-seed');
  // D6 (同 backfill CLI): createApplicationContext 前置 sentinel → worker OnModuleInit no-op。
  process.env[MARKETDATA_WORKER_DISABLED] = '1';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const service = app.get(TradingCalendarSyncService);
    const to = args.to ?? shanghaiToday(new Date());
    const results = await service.syncRange(args.markets, args.from, to);
    logger.log(`trading-day seed 完成: ${JSON.stringify({ from: args.from, to, results })}`);
    return 0;
  } finally {
    await app.close();
  }
}

// entry guard: 仅 `node .../marketdata-trading-day-seed.cli.js` 直跑时执行 (vitest 导入本模块
// 测 parseSeedArgs 时不触发 NestFactory boot)。解析/执行错误 → stderr + 退出码 1。
if (process.argv[1]?.includes('marketdata-trading-day-seed')) {
  void runSeed(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(String(err));
      process.exit(1);
    },
  );
}
