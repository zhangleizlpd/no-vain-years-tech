import { describe, expect, it } from 'vitest';
import {
  checkRepoLayout,
  OPS_ALLOWED,
  SCRIPTS_ALLOWED,
  SCRIPTS_ROOT_ALLOWLIST,
  type LayoutSnapshot,
} from './check-repo-layout';

/**
 * 每条断言都配一个**反例**用例 —— 只测「合规输入返空」等于什么都没验：
 * 一个 `return []` 也能通过。下面每个 🚨 用例都是注入一种真实退化形态，要求它翻红。
 */

/** 2026-08-07 重排完成后的真实形状，作为基线。 */
function baseline(): LayoutSnapshot {
  return {
    opsChildren: ['bin', 'host', 'jobs', 'lib', 'runbook'],
    runbookFiles: ['scheduled-tasks.md', 'cert-management.md'],
    scriptsChildren: ['checks', 'ci', 'eas', 'hooks', 'jobs', 'sdd-run'],
    scriptsRootFiles: ['check-adr-frontmatters.ts', 'local-verify-as-ci.sh'],
    appDirs: [
      { name: 'server', hasProjectJson: true },
      { name: 'mobile', hasProjectJson: true },
    ],
    serviceDirs: [
      { name: 'code-index', hasDeployDir: true },
      { name: 'futu-shim', hasDeployDir: true },
      { name: 'guest-proxy', hasDeployDir: true },
    ],
    workspaceGlobs: ['apps/*', 'packages/*', 'scripts/checks'],
    systemdFiles: ['futu-shim-health.service', 'futu-shim-health.timer'],
    execStartLines: {
      'futu-shim-health.service': [
        '/usr/bin/bash /usr/local/lib/nvy/nvy-run-reported.sh futu-shim-health --on-success silent --tail 5 -- /usr/local/lib/nvy/jobs/futu-shim-health.sh',
      ],
    },
    repoPaths: new Set(['ops/jobs/futu-shim-health.sh', 'ops/lib/nvy-run-reported.sh']),
  };
}

describe('check-repo-layout', () => {
  it('重排后的真实布局 → 零违规', () => {
    expect(checkRepoLayout(baseline())).toEqual([]);
  });

  // ── 1. ops/ 顶层白名单 ──────────────────────────────────────────────────
  it('🚨 ops/ 下冒出一个新目录 → 报错（这条是防 ops/ 再次长回 11 个的主闸）', () => {
    const s = baseline();
    s.opsChildren.push('marketdata-snapshot-integrity'); // 047 T025a 若照旧范式建就是这个形状
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('[ops-toplevel]');
    expect(v[0]).toContain('marketdata-snapshot-integrity');
  });

  it('白名单常量与判据同源（改一处不会漏改另一处）', () => {
    expect([...OPS_ALLOWED].sort()).toEqual(['bin', 'host', 'jobs', 'lib', 'runbook']);
  });

  // ── 2. runbook 纯文档 ───────────────────────────────────────────────────
  it('🚨 可执行混进 runbook/ → 报错（rollback-prod.sh 曾经就在那儿）', () => {
    const s = baseline();
    s.runbookFiles.push('rollback-prod.sh');
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('[runbook-purity]');
    expect(v[0]).toContain('ops/bin/');
  });

  it('runbook 下的 .md 不算违规', () => {
    const s = baseline();
    s.runbookFiles.push('host-inventory.md');
    expect(checkRepoLayout(s)).toEqual([]);
  });

  // ── 3. apps/* 判据 ──────────────────────────────────────────────────────
  it('🚨 apps/ 下的目录没有 project.json → 报错', () => {
    const s = baseline();
    s.appDirs.push({ name: 'admin-console', hasProjectJson: false });
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('[apps-definition]');
  });

  // ── 4. services/* 判据（两条，分别翻红）──────────────────────────────────
  it('🚨 services/ 下的目录没有 deploy/ → 报错', () => {
    const s = baseline();
    s.serviceDirs.push({ name: 'shared-utils', hasDeployDir: false });
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('[services-definition]');
    expect(v[0]).toContain('没有 deploy/');
  });

  it('🚨 services/* 被 workspace glob 命中 → 报错（它们刻意不入 workspace）', () => {
    const s = baseline();
    s.workspaceGlobs.push('services/*');
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(3); // 三个 service 各一条
    expect(v[0]).toContain("被 pnpm-workspace.yaml 的 'services/*' 命中");
  });

  it('glob 匹配不跨层级：services/* 不该命中 services/a/b', () => {
    const s = baseline();
    s.serviceDirs = [{ name: 'code-index', hasDeployDir: true }];
    s.workspaceGlobs = ['apps/*']; // 不含 services
    expect(checkRepoLayout(s)).toEqual([]);
  });

  // ── 5. unit 成对性 + ExecStart 目标存在性 ───────────────────────────────
  it('🚨 .timer 没有同名 .service → 报错（timer 触发不了任何东西）', () => {
    const s = baseline();
    s.systemdFiles.push('orphan-job.timer');
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('[unit-pairing]');
    expect(v[0]).toContain('orphan-job.timer');
  });

  it('🚨🚨 ExecStart 指向仓内已不存在的脚本 → 报错（本次重排最大的风险面）', () => {
    const s = baseline();
    s.execStartLines['futu-shim-health.service'] = [
      // 扁平化前的旧落点：仓内早已没有 ops/jobs/futu-shim-health/check.sh 这个路径
      '/usr/bin/bash /usr/local/lib/nvy/nvy-run-reported.sh futu-shim-health -- /usr/local/lib/nvy/jobs/futu-shim-health/check.sh',
    ];
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('[execstart-target]');
    expect(v[0]).toContain('203/EXEC');
  });

  it('🚨 ExecStart 指向未知装机落点（如 /usr/local/bin）→ 报错', () => {
    const s = baseline();
    s.execStartLines['futu-shim-health.service'] = [
      '/usr/bin/bash /usr/local/lib/nvy/nvy-run-reported.sh cert-expiry -- /usr/local/bin/check-cert-expiry.sh',
    ];
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('不在已知装机落点里');
  });

  it('ExecStart 里的 /usr/bin/bash 不参与校验（只管 /usr/local/ 下的落点）', () => {
    expect(checkRepoLayout(baseline())).toEqual([]);
  });

  it('lib 落点（无 jobs/ 段）映射到 ops/lib/ —— 前缀顺序不能反', () => {
    const s = baseline();
    s.systemdFiles = ['nvy-watchdog.service', 'nvy-watchdog.timer'];
    s.execStartLines = {
      'nvy-watchdog.service': [
        '/usr/bin/bash /usr/local/lib/nvy/nvy-watchdog.sh cert-expiry:90000',
      ],
    };
    s.repoPaths = new Set(['ops/lib/nvy-watchdog.sh']);
    expect(checkRepoLayout(s)).toEqual([]);
  });

  // ── 6/7. scripts/ 白名单（2026-08-28 收敛的另一半：ops/ 之后轮到 scripts/）─
  it('🚨 scripts/ 下冒出一个新目录 → 报错（防 scripts/ 再次沙化的主闸）', () => {
    const s = baseline();
    s.scriptsChildren.push('my-new-tool');
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('[scripts-toplevel]');
    expect(v[0]).toContain('my-new-tool');
  });

  it('🚨 scripts/ 根出现白名单外的文件 → 报错（收敛前根上平铺过 13 个文件）', () => {
    const s = baseline();
    s.scriptsRootFiles.push('quick-fix.sh');
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('[scripts-root]');
    expect(v[0]).toContain('quick-fix.sh');
  });

  it('scripts 白名单常量与判据同源（改一处不会漏改另一处）', () => {
    expect([...SCRIPTS_ALLOWED].sort()).toEqual([
      'checks',
      'ci',
      'eas',
      'hooks',
      'jobs',
      'sdd-run',
    ]);
    expect([...SCRIPTS_ROOT_ALLOWLIST]).toContain('check-adr-frontmatters.ts');
    expect([...SCRIPTS_ROOT_ALLOWLIST]).toContain('check-spec-frontmatters.ts');
  });

  // ── 多条同时违规不互相遮蔽 ──────────────────────────────────────────────
  it('多类违规同时存在时全部报出（不是撞到第一条就 return）', () => {
    const s = baseline();
    s.opsChildren.push('watchdog');
    s.runbookFiles.push('backup-pg.sh');
    s.appDirs.push({ name: 'x', hasProjectJson: false });
    s.scriptsChildren.push('rogue');
    const v = checkRepoLayout(s);
    expect(v).toHaveLength(4);
    expect(v.map((x) => x.match(/^\[([a-z-]+)\]/)?.[1]).sort()).toEqual([
      'apps-definition',
      'ops-toplevel',
      'runbook-purity',
      'scripts-toplevel',
    ]);
  });
});
