import { describe, it, expect } from 'vitest';
import { buildPostObjectCredential } from '../integrations/oss/oss-policy.js';
import {
  InvalidSymbolError,
  RESEARCH_KEY_LEAF,
  RESEARCH_KEY_PREFIX,
  buildObjectKey,
  looksLikePdf,
  normalizeSymbol,
  titleFromFilename,
} from './research-report.rules.js';

describe('normalizeSymbol — 归一到 canonical market:code', () => {
  it.each([
    ['hk:1698', 'hk:01698'],
    ['HK:1698', 'hk:01698'],
    ['hk:01698', 'hk:01698'],
    ['1698.HK', 'hk:01698'],
    ['HK.01698', 'hk:01698'],
    ['  hk:1698  ', 'hk:01698'],
    ['700.hk', 'hk:00700'],
  ])('%s → %s（HK 补零到 5 位，与仓内 canonical 一致）', (raw, expected) => {
    expect(normalizeSymbol(raw)).toBe(expected);
  });

  it.each([
    ['cn:600519', 'cn:600519'],
    ['600519.SH', 'cn:600519'],
    ['CN.600519', 'cn:600519'],
  ])('%s → %s（A 股 6 位）', (raw, expected) => {
    expect(normalizeSymbol(raw)).toBe(expected);
  });

  it.each([
    ['us:pep', 'us:PEP'],
    ['PEP.US', 'us:PEP'],
    ['us:PEP', 'us:PEP'],
    // ticker 自身带点（BRK.B / BF.B 这类）不能被当成市场分隔符切开。
    ['us:brk.b', 'us:BRK.B'],
    ['BRK.B.US', 'us:BRK.B'],
  ])('%s → %s（美股代码转大写）', (raw, expected) => {
    expect(normalizeSymbol(raw)).toBe(expected);
  });

  it('反例：百分号编码 hk%3A1698 被拒，且理由明说不要编码', () => {
    // `$arg_*` 在 nginx 侧不解码 ⇒ 编码过的值撞不上市场闸而 400。方向 fail-closed 安全，
    // 但不写明「不要编码」的话，agent 会反复试错烧限频（spec Edge Case）。
    expect(() => normalizeSymbol('hk%3A1698')).toThrow(InvalidSymbolError);
    try {
      normalizeSymbol('hk%3A1698');
    } catch (err) {
      expect((err as InvalidSymbolError).reason).toBe('percent-encoded');
      expect((err as InvalidSymbolError).message).toContain('不要');
    }
  });

  it('反例：一次给多个标的 hk:1698,us:PEP 被拒', () => {
    expect(() => normalizeSymbol('hk:1698,us:PEP')).toThrow(InvalidSymbolError);
  });

  it('反例：市场不在 cn|hk|us 白名单', () => {
    expect(() => normalizeSymbol('jp:7203')).toThrow(InvalidSymbolError);
    expect(() => normalizeSymbol('7203.JP')).toThrow(InvalidSymbolError);
    try {
      normalizeSymbol('jp:7203');
    } catch (err) {
      expect((err as InvalidSymbolError).reason).toBe('market');
    }
  });

  it.each(['', '   ', 'hk:', ':1698', 'hk', '1698', 'hk:16 98', 'hk:16#98'])(
    '反例：形态非法 %j 被拒',
    (raw) => {
      expect(() => normalizeSymbol(raw)).toThrow(InvalidSymbolError);
    },
  );

  it('反例：HK 代码超过 5 位被拒（补零只补短的，不截长的）', () => {
    expect(() => normalizeSymbol('hk:123456')).toThrow(InvalidSymbolError);
  });

  it('归一是幂等的（再归一一次结果不变）', () => {
    const once = normalizeSymbol('1698.HK');
    expect(normalizeSymbol(once)).toBe(once);
  });
});

describe('looksLikePdf — 判据基于内容而非文件名', () => {
  it('以 %PDF- 开头 → true', () => {
    expect(looksLikePdf(Buffer.from('%PDF-1.4\n...'))).toBe(true);
  });

  it('反例：PNG 字节（哪怕文件名叫 .pdf）→ false', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(looksLikePdf(png)).toBe(false);
  });

  it('反例：内容里晚一点才出现 %PDF- 不算（魔数必须在开头）', () => {
    expect(looksLikePdf(Buffer.from('xx%PDF-1.4'))).toBe(false);
  });

  it('反例：比魔数还短的字节不越界读', () => {
    expect(looksLikePdf(Buffer.from('%PD'))).toBe(false);
    expect(looksLikePdf(Buffer.alloc(0))).toBe(false);
  });
});

describe('titleFromFilename — 缺标题时的兜底', () => {
  it('去掉扩展名', () => {
    expect(titleFromFilename('某公司深度研报.pdf')).toBe('某公司深度研报');
    expect(titleFromFilename('report.PDF')).toBe('report');
  });

  it('吃掉工具链附加的 ---<uuid> 后缀', () => {
    expect(titleFromFilename('某公司深度研报---3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071.pdf')).toBe(
      '某公司深度研报',
    );
  });

  it('反例：正常标题里的连字符不被吃掉（只吃完整 uuid 那种后缀）', () => {
    expect(titleFromFilename('2026-08-01 某公司-中报点评.pdf')).toBe('2026-08-01 某公司-中报点评');
  });

  it('去干净后为空 → 给一个确定的兜底串，不返回空字符串', () => {
    expect(titleFromFilename('.pdf')).toBe('未命名研报');
    expect(titleFromFilename('---3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071.pdf')).toBe('未命名研报');
  });
});

describe('buildObjectKey — 位置由内容指纹单独导出', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  it('同字节 → 同一个 key（与投递方无关，这是共享对象成立的机制）', () => {
    // 函数签名里根本没有投递方这个参数 —— 断言的是这条设计事实本身。
    expect(buildObjectKey(HASH_A)).toBe(buildObjectKey(HASH_A));
    expect(buildObjectKey(HASH_A)).toBe(`${RESEARCH_KEY_PREFIX}${HASH_A}/${RESEARCH_KEY_LEAF}`);
  });

  it('不同字节 → 不同 key', () => {
    expect(buildObjectKey(HASH_A)).not.toBe(buildObjectKey(HASH_B));
  });

  it('key 落在 research/ 前缀内（RAM 策略的作用域就卡在这个前缀上）', () => {
    expect(buildObjectKey(HASH_A).startsWith('research/')).toBe(true);
  });

  it('与签名器算出的 objectKey 逐字节相同（两处不得各算各的）', () => {
    // 落库的 objectKey 取自签名器的产物，而本函数是「同字节同位置」那条语义的载体。
    // 两者一旦漂移，续做时的幂等重写就会写到另一个位置，且不会有任何东西报错。
    const cred = buildPostObjectCredential({
      region: 'oss-cn-shanghai',
      bucket: 'bucket',
      accessKeyId: 'AK',
      accessKeySecret: 'SK',
      keyPrefix: RESEARCH_KEY_PREFIX,
      keyLeaf: RESEARCH_KEY_LEAF,
      maxSizeBytes: 1,
      ttlMs: 60_000,
      now: new Date('2026-08-15T12:00:00.000Z'),
      uuid: HASH_A,
    });
    expect(cred.objectKey).toBe(buildObjectKey(HASH_A));
  });
});
