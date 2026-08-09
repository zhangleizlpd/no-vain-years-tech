import { describe, expect, it } from 'vitest';
import { scanScheduledTasks } from './check-scheduled-tasks';

// 一个最小注册表：登记了 foo.timer 与 launchd LABEL com.nvy.foo
const REGISTRY = `
| foo 任务 | 每日 | \`foo.timer\` | … | … |
| bar 任务 | 每日 10:00 | \`com.nvy.foo\` | … | … |
`;

const scan = (files: Record<string, string>, registry = REGISTRY) =>
  scanScheduledTasks(files, registry);
const codes = (files: Record<string, string>) => scan(files).map((v) => v.code);

describe('check-scheduled-tasks — A: 飞书传输集中', () => {
  it('调度脚本内重写 msg_type → 违反 A', () => {
    expect(codes({ 'ops/jobs/cert-expiry-monitor.sh': 'curl -d \'{"msg_type":"text"}\'' })).toEqual(
      ['A'],
    );
  });

  it('内联 open.feishu bot host → 违反 A', () => {
    expect(
      codes({ 'services/x/scripts/y.sh': 'POST https://open.feishu.cn/open-apis/bot/v2/hook/X' }),
    ).toEqual(['A']);
  });

  it('feishu wire-format 在 feishu-send.sh（白名单）→ 放行', () => {
    expect(scan({ 'ops/lib/feishu-send.sh': '{"msg_type":"text"}' })).toHaveLength(0);
  });

  it('守门脚本自身含标志串（注释/正则）→ 放行', () => {
    expect(
      scan({ 'scripts/checks/check-scheduled-tasks.ts': 'const M = /msg_type/;' }),
    ).toHaveLength(0);
  });

  it('非代码文件（.md runbook）含 msg_type → 不扫', () => {
    expect(scan({ 'ops/runbook/cert-management.md': 'payload msg_type=text 示例' })).toHaveLength(
      0,
    );
  });

  it('调度脚本只打 stdout、无飞书串 → 放行', () => {
    expect(
      scan({ 'ops/jobs/cert-expiry-monitor.sh': 'echo "api: 67d left"; exit 0' }),
    ).toHaveLength(0);
  });
});

describe('check-scheduled-tasks — B: 注册表同步', () => {
  it('未登记的 .timer → 违反 B', () => {
    expect(codes({ 'ops/x/unregistered.timer': '[Timer]\nOnCalendar=daily' })).toEqual(['B']);
  });

  it('已登记的 .timer → 放行', () => {
    expect(scan({ 'services/x/deploy/foo.timer': '[Timer]' })).toHaveLength(0);
  });

  it('未登记的 launchd LABEL（bash setup.sh）→ 违反 B', () => {
    expect(codes({ 'scripts/x/setup.sh': "LABEL='com.nvy.ghost'" })).toEqual(['B']);
  });

  it('已登记的 LABEL（TS setup.ts，const LABEL = ...）→ 放行', () => {
    expect(scan({ 'scripts/foo/setup.ts': "const LABEL = 'com.nvy.foo';" })).toHaveLength(0);
  });

  it('setup.* 无 com.* LABEL（如纯辅助脚本）→ 不卡', () => {
    expect(scan({ 'scripts/x/setup.sh': 'echo no label here' })).toHaveLength(0);
  });
});

describe('check-scheduled-tasks — 组合', () => {
  it('同一 PR 多类违反一并报出', () => {
    const v = scan({
      'ops/x/y.sh': '{"msg_type":"text"}', // A
      'ops/x/ghost.timer': '[Timer]', // B
      'scripts/x/setup.sh': "LABEL='com.nvy.ghost'", // B
    });
    expect(v.map((x) => x.code).sort()).toEqual(['A', 'B', 'B']);
  });

  it('干净 PR → 零违反', () => {
    expect(
      scan({
        'ops/lib/feishu-send.sh': '{"msg_type":"text"}',
        'services/x/deploy/foo.timer': '[Timer]',
        'scripts/foo/setup.ts': "const LABEL = 'com.nvy.foo';",
        'ops/jobs/cert-expiry-monitor.sh': 'echo done; exit 0',
      }),
    ).toHaveLength(0);
  });
});
