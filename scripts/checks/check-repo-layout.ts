#!/usr/bin/env node
/**
 * check-repo-layout.ts — 守住顶层目录的归属判据（canonical: docs/conventions/repo-layout.md）。
 *
 * 为什么值得一个专门的检查：2026-08-07 重排前，`ops/` 长成了 11 个子目录，其中一个
 * （`guest-access`）其实是可部署服务、7 个是同一类定时任务各占一个目录、还有 5 个可执行
 * 混在文档目录 `runbook/` 里 —— 其中 `rollback-prod.sh` 是 `deploy.yml` 自动回滚的实际执行体。
 * 每一步单看都合理，合起来就没人说得清「一个新东西该放哪」。**目录沙化是渐进的，靠人眼
 * 守不住**，所以把判据写成断言。
 *
 * 七条断言（全部 fail-closed —— 目标目录缺失 = 红，不是 skip）：
 *   1. `ops/` 顶层子目录 ⊆ {bin, host, jobs, lib, runbook}   ← 主要价值：防 ops/ 再次长回来
 *   2. `ops/runbook/` 下不得有可执行（*.sh / *.ts）—— 它是纯文档目录
 *   3. 每个 `apps/*` 必须有 project.json（apps/ 的定义 = 归 Nx / pnpm workspace 管的可部署物）
 *   4. 每个 `services/*` 必须有 `deploy/`，且**不得**被 pnpm-workspace 的 glob 命中
 *      （services/ 的定义 = 独立工具链的可部署物，刻意不入 workspace）
 *   5. `ops/jobs/systemd/`：每个 `.timer` 有同名 `.service`；每个 `.service` 的 ExecStart
 *      里指向 `/usr/local/lib/nvy/…` 的路径，映射回仓内必须真的存在
 *   6. `scripts/` 顶层子目录 ⊆ {checks, ci, eas, hooks, jobs, sdd-run} ← 防 scripts/ 根再次长草
 *      （2026-08-28 收敛前根上平铺过 13 个文件、横跨 3 类受众）
 *   7. `scripts/` 根文件 ⊆ 显式白名单（preset 钉死的 2 个 + 入口级单文件工具）
 *
 * 第 5 条是重排最大的风险面：unit 指着一个仓里已经不存在的脚本，systemd **不会提前告诉你**,
 * 要等下一次 OnCalendar 触发才 203/EXEC —— 而 5 个任务是 `--on-success silent`，
 * 「装错了」和「探到真故障」在飞书上长得一模一样。
 *
 * ⚠️ 本检查只管**仓内布局**，管不到「机器上装成什么样」。后者由 `ops/jobs/install.sh` 的
 * 装机自检负责（同一条不变量的运行期孪生）。
 *
 * Usage:
 *   pnpm tsx scripts/checks/check-repo-layout.ts
 *   pr-validation.yml `gate-checks` job 每个 PR 无条件跑 + lefthook pre-commit 路径触发。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** `ops/` 允许的顶层子目录。加一个之前先改 docs/conventions/repo-layout.md，别只改这里。 */
export const OPS_ALLOWED = ['bin', 'host', 'jobs', 'lib', 'runbook'] as const;

/** `scripts/` 允许的顶层子目录。加一个之前先改 docs/conventions/repo-layout.md，别只改这里。 */
export const SCRIPTS_ALLOWED = ['checks', 'ci', 'eas', 'hooks', 'jobs', 'sdd-run'] as const;

/**
 * `scripts/` 根允许的文件。两类：spec-kit preset 钉死在根的治理检查（落点不归本仓定，#170）
 * + 入口级单文件工具。新增先改 docs/conventions/repo-layout.md 再登记这里；
 * 长到多文件就开子目录（进 SCRIPTS_ALLOWED 那张表）。
 */
export const SCRIPTS_ROOT_ALLOWLIST = [
  'check-adr-frontmatters.ts', // preset 钉死
  'check-spec-frontmatters.ts', // preset 钉死
  'inject-perf-env.ts',
  'local-verify-as-ci.sh',
  'prisma-migrate.ts',
] as const;

/** 装机落点 → 仓内路径的映射（`ops/jobs/install.sh` 的落点契约，两处必须一致）。 */
const INSTALL_PREFIXES: readonly [string, string][] = [
  ['/usr/local/lib/nvy/jobs/', 'ops/jobs/'],
  ['/usr/local/lib/nvy/', 'ops/lib/'], // 顺序承重：jobs/ 更长，必须先匹配
];

export interface LayoutSnapshot {
  /** ops/ 的顶层子目录名 */
  opsChildren: string[];
  /** ops/runbook/ 下的文件名（不含子目录） */
  runbookFiles: string[];
  /** scripts/ 的顶层子目录名 */
  scriptsChildren: string[];
  /** scripts/ 根的文件名（隐藏文件已在采集端滤掉，.DS_Store 之类不判） */
  scriptsRootFiles: string[];
  appDirs: { name: string; hasProjectJson: boolean }[];
  serviceDirs: { name: string; hasDeployDir: boolean }[];
  /** pnpm-workspace.yaml 的 packages 条目，原样 */
  workspaceGlobs: string[];
  /** ops/jobs/systemd/ 下的文件名 */
  systemdFiles: string[];
  /** unit 名 → 该 .service 里所有 ExecStart 行的原文 */
  execStartLines: Record<string, string[]>;
  /** 仓内存在的路径集合（相对仓根），供第 5 条反查 */
  repoPaths: Set<string>;
}

/** 把 `apps/*` 这类 workspace glob 变成匹配器。只支持末尾 `*`，够用且不引依赖。 */
function globMatches(glob: string, path: string): boolean {
  if (glob.endsWith('/*'))
    return path.startsWith(glob.slice(0, -1)) && !path.slice(glob.length - 1).includes('/');
  return glob === path;
}

/** 纯函数，便于单测。返回违规文案数组，空数组 = 通过。 */
export function checkRepoLayout(s: LayoutSnapshot): string[] {
  const v: string[] = [];

  // ── 1. ops/ 顶层白名单 ────────────────────────────────────────────────────
  for (const child of s.opsChildren) {
    if (!(OPS_ALLOWED as readonly string[]).includes(child)) {
      v.push(
        `[ops-toplevel] ops/${child}/ 不在允许清单 {${OPS_ALLOWED.join(', ')}} 里。` +
          `先读 docs/conventions/repo-layout.md 判断它属于哪一类：可部署服务 → services/；` +
          `定时任务 → ops/jobs/；宿主机配置 → ops/host/；人工/CI 调用的可执行 → ops/bin/；` +
          `共享 shell 原语 → ops/lib/；纯文档 → ops/runbook/。`,
      );
    }
  }

  // ── 2. runbook/ 是纯文档目录 ──────────────────────────────────────────────
  for (const f of s.runbookFiles) {
    if (/\.(sh|ts|mjs|cjs|py)$/.test(f)) {
      v.push(
        `[runbook-purity] ops/runbook/${f} 是可执行，不该在文档目录里 → 挪去 ops/bin/。` +
          `（2026-08-07 之前 deploy.yml 自动回滚的执行体 rollback-prod.sh 就躺在这里。）`,
      );
    }
  }

  // ── 3. apps/* 必须是 Nx project ───────────────────────────────────────────
  for (const a of s.appDirs) {
    if (!a.hasProjectJson) {
      v.push(
        `[apps-definition] apps/${a.name}/ 没有 project.json。apps/ 的定义 = 归 Nx / pnpm ` +
          `workspace 管的可部署物；独立工具链的可部署物属于 services/。`,
      );
    }
  }

  // ── 4. services/* 必须有 deploy/ 且在 workspace 之外 ──────────────────────
  for (const svc of s.serviceDirs) {
    if (!svc.hasDeployDir) {
      v.push(
        `[services-definition] services/${svc.name}/ 没有 deploy/。services/ 的定义 = ` +
          `**可部署**且自带工具链；没有部署产物就不是 service（共享库属于 packages/）。`,
      );
    }
    const path = `services/${svc.name}`;
    const hit = s.workspaceGlobs.find((g) => globMatches(g, path));
    if (hit) {
      v.push(
        `[services-definition] ${path} 被 pnpm-workspace.yaml 的 '${hit}' 命中。services/* ` +
          `刻意不入 workspace（各自 lockfile / venv / 纯配置）；要入 workspace 就该放 apps/。`,
      );
    }
  }

  // ── 5. jobs/systemd 的成对性 + ExecStart 目标存在性 ───────────────────────
  const timers = s.systemdFiles.filter((f) => f.endsWith('.timer'));
  const services = new Set(s.systemdFiles.filter((f) => f.endsWith('.service')));
  for (const t of timers) {
    const paired = `${t.slice(0, -'.timer'.length)}.service`;
    if (!services.has(paired)) {
      v.push(`[unit-pairing] ops/jobs/systemd/${t} 没有同名 .service（timer 触发不了任何东西）。`);
    }
  }
  for (const [unit, lines] of Object.entries(s.execStartLines)) {
    for (const line of lines) {
      for (const token of line.split(/\s+/)) {
        if (!token.startsWith('/usr/local/')) continue;
        const mapped = INSTALL_PREFIXES.find(([inst]) => token.startsWith(inst));
        if (!mapped) {
          v.push(
            `[execstart-target] ${unit} 的 ExecStart 指向 ${token}，不在已知装机落点里` +
              `（${INSTALL_PREFIXES.map(([i]) => i).join(' / ')}）。落点变了就同步改 ` +
              `ops/jobs/install.sh 和本检查的 INSTALL_PREFIXES。`,
          );
          continue;
        }
        const [instPrefix, repoPrefix] = mapped;
        const repoPath = repoPrefix + token.slice(instPrefix.length);
        if (!s.repoPaths.has(repoPath)) {
          v.push(
            `[execstart-target] ${unit} 的 ExecStart 指向 ${token}，映射回仓内是 ${repoPath}，` +
              `**该文件不存在**。systemd 不会提前报错，要等下次 OnCalendar 触发才 203/EXEC；` +
              `而多数任务是 --on-success silent，届时「装错了」与「探到真故障」在飞书上没法区分。`,
          );
        }
      }
    }
  }

  // ── 6. scripts/ 顶层白名单 ───────────────────────────────────────────────
  for (const child of s.scriptsChildren) {
    if (!(SCRIPTS_ALLOWED as readonly string[]).includes(child)) {
      v.push(
        `[scripts-toplevel] scripts/${child}/ 不在允许清单 {${SCRIPTS_ALLOWED.join(', ')}} 里。` +
          `先读 docs/conventions/repo-layout.md 判断它属于哪一舱：治理检查 → scripts/checks/；` +
          `CI 专用 helper → scripts/ci/；Claude harness 钩子 → scripts/hooks/；` +
          `开发机 launchd 定时任务 → scripts/jobs/<name>/；会落到生产宿主机的东西不属于 scripts/ → ops/。`,
      );
    }
  }

  // ── 7. scripts/ 根文件白名单 ─────────────────────────────────────────────
  for (const f of s.scriptsRootFiles) {
    if (!(SCRIPTS_ROOT_ALLOWLIST as readonly string[]).includes(f)) {
      v.push(
        `[scripts-root] scripts/${f} 不在根文件白名单里。入口级单文件工具 → 先改 ` +
          `docs/conventions/repo-layout.md 再登记 SCRIPTS_ROOT_ALLOWLIST；多文件工具 → 开子目录；` +
          `治理检查 → scripts/checks/（preset 钉死的除外）。`,
      );
    }
  }

  return v;
}

/** 目录下的子目录名（不存在 → 抛，fail-closed）。 */
function childDirs(abs: string): string[] {
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function childFiles(abs: string): string[] {
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

function buildSnapshot(root: string): LayoutSnapshot {
  // fail-closed：三个域缺一个都说明仓结构已经不是本检查认识的样子，红比 skip 好。
  for (const d of ['ops', 'apps', 'services', 'scripts', 'ops/runbook', 'ops/jobs/systemd']) {
    if (!existsSync(join(root, d))) {
      throw new Error(
        `仓内缺 ${d}/ — 布局已偏离 docs/conventions/repo-layout.md，请先对齐再跑本检查`,
      );
    }
  }

  const systemdDir = join(root, 'ops/jobs/systemd');
  const systemdFiles = childFiles(systemdDir);
  const execStartLines: Record<string, string[]> = {};
  for (const f of systemdFiles.filter((x) => x.endsWith('.service'))) {
    execStartLines[f] = readFileSync(join(systemdDir, f), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('ExecStart='))
      .map((l) => l.slice('ExecStart='.length));
  }

  // 只收 ops/jobs 与 ops/lib 下的文件（第 5 条反查用），不做全仓遍历。
  const repoPaths = new Set<string>();
  for (const rel of ['ops/jobs', 'ops/lib']) {
    for (const f of childFiles(join(root, rel))) repoPaths.add(`${rel}/${f}`);
  }

  const wsRaw = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const workspaceGlobs = wsRaw
    .split('\n')
    .map((l) => l.match(/^\s*-\s*'?"?([^'"#]+?)'?"?\s*$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => m[1].trim());

  return {
    opsChildren: childDirs(join(root, 'ops')),
    runbookFiles: childFiles(join(root, 'ops/runbook')),
    scriptsChildren: childDirs(join(root, 'scripts')),
    scriptsRootFiles: childFiles(join(root, 'scripts')).filter((f) => !f.startsWith('.')),
    appDirs: childDirs(join(root, 'apps')).map((name) => ({
      name,
      hasProjectJson: existsSync(join(root, 'apps', name, 'project.json')),
    })),
    serviceDirs: childDirs(join(root, 'services')).map((name) => ({
      name,
      hasDeployDir: existsSync(join(root, 'services', name, 'deploy')),
    })),
    workspaceGlobs,
    systemdFiles,
    execStartLines,
    repoPaths,
  };
}

function main(): void {
  const violations = checkRepoLayout(buildSnapshot(REPO_ROOT));
  if (violations.length > 0) {
    console.error('❌ 顶层布局守门失败：\n');
    for (const v of violations) console.error(`  - ${v}`);
    console.error('\n判据 SoT：docs/conventions/repo-layout.md');
    process.exit(1);
  }
  console.log(
    '✅ 顶层布局守门通过（ops/scripts 白名单 + runbook 纯文档 + apps/services 判据 + unit 目标存在性 + scripts 根白名单）。',
  );
}

// 只在被直接执行时跑 —— spec 只 import 纯函数 checkRepoLayout，不该触发 fs 遍历与 exit。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
