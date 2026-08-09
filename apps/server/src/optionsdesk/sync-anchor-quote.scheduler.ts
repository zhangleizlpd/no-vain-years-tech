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
 * **时点 06:30 (Asia/Shanghai)**: 排在 `us_equity_bar` 维度 (`0 0 6 * * *`) **之后** —— 那条是
 * `last_close` 的上游供给方, 先有 bar 才有得投影。实测该维度 12 只票约 23s 跑完, 30 分钟余量充裕。
 * ⚠️ 改 `us_equity_bar` 的 `cron_expr` 时**必须回来核这个时点**, 否则会静默投影出前一天的值。
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

  constructor(private readonly syncAnchorQuote: SyncAnchorQuoteUseCase) {}

  @Cron('0 30 6 * * *', { timeZone: 'Asia/Shanghai' })
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
      if (noData.length > 0) {
        const shown = noData.slice(0, NO_DATA_SAMPLE_LIMIT).join(',');
        const more =
          noData.length > NO_DATA_SAMPLE_LIMIT
            ? ` (+${noData.length - NO_DATA_SAMPLE_LIMIT} more)`
            : '';
        this.logger.warn(`anchor quote no-data: ${shown}${more}`);
      }

      return report;
    } catch (err) {
      this.logger.error(
        `anchor quote projection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
