import { describe, it, expect } from 'vitest';
import { DEFAULT_OPERATOR, exitCodeOf, parseSymbolChangeArgs } from './symbol-change.cli';

// 086 T014 修正 CLI 纯函数层: argv 解析 + 「无 --confirm ⇒ preview」+ 退出码判定。
// 编排本身的写入 / 幂等走 Testcontainers IT (optionsdesk-086.remediate.it.spec.ts)。

const BASE = ['us', 'PSKY', 'SKYD', '2026-09-15', '--evidence', 'https://example.test/notice 1'];

describe('parseSymbolChangeArgs', () => {
  it('apply 不带 --confirm ⇒ mode=preview, operator 取默认', () => {
    expect(parseSymbolChangeArgs(['apply', ...BASE])).toEqual({
      kind: 'remediate',
      direction: 'remediate',
      market: 'us',
      oldCode: 'PSKY',
      newCode: 'SKYD',
      effectiveDate: '2026-09-15',
      evidence: 'https://example.test/notice 1',
      operator: DEFAULT_OPERATOR,
      mode: 'preview',
    });
  });

  it('apply --confirm ⇒ mode=apply; --operator 覆盖默认; 旗标可插在位置参数之间', () => {
    expect(
      parseSymbolChangeArgs([
        'apply',
        'us',
        '--confirm',
        'PSKY',
        '--operator',
        'me',
        'SKYD',
        '2026-09-15',
        '--evidence',
        'x',
      ]),
    ).toMatchObject({ mode: 'apply', operator: 'me', oldCode: 'PSKY', newCode: 'SKYD' });
  });

  it('revert ⇒ direction=revert, 同样默认 preview', () => {
    expect(parseSymbolChangeArgs(['revert', ...BASE])).toMatchObject({
      direction: 'revert',
      mode: 'preview',
    });
  });

  it('list [market]', () => {
    expect(parseSymbolChangeArgs(['list'])).toEqual({ kind: 'list' });
    expect(parseSymbolChangeArgs(['list', 'hk'])).toEqual({ kind: 'list', market: 'hk' });
  });

  it('candidates [--all] / dismiss <id> --note (T019)', () => {
    expect(parseSymbolChangeArgs(['candidates'])).toEqual({ kind: 'candidates', all: false });
    expect(parseSymbolChangeArgs(['candidates', '--all'])).toEqual({
      kind: 'candidates',
      all: true,
    });
    expect(parseSymbolChangeArgs(['dismiss', '12', '--note', '非改名'])).toEqual({
      kind: 'dismiss',
      candidateId: 12n,
      note: '非改名',
    });
  });

  it('apply --from-candidate: 不带 --confirm ⇒ preview; --new 可选 (缺省由候选建议补)', () => {
    const argv = ['apply', '--from-candidate', '7', '--effective', '2026-09-15', '--evidence', 'x'];
    expect(parseSymbolChangeArgs(argv)).toEqual({
      kind: 'from-candidate',
      candidateId: 7n,
      effectiveDate: '2026-09-15',
      evidence: 'x',
      operator: DEFAULT_OPERATOR,
      mode: 'preview',
    });
    expect(parseSymbolChangeArgs([...argv, '--new', 'SKYD', '--confirm'])).toMatchObject({
      newCode: 'SKYD',
      mode: 'apply',
    });
  });

  it('无参数 / --help / -h ⇒ help', () => {
    expect(parseSymbolChangeArgs([])).toEqual({ kind: 'help' });
    expect(parseSymbolChangeArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseSymbolChangeArgs(['apply', '-h'])).toEqual({ kind: 'help' });
  });

  it.each([
    ['未知子命令', ['rename', ...BASE]],
    ['位置参数不足', ['apply', 'us', 'PSKY', 'SKYD', '--evidence', 'x']],
    ['缺 --evidence', ['apply', 'us', 'PSKY', 'SKYD', '2026-09-15']],
    ['--evidence 空白', ['apply', 'us', 'PSKY', 'SKYD', '2026-09-15', '--evidence', ' ']],
    ['--evidence 无取值', ['apply', 'us', 'PSKY', 'SKYD', '2026-09-15', '--evidence']],
    ['非法市场', ['apply', 'jp', 'PSKY', 'SKYD', '2026-09-15', '--evidence', 'x']],
    ['日期格式错', ['apply', 'us', 'PSKY', 'SKYD', '2026/09/15', '--evidence', 'x']],
    ['新旧码相同', ['apply', 'us', 'PSKY', 'PSKY', '2026-09-15', '--evidence', 'x']],
    ['未知旗标', ['apply', ...BASE, '--force']],
    ['list 非法市场', ['list', 'jp']],
    ['dismiss 缺 --note', ['dismiss', '12']],
    ['dismiss id 非正整数', ['dismiss', 'abc', '--note', 'x']],
    ['from-candidate 缺 --effective', ['apply', '--from-candidate', '7', '--evidence', 'x']],
    [
      'from-candidate 带位置参数',
      ['apply', 'us', '--from-candidate', '7', '--effective', '2026-09-15', '--evidence', 'x'],
    ],
    ['revert 不接 --from-candidate', ['revert', ...BASE, '--from-candidate', '7']],
    ['candidates 不接 --note', ['candidates', '--note', 'x']],
  ])('非法输入 (%s) ⇒ throw', (_label, argv) => {
    expect(() => parseSymbolChangeArgs(argv)).toThrow();
  });
});

describe('exitCodeOf', () => {
  const line = (status: 'ok' | 'skipped' | 'failed' | 'conflict') => ({
    step: 's',
    status,
    detail: '',
  });

  it('末行 ok / skipped ⇒ 0', () => {
    expect(exitCodeOf([line('skipped'), line('ok')])).toBe(0);
    expect(exitCodeOf([line('ok'), line('skipped')])).toBe(0);
  });

  it('末行 failed / conflict ⇒ 1; 空报告 ⇒ 1', () => {
    expect(exitCodeOf([line('ok'), line('failed')])).toBe(1);
    expect(exitCodeOf([line('conflict')])).toBe(1);
    expect(exitCodeOf([])).toBe(1);
  });
});
