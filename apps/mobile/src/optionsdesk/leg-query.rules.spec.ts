// 053 T007 — 错峰闸 + 一致性 latch 的纯逻辑单测（FR-020 / FR-025，plan D-ASYNC-1 / D-CONSIST-1）。
// 渲染 / 提示位归 T010 Playwright e2e（本仓测试分层：vitest = 纯逻辑）。
import { describe, expect, it } from 'vitest';

import {
  legAsOfConsistent,
  legConsistencyStep,
  legQueryEnabled,
  type LegPerspectiveAsOf,
} from './leg-query.rules';

const settled = (asOf: string | null): LegPerspectiveAsOf => ({ settled: true, asOf });
/** 已落地但**没有成功响应**（读故障 / 无锚）—— 没有可比的业务日。 */
const failed: LegPerspectiveAsOf = { settled: true };
const inFlight: LegPerspectiveAsOf = { settled: false };

describe('legQueryEnabled（错峰，FR-025）', () => {
  it('首屏只开当前视角那一份 —— 其余两个 MUST 关着（并发三份约 670 kB 拖慢首屏）', () => {
    const gate = { current: 'all', primed: false } as const;
    expect(legQueryEnabled('all', gate, true)).toBe(true);
    expect(legQueryEnabled('build', gate, true)).toBe(false);
    expect(legQueryEnabled('rent', gate, true)).toBe(false);
  });

  it('当前视角落地后其余两个才开（后台补齐）', () => {
    const gate = { current: 'all', primed: true } as const;
    expect(legQueryEnabled('build', gate, true)).toBe(true);
    expect(legQueryEnabled('rent', gate, true)).toBe(true);
  });

  it('当前视角**无条件**开 —— 切到尚未落地的视角时它自己立刻开', () => {
    const gate = { current: 'rent', primed: false } as const;
    expect(legQueryEnabled('rent', gate, true)).toBe(true);
    expect(legQueryEnabled('all', gate, false)).toBe(false);
    expect(legQueryEnabled('build', gate, false)).toBe(false);
  });

  it('无 symbol ⇒ 三份全关（路由参数未就绪时不打空请求）', () => {
    const gate = { current: 'all', primed: true } as const;
    expect(legQueryEnabled('all', gate, false)).toBe(false);
    expect(legQueryEnabled('build', gate, false)).toBe(false);
  });
});

describe('legAsOfConsistent（FR-020 检测判据）', () => {
  it('有视角未落地 ⇒ 还判不了（null），MUST NOT 拿半份数据下结论', () => {
    expect(legAsOfConsistent([settled('2026-08-13'), inFlight, settled('2026-08-14')])).toBeNull();
  });

  it('三份同一业务日 ⇒ 一致', () => {
    expect(
      legAsOfConsistent([settled('2026-08-13'), settled('2026-08-13'), settled('2026-08-13')]),
    ).toBe(true);
  });

  it('跨过业务日切换点 ⇒ 不一致', () => {
    expect(
      legAsOfConsistent([settled('2026-08-13'), settled('2026-08-13'), settled('2026-08-14')]),
    ).toBe(false);
  });

  it('`null`（链未就绪）是一个值 —— 与有值的那两份并列即不一致', () => {
    expect(legAsOfConsistent([settled(null), settled('2026-08-13'), settled('2026-08-13')])).toBe(
      false,
    );
  });

  it('失败的视角不参与比较（FR-022 失败隔离）—— 一次读故障 MUST NOT 变成一轮重取', () => {
    expect(legAsOfConsistent([settled('2026-08-13'), failed, settled('2026-08-13')])).toBe(true);
    expect(legAsOfConsistent([failed, failed, settled('2026-08-13')])).toBe(true);
  });
});

describe('legConsistencyStep（latch，Guardrail 4）', () => {
  const mixed = [settled('2026-08-13'), settled('2026-08-13'), settled('2026-08-14')];
  const same = [settled('2026-08-13'), settled('2026-08-13'), settled('2026-08-13')];

  it('不一致且未闩 ⇒ 重取全部并置闩', () => {
    expect(legConsistencyStep(mixed, false)).toEqual({ action: 'refetch', latched: true });
  });

  it('🚨 **只重取一次** —— 已闩之后无论调多少次都只出显式提示，永不再重取', () => {
    let latched = false;
    const actions: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const step = legConsistencyStep(mixed, latched);
      actions.push(step.action);
      latched = step.latched;
    }
    expect(actions).toEqual(['refetch', 'warn', 'warn', 'warn', 'warn']);
    expect(actions.filter((action) => action === 'refetch')).toHaveLength(1);
  });

  it('重取在飞期间保持闩（还判不了 ⇒ 不动作、也不解闩）', () => {
    expect(legConsistencyStep([settled('2026-08-13'), inFlight, inFlight], true)).toEqual({
      action: 'none',
      latched: true,
    });
  });

  it('一致恢复即解闩 —— 换日 / 改水位之后真出现的第二次不一致仍修得了', () => {
    expect(legConsistencyStep(same, true)).toEqual({ action: 'none', latched: false });
    // 解闩之后再遇不一致 ⇒ 重新拿到那一次重取（而不是永久卡在提示态）。
    expect(legConsistencyStep(mixed, false)).toEqual({ action: 'refetch', latched: true });
  });
});
