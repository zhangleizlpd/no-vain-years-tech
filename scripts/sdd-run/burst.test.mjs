// node --test scripts/sdd-run/burst.test.mjs
// Zero-infra tests (Node built-in runner) for the Track 2 burst wrapper.
// Focus: the SAFETY-CRITICAL classification (does the circuit breaker correctly
// detect each runaway?) + command shape + result parsing + end-to-end via a
// fake runner (NO real claude -p spend).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildArgv,
  extractResultEvent,
  classifyOutcome,
  toBurstRecord,
  renderBurstReport,
  runBurst,
  realRunner,
  DEFAULTS,
  DEFAULT_ALLOWED_TOOLS,
} from './burst.mjs';

test('buildArgv: claude -p (no timeout wrapper) with all guardrail flags + wallSec', () => {
  const { cmd, args, wallSec } = buildArgv({
    feature: '026-x',
    capUsd: 12,
    maxTurns: 50,
    wallSec: 600,
  });
  assert.equal(cmd, 'claude'); // CLAUDE_BIN default; NOT the GNU `timeout` (absent on macOS)
  assert.equal(args[0], '-p'); // claude args start immediately — no `timeout <sec> claude` prefix
  assert.equal(wallSec, 600); // wall-clock returned separately → node SIGKILL timer in realRunner
  const s = args.join(' ');
  assert.match(s, /-p \/sdd-auto-impl 026-x --unattended/);
  assert.match(s, /--max-budget-usd 12/);
  assert.match(s, /--max-turns 50/);
  assert.match(s, /--permission-mode dontAsk/);
  assert.match(s, /--output-format stream-json --verbose/); // stream not json (json blinds on kill)
  assert.ok(args.includes(DEFAULT_ALLOWED_TOOLS.join(' ')));
});

test('buildArgv: falls back to uncalibrated DEFAULTS', () => {
  const { args, wallSec } = buildArgv({ feature: '001-y' });
  assert.ok(args.includes(String(DEFAULTS.capUsd)));
  assert.ok(args.includes(String(DEFAULTS.maxTurns)));
  assert.equal(wallSec, DEFAULTS.wallSec);
});

test('buildArgv: throws without feature', () => {
  assert.throws(() => buildArgv({}), /feature/);
});

test('extractResultEvent: json mode single object', () => {
  const ev = extractResultEvent(
    JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1.23 }),
  );
  assert.equal(ev.subtype, 'success');
  assert.equal(ev.total_cost_usd, 1.23);
});

test('extractResultEvent: stream-json picks the result line bottom-up', () => {
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant' }),
    JSON.stringify({ type: 'result', subtype: 'success', num_turns: 7 }),
  ].join('\n');
  const ev = extractResultEvent(stream);
  assert.equal(ev.num_turns, 7);
});

test('extractResultEvent: null on empty / unparseable', () => {
  assert.equal(extractResultEvent(''), null);
  assert.equal(extractResultEvent('not json\nstill not'), null);
});

// ── SAFETY-CRITICAL: every runaway must be classified, and the deterministic
//    guard trips must be flagged isRunaway. ────────────────────────────────
test('classifyOutcome: timeout (exit 124) → runaway', () => {
  const o = classifyOutcome({ resultEvent: null, exitCode: 124 });
  assert.equal(o.outcome, 'timeout');
  assert.equal(o.isRunaway, true);
});

test('classifyOutcome: SIGKILL (exit 137) → timeout runaway', () => {
  assert.equal(classifyOutcome({ exitCode: 137 }).outcome, 'timeout');
});

test('classifyOutcome: error_max_turns → runaway', () => {
  const o = classifyOutcome({ resultEvent: { subtype: 'error_max_turns' }, exitCode: 1 });
  assert.equal(o.outcome, 'max_turns');
  assert.equal(o.isRunaway, true);
});

test('classifyOutcome: error_max_budget_usd → runaway', () => {
  const o = classifyOutcome({ resultEvent: { subtype: 'error_max_budget_usd' }, exitCode: 1 });
  assert.equal(o.outcome, 'max_budget');
  assert.equal(o.isRunaway, true);
});

test('classifyOutcome: credit-drain heuristic → pool_drained (not runaway, resumable)', () => {
  const o = classifyOutcome({
    resultEvent: { is_error: true, result: 'API error: insufficient credit balance' },
    exitCode: 1,
  });
  assert.equal(o.outcome, 'pool_drained');
  assert.equal(o.isRunaway, false);
  assert.match(o.detail, /可续/);
});

test('classifyOutcome: generic execution error', () => {
  const o = classifyOutcome({
    resultEvent: { subtype: 'error_during_execution', result: 'boom' },
    exitCode: 1,
  });
  assert.equal(o.outcome, 'error');
});

test('classifyOutcome: success', () => {
  const o = classifyOutcome({ resultEvent: { subtype: 'success' }, exitCode: 0 });
  assert.equal(o.outcome, 'success');
  assert.equal(o.isRunaway, false);
});

test('classifyOutcome: no result event → no_result', () => {
  assert.equal(classifyOutcome({ resultEvent: null, exitCode: 1 }).outcome, 'no_result');
});

test('toBurstRecord: carries real cost/turns + OTel token keys', () => {
  const rec = toBurstRecord({
    feature: '026-x',
    resultEvent: {
      total_cost_usd: 3.5,
      num_turns: 42,
      usage: { input_tokens: 1000, output_tokens: 200 },
      subtype: 'success',
    },
    outcome: { outcome: 'success', isRunaway: false, detail: 'ok' },
    wallMs: 120000,
    ts: '2026-06-13T00:00:00.000Z',
  });
  assert.equal(rec.cost_usd, 3.5);
  assert.equal(rec.num_turns, 42);
  assert.equal(rec['gen_ai.usage.input_tokens'], 1000);
  assert.equal(rec.kind, 'burst');
});

test('renderBurstReport: shows cost + runaway flag', () => {
  const md = renderBurstReport(
    toBurstRecord({
      feature: '026-x',
      resultEvent: {
        total_cost_usd: 9.99,
        num_turns: 5,
        usage: {},
        subtype: 'error_max_budget_usd',
      },
      outcome: { outcome: 'max_budget', isRunaway: true, detail: 'hit cap' },
      wallMs: 60000,
      ts: '2026-06-13T00:00:00.000Z',
    }),
  );
  assert.match(md, /\$9\.99/);
  assert.match(md, /🚨runaway/);
  assert.match(md, /max_budget/);
});

test('renderBurstReport: missing telemetry renders — not crash', () => {
  const md = renderBurstReport(
    toBurstRecord({
      feature: 'x',
      resultEvent: null,
      outcome: { outcome: 'no_result', isRunaway: false, detail: 'd' },
      wallMs: 1,
      ts: '2026-06-13T00:00:00.000Z',
    }),
  );
  assert.match(md, /—/);
});

// End-to-end via fake runner — proves the orchestration + persistence with NO spend.
test('runBurst: fake runner end-to-end persists bursts.jsonl + raw result', async () => {
  const base = mkdtempSync(join(tmpdir(), 'burst-test-'));
  const fakeResult = {
    type: 'result',
    subtype: 'success',
    total_cost_usd: 2.0,
    num_turns: 10,
    usage: { input_tokens: 5 },
  };
  const fakeRunner = async () => ({ stdout: JSON.stringify(fakeResult), stderr: '', exitCode: 0 });
  const { record, outcome } = await runBurst({
    feature: '026-x',
    baseDir: base,
    runner: fakeRunner,
  });
  assert.equal(outcome.outcome, 'success');
  assert.equal(record.cost_usd, 2.0);
  const jsonl = readFileSync(join(base, 'specs/026-x/.sdd-run/bursts.jsonl'), 'utf-8').trim();
  assert.equal(JSON.parse(jsonl).cost_usd, 2.0);
  assert.ok(existsSync(join(base, 'specs/026-x/.sdd-run')));
});

test('realRunner: node wall-clock SIGKILLs a hanging child → exitCode 124', async () => {
  // No GNU `timeout` on macOS — the wall-clock is a node SIGKILL timer. Spawn a
  // process that would hang forever; a 0.3s wallSec must kill it and normalize
  // the exit to 124 (so classifyOutcome maps it to `timeout`).
  const { exitCode } = await realRunner({
    cmd: process.execPath, // node
    args: ['-e', 'setInterval(() => {}, 1000)'],
    wallSec: 0.3,
  });
  assert.equal(exitCode, 124);
  assert.equal(classifyOutcome({ resultEvent: null, exitCode }).outcome, 'timeout');
});

test('realRunner: fast child exits normally, timer cleared (no false timeout)', async () => {
  const { exitCode } = await realRunner({
    cmd: process.execPath,
    args: ['-e', 'process.exit(0)'],
    wallSec: 30,
  });
  assert.equal(exitCode, 0);
});

test('runBurst: fake timeout → classified runaway, still persisted', async () => {
  const base = mkdtempSync(join(tmpdir(), 'burst-test-'));
  const fakeRunner = async () => ({ stdout: '', stderr: 'Terminated', exitCode: 124 });
  const { outcome } = await runBurst({ feature: '009-z', baseDir: base, runner: fakeRunner });
  assert.equal(outcome.outcome, 'timeout');
  assert.equal(outcome.isRunaway, true);
  assert.ok(existsSync(join(base, 'specs/009-z/.sdd-run/bursts.jsonl')));
});
