import { describe, it, expect } from 'vitest';
import { checkMessages } from './check-commit-msg-parseable';

const msg = (body: string) => [{ label: 't', text: `feat(x): 主题\n\n${body}` }];

describe('checkMessages — release-please 文法可解析性', () => {
  it('正常 message 通过', () => {
    expect(checkMessages(msg('一段普通正文，没有奇怪的括号。'))).toEqual([]);
  });

  /**
   * 🚨 本文件的**承重用例**：下面这行是 `cbc66a3f`（047 M2b）的真实第 761 行，它让 server 的
   * Release PR 整个没起来。判据钉在**这行原文**上，而不是钉在「括号要配对」那种归纳出来的规则上
   * —— 起初就是按那个规则写的，全史扫描证明它既漏且误。
   */
  it('真实事故行（cbc66a3f:761）被拦下', () => {
    const line = '测试一律**从常量派生**而不是把数字换一个(窗数 = Math.ceil(视野/窗宽),';
    const [v] = checkMessages(msg(line));
    expect(v).toBeDefined();
    expect(v.error).toContain("unexpected token '('");
    expect(v.sourceLine).toBe(line);
    expect(v.line).toBe(3); // header + 空行 + 正文首行
  });

  /**
   * 触发条件是**行首**那串非空格字符紧跟 `(` —— 不是「括号没配对」，也不是「段首」。
   * 这两个更直觉的判据都被实测证伪过（`Math.ceil(a(b))` 完全配对照样炸；
   * `甲乙丙\n一个(窗数` 不在段首照样炸），所以这一组用例是**判据本身的回归网**。
   */
  describe('触发条件 = 行首非空格串紧跟左括号（实测，非推断）', () => {
    it.each([
      ['CJK 行首紧贴、同行不闭合', '一个(窗数'],
      ['ASCII 行首紧贴、同行不闭合', 'Math.ceil(x'],
      ['行首紧贴 + 同行嵌套：即使完全配对也拒绝', '一个(窗数 Math.ceil(x))'],
      ['非段首（无空行）的续行同样命中', '甲乙丙\n一个(窗数'],
    ])('❌ %s', (_name, body) => {
      expect(checkMessages(msg(body))).toHaveLength(1);
    });

    it.each([
      ['括号前留空格', '一个 (窗数'],
      ['改用全角括号', '一个（窗数'],
      ['行首直接起括号（前面没有词）', '(窗数 = Math.ceil(视野/窗宽),'],
      ['行首紧贴但同行闭合且不嵌套', '一个(窗数)后续'],
      ['括号不在行首 ⇒ 完全无害', '第二行有 一个(窗数 的问题'],
    ])('✅ %s', (_name, body) => {
      expect(checkMessages(msg(body))).toEqual([]);
    });
  });

  it('git 自动生成 / 临时 message 跳过（它们活不到 main）', () => {
    const generated = [
      "Merge remote-tracking branch 'origin/main' into feat/x",
      'Revert "feat(x): 主题"',
      'fixup! feat(x): 主题',
      'squash! feat(x): 主题',
    ].map((text) => ({ label: 't', text }));
    expect(checkMessages(generated)).toEqual([]);
  });

  it('violation 带定位信息，便于直接指出改哪一行', () => {
    const [v] = checkMessages(msg('第一行正常。\n一个(窗数 的问题'));
    expect(v.line).toBe(4);
    expect(v.column).toBeGreaterThan(0);
    expect(v.sourceLine).toBe('一个(窗数 的问题');
  });

  it('多条 message 各自独立判定', () => {
    const out = checkMessages([
      { label: 'ok', text: 'feat(x): a\n\n正常正文' },
      { label: 'bad', text: 'feat(x): b\n\n一个(窗数' },
    ]);
    expect(out.map((v) => v.label)).toEqual(['bad']);
  });
});
