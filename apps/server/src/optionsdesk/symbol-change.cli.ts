import type { RemediationStepReport } from './remediate-symbol-change.usecase.js';

/**
 * 代码变更修正 CLI (086 T014 / T019, FR-009 / FR-011 / FR-012 / FR-019; plan D5 / D6 / D8)。
 *
 * 三段式同 `marketdata/marketdata-trigger.cli.ts`: `parseSymbolChangeArgs` 纯解析 (Small 单测直测)
 * + `runSymbolChange` NestFactory 接线 + argv[1] entry-guard。prod 经 `ops/bin/symbol-change.sh`
 * ssh 进 app 容器跑本文件 (`node dist/optionsdesk/symbol-change.cli.js …`), 容器内直连 DB, 不走 HTTP。
 *
 * 🚨 AppModule 及各 use case **动态 import**: `--help` / 解析错误不 boot、不读配置 (本机无 prod env
 *    也能看帮助)。
 *
 * 退出码: 0 = 成功 (预览 / 写入的末行既非 failed 也非 conflict) / 1 = 解析错误、末行 failed|conflict、异常。
 */

/** 未传 `--operator` 时的默认登记人 / 撤销人 (写进 `registered_by` / `revoked_by`)。 */
export const DEFAULT_OPERATOR = 'cli';

export const SYMBOL_CHANGE_USAGE = `用法:
  symbol-change apply  <market> <oldCode> <newCode> <effectiveDate> --evidence <text> [--operator <name>] [--confirm]
  symbol-change revert <market> <oldCode> <newCode> <effectiveDate> --evidence <text> [--operator <name>] [--confirm]
  symbol-change list   [market]
  symbol-change candidates [--all]
  symbol-change dismiss <candidateId> --note <text>
  symbol-change apply --from-candidate <candidateId> [--new <newCode>] --effective <effectiveDate> --evidence <text> [--operator <name>] [--confirm]
  symbol-change --help

  market          us | hk | cn
  effectiveDate   交易所当地日历日 YYYY-MM-DD
  --evidence      apply: 登记证据 (公告 URL 等); revert: 撤销理由
  --operator      登记人 / 撤销人, 默认 "${DEFAULT_OPERATOR}"
  --confirm       不带 = 只预览 (零写入, 打印将要做什么); 带上才真正写入
  candidates      疑似改名候选, 默认只列 PENDING; --all 列全部
  --from-candidate  market / 旧码取自候选; 新码取 --new, 否则取候选建议第一名;
                  候选无建议 (代码失效) 且未给 --new ⇒ 拒绝。--confirm 写入时候选翻 CONFIRMED

退出码: 0 成功; 1 参数错误 / 某步 failed 或 conflict (编排停在该步)。`;

const MARKETS: ReadonlySet<string> = new Set(['us', 'hk', 'cn']);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export interface RemediateCommand {
  kind: 'remediate';
  direction: 'remediate' | 'revert';
  market: string;
  oldCode: string;
  newCode: string;
  effectiveDate: string;
  evidence: string;
  operator: string;
  mode: 'preview' | 'apply';
}

/** `apply --from-candidate`: market / 旧码 / 新码运行时从候选推导 (依赖库内建议, 解析层不知道)。 */
export interface FromCandidateCommand {
  kind: 'from-candidate';
  candidateId: bigint;
  newCode?: string;
  effectiveDate: string;
  evidence: string;
  operator: string;
  mode: 'preview' | 'apply';
}

export type SymbolChangeCommand =
  | { kind: 'help' }
  | { kind: 'list'; market?: string }
  | { kind: 'candidates'; all: boolean }
  | { kind: 'dismiss'; candidateId: bigint; note: string }
  | RemediateCommand
  | FromCandidateCommand;

function requireMarket(m: string | undefined): string {
  if (m === undefined || !MARKETS.has(m)) {
    throw new Error(`market 必须是 us | hk | cn, 收到 ${String(m)}`);
  }
  return m;
}

function requireDate(d: string | undefined): string {
  if (d === undefined || !DATE_ONLY.test(d)) {
    throw new Error(`effectiveDate 须为 YYYY-MM-DD, 收到 ${String(d)}`);
  }
  return d;
}

function requireId(raw: string | undefined): bigint {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw))
    throw new Error(`候选 id 须为正整数, 收到 ${String(raw)}`);
  return BigInt(raw);
}

function requireText(args: SplitArgs, flag: string): string {
  const v = args.values.get(flag);
  if (v === undefined || v.trim() === '') throw new Error(`${flag} 必填`);
  return v;
}

/** 带取值的旗标 / 布尔旗标白名单; 其余 `--x` 一律报「未知参数」。 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--evidence',
  '--operator',
  '--note',
  '--from-candidate',
  '--new',
  '--effective',
]);
const BOOL_FLAGS: ReadonlySet<string> = new Set(['--confirm', '--all']);

interface SplitArgs {
  positional: string[];
  values: Map<string, string>;
  bools: Set<string>;
}

/** 把子命令之后的 argv 切成位置参数 + 旗标。旗标可出现在任意位置。O(n)。 */
function splitArgs(rest: readonly string[]): SplitArgs {
  const out: SplitArgs = { positional: [], values: new Map(), bools: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 缺少取值`);
      out.values.set(a, v);
    } else if (BOOL_FLAGS.has(a)) out.bools.add(a);
    else if (a.startsWith('--')) throw new Error(`未知参数: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

/** 子命令不认的旗标 ⇒ 报错 (防止 `revert --from-candidate` 之类被静默忽略)。 */
function assertFlags(sub: string, args: SplitArgs, allowed: readonly string[]): void {
  for (const f of [...args.values.keys(), ...args.bools]) {
    if (!allowed.includes(f)) throw new Error(`${sub} 不接受 ${f}`);
  }
}

function parseList(args: SplitArgs): SymbolChangeCommand {
  assertFlags('list', args, []);
  if (args.positional.length > 1) throw new Error('list 至多一个参数 [market]');
  return args.positional.length === 0
    ? { kind: 'list' }
    : { kind: 'list', market: requireMarket(args.positional[0]) };
}

function parseCandidates(args: SplitArgs): SymbolChangeCommand {
  assertFlags('candidates', args, ['--all']);
  if (args.positional.length > 0) throw new Error('candidates 不接受位置参数');
  return { kind: 'candidates', all: args.bools.has('--all') };
}

function parseDismiss(args: SplitArgs): SymbolChangeCommand {
  assertFlags('dismiss', args, ['--note']);
  if (args.positional.length !== 1) throw new Error('dismiss 需要 1 个位置参数: <candidateId>');
  return {
    kind: 'dismiss',
    candidateId: requireId(args.positional[0]),
    note: requireText(args, '--note'),
  };
}

function parseFromCandidate(args: SplitArgs): FromCandidateCommand {
  const allowed = [
    '--from-candidate',
    '--new',
    '--effective',
    '--evidence',
    '--operator',
    '--confirm',
  ];
  assertFlags('apply --from-candidate', args, allowed);
  if (args.positional.length > 0) {
    throw new Error('apply --from-candidate 不接受位置参数 (market / 旧码取自候选; 新码用 --new)');
  }
  const newCode = args.values.get('--new');
  return {
    kind: 'from-candidate',
    candidateId: requireId(args.values.get('--from-candidate')),
    ...(newCode === undefined ? {} : { newCode }),
    effectiveDate: requireDate(args.values.get('--effective')),
    evidence: requireText(args, '--evidence'),
    operator: args.values.get('--operator') ?? DEFAULT_OPERATOR,
    mode: args.bools.has('--confirm') ? 'apply' : 'preview',
  };
}

function parseRemediate(sub: 'apply' | 'revert', args: SplitArgs): RemediateCommand {
  assertFlags(sub, args, ['--evidence', '--operator', '--confirm']);
  if (args.positional.length !== 4) {
    throw new Error(`${sub} 需要 4 个位置参数: <market> <oldCode> <newCode> <effectiveDate>`);
  }
  const [market, oldCode, newCode, effectiveDate] = args.positional;
  requireDate(effectiveDate);
  if (oldCode === newCode) throw new Error('oldCode 与 newCode 相同');
  const evidence = requireText(args, '--evidence');
  return {
    kind: 'remediate',
    direction: sub === 'apply' ? 'remediate' : 'revert',
    market: requireMarket(market),
    oldCode,
    newCode,
    effectiveDate,
    evidence,
    operator: args.values.get('--operator') ?? DEFAULT_OPERATOR,
    mode: args.bools.has('--confirm') ? 'apply' : 'preview',
  };
}

/**
 * 解析 argv (不含 node 与脚本路径)。非法输入一律 throw, 由 entry 打到 stderr 并退出 1。
 * 默认 mode = preview —— 只有显式 `--confirm` 才 apply (FR-012, 分支 12)。
 */
export function parseSymbolChangeArgs(argv: readonly string[]): SymbolChangeCommand {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  const [sub, ...rest] = argv;
  const args = splitArgs(rest);
  if (sub === 'list') return parseList(args);
  if (sub === 'candidates') return parseCandidates(args);
  if (sub === 'dismiss') return parseDismiss(args);
  if (sub === 'apply' && args.values.has('--from-candidate')) return parseFromCandidate(args);
  if (sub === 'apply' || sub === 'revert') return parseRemediate(sub, args);
  throw new Error(`未知子命令: ${String(sub)}`);
}

/** 复述表: 每步一行 `status  step  detail`。 */
export function formatReport(report: readonly RemediationStepReport[]): string {
  return report.map((r) => `${r.status.padEnd(8)} ${r.step.padEnd(22)} ${r.detail}`).join('\n');
}

/** 末行 failed / conflict ⇒ 非零 (编排失败即停, 末行就是停下的那步)。空报告视为失败。 */
export function exitCodeOf(report: readonly RemediationStepReport[]): number {
  const last = report.at(-1);
  if (last === undefined) return 1;
  return last.status === 'failed' || last.status === 'conflict' ? 1 : 0;
}

type AppContext = Awaited<
  ReturnType<typeof import('@nestjs/core').NestFactory.createApplicationContext>
>;

async function runList(app: AppContext, market: string | undefined): Promise<number> {
  const { RegisterSymbolChangeUseCase } =
    await import('../marketdata/register-symbol-change.usecase.js');
  const rows = await app.get(RegisterSymbolChangeUseCase).list(market);
  if (rows.length === 0) console.log('(无登记)');
  for (const r of rows) {
    const revoked =
      r.revokedAt === null
        ? 'active'
        : `revoked ${r.revokedAt.toISOString()} by ${String(r.revokedBy)}: ${String(r.revokeReason)}`;
    console.log(
      `#${r.id} ${r.market}:${r.oldCode} → ${r.newCode} @ ${r.effectiveDate} [${revoked}] by ${r.registeredBy} — ${r.evidence}`,
    );
  }
  return 0;
}

async function runCandidates(app: AppContext, all: boolean): Promise<number> {
  const { ResolveSymbolCandidateUseCase } = await import('./resolve-symbol-candidate.usecase.js');
  const rows = await app.get(ResolveSymbolCandidateUseCase).list(all ? 'all' : undefined);
  if (rows.length === 0) console.log('(无候选)');
  for (const c of rows) {
    const sug =
      c.suggestions.length === 0
        ? '代码失效 (无新码建议)'
        : c.suggestions.map((x) => `${x.code}(${x.name}, ${x.score})`).join(' / ');
    const resolved =
      c.resolvedAt === null
        ? ''
        : ` resolved ${c.resolvedAt.toISOString()}${c.symbolChangeId === null ? '' : ` 登记 id=${c.symbolChangeId}`}${c.resolutionNote === null ? '' : ` — ${c.resolutionNote}`}`;
    console.log(
      `#${c.id} ${c.ticker} [${c.status}] ${c.signal} 首见 ${c.firstSeenAt.toISOString()} 最近 ${c.lastSeenAt.toISOString()} 建议: ${sug}${resolved}`,
    );
  }
  return 0;
}

async function runDismiss(app: AppContext, id: bigint, note: string): Promise<number> {
  const { ResolveSymbolCandidateUseCase } = await import('./resolve-symbol-candidate.usecase.js');
  const r = await app.get(ResolveSymbolCandidateUseCase).dismiss(id, note);
  if (r.status === 'dismissed') {
    console.log(`候选 #${id} → DISMISSED`);
    return 0;
  }
  console.error(
    r.status === 'not_found' ? `候选 #${id} 不存在` : `候选 #${id} 已是 ${r.current}, 未改动`,
  );
  return 1;
}

async function runRemediate(
  app: AppContext,
  cmd: RemediateCommand,
  candidateId?: bigint,
): Promise<number> {
  const { RemediateSymbolChangeUseCase } = await import('./remediate-symbol-change.usecase.js');
  const report = await app.get(RemediateSymbolChangeUseCase).execute({
    market: cmd.market,
    oldCode: cmd.oldCode,
    newCode: cmd.newCode,
    effectiveDate: cmd.effectiveDate,
    evidence: cmd.evidence,
    operator: cmd.operator,
    mode: cmd.mode,
    direction: cmd.direction,
    candidateId,
  });
  const from = candidateId === undefined ? '' : ` (候选 #${candidateId})`;
  console.log(
    `${cmd.direction} ${cmd.market}:${cmd.oldCode} → ${cmd.newCode} @ ${cmd.effectiveDate} [${cmd.mode}]${from}`,
  );
  console.log(formatReport(report));
  const code = exitCodeOf(report);
  if (cmd.mode === 'preview' && code === 0)
    console.log('\n预览完成, 零写入。确认后加 --confirm 重跑。');
  return code;
}

/** 候选 → 修正参数 (库内建议); 「代码失效」且无 --new 等拒绝由 use case 判, 这里只转述。 */
async function runFromCandidate(app: AppContext, cmd: FromCandidateCommand): Promise<number> {
  const { ResolveSymbolCandidateUseCase } = await import('./resolve-symbol-candidate.usecase.js');
  const target = await app
    .get(ResolveSymbolCandidateUseCase)
    .targetOf(cmd.candidateId, cmd.newCode);
  if (target.status === 'rejected') {
    console.error(`拒绝: ${target.message}`);
    return 1;
  }
  return runRemediate(
    app,
    {
      kind: 'remediate',
      direction: 'remediate',
      market: target.market,
      oldCode: target.oldCode,
      newCode: target.newCode,
      effectiveDate: cmd.effectiveDate,
      evidence: cmd.evidence,
      operator: cmd.operator,
      mode: cmd.mode,
    },
    cmd.candidateId,
  );
}

/** NestFactory 接线 entry: 解析 → (需要时) sentinel 前置 → 起 DI → 执行 → close。 */
export async function runSymbolChange(argv: string[]): Promise<number> {
  const cmd = parseSymbolChangeArgs(argv);
  if (cmd.kind === 'help') {
    console.log(SYMBOL_CHANGE_USAGE);
    return 0;
  }

  const [{ NestFactory }, { AppModule }, { SCHEDULER_DISABLED }, { MARKETDATA_WORKER_DISABLED }] =
    await Promise.all([
      import('@nestjs/core'),
      import('../app/app.module.js'),
      import('../app/schedule-options.js'),
      import('../marketdata/marketdata-sync.queue.js'),
    ]);
  // 同 trigger CLI (D6): createApplicationContext 前置 sentinel → worker / 调度器 OnModuleInit no-op。
  process.env[MARKETDATA_WORKER_DISABLED] = '1';
  process.env[SCHEDULER_DISABLED] = '1';
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    switch (cmd.kind) {
      case 'list':
        return await runList(app, cmd.market);
      case 'candidates':
        return await runCandidates(app, cmd.all);
      case 'dismiss':
        return await runDismiss(app, cmd.candidateId, cmd.note);
      case 'from-candidate':
        return await runFromCandidate(app, cmd);
      case 'remediate':
        return await runRemediate(app, cmd);
    }
  } finally {
    await app.close();
  }
}

// entry guard: 仅 `node .../symbol-change.cli.js` 直跑时执行。解析错误 → stderr + usage + 退出码 1。
if (process.argv[1]?.includes('symbol-change.cli')) {
  void runSymbolChange(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      console.error(SYMBOL_CHANGE_USAGE);
      process.exit(1);
    },
  );
}
