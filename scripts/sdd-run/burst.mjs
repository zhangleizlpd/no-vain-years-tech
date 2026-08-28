#!/usr/bin/env node
// Track 2 · headless burst wrapper for SDD auto-impl (PAID path).
//
// Runs ONE feature's impl as a single headless `claude -p` process wrapped in a
// deterministic outer-safety stack, captures the terminal `result` event (which
// — unlike the interactive path — carries real total_cost_usd / num_turns), and
// classifies runaway outcomes. process-per-feature granularity (decided
// 2026-06-13): one result event = feature-level cost/turns.
//
// Outer-safety stack (all deterministic, harness-enforced — never trusts the
// model to self-limit; per reference_claude_agent_sdk_credit_billing_2026_06_15
// the platform's monthly SDK-credit pool is the primary $ circuit breaker, these
// are the per-run finer guards):
//   --max-budget-usd  : hard $ ceiling for THIS run (rations the monthly pool)
//   --max-turns       : hard iteration ceiling (catches non-$ loop runaway)
//   node SIGKILL timer: wall-clock kill (macOS has no GNU timeout; realRunner)
//   --permission-mode dontAsk + --allowedTools : locked-down tool surface
//   PreToolUse destructive-guard (SDD_BURST=1)  : blocks rm -rf / force-push /
//     reset --hard / DB-drop in Bash content (dontAsk gates tools, not Bash args)
//
// 🚨 This wrapper is the OUTER loop only (budget/timeout/capture/report). The
// INNER loop is a single `claude -p` invocation driving /sdd-auto-impl —
// model-driven, NOT scripted reasoning. That is the命门 difference from the
// retired scripts/orchestrator (which scripted the inner loop, 6500 lines).
//
// ✅ CONFIRMED (T2-1 probe 2026-06-13): `result` event carries total_cost_usd /
//    num_turns / duration_ms / usage{input_tokens,output_tokens,cache_*} /
//    modelUsage / subtype / is_error / session_id — burst.mjs parsing matches.
// ✅ CONFIRMED (T2-9 calibration 2026-06-13, real run on 015 T016 → success):
//   - `--allowedTools` space-separated IS accepted (model invoked Bash/Edit/
//     Write/Agent fine).
//   - `claude -p "/sdd-auto-impl …"` DOES resolve the slash command (no --bare,
//     command discovery on).
// ⚠️ STILL UNCONFIRMED:
//   - exact error shape when the monthly SDK credit drains mid-run (pool_drained
//     classification is a best-effort heuristic) — untestable until 6.15 gives a
//     separate SDK pool to drain (pre-6.15 `-p` draws the shared Max quota).
//   See docs/private/plans/2026-06/06-13-burst-calibration-baseline.md.
//
// Usage:  node scripts/sdd-run/burst.mjs <NNN-slug> [--cap 20] [--max-turns 300] [--wall 5400]
import { spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeReducer } from './burst-view.mjs';

// Whitelisted tools for the headless impl (dontAsk denies everything else).
export const DEFAULT_ALLOWED_TOOLS = [
  'Agent',
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Monitor',
];

// Anchored by T2-9 calibration (2026-06-13, 015 T016): steady-state ≈ $0.331/turn
// ($7.62 / 23 turns). So capUsd:20 is the BINDING guard (≈60 turns ≈ 2-3 tasks);
// maxTurns:300 is the far-outer non-$ loop-runaway catch (per plan §4.1 — by
// design they aren't equal). $20 fits a零头 feature (1-3 pending tasks); a full
// multi-task feature (≈100-300 turns / $30-100) needs a higher cap OR expects a
// mid-run max_budget abort (partial commits resume). Numbers UNCHANGED pending a
// representative multi-task measurement — single-task is a floor, not a sample.
// See docs/private/plans/2026-06/06-13-burst-calibration-baseline.md.
export const DEFAULTS = { capUsd: 20, maxTurns: 300, wallSec: 5400 /* 90min */ };

/**
 * Build the `claude -p …` argv + the wall-clock budget. Pure — no side effects.
 *
 * Wall-clock is NOT a `timeout`-wrapper: macOS (BSD userland) ships no GNU
 * `timeout`/`gtimeout` (probe 2026-06-13 → exit 127). realRunner enforces
 * wallSec with a node SIGKILL timer instead — portable, no coreutils dep.
 * cmd resolves from $CLAUDE_BIN (default `claude` on PATH).
 */
export function buildArgv({ feature, capUsd, maxTurns, wallSec, allowedTools } = {}) {
  if (!feature) throw new Error('buildArgv: feature (NNN-slug) required');
  const cap = capUsd ?? DEFAULTS.capUsd;
  const turns = maxTurns ?? DEFAULTS.maxTurns;
  const wall = wallSec ?? DEFAULTS.wallSec;
  const tools = (allowedTools ?? DEFAULT_ALLOWED_TOOLS).join(' ');
  const args = [
    '-p',
    `/sdd-auto-impl ${feature} --unattended`,
    '--max-budget-usd',
    String(cap),
    '--max-turns',
    String(turns),
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    tools,
    // stream-json (not json): json buffers everything to the end, so a
    // SIGKILLed/timed-out run yields zero output + zero progress visibility
    // (smoke 2026-06-13). stream-json emits NDJSON events live → realRunner tees
    // them to a log so a killed run keeps its full trace, and extractResultEvent
    // finds the terminal `result` line. `-p` requires --verbose for stream-json.
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  return { cmd: process.env.CLAUDE_BIN || 'claude', args, wallSec: wall };
}

/**
 * Extract the terminal `result` event from claude -p stdout. Handles both
 * --output-format json (single object) and stream-json (NDJSON; find the
 * type:"result" line). Returns null when none is parseable. Defensive: never
 * throws on malformed output.
 */
export function extractResultEvent(stdout) {
  if (!stdout || !stdout.trim()) return null;
  // json mode: the whole payload is one object.
  try {
    const obj = JSON.parse(stdout);
    if (
      obj &&
      (obj.type === 'result' || obj.total_cost_usd !== undefined || obj.subtype !== undefined)
    ) {
      return obj;
    }
  } catch {
    /* fall through to NDJSON scan */
  }
  // stream-json mode: scan lines bottom-up for the result event.
  const lines = stdout.split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev && ev.type === 'result') return ev;
    } catch {
      /* skip non-JSON line */
    }
  }
  return null;
}

/**
 * Classify the run outcome from the result event + process exit code + stderr.
 * `isRunaway` marks the deterministic-guard trips (the things the outer-safety
 * stack exists to catch). SAFETY-CRITICAL — unit-tested per subtype.
 */
export function classifyOutcome({ resultEvent, exitCode, stderr = '' } = {}) {
  // GNU timeout: 124 on expiry; 137 = 128+SIGKILL when --signal KILL used.
  if (exitCode === 124 || exitCode === 137) {
    return {
      outcome: 'timeout',
      isRunaway: true,
      detail: 'wall-clock timeout — process SIGKILLed',
    };
  }
  const sub = resultEvent?.subtype;
  if (sub === 'error_max_turns') {
    return { outcome: 'max_turns', isRunaway: true, detail: 'hit --max-turns ceiling' };
  }
  if (sub === 'error_max_budget_usd') {
    return { outcome: 'max_budget', isRunaway: true, detail: 'hit --max-budget-usd ceiling' };
  }
  // Monthly SDK-credit drain (exact shape UNCONFIRMED) — best-effort sniff.
  const haystack = `${stderr} ${resultEvent?.result ?? ''}`;
  if (/insufficient|credit|quota|exhaust|payment required|billing/i.test(haystack)) {
    return {
      outcome: 'pool_drained',
      isRunaway: false,
      detail:
        '月度 SDK credit 疑似耗尽 — 开溢出续跑 或 等月度重置（partial commits 已在分支，可续）',
    };
  }
  if (sub === 'error_during_execution' || resultEvent?.is_error) {
    return {
      outcome: 'error',
      isRunaway: false,
      detail: String(resultEvent?.result ?? 'execution error').slice(0, 240),
    };
  }
  if (sub === 'success') {
    return { outcome: 'success', isRunaway: false, detail: 'feature impl 完成' };
  }
  if (!resultEvent) {
    return {
      outcome: 'no_result',
      isRunaway: false,
      detail: `进程 exit=${exitCode}，无 result 事件（早死/未启动）`,
    };
  }
  return { outcome: 'unknown', isRunaway: false, detail: `subtype=${sub} exit=${exitCode}` };
}

/** Build the feature-level burst audit record (carries REAL cost, unlike Track 1). */
export function toBurstRecord({ feature, resultEvent, outcome, wallMs, ts }) {
  const usage = resultEvent?.usage ?? {};
  return {
    kind: 'burst',
    feature,
    outcome: outcome.outcome,
    is_runaway: outcome.isRunaway,
    detail: outcome.detail,
    // OTel gen_ai.* vocabulary + real headless telemetry (defensive reads).
    'gen_ai.usage.input_tokens': usage.input_tokens,
    'gen_ai.usage.output_tokens': usage.output_tokens,
    cost_usd: resultEvent?.total_cost_usd,
    num_turns: resultEvent?.num_turns,
    duration_ms: resultEvent?.duration_ms,
    wall_ms: wallMs,
    session_id: resultEvent?.session_id,
    subtype: resultEvent?.subtype,
    ts: ts ?? new Date().toISOString(),
  };
}

/** Render the headless run-report: feature-level totals (with REAL cost). */
export function renderBurstReport(rec) {
  const n = (v, suffix = '') => (v === undefined || v === null ? '—' : `${v}${suffix}`);
  const cost = rec.cost_usd === undefined ? '—' : `$${Number(rec.cost_usd).toFixed(2)}`;
  const wall = rec.wall_ms === undefined ? '—' : `${(rec.wall_ms / 60000).toFixed(1)}min`;
  const flag = rec.is_runaway ? ' 🚨runaway' : '';
  const lines = [
    `## Burst run-report — ${rec.feature}`,
    '',
    `**Outcome**: \`${rec.outcome}\`${flag} — ${rec.detail}`,
    '',
    '| Cost | Turns | Wall | In tok | Out tok | subtype |',
    '|---:|---:|---:|---:|---:|---|',
    `| ${cost} | ${n(rec.num_turns)} | ${wall} | ${n(rec['gen_ai.usage.input_tokens'])} | ${n(rec['gen_ai.usage.output_tokens'])} | ${n(rec.subtype)} |`,
    '',
    '> per-task 状态/commit 见同 feature `runs.jsonl`（/sdd-auto-impl --unattended 写入，无成本列）。per-feature 粒度只有 feature 级成本。',
  ];
  return lines.join('\n');
}

/** Persist raw result event + append burst record to bursts.jsonl. */
export function persist({ feature, resultEvent, record, baseDir }) {
  const dir = join(baseDir, `specs/${feature}/.sdd-run`);
  mkdirSync(dir, { recursive: true });
  if (resultEvent) {
    writeFileSync(
      join(dir, `burst-${record.ts.replace(/[:.]/g, '-')}.json`),
      JSON.stringify(resultEvent, null, 2) + '\n',
    );
  }
  appendFileSync(join(dir, 'bursts.jsonl'), JSON.stringify(record) + '\n');
}

/**
 * Spawn the real `claude -p …` and return { stdout, stderr, exitCode }.
 * Injectable for tests (default = real spawn).
 *
 * Wall-clock: enforced here with a node SIGKILL timer (macOS has no GNU
 * `timeout`). On expiry the child is SIGKILLed and exitCode is normalized to
 * 124 so classifyOutcome maps it to `timeout`.
 *
 * SDD_BURST=1 is exported so the repo's PreToolUse destructive-op guard
 * (scripts/hooks/pretooluse-burst-destructive-guard.sh) ENFORCES inside this headless
 * run — it env-gates off and no-ops in interactive sessions. The claude process
 * inherits this env, and so do its hook subprocesses + subagents.
 */
export function realRunner({ cmd, args, wallSec, streamLogPath, onLine }) {
  return new Promise((resolve) => {
    // Tee the live NDJSON event stream to disk so a SIGKILLed run keeps its
    // full trace (json mode lost everything on kill — smoke 2026-06-13).
    const logStream = streamLogPath ? createWriteStream(streamLogPath) : null;
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SDD_BURST: '1' },
    });
    let stdout = '';
    let stderr = '';
    let lineBuf = '';
    let timedOut = false;
    const timer = wallSec
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, wallSec * 1000)
      : null;
    const done = (exitCode, extraStderr = '') => {
      if (timer) clearTimeout(timer);
      if (logStream) logStream.end();
      resolve({ stdout, stderr: stderr + extraStderr, exitCode });
    };
    child.stdout.on('data', (b) => {
      const s = b.toString('utf-8');
      stdout += s;
      if (logStream) logStream.write(b);
      if (onLine) {
        // Emit complete NDJSON lines for live display; keep the partial tail.
        lineBuf += s;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          if (line.trim()) onLine(line);
        }
      }
    });
    child.stderr.on('data', (b) => (stderr += b.toString('utf-8')));
    child.on('close', (code) => done(timedOut ? 124 : (code ?? 0)));
    child.on('error', (err) => done(127, String(err)));
  });
}

/** Orchestrate one burst. Returns the outcome record. runner injectable for tests. */
export async function runBurst({
  feature,
  capUsd,
  maxTurns,
  wallSec,
  allowedTools,
  baseDir = process.cwd(),
  runner = realRunner,
}) {
  const startedAt = Date.now();
  const ts = new Date().toISOString();
  const sddDir = join(baseDir, 'specs', feature, '.sdd-run');
  mkdirSync(sddDir, { recursive: true }); // ensure dir exists before the live tee
  const streamLogPath = join(sddDir, `stream-${ts.replace(/[:.]/g, '-')}.jsonl`);
  const {
    cmd,
    args,
    wallSec: wall,
  } = buildArgv({ feature, capUsd, maxTurns, wallSec, allowedTools });
  // Live progress: reduce each NDJSON event → a stderr line (no-op under the
  // fake runner in tests, which never calls onLine).
  const reduce = makeReducer();
  const onLine = (line) => {
    const out = reduce(line);
    if (out) process.stderr.write(out + '\n');
  };
  const { stdout, stderr, exitCode } = await runner({
    cmd,
    args,
    wallSec: wall,
    streamLogPath,
    onLine,
  });
  const resultEvent = extractResultEvent(stdout);
  const outcome = classifyOutcome({ resultEvent, exitCode, stderr });
  const record = toBurstRecord({
    feature,
    resultEvent,
    outcome,
    wallMs: Date.now() - startedAt,
    ts,
  });
  persist({ feature, resultEvent, record, baseDir });
  return { record, resultEvent, outcome, stderr, streamLogPath };
}

// CLI entry (skipped when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const [feature, ...rest] = process.argv.slice(2);
  if (!feature) {
    console.error('usage: burst.mjs <NNN-slug> [--cap N] [--max-turns N] [--wall SEC]');
    process.exit(2);
  }
  const flag = (name, def) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : def;
  };
  const opts = { feature, capUsd: flag('cap'), maxTurns: flag('max-turns'), wallSec: flag('wall') };
  console.error(
    `burst: 🚨 PAID headless run — feature=${feature} cap=$${opts.capUsd ?? DEFAULTS.capUsd} maxTurns=${opts.maxTurns ?? DEFAULTS.maxTurns} wall=${opts.wallSec ?? DEFAULTS.wallSec}s`,
  );
  const { record, outcome } = await runBurst(opts);
  console.log('\n' + renderBurstReport(record));
  // Non-zero exit on any non-success so callers/CI can branch.
  process.exit(outcome.outcome === 'success' ? 0 : 1);
}
