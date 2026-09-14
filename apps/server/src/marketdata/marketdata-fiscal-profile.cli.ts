import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app/app.module.js';
import { PrismaService } from '../security/prisma.service.js';
import { MARKETDATA_WORKER_DISABLED } from './marketdata-sync.queue.js';

/**
 * 财年档案人工补录 CLI (079 T029, FR-026 / plan §D13 ③)。
 *
 * 反推推不出 / 来源矛盾的港股锚进日报「财年待补」，维护者核对港交所公开资料后用本命令补录。
 * 写 `source = 'manual'`，**幂等**：同值重跑零写入 (行数与各列不变)；已有行 (含反推所得) 以人工值
 * 覆盖 —— 人工补录是维护者的显式裁决。🚨 prod 执行属写操作，命令与参数先呈维护者确认 (plan §D13)。
 *
 * 照 `marketdata-trading-day-seed.cli.ts` 范式 (先解析 fail-fast → sentinel 前置 → ApplicationContext
 * → 同步直写 → close)，无队列、无 worker。
 *
 * 用法: node dist/marketdata/marketdata-fiscal-profile.cli.js --set hk:00005=12 [--set hk:00883=12]
 * 退出码: 0 全部写入 / 1 参数非法、或任一标的不在主表 (此时零写入)。
 */

export interface FiscalProfileSetEntry {
  readonly ticker: string;
  readonly market: string;
  readonly code: string;
  readonly month: number;
}

export interface FiscalProfileSetArgs {
  readonly entries: readonly FiscalProfileSetEntry[];
}

const SET_VALUE = /^(hk):(\d{5})=(\d{1,2})$/;

/** 解析 argv: `--set hk:00005=12 --set hk:00883=12`。只收港股 (FR-028)。 */
export function parseFiscalProfileArgs(argv: string[]): FiscalProfileSetArgs {
  const entries: FiscalProfileSetEntry[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--set') {
      throw new Error(`未知参数 "${argv[i]}" (用法: --set hk:<5 位代码>=<财年结束月>)`);
    }
    const raw = argv[++i] ?? '';
    const m = SET_VALUE.exec(raw);
    if (m === null) {
      throw new Error(`--set 须为 hk:<5 位代码>=<财年结束月> (如 hk:00005=12)，得 "${raw}"`);
    }
    const month = Number(m[3]);
    if (month < 1 || month > 12) throw new Error(`财年结束月须为 1–12，得 ${m[3]}`);
    entries.push({ ticker: `${m[1]}:${m[2]}`, market: m[1], code: m[2], month });
  }
  if (entries.length === 0) throw new Error('至少需要一个 --set hk:<5 位代码>=<财年结束月>');
  return { entries };
}

/** 补录本体 (注入 prisma，IT 直测)。任一标的不在主表 ⇒ 零写入、返 1。 */
export async function executeFiscalProfileSet(
  prisma: PrismaService,
  args: FiscalProfileSetArgs,
  now: Date,
  logger: Logger = new Logger('marketdata-fiscal-profile'),
): Promise<number> {
  const instruments = await prisma.instrument.findMany({
    where: { OR: args.entries.map((e) => ({ market: e.market, code: e.code })) },
    select: { id: true, market: true, code: true },
  });
  const idByTicker = new Map(instruments.map((i) => [`${i.market}:${i.code}`, i.id]));
  const missing = args.entries.filter((e) => !idByTicker.has(e.ticker)).map((e) => e.ticker);
  if (missing.length > 0) {
    logger.error(`标的不在主表，未写入任何行: ${missing.join(', ')}`);
    return 1;
  }

  let written = 0;
  for (const e of args.entries) {
    const instrumentId = idByTicker.get(e.ticker) as bigint;
    const existing = await prisma.earningsFiscalProfile.findUnique({
      where: { instrumentId },
      select: { fiscalYearEndMonth: true, source: true },
    });
    if (existing?.fiscalYearEndMonth === e.month && existing.source === 'manual') continue;
    const row = {
      fiscalYearEndMonth: e.month,
      source: 'manual',
      evidence: `manual: marketdata-fiscal-profile.cli --set ${e.ticker}=${e.month}`,
      determinedAt: now,
    };
    await prisma.earningsFiscalProfile.upsert({
      where: { instrumentId },
      create: { instrumentId, ...row },
      update: row,
    });
    written++;
  }
  logger.log(`财年档案人工补录完成: ${JSON.stringify({ entries: args.entries.length, written })}`);
  return 0;
}

/** NestFactory 接线 entry: 解析 (可 throw) → sentinel 前置 → 起 DI → 补录 → close。 */
export async function runFiscalProfileCli(argv: string[]): Promise<number> {
  const args = parseFiscalProfileArgs(argv); // 先解析 fail-fast，坏参不必启动 DI。
  process.env[MARKETDATA_WORKER_DISABLED] = '1';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    return await executeFiscalProfileSet(app.get(PrismaService), args, new Date());
  } finally {
    await app.close();
  }
}

// entry guard: 仅 `node .../marketdata-fiscal-profile.cli.js` 直跑时执行 (vitest 导入本模块测解析时
// 不触发 NestFactory boot)。解析 / 执行错误 → stderr + 退出码 1。
if (process.argv[1]?.includes('marketdata-fiscal-profile')) {
  void runFiscalProfileCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(String(err));
      process.exit(1);
    },
  );
}
