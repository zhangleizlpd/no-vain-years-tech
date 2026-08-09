import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Redis } from 'ioredis';
import type { PrismaService } from '../security/prisma.service';
import type { EvaluateIntradayAlertsUseCase } from './evaluate-intraday-alerts.usecase';
import {
  IntradayEvalProcessor,
  INTRADAY_MARKET,
  isWithinTradingSession,
  marketNow,
  CIRCUIT_THRESHOLD,
  INTRADAY_FAILSTREAK_KEY,
  INTRADAY_CIRCUIT_KEY,
} from './intraday-eval.processor';

// 024 T008 单测: 交易时段 gate (纯时窗 + trading_day 直查) + Redis 熔断 (failstreak/circuit
// 连续 3 失败 open → 降级、成功 reset+close 回升)。源调用 (实时 port) 在 T009 evaluate-intraday
// UC 内 — 本处以 UC stub 替身, 验「非交易时段/非交易日 0 源调用」= UC.execute 零调用。
// repeatable 注册归 alert-eval.processor.spec (同 queue 第 3 tick)。tick 全链路归 T011 IT。
describe('intraday-eval processor — 交易时段 gate + 熔断 (024 T008)', () => {
  let container: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis(container.getConnectionUrl(), { maxRetriesPerRequest: null });
  }, 120_000);

  afterAll(async () => {
    redis.disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    await redis.flushall();
  });

  describe('纯时窗 helpers (按市场登记的时区与时段)', () => {
    it('marketNow(cn): UTC 02:00 → 上海 10:00 (date + 当日分钟)', () => {
      const { dateOnly, minutesOfDay } = marketNow('cn', new Date('2026-06-09T02:00:00Z'));
      expect(dateOnly).toBe('2026-06-09');
      expect(minutesOfDay).toBe(600); // 10:00
    });

    it('marketNow(cn): UTC 16:00 → 跨日到上海次日 00:00', () => {
      const { dateOnly, minutesOfDay } = marketNow('cn', new Date('2026-06-09T16:00:00Z'));
      expect(dateOnly).toBe('2026-06-10');
      expect(minutesOfDay).toBe(0);
    });

    it('isWithinTradingSession(cn): 上午 [09:30,11:30] / 下午 [13:00,15:00] 含端点, 午休/盘后 false', () => {
      expect(isWithinTradingSession('cn', 570)).toBe(true); // 09:30 开盘
      expect(isWithinTradingSession('cn', 600)).toBe(true); // 10:00
      expect(isWithinTradingSession('cn', 690)).toBe(true); // 11:30 午收
      expect(isWithinTradingSession('cn', 720)).toBe(false); // 12:00 午休
      expect(isWithinTradingSession('cn', 780)).toBe(true); // 13:00 午开
      expect(isWithinTradingSession('cn', 900)).toBe(true); // 15:00 收盘
      expect(isWithinTradingSession('cn', 901)).toBe(false); // 15:01 盘后
      expect(isWithinTradingSession('cn', 569)).toBe(false); // 09:29 盘前
    });

    /**
     * 🚨 **本通路只服务 A 股, 且这件事必须是显式的。** 美股盘中 = 北京 21:30–04:00, 与 A 股
     * 时窗零重叠 —— 旧实现把「上海时段」当成全局的盘中判据, 接美股时会**一次都不触发且不报错**。
     * 现在时段按市场登记: 未登记市场 `marketNow` 直接抛, 不会静默套用别人的时窗。
     */
    it('🚨 未登记市场 → marketNow 抛 (禁静默套用 A 股时窗)', () => {
      expect(() => marketNow('us', new Date('2026-06-09T02:00:00Z'))).toThrow(/未登记盘中时段/);
      expect(isWithinTradingSession('us', 600)).toBe(false);
    });

    it('🚨 美东 10:00 (= 北京 22:00) 不在 A 股时段内 —— 复用本通路做美股必须先登记时段', () => {
      // 2026-06-09 EDT: 美股盘中 10:00 ET = 14:00Z = 北京 22:00。
      const { minutesOfDay } = marketNow(INTRADAY_MARKET, new Date('2026-06-09T14:00:00Z'));
      expect(minutesOfDay).toBe(22 * 60);
      expect(isWithinTradingSession(INTRADAY_MARKET, minutesOfDay)).toBe(false);
    });
  });

  /** UC 替身: 记录调用次数 + 可注入抛错 (熔断计数面)。 */
  function ucStub(opts: { fail?: boolean } = {}): {
    uc: EvaluateIntradayAlertsUseCase;
    calls: () => number;
  } {
    let n = 0;
    const uc = {
      execute: async () => {
        n += 1;
        if (opts.fail) throw new Error('all realtime quote sources failed');
        return { fetched: 1, triggered: 0, skippedDuplicate: 0, skippedNoData: 0 };
      },
    } as unknown as EvaluateIntradayAlertsUseCase;
    return { uc, calls: () => n };
  }

  /** prisma 替身: trading_day count (交易日=1, 节假日=0)。 */
  function prismaStub(tradingDay: boolean): PrismaService {
    return {
      tradingDay: { count: async () => (tradingDay ? 1 : 0) },
    } as unknown as PrismaService;
  }

  const IN_SESSION = new Date('2026-06-09T02:00:00Z'); // 上海 10:00
  const LUNCH_BREAK = new Date('2026-06-09T04:00:00Z'); // 上海 12:00

  it('非交易时段 (午休) → skipped-session, 0 源调用 (UC 不触, 不查 trading_day)', async () => {
    const { uc, calls } = ucStub();
    const proc = new IntradayEvalProcessor(redis, prismaStub(true), uc);

    const outcome = await proc.process(LUNCH_BREAK);
    expect(outcome.status).toBe('skipped-session');
    expect(calls()).toBe(0);
  });

  it('交易时段但非交易日 (节假日) → skipped-holiday, 0 源调用', async () => {
    const { uc, calls } = ucStub();
    const proc = new IntradayEvalProcessor(redis, prismaStub(false), uc);

    const outcome = await proc.process(IN_SESSION);
    expect(outcome.status).toBe('skipped-holiday');
    expect(calls()).toBe(0);
  });

  it('交易时段 + 交易日 + 源成功 → evaluated, failstreak reset 0', async () => {
    await redis.set(INTRADAY_FAILSTREAK_KEY, '2'); // 先前残留
    const { uc, calls } = ucStub();
    const proc = new IntradayEvalProcessor(redis, prismaStub(true), uc);

    const outcome = await proc.process(IN_SESSION);
    expect(outcome.status).toBe('evaluated');
    expect(calls()).toBe(1);
    expect(await redis.get(INTRADAY_FAILSTREAK_KEY)).toBe('0');
  });

  it(`连续 ${CIRCUIT_THRESHOLD} 次源失败 → circuit open + failstreak=${CIRCUIT_THRESHOLD} (降级 EOD-only)`, async () => {
    const { uc } = ucStub({ fail: true });
    const proc = new IntradayEvalProcessor(redis, prismaStub(true), uc);

    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      const outcome = await proc.process(IN_SESSION);
      expect(outcome.status).toBe('source-failed');
    }
    expect(await redis.get(INTRADAY_FAILSTREAK_KEY)).toBe(String(CIRCUIT_THRESHOLD));
    expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('open');
  });

  it('熔断后源恢复 → circuit close + failstreak reset 0 (自动回升)', async () => {
    // 先打到 open
    const failing = ucStub({ fail: true });
    const failProc = new IntradayEvalProcessor(redis, prismaStub(true), failing.uc);
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) await failProc.process(IN_SESSION);
    expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('open');

    // 下一 tick 源恢复
    const healthy = ucStub();
    const okProc = new IntradayEvalProcessor(redis, prismaStub(true), healthy.uc);
    const outcome = await okProc.process(IN_SESSION);
    expect(outcome.status).toBe('evaluated');
    expect(await redis.get(INTRADAY_CIRCUIT_KEY)).toBe('closed');
    expect(await redis.get(INTRADAY_FAILSTREAK_KEY)).toBe('0');
  });
});
