import { describe, it, expect } from 'vitest';
import { classifyNoticeTitle, isResultsPublication } from './earnings-notice.rules.js';

const ALL = ['all'];

describe('classifyNoticeTitle — 会前通知信号 (FR-005, plan §D6)', () => {
  it.each([
    ['hk:00001', '董事會會議召開日期'],
    ['hk:00939', '董事會會議通告'],
    ['hk:00762', '董事會會議通知'],
    ['hk:06862', '董事會會議日期'],
    ['hk:01044', '董事會召開日期'],
    ['hk:02318', '更改董事會召開日期'],
    ['plan §D6 写法', '召開董事會的日期'],
    ['hk:00005', '2025年中期業績及審議會否派發2025年第二次股息'],
    ['hk:00005', '2025年第一季盈利公布及審議會否派發2025年第一次股息'],
    ['hk:01299', '董事會委任的委員會會議'],
    ['hk:09961', '審計委員會會議日期及2025年第三季度業績公告日期'],
    [
      'hk:09961',
      '( 1 ) 審計委員會會議日期及2024 年第四季度及全年業績公告日期及( 2 ) 有關現金股息的董事會決議日期',
    ],
    ['hk:09999', '董事會會議召開日期及2025年第二季度及上半年業績公告發佈日期'],
  ])('%s「%s」⇒ notice', (_code, title) => {
    expect(classifyNoticeTitle(title, ALL)).toBe('notice');
  });

  it.each([
    ['会后决议', '董事會會議決議公告'],
    ['会后决议 (A+H 海外監管)', '中國石油天然氣股份有限公司第九屆董事會第十一次會議決議公告'],
    ['董事名单', '董事會成員名單與其角色及職能'],
    ['董事名单', '董事名單及其角色與職能'],
    ['委员会工作细则', '提名與薪酬委員會工作細則'],
    ['委员会职权范围', '審核委員會 - 職權範圍'],
    ['委任', '委任代理主席'],
    ['强写法 + 余下文本含排除词', '董事會會議通知及委任獨立非執行董事'],
  ])('%s「%s」⇒ lookalike (不作信号, 只计数)', (_label, title) => {
    expect(classifyNoticeTitle(title, ALL)).toBe('lookalike');
  });

  it('业绩公告本身 (types 含 fs_main) 不作通知 —— 即使标题含通知写法', () => {
    expect(
      classifyNoticeTitle('2025年中期業績及審議會否派發2025年第二次股息', ['fs', 'fs_main']),
    ).toBe('other');
    expect(classifyNoticeTitle('截至2026年6月30日止六個月的中期業績公告', ['fs', 'fs_main'])).toBe(
      'other',
    );
  });

  it('无关公告 ⇒ other', () => {
    expect(classifyNoticeTitle('翌日披露報表', ['ndd_r'])).toBe('other');
  });
});

describe('isResultsPublication — 业绩刊发事实 (FR-004, plan §D6)', () => {
  it('🚨 hk:09992「…中期業績公告及授出獎勵之補充公告」⇒ 刊发 (補充窄排除)', () => {
    expect(
      isResultsPublication('截至2026年6月30日止六個月的中期業績公告及授出獎勵之補充公告', [
        'fs',
        'fs_main',
        'fs_s_a_m',
      ]),
    ).toBe(true);
  });

  it('「業績公佈」本体 + 補充 ⇒ 刊发', () => {
    expect(
      isResultsPublication('截至2025年6月30日止六個月的中期業績公佈之補充公佈', ['fs_main']),
    ).toBe(true);
  });

  it.each([
    ['年报补充', '有關截至2025年12月31日止年度之年報之補充公佈'],
    ['更正', '有關2025年度報告的更正公告'],
  ])('%s「%s」(不含業績公告本体) ⇒ 非刊发', (_label, title) => {
    expect(isResultsPublication(title, ['fs_main'])).toBe(false);
  });

  it('普通 fs_main 业绩公告 ⇒ 刊发', () => {
    expect(isResultsPublication('2025年中期業績', ['fs', 'fs_main'])).toBe(true);
  });

  it.each([
    ['A+H 海外監管季报', '2025年第一季度報告'],
    ['通知里的「業績公告日期」', '審計委員會會議日期及2025年第三季度業績公告日期'],
    ['通知里的「盈利公布」', '2025年第一季盈利公布及審議會否派發2025年第一次股息'],
  ])('🚫 types 不含 fs_main (%s) ⇒ 非刊发, 不按标题认 all 类', (_label, title) => {
    expect(isResultsPublication(title, ALL)).toBe(false);
  });
});

// spec Session（八）2a (FR-004 修订): types 无 fs_main、只有 fs 族标签时, 标题命中业绩标题规则 v3 才算刊发。
describe('isResultsPublication — fs 族标签 + 业绩标题规则 v3 (FR-004, spec Session（八）2a)', () => {
  const FS_FULL = ['fs', 'fs_full'];

  it.each([
    ['🚨 hk:09961 季度 + 上半年', '2025 年第二季度及上半年業績公告', FS_FULL],
    [
      '🚨 hk:09999 业绩公告 + 中期报告合刊 (本体覆盖「報告」排除)',
      '截至2025年6月30日止三個月及六個月之財務業績公告、第二季度股息公告及中期報告',
      FS_FULL,
    ],
    ['只有 fs、无任何子标签', '截至2026年6月30日止六個月的中期業績公告', ['fs']],
    ['只有 fs_ 子标签', '2025年全年業績公告', ['fs_full']],
    ['年度業績', '2025年度業績', ['fs']],
    ['简体', '2025年中期业绩公告', ['fs']],
    ['英文', 'Interim Results Announcement for the Six Months Ended 30 June 2025', FS_FULL],
    [
      '业绩公告本体 + 補充 (窄排除两路共用)',
      '截至2025年6月30日止六個月的中期業績公告之補充公告',
      ['fs'],
    ],
  ])('%s「%s」⇒ 刊发', (_label, title, types) => {
    expect(isResultsPublication(title, types)).toBe(true);
  });

  it('🚨 hk:01188 形态「澄清公佈…中期業績公佈」⇒ 钉为刊发 (标题含业绩公告本体; 同期只留最早一份, 澄清晚于本体不改公布日)', () => {
    expect(isResultsPublication('澄清公佈 - 截至2025年6月30日止六個月之中期業績公佈', ['fs'])).toBe(
      true,
    );
  });

  it.each([
    ['🚨 hk:00005 业绩报告 (无本体, 「報告」排除)', '2025年中期業績報告', FS_FULL],
    ['英文 report (无本体)', 'Interim Results Report 2025', FS_FULL],
    ['日期 (通知)', '2025年中期業績公告日期', ['fs']],
    ['董事會會議', '董事會會議 - 審批2025年中期業績', ['fs']],
    ['通函', '有關2025年度業績之通函', ['fs']],
    ['通告', '股東週年大會通告 - 省覽2025年度業績', ['fs']],
    ['延遲', '延遲刊發2025年度業績公告', ['fs']],
    ['英文 board meeting', 'Date of Board Meeting to Approve Interim Results', ['fs']],
    ['补充 (无本体)', '2025年中期業績之補充資料', ['fs']],
    ['标题不像业绩', '翌日披露報表', ['fs']],
  ])('%s「%s」⇒ 非刊发', (_label, title, types) => {
    expect(isResultsPublication(title, types)).toBe(false);
  });

  it.each([['all'], ['mr'], ['srp'], ['m_a_v']])(
    '🚫 族标签之外 (%s) 即使标题命中 v3 ⇒ 非刊发',
    (type) => {
      expect(isResultsPublication('2025 年第二季度及上半年業績公告', [type])).toBe(false);
    },
  );
});
