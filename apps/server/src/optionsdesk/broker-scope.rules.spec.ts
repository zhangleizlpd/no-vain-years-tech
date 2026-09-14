import { describe, expect, it } from 'vitest';
import { parseBrokerCode } from './broker-code.rules';
import { inBrokerScope } from './broker-scope.rules';

/**
 * `broker-scope.rules.ts` 纯单测 (082 T006, plan D6; FR-005 / FR-006 / FR-014)。
 *
 * 🚨 本文件最重要的一臂是 ④: 正股未解析 ⇒ 恒保留。写反不报错, 只让判不出正股的成交 / 订单 /
 * 持仓在 `anchored` 范围下被**静默丢掉** —— 而 FR-006 要求它们落库并标未解析。
 *
 * 锚集由调用方组装 (锚表**全部**行, 含被标 `excluded` 的, plan D6 / U8); 本函数不接触 excluded 概念。
 *
 * 定向变异 (out-of-test sabotage, testing.md §7.1):
 *   改坏: 未解析分支 `return true` 改为 `return false`
 *   结果 (2026-09-14 实跑): 1 failed | 6 passed —— 只有 ④ 红;
 *         还原后 `cmp` 与备份逐字节相同, 7/7 绿
 *   复跑: pnpm nx test server src/optionsdesk/broker-scope.rules.spec.ts --skip-nx-cache
 */

const ANCHORS: ReadonlySet<string> = new Set(['us:PDD', 'hk:00700', 'us:BRK.B']);
const ACCOUNT_ID = 1n;

describe('inBrokerScope — 范围判定单点 (state_branches 1–4)', () => {
  it('① anchored + 正股在锚集 ⇒ true (branch 1)', () => {
    expect(
      inBrokerScope({
        scope: 'anchored',
        anchoredTickers: ANCHORS,
        underlyingTicker: 'us:PDD',
        accountId: ACCOUNT_ID,
      }),
    ).toBe(true);
  });

  it('② anchored + 正股不在锚集 ⇒ false (branch 2)', () => {
    expect(
      inBrokerScope({
        scope: 'anchored',
        anchoredTickers: ANCHORS,
        underlyingTicker: 'us:BABA',
        accountId: ACCOUNT_ID,
      }),
    ).toBe(false);
  });

  it('③ full + 正股不在锚集 ⇒ true (branch 3)', () => {
    expect(
      inBrokerScope({
        scope: 'full',
        anchoredTickers: ANCHORS,
        underlyingTicker: 'us:BABA',
        accountId: ACCOUNT_ID,
      }),
    ).toBe(true);
  });

  it('🚨 ④ anchored + 正股未解析 (null) ⇒ true, 锚集为空时同样保留 (branch 4, FR-006)', () => {
    for (const anchoredTickers of [ANCHORS, new Set<string>()]) {
      expect(
        inBrokerScope({
          scope: 'anchored',
          anchoredTickers,
          underlyingTicker: null,
          accountId: ACCOUNT_ID,
        }),
      ).toBe(true);
    }
  });

  it('full + 未解析 ⇒ true', () => {
    expect(
      inBrokerScope({
        scope: 'full',
        anchoredTickers: ANCHORS,
        underlyingTicker: null,
        accountId: ACCOUNT_ID,
      }),
    ).toBe(true);
  });
});

describe('inBrokerScope — ticker 形态与锚一致', () => {
  it('⑤ 锚集含 `us:BRK.B` 时, 券商码 `US.BRK.B` 解析出的正股命中', () => {
    const parsed = parseBrokerCode('US.BRK.B');
    const underlyingTicker = parsed?.kind === 'stock' ? parsed.ticker : null;
    expect(underlyingTicker).toBe('us:BRK.B');
    expect(
      inBrokerScope({
        scope: 'anchored',
        anchoredTickers: ANCHORS,
        underlyingTicker,
        accountId: ACCOUNT_ID,
      }),
    ).toBe(true);
  });

  it('accountId 现阶段不参与判定: 换账号结论不变 (master §12-A4 预留)', () => {
    const base = {
      scope: 'anchored',
      anchoredTickers: ANCHORS,
      underlyingTicker: 'us:BABA',
    } as const;
    expect(inBrokerScope({ ...base, accountId: 1n })).toBe(
      inBrokerScope({ ...base, accountId: 2n }),
    );
  });
});
