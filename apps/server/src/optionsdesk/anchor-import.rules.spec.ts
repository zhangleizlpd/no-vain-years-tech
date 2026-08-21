import { describe, expect, it } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import {
  ANCHOR_CONFIDENCE_MAX,
  ANCHOR_CONFIDENCE_MIN,
  ANCHOR_CREATE_INVALID_PREFIX,
  ANCHOR_IMPORT_INVALID_PREFIX,
  IMPORTABLE_MARKETS,
  INVALID_ANCHOR_MARKET_CODE,
  INVALID_ANCHOR_TICKER_CODE,
  INVALID_IMPORT_CONFIDENCE_CODE,
  INVALID_IMPORT_MARKET_CODE,
  INVALID_IMPORT_TICKER_CODE,
  assertCreatableTicker,
  assertImportableConfidence,
  assertImportableTicker,
} from './anchor-import.rules';

/**
 * 059 T002 —— 导入通道的输入校验 (FR-003 / FR-004 / FR-005)。
 *
 * 🚨 **一律拒而非归一**: 导入方是程序, 收到 400 就该改自己的输出; 静默归一 (`AOS` → `us:AOS`,
 * `us:pep` → `us:PEP`) 会把上游 bug 藏起来, 而藏起来的形态是「锚建出来了、行情永远为空」。
 */
describe('anchor-import.rules — 标的写法 (FR-003 / FR-005)', () => {
  it('canonical `market:code` 放行 (美股 / 港股 / 带点代码)', () => {
    expect(() => assertImportableTicker('us:AOS')).not.toThrow();
    expect(() => assertImportableTicker('hk:00700')).not.toThrow();
    expect(() => assertImportableTicker('us:BRK.B')).not.toThrow();
  });

  it('无市场前缀 (`AOS`) → 拒', () => {
    // 失败形态不是报错而是**静默**: 归一放行的话锚会建成功, 而行情投影按 `market:code` 找不到
    // 它 ⇒ 永远没有行情的僵尸锚, 且与「标的尚未采集」在界面上不可区分 (plan §7)。
    expect(() => assertImportableTicker('AOS')).toThrow(INVALID_IMPORT_TICKER_CODE);
  });

  it('后缀式 (`PEP.US`) → 拒 —— 不认第二种写法', () => {
    expect(() => assertImportableTicker('PEP.US')).toThrow(INVALID_IMPORT_TICKER_CODE);
  });

  it('代码段小写 (`us:pep`) → 拒, MUST NOT 悄悄大写化', () => {
    expect(() => assertImportableTicker('us:pep')).toThrow(INVALID_IMPORT_TICKER_CODE);
  });

  it('市场段大写 (`US:PEP`) → 拒 —— 市场段是小写 canonical', () => {
    expect(() => assertImportableTicker('US:PEP')).toThrow(INVALID_IMPORT_TICKER_CODE);
  });

  it('市场越界 (`cn:600519`) → 拒, 且原因与「写法不合规」可区分 (SC-006)', () => {
    expect(() => assertImportableTicker('cn:600519')).toThrow(INVALID_IMPORT_MARKET_CODE);
  });

  it('空代码 / 空市场 / 空串 → 拒', () => {
    expect(() => assertImportableTicker('us:')).toThrow(INVALID_IMPORT_TICKER_CODE);
    expect(() => assertImportableTicker(':AOS')).toThrow(INVALID_IMPORT_TICKER_CODE);
    expect(() => assertImportableTicker('')).toThrow(INVALID_IMPORT_TICKER_CODE);
  });

  it('超过锚表 ticker 列宽 → 拒 (别让它穿透到 PG 变成 22001)', () => {
    expect(() => assertImportableTicker(`us:${'A'.repeat(30)}`)).toThrow(
      INVALID_IMPORT_TICKER_CODE,
    );
  });

  it('白名单本期恰是美股 / 港股 (FR-005)', () => {
    expect([...IMPORTABLE_MARKETS]).toEqual(['us', 'hk']);
  });
});

describe('anchor-import.rules — 置信度值域 (FR-004)', () => {
  it('闭区间两端放行 (量表含 0 与满分)', () => {
    expect(() => assertImportableConfidence(String(ANCHOR_CONFIDENCE_MIN))).not.toThrow();
    expect(() => assertImportableConfidence(String(ANCHOR_CONFIDENCE_MAX))).not.toThrow();
  });

  it('区间内的非整值放行 (模型可出 8.5)', () => {
    expect(() => assertImportableConfidence('8.5')).not.toThrow();
    expect(() => assertImportableConfidence(new Prisma.Decimal('9.25'))).not.toThrow();
  });

  it('越界 (999) → **可捕获的校验失败**, MUST NOT 穿透到 PG 变 numeric overflow (FR-004)', () => {
    expect(() => assertImportableConfidence('999')).toThrow(INVALID_IMPORT_CONFIDENCE_CODE);
  });

  it('负值 → 拒', () => {
    expect(() => assertImportableConfidence('-1')).toThrow(INVALID_IMPORT_CONFIDENCE_CODE);
  });

  it('非数字 → 拒 (Decimal 构造异常也折成同一个校验失败, 不外泄 vendor 报错)', () => {
    expect(() => assertImportableConfidence('高')).toThrow(INVALID_IMPORT_CONFIDENCE_CODE);
    expect(() => assertImportableConfidence('')).toThrow(INVALID_IMPORT_CONFIDENCE_CODE);
  });
});

/**
 * 065 T02 —— 建锚入口复用同一套判据, 但**标签另起**且顺带把市场段交回给写侧。
 *
 * 建锚失败报「IMPORT」读起来是错的; 而 059 的码有 IT 在断言 ⇒ 不能改它。重复的只是错误
 * 字符串 (无害), 判据仍单点在 {@link assertImportableTicker} —— 会漂的是那个, 不是字符串。
 */
describe('anchor-import.rules — 建锚侧 assertCreatableTicker (065 FR-013 / FR-014)', () => {
  it('合法 ticker 返回市场段 —— 写侧据此写列, MUST NOT 再解析第二次', () => {
    expect(assertCreatableTicker('us:AOS')).toBe('us');
    expect(assertCreatableTicker('hk:00700')).toBe('hk');
    expect(assertCreatableTicker('us:BRK.B')).toBe('us');
  });

  it('失败标签换成 INVALID_ANCHOR_*', () => {
    expect(() => assertCreatableTicker('AOS')).toThrow(INVALID_ANCHOR_TICKER_CODE);
    expect(() => assertCreatableTicker('us:')).toThrow(INVALID_ANCHOR_TICKER_CODE);
    expect(() => assertCreatableTicker('us:BRK:B')).toThrow(INVALID_ANCHOR_TICKER_CODE);
    expect(() => assertCreatableTicker('cn:600519')).toThrow(INVALID_ANCHOR_MARKET_CODE);
  });

  it('**只换前缀**: message 体与 059 侧逐字相同 (判据单点的直接证据)', () => {
    const grab = (fn: () => void): string => {
      try {
        fn();
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    };
    for (const bad of ['AOS', 'us:pep', 'us:BRK:B', 'cn:600519']) {
      const importMsg = grab(() => assertImportableTicker(bad));
      const createMsg = grab(() => assertCreatableTicker(bad));
      expect(importMsg).not.toBe('');
      expect(createMsg).toBe(
        importMsg.replace(ANCHOR_IMPORT_INVALID_PREFIX, ANCHOR_CREATE_INVALID_PREFIX),
      );
    }
  });
});
