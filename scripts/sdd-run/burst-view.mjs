#!/usr/bin/env node
// Reduce `claude -p --output-format stream-json` NDJSON events → human progress
// lines. ONE reducer, two inputs: live (burst.mjs feeds each line during a run)
// + post-hoc (replay a saved stream-*.jsonl of a finished/killed run).
//
// Industry verdict (2026-06-13 research): NO off-the-shelf tool consumes
// `claude -p` stream-json stdout as a live viewer — transcript viewers read
// ~/.claude/projects/*.jsonl (a different format), claude-trace wraps the HTTP
// layer, ccusage reads statusline stdin. A ~30-line NDJSON reducer is the right
// call. Listr2 (the retired orchestrator's choice) is overkill: it models a
// PREDEFINED task tree, but an agent's tool calls are an UNBOUNDED stream, so
// append-only lines beat a task-tree. Manual escape hatch for a saved trace:
//   jq -rj 'select(.type=="stream_event" and .event.delta.type?=="text_delta") | .event.delta.text' stream-*.jsonl
//
// Usage (post-hoc replay):  node scripts/sdd-run/burst-view.mjs <stream-*.jsonl>
//        (or pipe):         claude -p … --output-format stream-json --verbose | node scripts/sdd-run/burst-view.mjs
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** One-line summary of a tool_use input (best-effort across tools). */
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v =
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.description ??
    input.prompt;
  return v ? truncate(String(v).replace(/\s+/g, ' ').trim(), 60) : '';
}

/** Fresh reducer state. */
export function newState() {
  return { turns: 0, model: '' };
}

/**
 * Reduce ONE NDJSON line → a display string (or null to skip). Mutates state
 * (turn count / model). Defensive: never throws on a malformed line.
 */
export function reduceLine(line, state) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  switch (ev?.type) {
    case 'system':
      if (ev.subtype === 'init') {
        state.model = ev.model ?? '';
        return `◆ init · ${ev.model ?? '?'} · ${(ev.tools ?? []).length} tools`;
      }
      if (ev.subtype === 'api_retry') {
        return `⟳ api retry ${ev.attempt}/${ev.max_retries} (${ev.error_status ?? ev.error ?? '?'})`;
      }
      if (ev.subtype === 'compact_boundary') return '… context compacted';
      return null;
    case 'assistant': {
      state.turns += 1;
      const blocks = ev.message?.content ?? [];
      const tools = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => `${b.name}(${summarizeInput(b.input)})`);
      if (tools.length) return `▶ T${state.turns} ${tools.join(', ')}`;
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      return text ? `· T${state.turns} ${truncate(text, 100)}` : null;
    }
    case 'user': {
      const results = (ev.message?.content ?? []).filter((b) => b.type === 'tool_result');
      return results.length ? `  ✓ ${results.length} tool result(s)` : null;
    }
    case 'result':
      return `■ ${ev.subtype} · $${Number(ev.total_cost_usd ?? 0).toFixed(2)} · ${ev.num_turns ?? '?'} turns · ${((ev.duration_ms ?? 0) / 1000).toFixed(0)}s${ev.is_error ? ' · ERROR' : ''}`;
    default:
      return null; // stream_event (partial deltas) etc. — skipped in the default view
  }
}

/** Stateful per-line feeder for live use: burst.mjs calls feed(line) per line. */
export function makeReducer() {
  const state = newState();
  return (line) => reduceLine(line, state);
}

// CLI: replay a saved stream log (arg) or stdin.
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  const input = file ? createReadStream(file, 'utf-8') : process.stdin;
  const reduce = makeReducer();
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const out = reduce(line);
    if (out) console.log(out);
  });
}
