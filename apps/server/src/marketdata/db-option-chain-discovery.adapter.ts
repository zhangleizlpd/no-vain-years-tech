import { Injectable } from '@nestjs/common';
import { PrismaService } from '../security/prisma.service.js';
import type { DimensionKey } from './dimension-executor.js';
import type { OptionChainDiscoveryPort } from './option-chain-discovery.port.js';

/**
 * 市场 → **该市场链发现维度的键**。类型钉成 {@link DimensionKey} ⇒ 维度改名时本表编译期红,
 * 不会静默指向一个不存在的 `sync_type` (那会让本 adapter 恒返 `null`, 而恒 `null` 是
 * fail-closed 的安全侧, **没有任何测试会红**)。
 *
 * 🚨 未登记的市场**不给默认值** —— 返 `null` 让调用方 fail-closed, 🚫 MUST NOT 猜一个键。
 */
const CHAIN_DISCOVERY_DIMENSION: Readonly<Record<string, DimensionKey>> = {
  us: 'option_contract',
  hk: 'hk_option_contract',
};

/**
 * `sync_run` 驱动的链发现进度 adapter (#361, `OPTION_CHAIN_DISCOVERY_PORT` 的 live 实现)。
 *
 * 它把「链发现有没有把工作集问全过」这件**本 ctx 的运行事实**摆到边界上, 好让 optionsdesk
 * 不必去翻 `sync_run` —— 那张表是本 ctx 的运维表, 消费方绑它的 schema 等于把选约表的状态语义
 * 绑在采集器的实现细节上 (bounded-context catalog Q7-B 明写直查是「临时」档)。
 *
 * 判据三条 (为什么是这三条、以及少一条会怎样, 见端口接口的注释, 那里是 canonical):
 * `status = 'success'` ∧ `skipped = 0` ∧ 取 `started_at`。
 */
@Injectable()
export class DbOptionChainDiscoveryAdapter implements OptionChainDiscoveryPort {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 复杂度: 单次索引扫 —— `ix_sync_run_type_started` 是 `(sync_type, started_at DESC)`,
   * 本查询按该前缀有序回溯, 直到撞上第一条同时满足 `status` / `skipped` 的行。稳态下最近一轮
   * 就命中 (k=1); 最坏情形是该维度连续多轮顺延, 扫过那几轮。**不落全表扫**。
   */
  async lastCompleteDiscoveryAt(market: string): Promise<Date | null> {
    const syncType = CHAIN_DISCOVERY_DIMENSION[market];
    if (syncType === undefined) return null;
    const row = await this.prisma.syncRun.findFirst({
      // 🚨 `skipped: 0` 与 `status: 'success'` **不是同一条判据**: 前者拦「限频顺延, 这一轮
      //    没问全」, 后者拦「有标的取数失败」。只写后者会让一只每晚都被顺延的锚被判成无期权。
      where: { syncType, status: 'success', skipped: 0 },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    return row?.startedAt ?? null;
  }
}
