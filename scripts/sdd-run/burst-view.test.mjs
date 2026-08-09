// node --test scripts/sdd-run/burst-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceLine, newState, makeReducer } from './burst-view.mjs';

test('reduceLine: system/init → model + tool count', () => {
  const s = newState();
  const out = reduceLine(
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'claude-opus-4-8',
      tools: ['Bash', 'Read'],
    }),
    s,
  );
  assert.match(out, /◆ init · claude-opus-4-8 · 2 tools/);
  assert.equal(s.model, 'claude-opus-4-8');
});

test('reduceLine: assistant tool_use → ▶ with turn + tool summary', () => {
  const s = newState();
  const out = reduceLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm nx test server' } }],
      },
    }),
    s,
  );
  assert.match(out, /▶ T1 Bash\(pnpm nx test server\)/);
  assert.equal(s.turns, 1);
});

test('reduceLine: assistant text-only → · with truncated text', () => {
  const s = newState();
  const out = reduceLine(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'planning the next task' }] },
    }),
    s,
  );
  assert.match(out, /· T1 planning the next task/);
});

test('reduceLine: user tool_result → ✓ count', () => {
  const out = reduceLine(
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result' }, { type: 'tool_result' }] },
    }),
    newState(),
  );
  assert.match(out, /✓ 2 tool result/);
});

test('reduceLine: api_retry surfaced', () => {
  const out = reduceLine(
    JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      error_status: 'rate_limit',
    }),
    newState(),
  );
  assert.match(out, /⟳ api retry 2\/5 \(rate_limit\)/);
});

test('reduceLine: result → outcome + cost + turns + duration', () => {
  const out = reduceLine(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 3.456,
      num_turns: 12,
      duration_ms: 95000,
      is_error: false,
    }),
    newState(),
  );
  assert.match(out, /■ success · \$3\.46 · 12 turns · 95s/);
});

test('reduceLine: result error flagged', () => {
  const out = reduceLine(
    JSON.stringify({
      type: 'result',
      subtype: 'error_max_budget_usd',
      total_cost_usd: 2,
      num_turns: 5,
      duration_ms: 1000,
      is_error: true,
    }),
    newState(),
  );
  assert.match(out, /■ error_max_budget_usd .* · ERROR/);
});

test('reduceLine: stream_event (partial) + malformed → skipped (null)', () => {
  assert.equal(reduceLine(JSON.stringify({ type: 'stream_event', event: {} }), newState()), null);
  assert.equal(reduceLine('not json', newState()), null);
  assert.equal(reduceLine('', newState()), null);
});

test('makeReducer: turn counter accumulates across lines', () => {
  const r = makeReducer();
  r(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }] },
    }),
  );
  const out = r(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/c.ts' } }] },
    }),
  );
  assert.match(out, /▶ T2 Edit\(\/c\.ts\)/);
});
