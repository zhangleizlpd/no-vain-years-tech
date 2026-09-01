import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupEmptyDb } from '../_support/isolated-db';
import { runMigrateDeploy } from '../_support/run-migrate';
import { PrismaService } from '../../src/security/prisma.service';
import { COLD_START_CAPABILITY } from '../../src/marketdata/anchor-cold-start.rules';
import { computeNext } from '../../src/marketdata/sync-tick-driver';

// 066 T04 港股期权三维度 seed + 依赖边 IT (FR-015, plan §A1)。
//
// ## 为什么用 `setupEmptyDb()` + 自己跑 `migrate deploy`
//
// 本 task 的被测对象**就是那份 migration**。共享 PG 的模板克隆 (`setupIsolatedDb()`) 拿到的
// 是「migration 已经跑完」的库 —— 断言照样绿, 但绿的是模板, 不是本片新写的 SQL。⇒ 走
// `optionsdesk-045.schema.it.spec.ts` 那一档: 空库 + `runMigrateDeploy()`, 顺带把 verify ④
// 「migration 在空库单向可用」也一并验掉 (跑不通就在 beforeAll 当场炸)。
//
// ## 三行为什么必须是独立维度而不是给现有维度扩 scope (plan §A1)
//
// `session-clock.ts` 的 `exchangeCalendarDateForScope` 在 scope 内各市场算出的日历日不同时
// **直接 throw**, 而该 throw 存在的目的就是禁止这种混用 (北京 06:00 时 us=D-1 而 hk=D)。
// 即使绕过它, 第二个坑仍在: tick payload 无 `markets` 字段 ⇒ 混 scope 维度的工作集恒为全
// scope, 港股休市而美股开市的日子会对港股全量发请求。
// 📌 反过来 `{cn,hk}` **不会抛** (现役 `eod_bar` 就是这个 scope) —— 判据是「算出来的日期
//    相同」而非「时区字符串相同」。所以下面断的是 `market_scope` **恰为** `['hk']`。
describe('066 T04 港股期权三维度 seed (Testcontainers PG migrate deploy)', () => {
  let prisma: PrismaService;
  let db: Awaited<ReturnType<typeof setupEmptyDb>>;

  const HK_CHAIN = 'hk_option_contract';
  const HK_SNAPSHOT = 'hk_option_daily_snapshot';
  const HK_IV = 'hk_underlying_iv_daily';

  /**
   * `hk_underlying_iv_daily.history_depth` (自然日)。
   *
   * 🚨 **这个值是一条性质的载体, 不是一个可调参数**: 单个 vendor 窗 (≤364 天) 港股只返 244
   * 个交易日, 不足 `IVP_MIN_WINDOW_TRADING_DAYS = 252` ⇒ 只拉一年会让分位**恒为**
   * `insufficient_window` 且**不报错**。1095 保证回填跨 ≥2 窗。
   * 同一个值在 `underlying-iv.rules.spec.ts` 的 `HK_HISTORY_DEPTH_DAYS` (066 T08) 也钉了一遍
   * —— 那边钉「单窗给不出 252」, 这边钉「维度行确实配到了跨窗的深度」, 两边缺一都留缺口。
   */
  const HK_HISTORY_DEPTH_DAYS = 1095;

  beforeAll(async () => {
    db = await setupEmptyDb();
    process.env.DATABASE_URL = db.databaseUrl;

    runMigrateDeploy();

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  it('三行落 marketdata.sync_dimension, `market_scope` 恰为 {hk} (不掺 us ⇒ 不撞 scope 日历 throw)', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_CHAIN, HK_SNAPSHOT, HK_IV] } },
      orderBy: { dimensionKey: 'asc' },
    });
    expect(rows.map((r) => r.dimensionKey)).toEqual([HK_CHAIN, HK_SNAPSHOT, HK_IV]);
    for (const row of rows) {
      expect(row.marketScope).toEqual(['hk']);
      expect(row.vendor).toBe('futu');
    }
  });

  // 🚫 本片解决港股期权的方式**只能**是新增三行, MUST NOT 给任何**采集**维度的 market_scope
  // 加 'hk' 凑合 —— 采集本体 (`sync-option-contract` / `sync-option-snapshot` /
  // `dimension-executor`) 直接调 `exchangeCalendarDateForScope`, 它在 scope 内各市场算出的
  // 日历日不同时**直接 throw** (北京 06:00 时 us=D-1 而 hk=D)。
  //
  // 📌 `universe` 是**合法例外**且必须留在白名单里: 它的 scope 就是 {cn,hk,us}, 而它是覆盖式
  //    meta 维度 —— asOf 不往任何一行上盖日戳, scope 只是给交易日闸用的元数据。
  //    `resolveAsOfForDimension` 对这类跨时区 scope **刻意回落宿主日而不是抛** (极性与
  //    `exchangeCalendarDateForScope` 相反, 见 sync-asof.rules.ts 那段注释)。
  // ⇒ 断的是**白名单快照**: 混 {us,hk} 的维度集合恰为 {universe}。多出任何一个名字都是本片
  //    最想防的那种改法 (「给 eod_bar / option_contract 扩个 scope 就完事」)。
  it('🚫 混 {us,hk} 的维度集合恰为 {universe} —— 没有任何采集维度被顺手扩了 scope', async () => {
    const mixed = await prisma.syncDimension.findMany({
      where: { marketScope: { hasEvery: ['us', 'hk'] } },
      select: { dimensionKey: true },
      orderBy: { dimensionKey: 'asc' },
    });
    expect(mixed.map((r) => r.dimensionKey)).toEqual(['universe']);
  });

  it('链发现: batch_size 1 (get_option_chain 是单 code 接口) + history_depth NULL (链无回填语义)', async () => {
    const row = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: HK_CHAIN },
    });
    expect(row.enabled).toBe(true);
    expect(row.batchSize).toBe(1);
    expect(row.historyDepth).toBeNull();
  });

  it('快照行: batch_size 400 (官方批量上限) + history_depth NULL (期权 EOD 无跨日补救)', async () => {
    const row = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: HK_SNAPSHOT },
    });
    expect(row.batchSize).toBe(400); // get_option_snapshot 官方批量上限, 别套 /kline 那个兜底值
    expect(row.historyDepth).toBeNull(); // 期权 EOD 无跨日补救, 漏采即永久缺口
  });

  // ── 066 T06 verify ⑦: 两个开关的机械断言 (FR-016a) ────────────────────────────────────
  //
  // 🚨 `COLD_START_CAPABILITY.hk`(**建锚路径**) 与 `hk_option_daily_snapshot.enabled`
  // (**夜间 cron 路径**) 是**彼此独立的两条路**: 冷启动直调采集本体, **不读**采集维度的启用位
  // (全仓实证: 冷启动编排对 `sync_dimension` 零引用) ⇒ 只翻其一, 两条路的行为当场分叉 ——
  // 只翻能力表 = 建锚补得到、当晚 cron 一行都不采; 只翻维度行 = cron 采得到、新锚建完是空的。
  // 而**两种分叉都不报错**, 只是某一条路默默什么都没做。
  //
  // 📌 判据写成「两者同真同假」而不是各断各的 `true`: 前者对「将来有人只改一处」也红, 后者
  // 只对「改错了值」红。seed 那份 `enabled = false` (T04) 与今天这份 `true` 都能被它守住。
  it('🚨 FR-016a 能力表的 hk 两档与 `hk_option_daily_snapshot.enabled` **同真同假**', async () => {
    const row = await prisma.syncDimension.findUniqueOrThrow({
      where: { dimensionKey: HK_SNAPSHOT },
    });
    const capability = COLD_START_CAPABILITY.hk;

    // 两档同开同关 —— 中间态 `{chain:true, snapshot:false}` 会让冷启动第 7 步的 chain-only
    // 早退抢在盘中闸 / `no_option_chain` / 落库复判之前 (排序铁律 5)。
    expect(capability.optionChain).toBe(capability.optionSnapshot);
    // 建锚路径与夜间 cron 路径**同真同假**。
    expect(row.enabled).toBe(capability.optionSnapshot);
    // 钉住当下这一档的取值本身 (T06 = 两条路都开)。
    expect(row.enabled).toBe(true);
  });

  it('🚨 标的 IV: history_depth 恰为 1095 —— 单个 364 天窗港股只返 244 个交易日, 不足 252', async () => {
    const row = await prisma.syncDimension.findUniqueOrThrow({ where: { dimensionKey: HK_IV } });
    expect(row.enabled).toBe(true);
    expect(row.historyDepth).toBe(HK_HISTORY_DEPTH_DAYS);
    expect(row.batchSize).toBe(500);
  });

  // FR-015 的机械断言。🚨 **不写死字符串比对** —— `expect(cronExpr).toBe('0 0 23 * * *')`
  // 会在有人把 cron 改成 `0 0 21 * * *` 时…… 红, 但红得毫无信息量; 更糟的是它对
  // `0 0 23 * * 1-5`(只跑工作日) 这类改动同样红, 而那根本不违反本 FR。这里断的是**性质**:
  // 下一触发时刻落在同日 22:00 之后、次日 00:00 之前。
  //
  // 22:00 是仓里既有的港股锚点 (`eod_bar` + 18 个理杏仁 cn/hk 维度全在这一刻)。
  //
  // 🚨 **原本写在这里的理由已被证伪, 留痕防回潮**: 曾写「BullMQ worker concurrency=1 ⇒ 那批
  //    要占用队列一段时间, 23:00 是给它留的余量」。实测那批跑到**次日 00:34:57**, 港股三维
  //    连续三晚执行在午夜后 (issue #210) ⇒ 「错峰留余量」这个前提从来没成立过。
  //    真正的解法是拆 vendor lane (#210 PR-1), 不是把 cron 再往后挪 —— 后者正是
  //    `cross-timezone-date-semantics.md` 那条 📌「别指望把 cron 挪到安全时刻」禁止的动作。
  //    本例仍然有价值: 它守的是**下界** (港股 OI 21:30 定稿) 与**上界** (不许溢出到次日)。
  // 🚨 **073 起本例只管 `hk_underlying_iv_daily` 一行。**
  //
  // 链发现与快照已于 073 前移到 **16:20** (收盘直后抢做市商还没撤走的盘口, 实测 23:00 那一档
  // 收租召回集 45.2% 的腿拿不到买价、16:2x 只有 11.5%)。它们的新窗口断言在
  // `marketdata-073.two-round.it.spec.ts` —— **判据换了, 不是这条被放宽了**: 那边守的下界是
  // 「收盘定稿缓冲解除」(16:10) 而不是本例的「22:00 锚点之后」, 两条窗口互不包含。
  // 📌 IV 那行留在 23:00 是条件项 (073 FR-017/T013): 该字段 vendor 侧盘中分钟级更新, 前移的
  //    前提是探针证明 16:2x 的读数已定型。结论落地前本例继续守着它。
  it('FR-015 标的 IV 行 cron 的下一触发时刻晚于同日 22:00 (Shanghai)、早于次日 00:00', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: HK_IV },
      select: { dimensionKey: true, cronExpr: true },
    });
    expect(rows).toHaveLength(1);

    // 取一个「当天 22:00 之前」的时刻当 now, 让 computeNext 一定落在同一个自然日内。
    // 2026-08-24 是周一 (非交易日会不会跑由 tick 的交易日闸管, 与 cron 表达式无关)。
    const now = new Date('2026-08-24T04:00:00Z'); // 12:00 Asia/Shanghai
    const sameDay2200 = new Date('2026-08-24T14:00:00Z'); // 22:00 Asia/Shanghai
    const nextDay0000 = new Date('2026-08-24T16:00:00Z'); // 次日 00:00 Asia/Shanghai

    for (const row of rows) {
      const next = computeNext(row.cronExpr, now);
      expect(
        next.getTime(),
        `${row.dimensionKey} 的 cron "${row.cronExpr}" 触发早于同日 22:00 —— 会与 22:00 那批抢 concurrency=1 的队列`,
      ).toBeGreaterThan(sameDay2200.getTime());
      expect(
        next.getTime(),
        `${row.dimensionKey} 的 cron "${row.cronExpr}" 溢出到次日 —— 业务日期会整体错位一天`,
      ).toBeLessThan(nextDay0000.getTime());
    }
  });

  // #210 的承重断言: 链发现与快照必须落在**同一个 tick**。
  //
  // 🚨 它们之间那条 `sync_dependency` 边**只在同一 tick 内生效** (ADR-0049 §3) —— 两端 cron
  //    差 30 分钟时会分进两棵 flow 树, `assertEdgesExpressible` 见到一端不在链里就整段跳过,
  //    于是这条边**从上线至今一次都没装配过**, 而且全绿。合进同一 tick 是它生效的**前提**。
  // 📌 断的是「下一触发时刻相同」这个性质, 不是字符串相等 —— 将来两者一起改成别的时刻
  //    (只要仍在窗口内) 本例不该红。
  it('#210 链发现与快照的下一触发时刻相同 (同 tick, 否则那条依赖边根本装不上)', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_CHAIN, HK_SNAPSHOT] } },
      select: { dimensionKey: true, cronExpr: true },
    });
    expect(rows).toHaveLength(2);
    const now = new Date('2026-08-24T04:00:00Z'); // 12:00 Asia/Shanghai
    const byKey = new Map(rows.map((r) => [r.dimensionKey, computeNext(r.cronExpr, now)]));
    expect(
      byKey.get(HK_SNAPSHOT)?.getTime(),
      '链发现与快照不同 tick ⇒ 分进两棵 flow 树 ⇒ 依赖边静默失效 (#210 的根因之一)',
    ).toBe(byKey.get(HK_CHAIN)?.getTime());
  });

  it('依赖边: universe→链发现 / universe→标的 IV 为 soft; 链发现→快照 #210 起也是 soft', async () => {
    const edges = await prisma.syncDependency.findMany({
      where: { downstream: { in: [HK_CHAIN, HK_SNAPSHOT, HK_IV] } },
      select: { upstream: true, downstream: true, mode: true },
      orderBy: [{ downstream: 'asc' }, { upstream: 'asc' }],
    });
    expect(edges).toEqual([
      // universe→* 全 soft 是第一道拦截 (017 先例): 标的须先注册才有 instrument_id 可挂,
      // 但 universe 缺席/失败不该拖垮它们。
      { upstream: 'universe', downstream: HK_CHAIN, mode: 'soft' },
      // 🚨 #210 由 hard 降 soft。原意「无合约表即无从取快照 ⇒ 链发现失败必须断下游」对**美股**
      // 仍然成立并保留, 但港股**零补救** (`OptionSnapshotRemediation` 的 US_MARKET_SCOPE=['us'],
      // 且 `history_depth = NULL` —— vendor 不给历史交易日的期权快照) ⇒ 漏采即**永久缺口**。
      // fail-closed 会把「漏几张当天新挂牌的合约」换成「整晚全丢且不可回补」, 方向反了。
      // ⚠️ 尤其挡的是链发现**专有**的硬失败路径 (`gapCheckExpiryDates` 对账 diff 非空直接
      //    throw) —— 那时 futu 是好的、快照本来完全采得到。
      // 📌 顺序不受影响: soft 边同样给 Kahn 前驱, 快照仍排在链发现之后。
      { upstream: HK_CHAIN, downstream: HK_SNAPSHOT, mode: 'soft' },
      { upstream: 'universe', downstream: HK_IV, mode: 'soft' },
    ]);
  });

  // (#210 后那条边已降 soft, 相邻性不再是硬要求; 但「不给快照多加前驱」这条仍然照旧 ——
  //  它的工作集来自合约表而不是 Instrument, 连一条 universe 边本就是语义错误。)
  it('🚨 快照刻意没有 universe 边 —— 它的工作集来自合约表, 不是 Instrument', async () => {
    const count = await prisma.syncDependency.count({
      where: { upstream: 'universe', downstream: HK_SNAPSHOT },
    });
    expect(count).toBe(0);
  });

  it('纯 seed 无 DDL: 三行的 priority 与 047 美股期权同档 (相邻性守卫在 dimension-executor.spec.ts)', async () => {
    const rows = await prisma.syncDimension.findMany({
      where: { dimensionKey: { in: [HK_CHAIN, HK_SNAPSHOT, HK_IV] } },
      select: { dimensionKey: true, priority: true, freshnessProfile: true, slaHours: true },
    });
    for (const row of rows) {
      expect(row.priority).toBe(5);
      expect(row.freshnessProfile).toBe('continuous-daily');
      expect(row.slaHours).toBe(26);
    }
  });
});
