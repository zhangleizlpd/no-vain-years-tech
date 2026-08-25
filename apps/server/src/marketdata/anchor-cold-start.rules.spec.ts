import { describe, expect, it } from 'vitest';
import { COLD_START_CAPABILITY, COLD_START_OUTCOME } from './anchor-cold-start.rules.js';

/*
 * 🚫 **本文件曾经还测 `resolveSnapshotSpec`（快照三元组决策表 + 与 remediation 的等值回归）。**
 * #187 起那个函数已退役 —— 它与 #181 新增的 `resolveSnapshotAttribution` 是两份同源判据。
 * 决策表的用例在 `snapshot-session-attribution.rules.spec.ts`（含盘中拒绝那一档，本文件从来
 * 没有过）；等值回归搬去了 `option-snapshot-remediation.spec.ts`，那才是它钉的东西的所在地。
 */

describe('COLD_START_CAPABILITY —— FR-024 一处显式登记', () => {
  it('us 两档齐开: 链与快照都走**直调本体**, 日线不在表内', () => {
    // 🚫 日线曾以 `us_equity_bar` 出现在本表 (issue #159 前): 建锚那一刻
    //    `CreateAnchorUseCase.seedLastClose` 已同步调过 `EnsureLatestEodBarUseCase`,
    //    而 `optionsdesk.anchor` 全仓只有一个 create 点 ⇒ 冷启动再补一遍是重复劳动。
    expect(COLD_START_CAPABILITY.us).toEqual({ optionChain: true, optionSnapshot: true });
  });

  it('🚨 066 T06 起 hk 两档全开 —— MUST NOT 停在 `{chain:true, snapshot:false}` 中间态', () => {
    // 中间态会让第 7 步的 chain-only 早退 (`return backfilled`) 抢在**盘中闸 /
    // `no_option_chain` 判断 / 落库复判**之前, 三条验收同时破: 盘中建的港股锚会落
    // `backfilled` 而一行快照都没有、无期权的票落不到 `no_option_chain`、采集没落库也照样
    // 报「已补齐」。⇒ 两档要么全关要么全开。
    expect(COLD_START_CAPABILITY.hk).toEqual({ optionChain: true, optionSnapshot: true });
  });

  it('未登记市场取不到表项 —— 与「登记了但全关」同样落 market_not_enabled, 但不静默', () => {
    expect(COLD_START_CAPABILITY.cn).toBeUndefined();
  });
});

// 📌 计数口径说明: 066 的 `FR-014` 写的是「由 8 扩到 9」—— 那个 8 是 `FR-027` 当初的**原始
// 八档**, 没把后来 `FR-027a` 补的 `backfill_incomplete` 算进去。代码里的基线因此是 9,
// 加上本片的 `no_option_chain` 是 **10**。差的那一档是记账口径, 不是漏了一个值。
describe('COLD_START_OUTCOME —— FR-027 结局零折叠 (SC-009); 066 FR-014 起十种', () => {
  it('恰好十种且取值两两互异', () => {
    const values = Object.values(COLD_START_OUTCOME);
    expect(values).toHaveLength(10);
    expect(new Set(values).size).toBe(10);
  });

  it('「没做」与「做了但失败」不共用取值', () => {
    expect(COLD_START_OUTCOME.INTRADAY_SKIPPED).not.toBe(COLD_START_OUTCOME.RETRY_EXHAUSTED);
    expect(COLD_START_OUTCOME.MARKET_NOT_ENABLED).not.toBe(COLD_START_OUTCOME.RETRY_EXHAUSTED);
    expect(COLD_START_OUTCOME.ALREADY_PRESENT).not.toBe(COLD_START_OUTCOME.BACKFILLED);
  });

  it('🚨 「已补齐」与「做了但没补上」MUST NOT 共用取值 (FR-027a)', () => {
    // 折叠这两个 = 唯一能发现永久缺口的那条按结局分组的查询失明。
    expect(COLD_START_OUTCOME.BACKFILLED).not.toBe(COLD_START_OUTCOME.BACKFILL_INCOMPLETE);
    // 也 MUST NOT 与「重试耗尽」混为一谈: 后者还有重试语义, 前者是终态、只等人工。
    expect(COLD_START_OUTCOME.BACKFILL_INCOMPLETE).not.toBe(COLD_START_OUTCOME.RETRY_EXHAUSTED);
    // VarChar(32) 列宽兜底。
    for (const v of Object.values(COLD_START_OUTCOME)) expect(v.length).toBeLessThanOrEqual(32);
  });

  it('🚨 066 FR-014 「无挂牌期权」与「做了但没补上」MUST NOT 共用取值', () => {
    // 前者是「本就没有可做的」(终态、非错误、不告警), 后者是「该做没做成」(ERROR 级、需人工
    // 介入)。港股绝大多数标的没有挂牌期权 (实测颐海国际 0 / 网龙 0 个到期日) —— 折进
    // backfill_incomplete 会让每一只无期权的港股锚都产出一条无从处理的告警。
    expect(COLD_START_OUTCOME.NO_OPTION_CHAIN).not.toBe(COLD_START_OUTCOME.BACKFILL_INCOMPLETE);
    // 也不是「已补齐」—— 什么都没补, 只是本就无从补。
    expect(COLD_START_OUTCOME.NO_OPTION_CHAIN).not.toBe(COLD_START_OUTCOME.BACKFILLED);
    // 也不是「该市场未开通」—— 那条说的是系统侧没开, 这条说的是标的侧没有。
    expect(COLD_START_OUTCOME.NO_OPTION_CHAIN).not.toBe(COLD_START_OUTCOME.MARKET_NOT_ENABLED);
    // 零 migration 的前提: `anchor_cold_start_run.outcome` 是 VarChar(32) 且无 CHECK 约束。
    expect(COLD_START_OUTCOME.NO_OPTION_CHAIN.length).toBeLessThanOrEqual(32);
  });
});
