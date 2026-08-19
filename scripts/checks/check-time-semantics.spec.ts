import { describe, expect, it } from 'vitest';
import { Project, type SourceFile } from 'ts-morph';
import { scanTimeSemantics } from './check-time-semantics';

/**
 * 🚨 **两条 Rule 各自双向反例**（同 `check-trading-day-read.spec.ts` 的纪律）。
 *
 * 只测「违规被拒」的门禁，在 AST 判据写错时会**静默放行一切且 CI 全绿** —— 门禁看起来还在岗、
 * 实际已经死了，而它死掉的那天恰好没人会知道。故每条 Rule 都必须同时有：
 * ① 违规样例被拒（判据有牙）② 合规样例放行（判据没把好人也咬了）。
 */

/** 把 {path: content} 喂进 in-memory ts-morph，返回 SourceFile[]。 */
function mk(files: Record<string, string>): SourceFile[] {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [path, content] of Object.entries(files)) project.createSourceFile(path, content);
  return project.getSourceFiles();
}

const rules = (sf: SourceFile[]): string[] => scanTimeSemantics(sf).map((v) => v.rule);

describe('Rule A — 市场时区表不得有第二份', () => {
  it('✅ 单点自己就是那张表 → 放行', () => {
    const sf = mk({
      '/apps/server/src/marketdata/session-clock.ts': `
        const EXCHANGE_TIME_ZONE: Record<string, string> = {
          cn: 'Asia/Shanghai', hk: 'Asia/Hong_Kong', us: 'America/New_York',
        };`,
    });
    expect(scanTimeSemantics(sf)).toHaveLength(0);
  });

  it('✅ 盘中时段表是另一件事, 同样放行 (两张表刻意分开)', () => {
    const sf = mk({
      '/apps/server/src/marketdata/market-session.rules.ts': `
        const MARKET_SESSION = {
          cn: { timeZone: 'Asia/Shanghai' }, us: { timeZone: 'America/New_York' },
        };`,
    });
    expect(scanTimeSemantics(sf)).toHaveLength(0);
  });

  it('🚨 别处冒出第二张 market→时区表 → timezone-table-duplicated', () => {
    const sf = mk({
      '/apps/server/src/alert/some-new.processor.ts': `
        const TZ: Record<string, string> = { cn: 'Asia/Shanghai', us: 'America/New_York' };`,
    });
    expect(rules(sf)).toEqual(['timezone-table-duplicated']);
  });

  it('✅ 单个时区字面量放行 —— @Cron 的 tz 是 processing-time 轴, 与市场无关', () => {
    // = alert-eval.processor.ts / option-snapshot-remediation.ts 的现状形状。
    const sf = mk({
      '/apps/server/src/marketdata/option-snapshot-remediation.ts': `
        class R {
          @Cron('0 0 8 * * *', { timeZone: 'Asia/Shanghai' }) a() {}
          @Cron('0 0 18 * * *', { timeZone: 'Asia/Shanghai' }) b() {}
        }`,
    });
    expect(scanTimeSemantics(sf)).toHaveLength(0);
  });

  it('✅ vendor 时间戳解析的单个时区常量放行 (L3 轴要求逐端点各自确认 offset)', () => {
    // = futu-option-snapshot.adapter.ts 的现状形状。
    const sf = mk({
      '/apps/server/src/marketdata/futu-option-snapshot.adapter.ts': `
        const VENDOR_UPDATE_TIME_ZONE = 'America/New_York';`,
    });
    expect(scanTimeSemantics(sf)).toHaveLength(0);
  });
});

describe('Rule B — 禁绕过词表裸做时区换算', () => {
  it('🚨 裸 Intl.DateTimeFormat({ timeZone }) → raw-timezone-conversion', () => {
    const sf = mk({
      '/apps/server/src/alert/some-new.usecase.ts': `
        function today(now: Date) {
          return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
        }`,
    });
    expect(rules(sf)).toEqual(['raw-timezone-conversion']);
  });

  it('✅ 走词表 → 放行', () => {
    const sf = mk({
      '/apps/server/src/alert/some-new.usecase.ts': `
        import { userToday } from '../marketdata/session-clock.js';
        function today(now: Date) { return userToday(now); }`,
    });
    expect(scanTimeSemantics(sf)).toHaveLength(0);
  });

  it('✅ 不带 timeZone 的 Intl.DateTimeFormat 放行 (那是纯格式化, 不是时区换算)', () => {
    const sf = mk({
      '/apps/server/src/chat/fmt.ts': `
        const f = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short' });`,
    });
    expect(scanTimeSemantics(sf)).toHaveLength(0);
  });

  it('✅ vendor adapter 放行 —— 解析 vendor 时间戳本就该逐端点自己确认 offset', () => {
    const sf = mk({
      '/apps/server/src/marketdata/futu-option-snapshot.adapter.ts': `
        const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });`,
    });
    expect(scanTimeSemantics(sf)).toHaveLength(0);
  });

  it('📌 存量豁免那三处放行 —— 它们是账单不是白名单, 解除条件见常量注释', () => {
    const sf = mk({
      '/apps/server/src/chat/system-prompt.rules.ts': `
        const f = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai' });`,
      '/apps/server/src/optionsdesk/create-anchor.usecase.ts': `
        const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });`,
      '/apps/server/src/portfolio/holdings-import.controller.ts': `
        const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });`,
    });
    expect(scanTimeSemantics(sf)).toHaveLength(0);
  });

  it('🚨 豁免只认那三个具体文件 —— 同 ctx 换个文件照样被拒 (不是按目录放行)', () => {
    const sf = mk({
      '/apps/server/src/chat/another-prompt.rules.ts': `
        const f = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai' });`,
    });
    expect(rules(sf)).toEqual(['raw-timezone-conversion']);
  });
});

describe('两条 Rule 正交', () => {
  it('同一文件可同时违反两条 —— 各报各的, 不互相吞', () => {
    const sf = mk({
      '/apps/server/src/alert/bad.ts': `
        const TZ = { cn: 'Asia/Shanghai', us: 'America/New_York' };
        const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ.cn });`,
    });
    expect(rules(sf).sort()).toEqual(['raw-timezone-conversion', 'timezone-table-duplicated']);
  });
});
