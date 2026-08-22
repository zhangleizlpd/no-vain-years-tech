import { describe, it, expect } from 'vitest';
import { ANCHOR_GATED_MARKETS } from './anchor-driven-sync-gate.js';
import { DIMENSION_KEYS } from './dimension-executor.js';
import {
  ANCHOR_SCOPED_DIMENSIONS,
  anchoredCodesForScope,
  isAnchorScopedDimension,
} from './anchor-scoped-dimensions.rules.js';

// 066 T02 锚作用域维度登记表 (FR-006 / FR-007 / FR-008, plan §A3)。
// Small / 零外部依赖 / 与源码 colocate (体例同 `optionsdesk/radar-cursor.spec.ts`):
// 被测面是一张常量表 + 两个纯函数, 库侧行为 (工作集真查询) 归
// `test/integration/marketdata-066.anchor-scoped-workset.it.spec.ts`。
describe('066 T02 锚作用域维度登记表', () => {
  describe('表本身', () => {
    it('登记港美两侧全部 per-code 期权 / IV 维度 —— 港股三行**先于** T04 的 seed 登记', () => {
      expect([...ANCHOR_SCOPED_DIMENSIONS].sort()).toEqual([
        'hk_option_contract',
        'hk_option_daily_snapshot',
        'hk_underlying_iv_daily',
        'option_contract',
        'option_daily_snapshot',
        'underlying_iv_daily',
      ]);
    });

    it('🚨 日线 / 市场级维度**不在**表里 —— 它们的判据归采集闸, 不归锚集 (SC-004 的前提)', () => {
      for (const key of ['eod_bar', 'us_equity_bar', 'universe', 'profile'] as const) {
        expect(isAnchorScopedDimension(key)).toBe(false);
      }
      // 这两个压根不走 loadWorkingSet (工作集 = 固定常量 / 市场级接口), 挂锚闸零收窄作用。
      expect(isAnchorScopedDimension('us_index_daily')).toBe(false);
      expect(isAnchorScopedDimension('earnings_event')).toBe(false);
    });

    it('已注册的美股三行都是真维度键 (拼错 = 静默退回旧判据, 不会红)', () => {
      const known = new Set<string>(DIMENSION_KEYS);
      for (const key of ['underlying_iv_daily', 'option_contract', 'option_daily_snapshot']) {
        expect(known.has(key)).toBe(true);
      }
    });

    it('🚨 成对约束: `hk` **MUST NOT** 出现在 ANCHOR_GATED_MARKETS —— 关闸路径放到 cn/hk 会把全部在市标的移出工作集', () => {
      expect([...ANCHOR_GATED_MARKETS]).toEqual(['us']);
    });
  });

  describe('anchoredCodesForScope', () => {
    it('按市场分组, 只保留 scope 内的市场', () => {
      const grouped = anchoredCodesForScope(['us:AOS', 'hk:00700', 'cn:600519'], ['hk']);
      expect([...grouped]).toEqual([['hk', ['00700']]]);
    });

    it('多市场 scope 各自成组 —— 不拍平, 防跨市场同 code 误命中', () => {
      const grouped = anchoredCodesForScope(['us:00700', 'hk:00700'], ['us', 'hk']);
      expect(grouped.get('us')).toEqual(['00700']);
      expect(grouped.get('hk')).toEqual(['00700']);
    });

    it('同一 market:code 的多只锚去重 (锚按用户 / 方法可多条, 工作集是标的集)', () => {
      expect(anchoredCodesForScope(['hk:00700', 'hk:00700'], ['hk']).get('hk')).toEqual(['00700']);
    });

    it('不可解析的 ticker 静默跳过 (同闸侧口径), 零锚 / 全越界 ⇒ 空 Map', () => {
      expect([...anchoredCodesForScope(['00700', ':', 'hk:'], ['hk'])]).toEqual([]);
      expect([...anchoredCodesForScope([], ['hk'])]).toEqual([]);
      expect([...anchoredCodesForScope(['us:AOS'], ['hk'])]).toEqual([]);
    });

    it('code 侧允许含冒号 (按**首个**冒号切, 同 parseGateTicker)', () => {
      expect(anchoredCodesForScope(['us:BRK:B'], ['us']).get('us')).toEqual(['BRK:B']);
    });
  });
});
