import { describe, it, expect } from 'vitest';
import { projectMarkets, normalizeClientNo, buildBrokerAccountList } from './portfolio.rules';

// 011 T003 + ADR-0046: portfolio 纯函数投影 (单行 active_markets 模型)。
describe('portfolio.rules', () => {
  describe('projectMarkets', () => {
    it('null (新用户无行) → 投影默认 {cn:active, hk/us:inactive} + 海外 6 恒 inactive', () => {
      const out = projectMarkets(null);
      expect(out).toHaveLength(9);
      const byCode = Object.fromEntries(out.map((m) => [m.marketCode, m]));
      expect(byCode['cn'].active).toBe(true);
      expect(byCode['hk'].active).toBe(false);
      expect(byCode['us'].active).toBe(false);
      for (const m of out.filter((x) => x.group === 'overseas')) {
        expect(m.active).toBe(false);
        expect(m.v1Available).toBe(false);
      }
    });

    it('激活集 ["cn","hk"] → 该集核心 active, 余核心 inactive', () => {
      const byCode = Object.fromEntries(projectMarkets(['cn', 'hk']).map((m) => [m.marketCode, m]));
      expect(byCode['cn'].active).toBe(true);
      expect(byCode['hk'].active).toBe(true);
      expect(byCode['us'].active).toBe(false);
    });

    it('海外码误入集合 (历史脏数据) → 读侧仍按字典强制 inactive', () => {
      const jp = projectMarkets(['jp']).find((m) => m.marketCode === 'jp');
      expect(jp?.active).toBe(false);
    });

    it('空集 [] (min-1 实际不可达) → 全核心 inactive (文档化边界)', () => {
      const byCode = Object.fromEntries(projectMarkets([]).map((m) => [m.marketCode, m]));
      expect(byCode['cn'].active).toBe(false);
      expect(byCode['hk'].active).toBe(false);
      expect(byCode['us'].active).toBe(false);
    });

    it('投影固定顺序 (字典 order)', () => {
      expect(projectMarkets(null).map((m) => m.marketCode)).toEqual([
        'cn',
        'hk',
        'us',
        'jp',
        'sg',
        'my',
        'ca',
        'au',
        'kr',
      ]);
    });
  });

  // 012 T003: 客户号归一 (FR-S07 宽松 + 禁控制/零宽/行分隔符, 不强制格式不限长)。
  describe('normalizeClientNo', () => {
    it('正常号 → trim 后明文返回', () => {
      expect(normalizeClientNo('  31190002466  ')).toBe('31190002466');
      expect(normalizeClientNo('A1B2-C3')).toBe('A1B2-C3');
    });

    it('trim 后空 / 纯空白 → 抛 INVALID_CLIENT_NO', () => {
      expect(() => normalizeClientNo('')).toThrow(/INVALID_CLIENT_NO/);
      expect(() => normalizeClientNo('   ')).toThrow(/INVALID_CLIENT_NO/);
    });

    it('含控制 / 零宽 / 行分隔符 → 抛 INVALID_CLIENT_NO', () => {
      // 不可见字符用 fromCharCode 构造 (literal/\uXXXX 写进源码会坏 parser,
      // per memory author_invisible_chars_via_fromcharcode)。
      const NUL = String.fromCharCode(0x00);
      const ZWSP = String.fromCharCode(0x200b); // 零宽空格
      const LSEP = String.fromCharCode(0x2028); // 行分隔符
      const BOM = String.fromCharCode(0xfeff);
      expect(() => normalizeClientNo(`123${NUL}456`)).toThrow(/INVALID_CLIENT_NO/);
      expect(() => normalizeClientNo(`123${ZWSP}456`)).toThrow(/INVALID_CLIENT_NO/);
      expect(() => normalizeClientNo(`123${LSEP}456`)).toThrow(/INVALID_CLIENT_NO/);
      expect(() => normalizeClientNo(`${BOM}123`)).toThrow(/INVALID_CLIENT_NO/); // BOM (trim 前查)
    });

    it('不限长上限 (各券商格式不一) → 长号通过', () => {
      const long = '9'.repeat(200);
      expect(normalizeClientNo(long)).toBe(long);
    });
  });

  // 012 T003: 合成默认账户置顶虚拟条目 + merge brokerName (OQ3 读侧虚拟派生)。
  describe('buildBrokerAccountList', () => {
    const acct = 42n;

    it('空行 → 仅默认账户置顶 (isDefault, id=accountId, brokerCode/clientNo/createdAt=null)', () => {
      const out = buildBrokerAccountList([], acct);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({
        id: '42',
        brokerCode: null,
        brokerName: '默认账户',
        clientNo: null,
        isDefault: true,
        createdAt: null,
      });
    });

    it('有行 → 默认置顶 (index 0) + 已绑按入参序 + brokerName merge + raw clientNo + ISO createdAt', () => {
      const d1 = new Date('2026-06-01T08:00:00.000Z');
      const d2 = new Date('2026-06-02T09:30:00.000Z');
      const out = buildBrokerAccountList(
        [
          { id: 1001n, brokerCode: 'htai', clientNo: '31190002466', createdAt: d1 },
          { id: 1002n, brokerCode: 'zxzq', clientNo: '888', createdAt: d2 },
        ],
        acct,
      );
      expect(out).toHaveLength(3);
      expect(out[0].isDefault).toBe(true);
      expect(out[1]).toEqual({
        id: '1001',
        brokerCode: 'htai',
        brokerName: '华泰证券',
        clientNo: '31190002466',
        isDefault: false,
        createdAt: d1.toISOString(),
      });
      expect(out[2].brokerName).toBe('中信证券');
      expect(out[2].clientNo).toBe('888'); // raw, 不脱敏
    });

    it('未知 brokerCode (防御) → brokerName 回退为 code 本身 (非 null, DTO 非 nullable)', () => {
      const out = buildBrokerAccountList(
        [
          {
            id: 1n,
            brokerCode: 'xxxx',
            clientNo: '1',
            createdAt: new Date('2026-06-01T00:00:00.000Z'),
          },
        ],
        acct,
      );
      expect(out[1].brokerName).toBe('xxxx');
    });
  });
});
