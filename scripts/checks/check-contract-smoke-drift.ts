#!/usr/bin/env node
/**
 * check-contract-smoke-drift.ts — echo-only drift 警告 (per 2026-06-22 #513/#530 教训)。
 *
 * 缝: contract-smoke (apps/mobile/e2e/contract-smoke/*.contract.ts) 只在 nightly
 * e2e-real-backend.yml 跑、不在 PR CI (太慢, 归 nightly 兜底)。改 server prod 行为却漏改对应
 * contract spec 的断言 → drift 静默合进 main, 只在 nightly (软信号) 才红 (#513 marketdata EP2
 * name 断言 / #530 ideation chips label 都是此类)。
 *
 * 本 check 在 authoring-time (lefthook pre-push) + PR CI 提醒: 若 branch diff (vs origin/main)
 * 改了某 server module 的非测试代码, 但该 module 的 contract spec(s) 没在同 diff 更新 → 警告。
 * **echo-only / 非阻断** (恒 exit 0); 这是「别忘了同步契约断言」的前置提醒, 不替代 nightly 兜底。
 * 反复咬人 (drift 仍漏到 nightly) 可升级为 hard-block (exit 1)。
 *
 * spec→module 自动派生: 解析每个 *.contract.ts 的 `<prefix>Controller<Op>` 函数名 (orval 由
 * OpenAPI operationId 生成) → PREFIX_TO_MODULE → 覆盖的 server module。加新 spec 用已知 prefix
 * 时零改本 check; 出现未映射 prefix 也警告 (防 PREFIX_TO_MODULE 过期)。
 *
 * Usage: pnpm tsx scripts/checks/check-contract-smoke-drift.ts
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Script lives at scripts/checks/ → repo root is two levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_DIR = join(REPO_ROOT, 'apps/mobile/e2e/contract-smoke');
const SERVER_SRC_PREFIX = 'apps/server/src/';

// api-client controller 前缀 → server module 目录名。前缀来自各 *.contract.ts import 的
// `<prefix>Controller<Op>` 函数 (orval 由 OpenAPI operationId 生成)。出现未列前缀 → 本 check 警告。
export const PREFIX_TO_MODULE: Readonly<Record<string, string>> = {
  alerts: 'alert',
  alertMessages: 'alert',
  pushBinding: 'alert',
  brokerAccounts: 'portfolio',
  watchlistGroups: 'portfolio',
  watchlistItems: 'portfolio',
  watchlistStatus: 'portfolio',
  holdings: 'portfolio',
  holdingsImport: 'portfolio',
  trades: 'portfolio',
  conversation: 'chat',
  chatPreference: 'chat',
  marketdata: 'marketdata',
  session: 'ideation',
  brief: 'ideation',
  clarifyStream: 'ideation',
  asrTranscribe: 'ideation',
  attachmentCredential: 'ideation',
  mockupCredential: 'ideation',
  mockupRecord: 'ideation',
  mockupList: 'ideation',
  optionsdesk: 'optionsdesk',
};

export interface ContractSpec {
  /** repo-root-relative path, e.g. apps/mobile/e2e/contract-smoke/marketdata.contract.ts */
  readonly file: string;
  /** 派生覆盖的 server module 目录名 */
  readonly modules: readonly string[];
  /** 出现在 spec 但不在 PREFIX_TO_MODULE 的 controller 前缀 (表过期信号) */
  readonly unmappedPrefixes: readonly string[];
}

export interface DriftWarning {
  readonly module: string;
  /** 覆盖该 module、但本 diff 未更新的 contract spec 文件 */
  readonly specs: readonly string[];
}

export interface DriftReport {
  readonly warnings: readonly DriftWarning[];
  readonly unmappedPrefixes: readonly string[];
}

/** 从 contract spec 源码抽 `<prefix>Controller` 前缀 → 派生覆盖 module + 未映射 prefix。纯函数。 */
export function deriveSpecCoverage(file: string, source: string): ContractSpec {
  const prefixes = new Set<string>();
  const re = /\b([a-zA-Z][a-zA-Z0-9]*)Controller[A-Za-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) prefixes.add(m[1]!);

  const modules = new Set<string>();
  const unmapped: string[] = [];
  for (const p of prefixes) {
    // 🚨 首字母大小写归一：同一个 operationId 会生成**两种**标识符 —— 函数
    // `optionsdeskControllerLegs` 与其参数 / 响应类型 `OptionsdeskControllerLegsParams`。
    // spec 只要 `import type` 了后者，不归一就会把 `Optionsdesk` 报成「未映射前缀」，
    // 而那条警告的本意是「PREFIX_TO_MODULE 过期了」—— 一个纯拼写差引发的假信号会让人
    // 去改表，而表本来是对的（052 T014 实撞）。
    const mod = PREFIX_TO_MODULE[p] ?? PREFIX_TO_MODULE[p.charAt(0).toLowerCase() + p.slice(1)];
    if (mod) modules.add(mod);
    else unmapped.push(p);
  }
  return { file, modules: [...modules].sort(), unmappedPrefixes: unmapped.sort() };
}

/** 纯函数: 给定 changed files + spec coverage → drift 警告。可单测。 */
export function analyzeContractSmokeDrift(
  changedFiles: readonly string[],
  specs: readonly ContractSpec[],
): DriftReport {
  const changed = new Set(changedFiles);

  // changed server modules (仅非测试 .ts/.tsx)。
  const changedModules = new Set<string>();
  for (const f of changedFiles) {
    if (!f.startsWith(SERVER_SRC_PREFIX)) continue;
    if (!/\.(ts|tsx)$/.test(f)) continue;
    if (/\.(spec|test)\.ts$/.test(f)) continue; // .spec.ts 含 .it.spec.ts
    const mod = f.slice(SERVER_SRC_PREFIX.length).split('/')[0];
    if (mod) changedModules.add(mod);
  }

  // module → 覆盖它的 spec 文件。
  const moduleToSpecs = new Map<string, string[]>();
  for (const s of specs) {
    for (const mod of s.modules) {
      const arr = moduleToSpecs.get(mod) ?? [];
      arr.push(s.file);
      moduleToSpecs.set(mod, arr);
    }
  }

  const warnings: DriftWarning[] = [];
  for (const mod of [...changedModules].sort()) {
    const covering = moduleToSpecs.get(mod);
    if (!covering || covering.length === 0) continue; // 无 contract 覆盖的 module → 不管
    if (!covering.some((sp) => changed.has(sp))) {
      warnings.push({ module: mod, specs: [...covering].sort() });
    }
  }

  const unmappedPrefixes = [...new Set(specs.flatMap((s) => s.unmappedPrefixes))].sort();
  return { warnings, unmappedPrefixes };
}

// ── 薄壳 (git/fs); 仅直接执行时跑 ──────────────────────────────────────────────────────
function gitChangedFiles(): string[] {
  try {
    // 三点 diff: origin/main...HEAD = 自 merge-base 起本 branch 的改动 (跨多 commit)。
    const out = execSync('git diff --name-only origin/main...HEAD', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // origin/main 缺失 (浅 clone / 离线) → 不警告, 不阻断。
    return [];
  }
}

function loadSpecs(): ContractSpec[] {
  if (!existsSync(CONTRACT_DIR)) return [];
  return readdirSync(CONTRACT_DIR)
    .filter((f) => f.endsWith('.contract.ts'))
    .map((f) =>
      deriveSpecCoverage(
        `apps/mobile/e2e/contract-smoke/${f}`,
        readFileSync(join(CONTRACT_DIR, f), 'utf8'),
      ),
    );
}

function emit(msg: string, ci: boolean): void {
  // CI: ::warning:: 注解 → 显示在 PR checks/files (绿日志没人读); 本地: stderr。
  if (ci) console.log(`::warning::${msg}`);
  else console.warn(`⚠️  ${msg}`);
}

function main(): void {
  const report = analyzeContractSmokeDrift(gitChangedFiles(), loadSpecs());
  const ci = process.env.GITHUB_ACTIONS === 'true';

  for (const w of report.warnings) {
    emit(
      `contract-smoke drift: server module '${w.module}' 有非测试改动, 但其 contract-smoke spec ` +
        `未在本 PR 更新 → ${w.specs.join(', ')}。若改动涉及这些 spec 断言的端点行为, 请同步更新并本地跑 ` +
        '`MARKETDATA_PROVIDER=mock RUN_REAL_BACKEND_SMOKE=true pnpm exec nx run mobile:contract-smoke`; ' +
        '不涉及则可忽略 (echo-only, 不阻断)。',
      ci,
    );
  }
  for (const p of report.unmappedPrefixes) {
    emit(
      `contract-smoke drift: 未映射的 controller 前缀 '${p}' — scripts/checks/check-contract-smoke-drift.ts ` +
        '的 PREFIX_TO_MODULE 需补该前缀→module, 否则对应 spec 的覆盖检测失效。',
      ci,
    );
  }
  if (report.warnings.length === 0 && report.unmappedPrefixes.length === 0) {
    console.log('✅ check-contract-smoke-drift: 无 contract-smoke drift 风险。');
  }
  process.exit(0); // echo-only: 永不阻断
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
