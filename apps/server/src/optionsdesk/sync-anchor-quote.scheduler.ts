import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SyncAnchorQuoteUseCase, type SyncAnchorQuoteReport } from './sync-anchor-quote';

/** 无行情锚的日志列举上限 —— 超出只报计数, 免把 12 只以上的名单刷进每日日志。 */
const NO_DATA_SAMPLE_LIMIT = 10;

/**
 * `SyncAnchorQuoteUseCase` 的**触发器**。
 *
 * 🚨 **为什么补这个**: 045 T012 只定义了投影**怎么算**+ 单测怎么验, plan D4 只写了**为什么必须
 * 投影**与单向纪律 —— 两处都没定义「谁在什么时候调它」。结果 `SyncAnchorQuoteUseCase` 在 prod
 * 从未被执行 (全仓引用只有 module 的 `providers` 注册 + 自身 spec + 雷达 IT), `last_close` /
 * `last_close_date` 恒 `null`, 而雷达的**距 W%**(主指标兼默认排序键) / `zone` / 「跌破 W」SQL 端
 * 筛选 / 复核锚红标状态机**全部以它为操作数** ⇒ M1「每天看谁进击球区」实际出不了真值。
 * IT 里是测试自己 `new SyncAnchorQuoteUseCase(prisma)` 再 `execute()`, 所以测试全绿也照不出这洞。
 *
 * 🚨 **方向铁律 —— 触发器必须落在 optionsdesk 侧**: 投影是 optionsdesk **读** marketdata
 * (CROSS-CONTEXT-READ, catalog Q7-B)。挂到 marketdata 的 executor 做 post-step 会让**底座依赖
 * 业务**, 方向反了 (与 `anchor-driven-sync-gate.ts` 那条「marketdata 主动拉锚表」正好互为镜像,
 * 两条都是「消费方主动拉」)。塞进雷达读路径则是把写操作放进只读 GET。
 *
 * **时点: 每小时 `:30` (Asia/Shanghai)** —— 蓄意**不与任何上游 cron 时点绑定**。
 *
 * 🚨 原先是 `0 30 6 * * *`, 理由是「排在 `us_equity_bar` (`0 0 6 * * *`) 之后」, 并附带一条
 * 「改那个维度的 `cron_expr` 时必须回来核这个时点」的人肉 invariant。**该设计在多市场下站不住**:
 * `last_close` 的上游供给方**按市场分裂** —— us 走 `us_equity_bar` (06:00), 而 cn/hk 走
 * `eod_bar` (22:00)。一个固定时点不可能同时排在两者之后; 按 06:30 走, hk 锚的收盘价要滞后到
 * **次日 06:30** 才进锚表 (hk 16:00 收盘 → 22:00 才落 bar), 而雷达的距 W% / zone / 跌破 W
 * 全以它为操作数。
 *
 * 🚨 更硬的一条 —— **上游耗时有长尾且在漂**。2026-08-17 prod 取证 (`marketdata.sync_run`):
 * 22:00 夜间批严格串行 (BullMQ concurrency=1), 22:00 → 次日 00:00-00:10; 其中 `eod_bar` 的
 * 真实完成时刻 = 08-05 `22:15` / 08-06 `22:13` / 08-12 `22:15` / 08-13 `22:25` / 08-14 `22:40`,
 * 最坏 08-07 `23:58` (那天 `failed=8145`)。⇒ **任何固定时点都是在赌一个正在变长的上游**,
 * 而赌输的形态正是本注释原先警告的那个: 静默投影出前一天的值。
 *
 * **为什么每小时是免费的** (三条性质本文件与 use case 早已具备, 非本次新增):
 * 零外部 IO (只读 `daily_bar`, 无 vendor 调用) · **幂等** (`isSameProjection` 值未变不写 ⇒
 * no-op 轮次零写库) · 不接交易日闸 (见下条)。成本 = 24 轮/天 × O(锚数) 次只读查询, 锚数上限
 * 约 1000 (spec Assumptions), 当前十几条。
 *
 * ⇒ 上游何时落库**不再需要被任何人知道**: `eod_bar` 22:15 完就 22:30 那轮接上, 漂到 23:58 就
 * 00:30 接上, us 的 06:00 仍由 06:30 那轮接上 (每小时 `:30` 天然包含原时点, us 行为逐字不变)。
 * **那条人肉 invariant 随之作废** —— 本文件不再与任何维度的 `cron_expr` 耦合。
 *
 * **不接交易日闸**: 投影只是把库里已有的 bar 抄到锚表, 非交易日跑就是一轮零变更 (值未变不写,
 * use case 内 `isSameProjection` 短路) —— 为省这点开销引一条日历依赖不划算。
 *
 * 降级: 整轮 try/catch, 异常只 `logger.error` **不上抛** —— scheduler 抛异常 = 进程级
 * unhandledRejection; 且投影是 R2 档缓存, 挂一轮的代价是「距 W% 陈旧一天」而非数据丢失
 * (下一轮自动追上, 与采集类维度「漏一天即永久缺口」性质完全不同)。
 */
@Injectable()
export class SyncAnchorQuoteScheduler {
  private readonly logger = new Logger(SyncAnchorQuoteScheduler.name);

  /**
   * 上一轮 no-data 名单的指纹 —— 同一份名单**只在变化时报一次**。
   *
   * 🚨 **不删这条 warn、也不降级成 debug**: 它是「锚已建但标的从未被采集」(EC-15) 唯一的运维
   * 出口 (FR-017 的运维侧兑现)。但改成每小时跑之后, 原实现会把同一份名单**每天重报 24 次**,
   * 而**假警报会训练人无视整份报告** —— 那等于把这条 warn 亲手作废。故按内容去重, 语义不变。
   *
   * 进程重启后首轮必报一次 (初值 `null` ≠ 任何名单指纹) —— 这是**要的**行为: 重启后运维视野
   * 清零, 该重新说一遍。
   */
  private lastNoDataSignature: string | null = null;

  constructor(private readonly syncAnchorQuote: SyncAnchorQuoteUseCase) {}

  @Cron('0 30 * * * *', { timeZone: 'Asia/Shanghai' })
  async handleCron(): Promise<void> {
    await this.run();
  }

  /** 一轮投影; 失败返 `null` (已记 ERROR log)。单测直调本方法, 不依赖 ScheduleModule。 */
  async run(): Promise<SyncAnchorQuoteReport | null> {
    try {
      const report = await this.syncAnchorQuote.execute();
      const noData = report.projections.filter((p) => !p.hasData).map((p) => p.ticker);

      this.logger.log(
        `anchor quote projection: ${JSON.stringify({
          scanned: report.scanned,
          updated: report.updated,
          noData: noData.length,
        })}`,
      );

      // FR-017「显式 no-data 不隐藏」的运维侧兑现: 锚已建但标的从未被采集 (EC-15) 在 UI 上是
      // 「行情不可用」一行小字, 不 log 出来就没人会主动去翻。列举截断避免刷屏。
      // 按名单内容去重 (见 `lastNoDataSignature`): 每小时跑 ⇒ 不去重就是每天 24 条同样的 warn。
      const signature = noData.join(',');
      if (noData.length > 0 && signature !== this.lastNoDataSignature) {
        const shown = noData.slice(0, NO_DATA_SAMPLE_LIMIT).join(',');
        const more =
          noData.length > NO_DATA_SAMPLE_LIMIT
            ? ` (+${noData.length - NO_DATA_SAMPLE_LIMIT} more)`
            : '';
        this.logger.warn(`anchor quote no-data: ${shown}${more}`);
      }
      this.lastNoDataSignature = signature;

      return report;
    } catch (err) {
      this.logger.error(
        `anchor quote projection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
