import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * Marketdata vendor config — discriminated union so the Lixinger token is only
 * required when `MARKETDATA_PROVIDER=live`. `mock` is the default for dev/test
 * (zero env → 全 Mock adapter, 8 端口返确定性 fixtures)。
 *
 * Boot-time `.parse()` rejects `kind=live` without `LIXINGER_TOKEN` (fail-fast,
 * 不静默降级 — FR-S02 / spec state_branch「config fail-fast」). 镜像 sms.config.ts。
 * vendor baseUrl 有默认 (env override 供 env-gated 真 vendor IT / 未来迁移)。
 */
const MarketdataConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mock') }),
  z.object({
    kind: z.literal('live'),
    lixingerToken: z.string().min(1, 'LIXINGER_TOKEN required when MARKETDATA_PROVIDER=live'),
    lixingerBaseUrl: z.string().url().default('https://open.lixinger.com/api'),
    eastmoneyBaseUrl: z.string().url().default('https://searchapi.eastmoney.com'),
    // clist (universe 枚举, 016) 在 push2 域, 与 searchapi suggest 不同 host → 独立 baseUrl。
    eastmoneyClistBaseUrl: z.string().url().default('https://push2.eastmoney.com'),
    // 交易日历源 (044): 腾讯 ifzq 指数 kline 派生交易日。旧东财 push2his kline 源已退役
    // (端点被定向下线 + robots.txt `Disallow: /`, FR-007) → 其 eastmoneyKlineBaseUrl 一并清。
    tencentCalendarBaseUrl: z.string().url().default('https://web.ifzq.gtimg.cn'),
    // 富途 shim (p3b §4.2, sellput-viz Phase 1): 港机上 OpenD 的 HTTP 薄壳, 经 B↔C
    // WireGuard 隧道访问 → **隧道虚 IP, 不是 localhost** (server 与 shim 从 day 1 不同机)。
    // 🚨 **无 `.default()` 是刻意的**: 它与 lixingerToken 同类 —— live 下缺失即 boot 抛,
    // 不给「悄悄没有 L1 日历源」留路 (静默降级正是 044 病根)。url + token 同属一个 SOPS
    // 单元 (照 CODE_INDEX_URL 先例, 隧道端点与其 token 一并加密)。
    futuShimUrl: z.string().url(),
    futuShimToken: z.string().min(1, 'FUTU_SHIM_TOKEN required when MARKETDATA_PROVIDER=live'),
  }),
]);

export type MarketdataConfig = z.infer<typeof MarketdataConfigSchema>;

/** `MARKETDATA_PROVIDER` 的合法值域 —— 之外一律 boot 抛 (054 FR-008)。 */
const PROVIDER_KINDS = ['mock', 'live'] as const;

export const marketdataConfig = registerAs('marketdata', (): MarketdataConfig => {
  const raw = process.env.MARKETDATA_PROVIDER;
  // 🚨 **缺失 (undefined) 仍落 mock, 但空串不是缺失** (054 FR-008 / plan D-5)。
  //
  // 旧实现是 `?? 'mock'`, 于是**任何**非 `'live'` 的值都被静默吞成 mock —— 拼错的 `liv` /
  // `Live` / `production`, 以及**空串**。空串才是 prod 侧的真陷阱: `docker-compose.tight.yml`
  // 的 `${MARKETDATA_PROVIDER}` 在变量未设时喂给容器的正是空串 (`??` 是 nullish 合并、
  // 空串不触发) ⇒「env-file 没加载」会一路穿到底, 生产容器零告警地跑着 mock 行情。
  //
  // 「缺失 → mock」则是**带论证的刻意保留**: ADR-0047 的「零 env → dev/test 可跑」靠它, 而
  // 054 之后 mock 已不能写库 (采集口绑拒绝壳) ⇒ 这个 silent default 不再危险。
  const kind = raw === undefined ? 'mock' : raw;
  if (!(PROVIDER_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `MARKETDATA_PROVIDER=${JSON.stringify(raw)} 不是合法值 —— 只接受 ` +
        `${PROVIDER_KINDS.map((k) => `'${k}'`).join(' | ')}。` +
        '空串通常意味着容器映射了该变量但 env-file 未加载 (照旧跑 mock 会让生产静默灌入伪造行情); ' +
        '整个变量缺失才落 mock 默认。',
    );
  }
  if (kind === 'live') {
    return MarketdataConfigSchema.parse({
      kind,
      lixingerToken: process.env.LIXINGER_TOKEN,
      lixingerBaseUrl: process.env.LIXINGER_BASE_URL,
      eastmoneyBaseUrl: process.env.EASTMONEY_BASE_URL,
      eastmoneyClistBaseUrl: process.env.EASTMONEY_CLIST_BASE_URL,
      tencentCalendarBaseUrl: process.env.TENCENT_CALENDAR_BASE_URL,
      futuShimUrl: process.env.FUTU_SHIM_URL,
      futuShimToken: process.env.FUTU_SHIM_TOKEN,
    });
  }
  return MarketdataConfigSchema.parse({ kind: 'mock' });
});

/**
 * 同步调度运行参数 (016 起, 独立于 mock|live 数据源 kind — 这是运维 tuning 而非 vendor
 * 选型)。tick/worker (017) + backfill CLI 消费。全有保守默认, env 可覆盖。
 * (016 旧 22:00 聚合调度的 `lockTtlMs`/`defaultCron` 已随 017 PR-7 清退 — 调度时刻
 * 真相在 `SyncDimension.cronExpr`, 互斥在 BullMQ 单 queue。)
 *
 * - `backfillDefaultHistoryDays`: backfill 默认浅回填天数 (D5, 防一条命令打爆 vendor 配额;
 *   深回填须显式 `--history-depth` opt-in)。
 * - `requeueDelayMs`: 配额耗尽顺延 self re-enqueue 的 delay (017 D5; 默认 30min 等配额窗)。
 * - `cliWaitTimeoutMs`: CLI `waitUntilFinished` 等终态上限 (017 FR-S15a; 默认 4h —
 *   backfill 长跑限频下单窗可达数小时; `--timeout` 可覆盖, 超时退出码 2)。
 * - `removeOnCompleteCount` / `removeOnFailCount`: bullmq 完成/失败 job 留存上限 (017,
 *   noeviction 下 Redis 内存有界的机制锚, FR-S12)。
 * - `tickEnabled`: 017 灰度 flag (US7) — 分钟级 tick 驱动开关, **默认 false** (新旧调度
 *   并存期由 env 翻开; 不用 z.coerce.boolean — 字符串 'false' 会被 coerce 成 true)。
 * - `optionCoverageThreshold`: 047 期权快照**逐票**覆盖率告警阈值 (FR-045), **先验起手 1
 *   = 100%** —— 快照按设计「有合约就有一行」(无报价也照落行), 故「基线日在、当日未到期、当日
 *   却没数据」一条都不该有。校准动作落 impl 期观察窗 (至少覆盖一个月度到期日次日): 若发现存在
 *   正常态缺行, 由 env 放宽并把成因写回 FR-045 —— 这正是它配置化而非写死的理由。
 */
const MarketdataSyncConfigSchema = z.object({
  backfillDefaultHistoryDays: z.coerce.number().int().positive().default(365),
  requeueDelayMs: z.coerce.number().int().positive().default(1_800_000),
  cliWaitTimeoutMs: z.coerce.number().int().positive().default(14_400_000),
  removeOnCompleteCount: z.coerce.number().int().positive().default(200),
  removeOnFailCount: z.coerce.number().int().positive().default(500),
  tickEnabled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  optionCoverageThreshold: z.coerce.number().min(0).max(1).default(1),
});

export type MarketdataSyncConfig = z.infer<typeof MarketdataSyncConfigSchema>;

export const marketdataSyncConfig = registerAs(
  'marketdataSync',
  (): MarketdataSyncConfig =>
    MarketdataSyncConfigSchema.parse({
      backfillDefaultHistoryDays: process.env.MARKETDATA_BACKFILL_HISTORY_DAYS,
      requeueDelayMs: process.env.MARKETDATA_SYNC_REQUEUE_DELAY_MS,
      cliWaitTimeoutMs: process.env.MARKETDATA_CLI_WAIT_TIMEOUT_MS,
      removeOnCompleteCount: process.env.MARKETDATA_SYNC_REMOVE_ON_COMPLETE_COUNT,
      removeOnFailCount: process.env.MARKETDATA_SYNC_REMOVE_ON_FAIL_COUNT,
      tickEnabled: process.env.MARKETDATA_TICK_ENABLED,
      optionCoverageThreshold: process.env.MARKETDATA_OPTION_COVERAGE_THRESHOLD,
    }),
);
